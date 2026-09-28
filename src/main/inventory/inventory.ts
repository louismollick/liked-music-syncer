import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { joinArtistNames } from '../domain'
import type { Db } from '../library/db'
import {
  artists,
  files,
  operations,
  tombstones,
  tracks,
  unmanagedFiles,
} from '../library/schema'
import {
  type Match,
  type MatchedRelease,
  RESOLUTION_METHODS,
  type ResolutionMethod,
  releaseIdentityKey,
  standaloneIdentityKey,
} from '../match/types'
import {
  CATALOG_SOURCE_ORIGIN,
  changedTagParts,
  readTags,
  sha256,
  type TagFields,
} from '../tags/schema'
import {
  exists,
  onDiskRelative,
  STAGING_DIR,
  sha256File,
  walkAudio,
} from './files'
import { pathKey, sidecarPath } from './layout'

/**
 * Library inventory: the narrow interface to the output folder. Scans for
 * Managed and Unmanaged Files, adopts v5 files into an empty database,
 * detects Outside Edits, and recovers interrupted writes.
 */

export interface InventoryDeps {
  db: Db
  coversDir: string
  now: () => Date
}

function releaseKindFromTag(value: string | null): MatchedRelease['kind'] {
  const lower = value?.toLowerCase() ?? ''
  if (lower.includes('single')) return 'single'
  if (lower === 'ep' || lower.includes(' ep')) return 'ep'
  if (lower.includes('album')) return 'album'
  return null
}

function yearFromDate(date: string | null): number | null {
  const match = date?.match(/^(\d{4})/)
  return match ? Number(match[1]) : null
}

function classifyLyrics(text: string | null): 'synced' | 'plain' | 'none' {
  if (!text) return 'none'
  const timestamps = [
    ...text.matchAll(/^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gm),
  ]
  if (timestamps.length === 0) return 'plain'
  const allZero = timestamps.every(
    (m) => Number(m[1]) === 0 && Number(m[2]) === 0 && Number(m[3] ?? 0) === 0
  )
  return allZero ? 'plain' : 'synced'
}

