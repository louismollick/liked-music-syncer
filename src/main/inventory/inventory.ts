import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { joinArtistNames } from '../domain'
import type { Db } from '../library/db'
import {
  artists,
  files,
  operations,
  tracks,
  unmanagedFiles,
} from '../library/schema'
import type { Match, MatchedRelease } from '../match/types'
import { readTags, sha256, type TagFields } from '../tags/schema'
import { exists, STAGING_DIR, sha256File, walkAudio } from './files'
import { sidecarPath } from './layout'

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

/** Rebuilds a Match from v5/v6 tags, using only facts the tags contain. */
export function matchFromTags(fields: TagFields): Match | null {
  const sourceVideoId = fields.lms.sourceVideoId
  if (!sourceVideoId) return null
  const catalogVideoId = fields.lms.resolvedVideoId ?? sourceVideoId
  const releaseId = fields.lms.releaseBrowseId
  const credits = fields.lms.artistCredits.length
    ? fields.lms.artistCredits
    : fields.artist
      ? [{ name: fields.artist, channelId: null }]
      : []
  const release: MatchedRelease | null = releaseId
    ? {
        browseId: releaseId,
        title: fields.lms.releaseTitle ?? fields.album ?? '',
        kind: releaseKindFromTag(fields.lms.releaseKind),
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
      ? `adopted:${releaseId}:${catalogVideoId}`
      : `adopted:video:${sourceVideoId}`,
    release,
    title: fields.title ?? '',
    artists: credits,
    // Standalone Tracks are filed as their own single (album = title).
    album: releaseId ? (fields.album ?? '') : (fields.title ?? ''),
    albumArtist: fields.albumArtist ?? joinArtistNames(credits.slice(0, 1)),
    durationSeconds: null,
    coverUrl: null,
    lyricsBrowseId: null,
    resolutionMethod:
      (fields.lms.resolutionMethod as Match['resolutionMethod']) ??
      'watch_playlist',
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
  const known = new Set(
    deps.db
      .select({ path: files.relativePath })
      .from(files)
      .all()
      .map((row) => row.path)
  )
  const entries = (await walkAudio(root)).filter(
    (entry) => !known.has(entry.relativePath)
  )
  let adopted = 0
  let unmanaged = 0
  const suggested = new Set<string>()
  const at = deps.now().toISOString()
  for (const [index, entry] of entries.entries()) {
    onProgress?.(index, entries.length)
    const absolute = path.join(root, entry.relativePath)
    let read: ReturnType<typeof readTags>
    try {
      read = readTags(absolute)
    } catch {
      deps.db
        .insert(unmanagedFiles)
        .values({
          relativePath: entry.relativePath,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          seenAt: at,
        })
        .onConflictDoNothing()
        .run()
      unmanaged += 1
      continue
    }
    const match = read.fields.lms.schemaVersion
      ? matchFromTags(read.fields)
      : null
    if (!match) {
      deps.db
        .insert(unmanagedFiles)
        .values({
          relativePath: entry.relativePath,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          seenAt: at,
        })
        .onConflictDoUpdate({
          target: unmanagedFiles.relativePath,
          set: { size: entry.size, mtimeMs: entry.mtimeMs, seenAt: at },
        })
        .run()
      unmanaged += 1
      continue
    }
    const lrcPath = path.join(root, sidecarPath(entry.relativePath))
    const lrcText = (await exists(lrcPath))
      ? (await readFile(lrcPath, 'utf8')).trim()
      : null
    const lyricsText = lrcText || read.fields.lyrics
    const lyricsStatus = classifyLyrics(lyricsText)
    const coverPath = await saveCover(deps.coversDir, read.cover)
    const contentSha = await sha256File(absolute)
    const lrcSha = lrcText !== null ? sha256(await readFile(lrcPath)) : null
    let identityKey = match.identityKey
    for (
      let n = 2;
      deps.db
        .select({ id: tracks.id })
        .from(tracks)
        .where(eq(tracks.identityKey, identityKey))
        .get();
      n += 1
    ) {
      identityKey = `${match.identityKey}:${n}`
    }
    const trackId = randomUUID()
    deps.db.transaction((tx) => {
      const db = tx as unknown as Db
      db.insert(tracks)
        .values({
          id: trackId,
          identityKey,
          adopted: true,
          title: match.title || path.basename(entry.relativePath, '.m4a'),
          artistCredits: JSON.stringify(match.artists),
          artist: read.fields.artist ?? joinArtistNames(match.artists),
          album: match.album,
          albumArtist: match.albumArtist,
          releaseId: match.release?.browseId ?? null,
          releaseKind: match.release?.kind ?? null,
          trackNumber: read.fields.trackNumber,
          trackTotal: read.fields.trackTotal,
          discNumber: read.fields.discNumber,
          discTotal: read.fields.discTotal,
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
          state: 'done',
          createdAt: at,
          updatedAt: at,
        })
        .run()
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
    })
    linkAdoptedArtists(deps.db, trackId, match.artists)
    if (read.fields.lms.sourceOrigin === 'favorite_artist_release') {
      for (const credit of match.artists)
        if (credit.channelId) suggested.add(`channel:${credit.channelId}`)
    }
    adopted += 1
  }
  for (const id of suggested) {
    deps.db
      .update(artists)
      .set({ suggested: true })
      .where(and(eq(artists.id, id), eq(artists.favorite, false)))
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
    if (row.outsideEdit) continue
    const absolute = path.join(root, row.relativePath)
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
          const { coverSha256: a, ...restRead } = read.fields
          const { coverSha256: b, ...restWritten } = written
          if (JSON.stringify(restRead) !== JSON.stringify(restWritten))
            parts.push('tags')
          if (a !== b) parts.push('artwork')
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
  const ops = deps.db.select().from(operations).all()
  let recovered = 0
  for (const op of ops) {
    const target = path.join(root, op.toPath)
    const digest = (await exists(target)) ? await sha256File(target) : null
    if (digest && digest === op.expectedSha256) {
      if (op.artifact === 'audio') {
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
              relativePath: op.toPath,
              contentSha256: digest,
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
              relativePath: op.toPath,
              size: info.size,
              mtimeMs: info.mtimeMs,
              contentSha256: digest,
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