async function saveCover(
  dir: string,
  cover: Uint8Array | null
): Promise<string | null> {
  if (!cover) return null
  const digest = sha256(cover)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${digest}.jpg`)
  if (!(await exists(target))) await writeFile(target, cover)
  return target
}

/**
 * Restores the Match a file records, or null when the file does not prove this
 * app matched it: no confirmation atom, or missing or contradictory facts.
 * Files the previous app wrote are never restored; they stay Unmanaged.
 */
export function matchFromTags(fields: TagFields): Match | null {
  const lms = fields.lms
  if (!lms.matchConfirmed) return null
  const sourceVideoId = lms.sourceVideoId
  const catalogVideoId = lms.resolvedVideoId
  const method = lms.resolutionMethod as ResolutionMethod | null
  if (!sourceVideoId || !catalogVideoId || !fields.title) return null
  if (!method || !RESOLUTION_METHODS.includes(method)) return null
  const releaseId = lms.releaseBrowseId
  // A Standalone Track has no Release and downloads the liked video itself.
  if ((method === 'standalone') !== !releaseId) return null
  if (!releaseId && catalogVideoId !== sourceVideoId) return null
  if (releaseId && !(lms.releaseTitle ?? fields.album)) return null
  const credits = lms.artistCredits.length
    ? lms.artistCredits
    : fields.artist
      ? [{ name: fields.artist, channelId: null }]
      : []
  const release: MatchedRelease | null = releaseId
    ? {
        browseId: releaseId,
        title: lms.releaseTitle ?? fields.album ?? '',
        kind: releaseKindFromTag(lms.releaseKind),
        artists: credits,
        year: yearFromDate(fields.date),
        date: fields.date,
        trackNumber: fields.trackNumber,
        trackTotal: fields.trackTotal,
        discNumber: fields.discNumber,
        discTotal: fields.discTotal,
        thumbnailUrl: null,
      }
    : null
  return {
    version: 1,
    sourceVideoId,
    catalogVideoId,
    identityKey: releaseId
      ? releaseIdentityKey(releaseId, catalogVideoId)
      : standaloneIdentityKey(sourceVideoId),
    release,
    title: fields.title,
    artists: credits,
    // Standalone Tracks are filed as their own single (album = title).
    album: releaseId ? (fields.album ?? '') : fields.title,
    albumArtist: fields.albumArtist ?? joinArtistNames(credits.slice(0, 1)),
    durationSeconds: null,
    coverUrl: null,
    lyricsBrowseId: null,
    resolutionMethod: method,
    confirmed: true,
  }
}

export interface AdoptResult {
  adopted: number
  unmanaged: number
  suggestedArtists: number
}

/**
 * Adopts every Managed File in `root` into the database. Called when the
 * database has no tracks, and for LMS-tagged files found later without a
 * record. Adopted tracks are marked done; contributions link on the first
 * source checks.
 */
export async function adoptFiles(
  deps: InventoryDeps,
  root: string,
  onProgress?: (done: number, total: number) => void
): Promise<AdoptResult> {
  // Skip files the app already tracks, files the user stopped managing, and
  // files waiting to be deleted (a quit before the delete ran must not undo it).
  const known = new Set(
    [
      ...deps.db
        .select({ path: files.relativePath })
        .from(files)
        .all()
        .map((row) => row.path),
      ...deps.db
        .select({ path: unmanagedFiles.relativePath })
        .from(unmanagedFiles)
        .where(eq(unmanagedFiles.released, true))
        .all()
        .map((row) => row.path),
      ...deps.db
        .select({
          path: tombstones.path,
          kind: tombstones.kind,
          doneAt: tombstones.doneAt,
        })
        .from(tombstones)
        .all()
        .filter((row) => row.kind === 'local' && !row.doneAt)
        .map((row) => row.path),
    ].map(pathKey)
  )
  // Case-insensitive: an older record may spell a folder differently than disk.
  // Sorted, so when two files hold one Release Track the same one is kept.
  const entries = (await walkAudio(root))
    .filter((entry) => !known.has(pathKey(entry.relativePath)))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
  let adopted = 0
  let unmanaged = 0
  const suggested = new Set<string>()
  const at = deps.now().toISOString()
  const listUnmanaged = (
    entry: { relativePath: string; size: number; mtimeMs: number },
    released = false
  ) => {
    deps.db
      .insert(unmanagedFiles)
      .values({ ...entry, seenAt: at, released })
      .onConflictDoUpdate({
        target: unmanagedFiles.relativePath,
        set: {
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          seenAt: at,
          ...(released ? { released } : {}),
        },
      })
      .run()
    unmanaged += 1
  }
  for (const [index, entry] of entries.entries()) {
    onProgress?.(index, entries.length)
    const absolute = path.join(root, entry.relativePath)
    let read: ReturnType<typeof readTags>
    try {
      read = readTags(absolute)
    } catch {
      listUnmanaged(entry)
      continue
    }
    const match = matchFromTags(read.fields)
    if (!match) {
      listUnmanaged(entry)
      continue
    }
    const lrcPath = path.join(root, sidecarPath(entry.relativePath))
    const sidecarInfo = await stat(lrcPath).catch(() => null)
    const lrcText = sidecarInfo
      ? (await readFile(lrcPath, 'utf8')).trim()
      : null
    const lyricsText = lrcText || read.fields.lyrics
    const lyricsStatus = classifyLyrics(lyricsText)
    const coverPath = await saveCover(deps.coversDir, read.cover)
    const contentSha = await sha256File(absolute)
    const lrcSha = lrcText !== null ? sha256(await readFile(lrcPath)) : null
    const values = {
      identityKey: match.identityKey,
      title: match.title || path.basename(entry.relativePath, '.m4a'),
      artistCredits: JSON.stringify(match.artists),
      artist: read.fields.artist ?? joinArtistNames(match.artists),
      album: match.album,
      albumArtist: match.albumArtist,
      releaseId: match.release?.browseId ?? null,
      releaseKind: match.release?.kind ?? null,
      // Standalone Tracks carry no numbers; their tags always say 1 of 1.
      trackNumber: match.release?.trackNumber ?? null,
      trackTotal: match.release?.trackTotal ?? null,
      discNumber: match.release?.discNumber ?? null,
      discTotal: match.release?.discTotal ?? null,
      date: read.fields.date,
      year: yearFromDate(read.fields.date),
      durationSeconds: read.durationSeconds,
      genre: read.fields.genre,
      isrc: read.fields.isrc,
      mbRecordingId: read.fields.mbRecordingId,
      language: read.fields.language,
      lyricsStatus,
      lyricsText: lyricsText || null,
      spotifyTrackId: read.fields.lms.spotifyTrackId,
      coverPath,
      match: JSON.stringify(match),
      updatedAt: at,
    }
    // Decided inside the transaction: a source check running meanwhile may
    // have created this Release Track since the file was read.
    const outcome = deps.db.transaction((tx): 'extra' | string => {
      const db = tx as unknown as Db
      const existing = db
        .select()
        .from(tracks)
        .where(eq(tracks.identityKey, match.identityKey))
        .get()
      const hasFile =
        existing &&
        db
          .select({ id: files.trackId })
          .from(files)
          .where(eq(files.trackId, existing.id))
          .get()
      if (
        existing &&
        (hasFile ||
          existing.state === 'released' ||
          existing.state === 'no_longer_wanted')
      ) {
        // Another file holds this Release Track, or the user stopped managing
        // or chose to delete it: keep this copy on disk, untouched, as Unmanaged.
        const release = (relativePath: string, size: number, mtimeMs: number) =>
          db
            .insert(unmanagedFiles)
            .values({ relativePath, size, mtimeMs, seenAt: at, released: true })
            .onConflictDoUpdate({
              target: unmanagedFiles.relativePath,
              set: { size, mtimeMs, seenAt: at, released: true },
            })
            .run()
        release(entry.relativePath, entry.size, entry.mtimeMs)
        if (sidecarInfo)
          release(
            sidecarPath(entry.relativePath),
            sidecarInfo.size,
            sidecarInfo.mtimeMs
          )
        return 'extra'
      }
      const trackId = existing?.id ?? randomUUID()
      if (existing) {
        // A source already wants this Release Track and nothing was downloaded
        // yet: the restored file is its file, with the Match it records.
        db.update(tracks)
          .set({
            ...values,
            state: 'pending',
            attempts: 0,
            nextAttemptAt: null,
          })
          .where(eq(tracks.id, trackId))
          .run()
        db.run(sql`DELETE FROM track_artists WHERE track_id = ${trackId}`)
      } else {
        db.insert(tracks)
          .values({
            id: trackId,
            ...values,
            adopted: true,
            state: 'done',
            createdAt: at,
          })
          .run()
      }
      db.insert(files)
        .values({
          trackId,
          relativePath: entry.relativePath,
          audioVideoId: match.catalogVideoId,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          contentSha256: contentSha,
          tagFields: JSON.stringify(read.fields),
          lrcSha256: lrcSha,
          writtenAt: at,
        })
        .run()
      db.delete(unmanagedFiles)
        .where(eq(unmanagedFiles.relativePath, entry.relativePath))
        .run()
      return trackId
    })
    if (outcome === 'extra') {
      unmanaged += sidecarInfo ? 2 : 1
      continue
    }
    linkAdoptedArtists(deps.db, outcome, match.artists)
    if (read.fields.lms.sourceOrigin === CATALOG_SOURCE_ORIGIN) {
      for (const credit of match.artists)
        if (credit.channelId) suggested.add(`channel:${credit.channelId}`)
    }
    adopted += 1
  }
  for (const id of suggested) {
    deps.db
      .update(artists)
      .set({ suggested: true })
      .where(and(eq(artists.id, id), eq(artists.fullDiscography, false)))
      .run()
  }
  onProgress?.(entries.length, entries.length)
  return { adopted, unmanaged, suggestedArtists: suggested.size }
}

function linkAdoptedArtists(
  db: Db,
  trackId: string,
  credits: Match['artists']
): void {
  credits.forEach((credit, position) => {
    const id = credit.channelId
      ? `channel:${credit.channelId}`
      : `name:${credit.name.normalize('NFKC').toLowerCase().trim()}`
    db.insert(artists)
      .values({ id, name: credit.name, channelId: credit.channelId })
      .onConflictDoNothing()
      .run()
    db.run(
      sql`INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (${trackId}, ${id}, ${position})`
    )
  })
}

export interface OutsideEditReport {
  checked: number
  edited: number
  missing: number
}

/**
 * Compares every Managed File with its record. Size/mtime changes trigger a
 * hash; a hash that matches neither the record nor a pending operation is an
 * Outside Edit, recorded with which parts changed. Edited files are paused.
 */
export async function detectOutsideEdits(
  deps: InventoryDeps,
  root: string
): Promise<OutsideEditReport> {
  // An unmounted or unreadable folder is not the user deleting every file.
  if (!(await readableDirectory(root)))
    return { checked: 0, edited: 0, missing: 0 }
  const rows = deps.db.select().from(files).all()
  const pending = new Set(
    deps.db
      .select({ sha: operations.expectedSha256 })
      .from(operations)
      .all()
      .map((row) => row.sha)
      .filter(Boolean)
  )
  let edited = 0
  let missing = 0
  for (const row of rows) {
    const absolute = path.join(root, row.relativePath)
    if (row.outsideEdit) {
      // Clear the flag once the file is back exactly as the app wrote it.
      if (await matchesRecord(root, row)) {
        deps.db
          .update(files)
          .set({ outsideEdit: null })
          .where(eq(files.trackId, row.trackId))
          .run()
      }
      continue
    }
    const parts: string[] = []
    let info: Awaited<ReturnType<typeof stat>> | null = null
    try {
      info = await stat(absolute)
    } catch {
      parts.push('deleted')
      missing += 1
    }
    if (
      info &&
      (info.size !== row.size || Math.abs(info.mtimeMs - row.mtimeMs) > 1)
    ) {
      const digest = await sha256File(absolute)
      if (digest === row.contentSha256) {
        deps.db
          .update(files)
          .set({ mtimeMs: info.mtimeMs })
          .where(eq(files.trackId, row.trackId))
          .run()
      } else if (!pending.has(digest)) {
        try {
          const read = readTags(absolute)
          const written = JSON.parse(row.tagFields) as TagFields
          parts.push(...changedTagParts(read.fields, written))
          if (parts.length === 0) parts.push('audio')
        } catch {
          parts.push('audio')
        }
      }
    }
    if (row.lrcSha256 && info) {
      const lrc = path.join(root, sidecarPath(row.relativePath))
      const lrcDigest = (await exists(lrc)) ? sha256(await readFile(lrc)) : null
      if (lrcDigest !== row.lrcSha256 && !(lrcDigest && pending.has(lrcDigest)))
        parts.push('sidecar')
    }
    if (parts.length) {
      edited += 1
      deps.db
        .update(files)
        .set({ outsideEdit: JSON.stringify(parts) })
        .where(eq(files.trackId, row.trackId))
        .run()
    }
  }
  return { checked: rows.length, edited, missing }
}

/**
 * Startup recovery: resolves pending operations by hash and clears staging.
 * Artifacts whose final path holds the expected bytes are committed; the rest
 * are left for their step to run again.
 */
export async function recoverOperations(
  deps: InventoryDeps,
  root: string
): Promise<number> {
  // Keep the journal for later if the folder is not available right now.
  if (!(await readableDirectory(root))) return 0
  const ops = deps.db.select().from(operations).all()
  let recovered = 0
  for (const op of ops) {
    const target = path.join(root, op.toPath)
    const digest = (await exists(target)) ? await sha256File(target) : null
    if (digest && digest === op.expectedSha256) {
      if (op.artifact === 'audio') {
        const toPath = await onDiskRelative(root, op.toPath)
        const info = await stat(target)
        let fields: string | null = null
        try {
          fields = JSON.stringify(readTags(target).fields)
        } catch {
          fields = null
        }
        const existing = deps.db
          .select()
          .from(files)
          .where(eq(files.trackId, op.trackId))
          .get()
        if (existing) {
          deps.db
            .update(files)
            .set({
              relativePath: toPath,
              contentSha256: digest,
              audioVideoId: op.audioVideoId,
              size: info.size,
              mtimeMs: info.mtimeMs,
              ...(fields ? { tagFields: fields } : {}),
              outsideEdit: null,
            })
            .where(eq(files.trackId, op.trackId))
            .run()
        } else if (fields) {
          deps.db
            .insert(files)
            .values({
              trackId: op.trackId,
              relativePath: toPath,
              size: info.size,
              mtimeMs: info.mtimeMs,
              contentSha256: digest,
              audioVideoId: op.audioVideoId,
              tagFields: fields,
              writtenAt: deps.now().toISOString(),
            })
            .onConflictDoNothing()
            .run()
        }
      } else {
        deps.db
          .update(files)
          .set({ lrcSha256: digest })
          .where(eq(files.trackId, op.trackId))
          .run()
      }
      recovered += 1
    }
    deps.db.delete(operations).where(eq(operations.id, op.id)).run()
  }
  await rm(path.join(root, STAGING_DIR), { recursive: true, force: true })
  return recovered
}

/** True when `root` exists and can be listed (e.g. the drive is mounted). */
export async function readableDirectory(root: string): Promise<boolean> {
  try {
    await readdir(root)
    return true
  } catch {
    return false
  }
}

async function matchesRecord(
  root: string,
  row: typeof files.$inferSelect
): Promise<boolean> {
  const absolute = path.join(root, row.relativePath)
  try {
    const info = await stat(absolute)
    if (
      info.size !== row.size ||
      (await sha256File(absolute)) !== row.contentSha256
    )
      return false
  } catch {
    return false
  }
  if (row.lrcSha256) {
    const lrc = path.join(root, sidecarPath(row.relativePath))
    if (!(await exists(lrc)) || sha256(await readFile(lrc)) !== row.lrcSha256)
      return false
  }
  return true
}
