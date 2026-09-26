import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, like } from 'drizzle-orm'
import type { Settings } from '../../shared/ipc'
import type { AudioDownloader } from '../acquire/audio'
import { makeSquareCover } from '../acquire/cover'
import type { CatalogRelease, YouTubeMusicCatalog } from '../catalog/types'
import { type ArtistCredit, joinArtistNames } from '../domain'
import {
  copyToStaging,
  exists,
  PathTakenError,
  placeNoClobber,
  pruneEmptyDirs,
  replaceOwned,
  STAGING_DIR,
  sha256File,
} from '../inventory/files'
import { pathKey, resolveCollision, sidecarPath } from '../inventory/layout'
import type { Db } from '../library/db'
import {
  artists,
  contributions,
  type FileRow,
  files,
  operations,
  type TrackRow,
  tombstones,
  trackArtists,
  trackHistory,
  tracks,
  type UploadRow,
  uploads,
} from '../library/schema'
import type { LyricsFinder } from '../lyrics/types'
import type { Match, Matcher, MatchInput } from '../match/types'
import type { HttpClient } from '../net/http'
import type { ToolPaths } from '../platform/tools'
import type {
  HashAlgo,
  Rclone,
  RemoteObject,
  RemoteTarget,
} from '../remote/rclone'
import { hashFile } from '../remote/rclone'
import { fieldDiff, sha256, type TagFields, writeTags } from '../tags/schema'
import {
  desiredPath,
  desiredSidecar,
  desiredTagFields,
  parseMatch,
} from './desired'
import type { CatalogRaw, LikedRaw } from './sources'

export interface StepDeps {
  db: Db
  tools: ToolPaths
  catalog: YouTubeMusicCatalog
  matcher: Matcher
  lyrics: LyricsFinder
  downloader: AudioDownloader
  rclone: Rclone
  http: HttpClient
  settings: () => Settings
  now: () => Date
}

export interface StepRun {
  signal: AbortSignal
  /** Progress within the current step, 0..1. */
  progress: (fraction: number) => void
}

export type StepKind = 'match' | 'acquire' | 'retag' | 'move' | 'upload'

/** Fields that do not justify rewriting a file on their own. */
const IMMATERIAL_FIELDS = new Set(['lms.schemaVersion'])

const iso = (deps: StepDeps) => deps.now().toISOString()

export function coversDir(deps: Pick<StepDeps, 'tools'>): string {
  return path.join(deps.tools.userData, 'covers')
}

export function coverShaFromPath(coverPath: string | null): string | null {
  if (!coverPath) return null
  return path.basename(coverPath, '.jpg')
}

export function libraryRoot(settings: Settings): string {
  if (!settings.libraryFolder)
    throw Object.assign(new Error('Choose a library folder first'), {
      kind: 'permanent',
    })
  return settings.libraryFolder
}

export function targetKey(target: RemoteTarget): string {
  return `${target.remote.replace(/:$/, '')}|${target.folder.replace(/\/+$/, '')}`
}

function targetFromKey(key: string): RemoteTarget {
  const separator = key.indexOf('|')
  return { remote: key.slice(0, separator), folder: key.slice(separator + 1) }
}

export function remoteTarget(settings: Settings): RemoteTarget | null {
  if (
    !settings.remoteEnabled ||
    !settings.rcloneRemote.trim() ||
    !settings.remoteFolder.trim()
  )
    return null
  return {
    remote: settings.rcloneRemote.trim(),
    folder: settings.remoteFolder.trim(),
  }
}

/** Origin tag implied by active contributions; undefined when none back the track. */
export function sourceOriginFor(
  db: Db,
  trackId: string
): string | null | undefined {
  const rows = db
    .select({ kind: contributions.kind })
    .from(contributions)
    .where(
      and(eq(contributions.trackId, trackId), eq(contributions.active, true))
    )
    .all()
  if (rows.length === 0) return undefined
  return rows.every((row) => row.kind === 'catalog')
    ? 'favorite_artist_release'
    : null
}

export function desiredFieldsFor(db: Db, track: TrackRow): TagFields {
  let origin = sourceOriginFor(db, track.id)
  if (origin === undefined) {
    // No source claims the track yet (e.g. just adopted): keep what the file says,
    // so adoption alone never rewrites a file.
    const file = db
      .select()
      .from(files)
      .where(eq(files.trackId, track.id))
      .get()
    origin = file ? (parseFields(file).lms?.sourceOrigin ?? null) : null
  }
  return desiredTagFields(track, coverShaFromPath(track.coverPath), origin)
}

export function materialDiff(written: TagFields, desired: TagFields): string[] {
  return fieldDiff(written, desired).filter(
    (field) => !IMMATERIAL_FIELDS.has(field)
  )
}

export function parseFields(row: FileRow): TagFields {
  return JSON.parse(row.tagFields) as TagFields
}

/** Decides the next Track Step from facts (plan: "Track states and steps"). */
export function nextStep(
  db: Db,
  track: TrackRow,
  file: FileRow | undefined,
  upload: UploadRow | undefined,
  settings: Settings
): StepKind | null {
  const match = parseMatch(track)
  if (
    !match ||
    track.refreshRequested ||
    !track.identityKey ||
    track.identityKey.startsWith('adopted:')
  ) {
    if (!match || track.refreshRequested) return 'match'
  }
  if (file?.outsideEdit) return null
  if (
    !file ||
    (match && file.audioVideoId && file.audioVideoId !== match.catalogVideoId)
  ) {
    return 'acquire'
  }
  const desired = desiredFieldsFor(db, track)
  const sidecar = desiredSidecar(track)
  const sidecarSha = sidecar ? sha256(sidecar) : null
  if (
    materialDiff(parseFields(file), desired).length > 0 ||
    (file.lrcSha256 ?? null) !== sidecarSha
  ) {
    return 'retag'
  }
  if (
    pathKey(file.relativePath) !== pathKey(desiredPath(track)) &&
    !isSuffixedVariant(file.relativePath, desiredPath(track))
  ) {
    return 'move'
  }
  const target = remoteTarget(settings)
  if (target) {
    if (
      !upload ||
      upload.remoteTarget !== targetKey(target) ||
      upload.localSha256 !== file.contentSha256 ||
      upload.remotePath !== file.relativePath ||
      (upload.lrcHash ?? null) !== (file.lrcSha256 ?? null)
    ) {
      return 'upload'
    }
  }
  return null
}

/** A collision-suffixed path counts as being at its layout path. */
function isSuffixedVariant(actual: string, preferred: string): boolean {
  const base = pathKey(preferred.replace(/\.m4a$/i, ''))
  const key = pathKey(actual)
  return key.startsWith(`${base} [`) && key.endsWith('.m4a')
}

// ---------------------------------------------------------------- match

const RELEASE_CACHE_MS = 10 * 60_000
const releaseCache = new Map<
  string,
  { at: number; release: Promise<CatalogRelease> }
>()

/** Release pages are shared by every track of a catalog; cache them briefly. */
function releaseWithTracks(
  catalog: YouTubeMusicCatalog,
  browseId: string,
  signal: AbortSignal
): Promise<CatalogRelease> {
  const cached = releaseCache.get(browseId)
  if (cached && Date.now() - cached.at < RELEASE_CACHE_MS) return cached.release
  const release = catalog.release(browseId, signal)
  releaseCache.set(browseId, { at: Date.now(), release })
  release.catch(() => releaseCache.delete(browseId))
  return release
}

function matchInputFor(db: Db, track: TrackRow): MatchInput | null {
  const rows = db
    .select()
    .from(contributions)
    .where(eq(contributions.trackId, track.id))
    .all()
  const active = rows.filter((row) => row.active)
  const candidates = active.length ? active : rows
  const chosen =
    candidates.find((row) => row.kind === 'liked') ??
    candidates.find((row) => row.kind === 'catalog')
  if (chosen) {
    const raw = JSON.parse(chosen.raw) as LikedRaw | CatalogRaw
    if (raw.kind === 'liked') return { kind: 'liked', song: raw.song }
    return {
      kind: 'catalog',
      artistId: raw.artistId,
      release: { ...raw.release, tracks: [raw.track] },
      track: raw.track,
    }
  }
  // Adopted track without contributions: rebuild a liked-style input from its saved Match.
  const match = parseMatch(track)
  if (!match) return null
  return {
    kind: 'liked',
    song: {
      videoId: match.sourceVideoId,
      title: track.title,
      artists: JSON.parse(track.artistCredits) as ArtistCredit[],
      album: track.releaseId
        ? { browseId: track.releaseId, name: track.album }
        : null,
      durationSeconds: track.durationSeconds,
      videoType: null,
      isExplicit: false,
      thumbnailUrl: track.coverUrl,
      trackNumber: null,
      discNumber: null,
      isAvailable: true,
      position: 0,
    },
  }
}

function artistIdFor(credit: ArtistCredit): string {
  return credit.channelId
    ? `channel:${credit.channelId}`
    : `name:${credit.name.normalize('NFKC').toLowerCase().trim()}`
}

export function linkTrackArtists(
  db: Db,
  trackId: string,
  credits: ArtistCredit[]
): void {
  db.delete(trackArtists).where(eq(trackArtists.trackId, trackId)).run()
  credits.forEach((credit, position) => {
    const id = artistIdFor(credit)
    const existing = db.select().from(artists).where(eq(artists.id, id)).get()
    if (!existing) {
      db.insert(artists)
        .values({ id, name: credit.name, channelId: credit.channelId })
        .run()
    } else if (existing.name !== credit.name && credit.channelId) {
      db.update(artists)
        .set({ name: credit.name })
        .where(eq(artists.id, id))
        .run()
    }
    db.insert(trackArtists)
      .values({ trackId, artistId: id, position })
      .onConflictDoNothing()
      .run()
  })
}

async function processCover(
  deps: StepDeps,
  url: string | null,
  signal: AbortSignal
): Promise<string | null> {
  if (!url) return null
  const bytes = await deps.http.bytes(url, { host: 'images', signal })
  const square = await makeSquareCover(deps.tools.ffmpeg, bytes)
  const digest = sha256(square)
  const dir = coversDir(deps)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${digest}.jpg`)
  if (!(await exists(target))) await writeFile(target, square)
  return target
}

function adoptedClaim(db: Db, match: Match): TrackRow | undefined {
  // Adopted files keep a provisional key until a Match re-keys them, even after a like claims them.
  const candidates = db
    .select()
    .from(tracks)
    .where(like(tracks.identityKey, 'adopted:%'))
    .all()
  return candidates.find((candidate) => {
    const saved = parseMatch(candidate)
    if (!saved) return false
    if (match.release) {
      if (candidate.releaseId !== match.release.browseId) return false
      const ids = new Set([saved.sourceVideoId, saved.catalogVideoId])
      return ids.has(match.sourceVideoId) || ids.has(match.catalogVideoId)
    }
    return !candidate.releaseId && saved.sourceVideoId === match.sourceVideoId
  })
}

/** Moves `from`'s contributions (and file, when `into` has none) into `into`, then deletes `from`. */
function mergeTracks(
  db: Db,
  from: TrackRow,
  into: TrackRow,
  at: string,
  survivorFileValid: boolean
): void {
  db.update(contributions)
    .set({ trackId: into.id })
    .where(eq(contributions.trackId, from.id))
    .run()
  const fromFile = db
    .select()
    .from(files)
    .where(eq(files.trackId, from.id))
    .get()
  const intoFile = db
    .select()
    .from(files)
    .where(eq(files.trackId, into.id))
    .get()
  const fromUpload = db
    .select()
    .from(uploads)
    .where(eq(uploads.trackId, from.id))
    .get()
  if (fromFile && (!intoFile || !survivorFileValid)) {
    if (intoFile) db.delete(files).where(eq(files.trackId, into.id)).run()
    db.update(files)
      .set({ trackId: into.id })
      .where(eq(files.trackId, from.id))
      .run()
    if (
      fromUpload &&
      !db.select().from(uploads).where(eq(uploads.trackId, into.id)).get()
    ) {
      db.update(uploads)
        .set({ trackId: into.id })
        .where(eq(uploads.trackId, from.id))
        .run()
    }
  } else if (fromFile) {
    // Redundant copy of the same Release Track: remove it through tombstones.
    db.insert(tombstones)
      .values({
        id: randomUUID(),
        trackId: null,
        kind: 'local',
        path: fromFile.relativePath,
        reason: 'merged',
        createdAt: at,
      })
      .run()
    if (fromFile.lrcSha256) {
      db.insert(tombstones)
        .values({
          id: randomUUID(),
          trackId: null,
          kind: 'local',
          path: sidecarPath(fromFile.relativePath),
          reason: 'merged',
          createdAt: at,
        })
        .run()
    }
    db.delete(files).where(eq(files.trackId, from.id)).run()
  }
  if (
    fromUpload &&
    db.select().from(uploads).where(eq(uploads.trackId, from.id)).get()
  ) {
    if (fromUpload.remotePath)
      db.insert(tombstones)
        .values({
          id: randomUUID(),
          trackId: null,
          kind: 'remote',
          path: fromUpload.remotePath,
          remoteTarget: fromUpload.remoteTarget,
          reason: 'merged',
          createdAt: at,
        })
        .run()
    if (fromUpload.lrcRemotePath)
      db.insert(tombstones)
        .values({
          id: randomUUID(),
          trackId: null,
          kind: 'remote',
          path: fromUpload.lrcRemotePath,
          remoteTarget: fromUpload.remoteTarget,
          reason: 'merged',
          createdAt: at,
        })
        .run()
    db.delete(uploads).where(eq(uploads.trackId, from.id)).run()
  }
  db.delete(trackArtists).where(eq(trackArtists.trackId, from.id)).run()
  db.insert(trackHistory)
    .values({
      trackId: into.id,
      at,
      event: 'merged',
      detail: JSON.stringify({ from: from.id, title: from.title }),
    })
    .run()
  db.delete(tracks).where(eq(tracks.id, from.id)).run()
}

async function validFile(
  root: string,
  file: FileRow | undefined
): Promise<boolean> {
  if (!file) return false
  const absolute = path.join(root, file.relativePath)
  try {
    const info = await stat(absolute)
    return (
      info.isFile() &&
      info.size === file.size &&
      (await sha256File(absolute)) === file.contentSha256
    )
  } catch {
    return false
  }
}

export interface MatchOutcome {
  /** Track that now carries the work (may differ from the input after a merge). */
  trackId: string
}

export async function runMatch(
  deps: StepDeps,
  track: TrackRow,
  run: StepRun
): Promise<MatchOutcome> {
  let input = matchInputFor(deps.db, track)
  if (!input)
    throw Object.assign(
      new Error('Nothing to match: this track has no source'),
      { kind: 'permanent' }
    )
  if (input.kind === 'catalog') {
    // Contributions store only their own track; numbering needs the whole release.
    input = {
      ...input,
      release: await releaseWithTracks(
        deps.catalog,
        input.release.browseId,
        run.signal
      ),
    }
  }
  const settings = deps.settings()
  const match = await deps.matcher.match(input, run.signal)
  run.progress(0.4)
  const errors: Record<string, string> = {}
  let enrichment = {
    mbRecordingId: null as string | null,
    genre: null as string | null,
    isrc: null as string | null,
  }
  try {
    enrichment = await deps.matcher.enrich(match, run.signal)
  } catch (error) {
    if (run.signal.aborted) throw error
    errors.musicbrainz = error instanceof Error ? error.message : String(error)
  }
  run.progress(0.6)
  let lyricsText: string | null = null
  let lyricsStatus: 'synced' | 'plain' | 'none' = 'none'
  let lyricsSource: string | null = null
  let language: string | null = null
  let spotifyTrackId = track.spotifyTrackId
  if (settings.lyricsEnabled) {
    const found = await deps.lyrics.find(
      {
        title: match.title,
        artists: match.artists,
        album: match.release?.title ?? null,
        durationSeconds: match.durationSeconds,
        lyricsBrowseId: match.lyricsBrowseId,
        spotifyTrackId,
      },
      { lyricsServerUrl: settings.lyricsServerUrl.trim() || null },
      run.signal
    )
    Object.assign(
      errors,
      Object.fromEntries(
        Object.entries(found.errors).map(([k, v]) => [`lyrics:${k}`, v])
      )
    )
    spotifyTrackId = found.spotifyTrackId ?? spotifyTrackId
    if (found.lyrics) {
      lyricsText = found.lyrics.text
      lyricsStatus = found.lyrics.synced ? 'synced' : 'plain'
      lyricsSource = found.lyrics.source
      language = found.lyrics.language
    }
  }
  run.progress(0.8)
  let coverPath = track.coverPath
  try {
    coverPath =
      (await processCover(deps, match.coverUrl, run.signal)) ?? coverPath
  } catch (error) {
    if (run.signal.aborted) throw error
    errors.cover = error instanceof Error ? error.message : String(error)
  }
  run.progress(1)

  const at = iso(deps)
  let survivor = track.id
  let candidate = deps.db
    .select()
    .from(tracks)
    .where(eq(tracks.identityKey, match.identityKey))
    .get()
  if (candidate?.id === track.id) candidate = undefined
  if (!candidate) candidate = adoptedClaim(deps.db, match)
  const candidateFile =
    candidate && candidate.id !== track.id
      ? deps.db
          .select()
          .from(files)
          .where(eq(files.trackId, candidate.id))
          .get()
      : undefined
  const survivorFileValid = candidateFile
    ? await validFile(libraryRoot(settings), candidateFile)
    : false
  run.signal.throwIfAborted()
  deps.db.transaction((tx) => {
    const db = tx as unknown as Db
    const current = db
      .select()
      .from(tracks)
      .where(eq(tracks.id, track.id))
      .get()
    if (!current) return
    const previousIdentityKey = current.identityKey
    let target = db
      .select()
      .from(tracks)
      .where(eq(tracks.identityKey, match.identityKey))
      .get()
    if (target?.id === current.id) target = undefined
    if (!target) {
      const claimed = adoptedClaim(db, match)
      if (claimed && claimed.id !== current.id) target = claimed
    }
    if (target && target.id !== current.id) {
      mergeTracks(db, current, target, at, survivorFileValid)
      survivor = target.id
    }
    const release = match.release
    db.update(tracks)
      .set({
        identityKey: match.identityKey,
        adopted: false,
        title: match.title,
        artistCredits: JSON.stringify(match.artists),
        artist: joinArtistNames(match.artists),
        album: match.album,
        albumArtist: match.albumArtist,
        releaseId: release?.browseId ?? null,
        releaseKind: release?.kind ?? null,
        trackNumber: release?.trackNumber ?? null,
        trackTotal: release?.trackTotal ?? null,
        discNumber: release?.discNumber ?? null,
        discTotal: release?.discTotal ?? null,
        date: release?.date ?? null,
        year: release?.year ?? null,
        durationSeconds: match.durationSeconds,
        genre: enrichment.genre,
        isrc: enrichment.isrc,
        mbRecordingId: enrichment.mbRecordingId,
        lyricsText,
        lyricsStatus,
        lyricsSource,
        language,
        lyricsCheckedAt: settings.lyricsEnabled ? at : null,
        spotifyTrackId,
        coverUrl: match.coverUrl,
        coverPath,
        match: JSON.stringify(match),
        enrichmentErrors: JSON.stringify(errors),
        refreshRequested: false,
        updatedAt: at,
      })
      .where(eq(tracks.id, survivor))
      .run()
    linkTrackArtists(db, survivor, match.artists)
    if (previousIdentityKey && previousIdentityKey !== match.identityKey) {
      db.insert(trackHistory)
        .values({
          trackId: survivor,
          at,
          event: 're-keyed',
          detail: JSON.stringify({
            from: previousIdentityKey,
            to: match.identityKey,
          }),
        })
        .run()
    }
    db.insert(trackHistory)
      .values({
        trackId: survivor,
        at,
        event: 'matched',
        detail: JSON.stringify({
          identityKey: match.identityKey,
          method: match.resolutionMethod,
        }),
      })
      .run()
  })
  return { trackId: survivor }
}

// ---------------------------------------------------------------- file placement

function stagingDir(root: string, trackId: string): string {
  return path.join(root, STAGING_DIR, trackId)
}

function takenChecker(db: Db, root: string, trackId: string) {
  const reserved = new Set(
    db
      .select({ path: files.relativePath, trackId: files.trackId })
      .from(files)
      .all()
      .filter((row) => row.trackId !== trackId)
      .map((row) => pathKey(row.path))
  )
  const own = db
    .select({ path: files.relativePath, lrcSha256: files.lrcSha256 })
    .from(files)
    .where(eq(files.trackId, trackId))
    .get()
  const ownKey = own ? pathKey(own.path) : null
  return async (relative: string) => {
    const key = pathKey(relative)
    if (reserved.has(key)) return true
    const sidecar = sidecarPath(relative)
    const ownsSidecar = key === ownKey && Boolean(own?.lrcSha256)
    if (!ownsSidecar && (await exists(path.join(root, sidecar)))) return true
    // The track's own file is not a collision (case-only differences on macOS).
    if (key === ownKey) return false
    return exists(path.join(root, relative))
  }
}

function chooseFreePath(
  db: Db,
  root: string,
  track: TrackRow
): Promise<string> {
  return resolveCollision(
    desiredPath(track),
    track.identityKey ?? track.id,
    takenChecker(db, root, track.id)
  )
}

function journal(
  db: Db,
  rows: Array<
    Omit<typeof operations.$inferInsert, 'id' | 'startedAt' | 'phase'>
  >,
  at: string
): void {
  for (const row of rows) {
    db.insert(operations)
      .values({ id: randomUUID(), phase: 'started', startedAt: at, ...row })
      .run()
  }
}

function clearJournal(db: Db, trackId: string, step: string): void {
  db.delete(operations)
    .where(and(eq(operations.trackId, trackId), eq(operations.step, step)))
    .run()
}

async function writeSidecarStaged(
  dir: string,
  content: string | null
): Promise<string | null> {
  if (!content) return null
  const staged = path.join(dir, 'lyrics.lrc')
  await writeFile(staged, content, 'utf8')
  return staged
}

async function coverBytes(track: TrackRow): Promise<Uint8Array | null> {
  if (!track.coverPath) return null
  try {
    return new Uint8Array(await readFile(track.coverPath))
  } catch {
    return null
  }
}

interface PlacedFile {
  relativePath: string
  contentSha256: string
  size: number
  mtimeMs: number
  lrcSha256: string | null
}

/**
 * Places staged audio (+ sidecar) for a track. When the track already owns a
 * file at `targetPath` it is replaced atomically; otherwise the new file is
 * placed without clobbering and the previous file is removed afterwards.
 */
async function placeTrackFiles(
  deps: StepDeps,
  root: string,
  track: TrackRow,
  step: StepKind,
  stagedAudio: string,
  stagedSidecar: string | null,
  previous: FileRow | undefined,
  audioVideoId: string | null,
  signal: AbortSignal
): Promise<PlacedFile> {
  signal.throwIfAborted()
  const at = iso(deps)
  const audioSha = await sha256File(stagedAudio)
  const sidecarSha = stagedSidecar
    ? sha256(await readFile(stagedSidecar))
    : null
  const taken = takenChecker(deps.db, root, track.id)
  const keepPath =
    previous &&
    previous.relativePath === desiredPath(track) &&
    !(await taken(previous.relativePath))
      ? previous.relativePath
      : null
  let target = keepPath ?? (await chooseFreePath(deps.db, root, track))
  signal.throwIfAborted()
  deps.db.transaction((tx) => {
    journal(
      tx as unknown as Db,
      [
        {
          trackId: track.id,
          step,
          artifact: 'audio',
          kind: keepPath ? 'replace' : 'place',
          fromPath: previous?.relativePath ?? null,
          toPath: target,
          expectedSha256: audioSha,
          audioVideoId,
        },
        ...(stagedSidecar
          ? [
              {
                trackId: track.id,
                step,
                artifact: 'sidecar',
                kind: keepPath ? 'replace' : 'place',
                fromPath: null,
                toPath: sidecarPath(target),
                expectedSha256: sidecarSha,
              },
            ]
          : []),
      ],
      at
    )
  })
  const absolute = (relative: string) => path.join(root, relative)
  if (keepPath) {
    signal.throwIfAborted()
    await replaceOwned(stagedAudio, absolute(target))
  } else {
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted()
      try {
        await placeNoClobber(stagedAudio, absolute(target))
        break
      } catch (error) {
        if (!(error instanceof PathTakenError) || attempt > 3) throw error
        target = await chooseFreePath(deps.db, root, track)
      }
    }
  }
  const lrcTarget = absolute(sidecarPath(target))
  signal.throwIfAborted()
  if (stagedSidecar) {
    if (previous?.lrcSha256 && previous.relativePath === target)
      await replaceOwned(stagedSidecar, lrcTarget)
    else await placeNoClobber(stagedSidecar, lrcTarget)
  } else if (previous?.lrcSha256 && previous.relativePath === target) {
    await rm(lrcTarget, { force: true })
  }
  if (previous && previous.relativePath !== target) {
    signal.throwIfAborted()
    await rm(absolute(previous.relativePath), { force: true })
    if (previous.lrcSha256)
      await rm(absolute(sidecarPath(previous.relativePath)), { force: true })
    await pruneEmptyDirs(root, path.dirname(absolute(previous.relativePath)))
  }
  const info = await stat(absolute(target))
  return {
    relativePath: target,
    contentSha256: audioSha,
    size: info.size,
    mtimeMs: info.mtimeMs,
    lrcSha256: sidecarSha,
  }
}

function commitFile(
  deps: StepDeps,
  track: TrackRow,
  step: StepKind,
  placed: PlacedFile,
  fields: TagFields,
  audioVideoId: string | null
): void {
  const at = iso(deps)
  deps.db.transaction((tx) => {
    const db = tx as unknown as Db
    const row = {
      trackId: track.id,
      relativePath: placed.relativePath,
      audioVideoId,
      size: placed.size,
      mtimeMs: placed.mtimeMs,
      contentSha256: placed.contentSha256,
      tagFields: JSON.stringify(fields),
      lrcSha256: placed.lrcSha256,
      writtenAt: at,
      outsideEdit: null,
    }
    const existing = db
      .select()
      .from(files)
      .where(eq(files.trackId, track.id))
      .get()
    if (existing)
      db.update(files).set(row).where(eq(files.trackId, track.id)).run()
    else db.insert(files).values(row).run()
    clearJournal(db, track.id, step)
  })
}

export async function runAcquire(
  deps: StepDeps,
  track: TrackRow,
  run: StepRun
): Promise<void> {
  const root = libraryRoot(deps.settings())
  const match = parseMatch(track)
  if (!match) throw new Error('Cannot download before matching')
  const dir = stagingDir(root, track.id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  try {
    const audio = await deps.downloader.download(
      match.catalogVideoId,
      dir,
      ({ fraction }) => run.progress(fraction * 0.9),
      run.signal
    )
    run.signal.throwIfAborted()
    const fields = desiredFieldsFor(deps.db, track)
    writeTags(audio, fields, await coverBytes(track))
    const sidecar = await writeSidecarStaged(dir, desiredSidecar(track))
    const previous = deps.db
      .select()
      .from(files)
      .where(eq(files.trackId, track.id))
      .get()
    const placed = await placeTrackFiles(
      deps,
      root,
      track,
      'acquire',
      audio,
      sidecar,
      previous,
      match.catalogVideoId,
      run.signal
    )
    commitFile(deps, track, 'acquire', placed, fields, match.catalogVideoId)
    run.progress(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function runRetag(
  deps: StepDeps,
  track: TrackRow,
  run: StepRun
): Promise<void> {
  const root = libraryRoot(deps.settings())
  const file = deps.db
    .select()
    .from(files)
    .where(eq(files.trackId, track.id))
    .get()
  if (!file) throw new Error('No file to retag')
  const dir = stagingDir(root, track.id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  try {
    const desired = desiredFieldsFor(deps.db, track)
    const content = desiredSidecar(track)
    const lrc = path.join(root, sidecarPath(file.relativePath))
    const sidecarBlocked = Boolean(
      content && !file.lrcSha256 && (await exists(lrc))
    )
    if (
      materialDiff(parseFields(file), desired).length === 0 &&
      !sidecarBlocked
    ) {
      // Only the sidecar differs: leave the audio (and its upload) untouched.
      run.signal.throwIfAborted()
      if (content) {
        const staged = await writeSidecarStaged(dir, content)
        if (file.lrcSha256) await replaceOwned(staged!, lrc)
        else await placeNoClobber(staged!, lrc)
      } else if (file.lrcSha256) {
        await rm(lrc, { force: true })
      }
      deps.db
        .update(files)
        .set({ lrcSha256: content ? sha256(content) : null })
        .where(eq(files.trackId, track.id))
        .run()
      run.progress(1)
      return
    }
    const staged = path.join(dir, 'audio.m4a')
    await copyToStaging(path.join(root, file.relativePath), staged)
    run.signal.throwIfAborted()
    const fields = desiredFieldsFor(deps.db, track)
    writeTags(staged, fields, await coverBytes(track))
    const sidecar = await writeSidecarStaged(dir, desiredSidecar(track))
    const placed = await placeTrackFiles(
      deps,
      root,
      track,
      'retag',
      staged,
      sidecar,
      file,
      file.audioVideoId,
      run.signal
    )
    commitFile(deps, track, 'retag', placed, fields, file.audioVideoId)
    run.progress(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function runMove(
  deps: StepDeps,
  track: TrackRow,
  run: StepRun
): Promise<void> {
  const root = libraryRoot(deps.settings())
  const file = deps.db
    .select()
    .from(files)
    .where(eq(files.trackId, track.id))
    .get()
  if (!file) throw new Error('No file to move')
  let target = await chooseFreePath(deps.db, root, track)
  run.signal.throwIfAborted()
  const at = iso(deps)
  deps.db.transaction((tx) => {
    journal(
      tx as unknown as Db,
      [
        {
          trackId: track.id,
          step: 'move',
          artifact: 'audio',
          kind: 'move',
          fromPath: file.relativePath,
          toPath: target,
          expectedSha256: file.contentSha256,
        },
        ...(file.lrcSha256
          ? [
              {
                trackId: track.id,
                step: 'move',
                artifact: 'sidecar',
                kind: 'move',
                fromPath: sidecarPath(file.relativePath),
                toPath: sidecarPath(target),
                expectedSha256: file.lrcSha256,
              },
            ]
          : []),
      ],
      at
    )
  })
  const from = path.join(root, file.relativePath)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await placeNoClobber(from, path.join(root, target))
      break
    } catch (error) {
      if (!(error instanceof PathTakenError) || attempt > 3) throw error
      target = await chooseFreePath(deps.db, root, track)
    }
  }
  if (file.lrcSha256) {
    const lrcFrom = path.join(root, sidecarPath(file.relativePath))
    if (await exists(lrcFrom)) {
      try {
        await placeNoClobber(lrcFrom, path.join(root, sidecarPath(target)))
      } catch (error) {
        await placeNoClobber(path.join(root, target), from).catch(
          () => undefined
        )
        throw error
      }
    }
  }
  await pruneEmptyDirs(root, path.dirname(from))
  deps.db.transaction((tx) => {
    const db = tx as unknown as Db
    db.update(files)
      .set({ relativePath: target })
      .where(eq(files.trackId, track.id))
      .run()
    db.insert(trackHistory)
      .values({
        trackId: track.id,
        at,
        event: 'moved',
        detail: JSON.stringify({ from: file.relativePath, to: target }),
      })
      .run()
    clearJournal(db, track.id, 'move')
  })
  run.progress(1)
}

// ---------------------------------------------------------------- upload

export interface RemoteIndexCache {
  get(
    target: RemoteTarget,
    algo: HashAlgo | null
  ): Promise<Map<string, RemoteObject>>
  invalidate(): void
}

export function createRemoteIndexCache(rclone: Rclone): RemoteIndexCache {
  let cached: { key: string; map: Promise<Map<string, RemoteObject>> } | null =
    null
  return {
    get(target, algo) {
      const key = `${target.remote}|${target.folder}|${algo}`
      if (!cached || cached.key !== key)
        cached = { key, map: rclone.list(target, { hashAlgo: algo }) }
      return cached.map
    },
    invalidate() {
      cached = null
    },
  }
}

/** Drop records for remote objects removed or resized outside the app. */
export async function auditRemote(deps: StepDeps): Promise<string[]> {
  const target = remoteTarget(deps.settings())
  if (!target) return []
  const listing = await deps.rclone.list(target, {})
  const key = targetKey(target)
  const stale: string[] = []
  for (const row of deps.db
    .select()
    .from(uploads)
    .where(eq(uploads.remoteTarget, key))
    .all()) {
    const audio = row.remotePath
      ? listing.get(row.remotePath.normalize('NFC'))
      : null
    const sidecar = row.lrcRemotePath
      ? listing.get(row.lrcRemotePath.normalize('NFC'))
      : null
    if (
      (row.remotePath && (!audio || audio.size !== row.remoteSize)) ||
      (row.lrcRemotePath && (!sidecar || sidecar.size !== row.lrcRemoteSize))
    ) {
      stale.push(row.trackId)
    }
  }
  if (stale.length)
    deps.db.delete(uploads).where(inArray(uploads.trackId, stale)).run()
  return stale
}

export async function runUpload(
  deps: StepDeps,
  track: TrackRow,
  run: StepRun,
  index: RemoteIndexCache
): Promise<void> {
  const settings = deps.settings()
  const target = remoteTarget(settings)
  if (!target) return
  const root = libraryRoot(settings)
  const file = deps.db
    .select()
    .from(files)
    .where(eq(files.trackId, track.id))
    .get()
  if (!file) throw new Error('No file to upload')
  const recorded = deps.db
    .select()
    .from(uploads)
    .where(eq(uploads.trackId, track.id))
    .get()
  // A record for another remote target is not an upload to this one.
  const existing =
    recorded?.remoteTarget === targetKey(target) ? recorded : undefined
  const local = path.join(root, file.relativePath)
  const caps = await deps.rclone.capabilities(target)
  const at = iso(deps)

  let audio: {
    size: number
    modTime: string
    hashAlgo: HashAlgo | null
    hash: string | null
  } | null = null
  let movedSidecar = false
  // Moved locally: move the remote copy instead of uploading again.
  if (
    existing?.remotePath &&
    existing.remotePath !== file.relativePath &&
    existing.localSha256 === file.contentSha256
  ) {
    await deps.rclone
      .move(target, existing.remotePath, file.relativePath, run.signal)
      .catch(() => undefined)
    if (existing.lrcRemotePath && existing.lrcHash === file.lrcSha256) {
      movedSidecar = await deps.rclone
        .move(
          target,
          existing.lrcRemotePath,
          sidecarPath(file.relativePath),
          run.signal
        )
        .then(
          () => true,
          () => false
        )
    }
    audio = await deps.rclone.verify(
      target,
      local,
      file.relativePath,
      run.signal
    )
  }
  if (!audio && !existing) {
    // No upload record (fresh database or adoption): accept an identical remote copy.
    const listing = await index.get(target, caps.hashAlgo)
    const remote = listing.get(file.relativePath.normalize('NFC'))
    if (remote && remote.size === file.size) {
      if (caps.hashAlgo && remote.hash) {
        if ((await hashFile(local, caps.hashAlgo)) === remote.hash) {
          audio = {
            size: remote.size,
            modTime: remote.modTime,
            hashAlgo: caps.hashAlgo,
            hash: remote.hash,
          }
        }
      } else {
        audio = await deps.rclone.verify(
          target,
          local,
          file.relativePath,
          run.signal
        )
      }
    }
  }
  if (
    !audio &&
    existing?.localSha256 === file.contentSha256 &&
    existing.remotePath === file.relativePath
  ) {
    audio = {
      size: existing.remoteSize ?? file.size,
      modTime: existing.remoteMtime ?? at,
      hashAlgo: (existing.hashAlgo as HashAlgo | null) ?? null,
      hash: existing.contentHash,
    }
  }
  if (!audio) {
    audio = await deps.rclone.upload(
      target,
      local,
      file.relativePath,
      (f) => run.progress(f * 0.9),
      run.signal
    )
  }

  // Sidecar
  const lrcRelative = sidecarPath(file.relativePath)
  let lrcRemotePath: string | null = null
  let lrcRemoteSize: number | null = null
  if (file.lrcSha256) {
    const lrcLocal = path.join(root, lrcRelative)
    if (
      !(
        movedSidecar ||
        (existing?.lrcHash === file.lrcSha256 &&
          existing.lrcRemotePath === lrcRelative)
      )
    ) {
      const verified = await deps.rclone.upload(
        target,
        lrcLocal,
        lrcRelative,
        () => {},
        run.signal
      )
      lrcRemoteSize = verified.size
    } else {
      lrcRemoteSize = existing?.lrcRemoteSize ?? null
    }
    lrcRemotePath = lrcRelative
  } else if (existing?.lrcRemotePath) {
    await deps.rclone.delete(target, existing.lrcRemotePath, run.signal)
  }
  if (existing?.remotePath && existing.remotePath !== file.relativePath) {
    await deps.rclone
      .delete(target, existing.remotePath, run.signal)
      .catch(() => undefined)
  }

  const row = {
    trackId: track.id,
    remoteTarget: targetKey(target),
    remotePath: file.relativePath,
    hashAlgo: audio.hashAlgo,
    contentHash: audio.hash,
    remoteSize: audio.size,
    remoteMtime: audio.modTime,
    lrcRemotePath,
    lrcHash: file.lrcSha256,
    lrcRemoteSize,
    tagFields: file.tagFields,
    localSha256: file.contentSha256,
    verifiedAt: at,
    uploadedAt: at,
  }
  deps.db.transaction((tx) => {
    const db = tx as unknown as Db
    if (db.select().from(uploads).where(eq(uploads.trackId, track.id)).get()) {
      db.update(uploads).set(row).where(eq(uploads.trackId, track.id)).run()
    } else {
      db.insert(uploads).values(row).run()
    }
  })
  run.progress(1)
}

/** Deletes files named by pending tombstones. */
export async function processTombstones(
  deps: StepDeps,
  signal: AbortSignal
): Promise<void> {
  const all = deps.db.select().from(tombstones).all()
  const pending = all.filter((row) => !row.doneAt)
  const settings = deps.settings()
  const target = remoteTarget(settings)
  for (const row of pending) {
    if (signal.aborted) return
    if (row.kind === 'local') {
      if (!settings.libraryFolder) continue
      const absolute = path.join(settings.libraryFolder, row.path)
      // Never delete a path another track now owns.
      const audioPath = row.path.replace(/\.lrc$/i, '.m4a')
      const owner = deps.db
        .select()
        .from(files)
        .where(eq(files.relativePath, audioPath))
        .get()
      if (!owner) {
        await rm(absolute, { force: true })
        await pruneEmptyDirs(settings.libraryFolder, path.dirname(absolute))
      }
    } else {
      const storedTarget = row.remoteTarget
        ? targetFromKey(row.remoteTarget)
        : target
      if (!storedTarget) continue
      const owner = row.path.endsWith('.lrc')
        ? deps.db
            .select()
            .from(uploads)
            .where(eq(uploads.lrcRemotePath, row.path))
            .get()
        : deps.db
            .select()
            .from(uploads)
            .where(eq(uploads.remotePath, row.path))
            .get()
      if (!owner || owner.remoteTarget !== targetKey(storedTarget))
        await deps.rclone.delete(storedTarget, row.path, signal)
    }
    deps.db
      .update(tombstones)
      .set({ doneAt: iso(deps) })
      .where(eq(tombstones.id, row.id))
      .run()
  }
  for (const trackId of new Set(
    all.flatMap((row) => (row.trackId ? [row.trackId] : []))
  )) {
    if (
      deps.db
        .select()
        .from(tombstones)
        .where(eq(tombstones.trackId, trackId))
        .all()
        .some((row) => !row.doneAt)
    )
      continue
    if (deps.db.select().from(files).where(eq(files.trackId, trackId)).get())
      continue
    if (
      deps.db.select().from(uploads).where(eq(uploads.trackId, trackId)).get()
    )
      continue
    deps.db.transaction((tx) => {
      const db = tx as unknown as Db
      db.delete(trackArtists).where(eq(trackArtists.trackId, trackId)).run()
      db.delete(contributions)
        .where(
          and(
            eq(contributions.trackId, trackId),
            eq(contributions.active, false)
          )
        )
        .run()
      db.delete(tracks).where(eq(tracks.id, trackId)).run()
    })
  }
}

export function deleteTracks(
  deps: StepDeps,
  trackIds: string[],
  where: 'local' | 'remote' | 'both'
): string[] {
  const at = iso(deps)
  const deleted: string[] = []
  deps.db.transaction((tx) => {
    const db = tx as unknown as Db
    for (const trackId of trackIds) {
      const track = db.select().from(tracks).where(eq(tracks.id, trackId)).get()
      const active = db
        .select({ id: contributions.id })
        .from(contributions)
        .where(
          and(
            eq(contributions.trackId, trackId),
            eq(contributions.active, true)
          )
        )
        .get()
      if (track?.state !== 'no_longer_wanted' || active) continue
      deleted.push(trackId)
      const file = db
        .select()
        .from(files)
        .where(eq(files.trackId, trackId))
        .get()
      const upload = db
        .select()
        .from(uploads)
        .where(eq(uploads.trackId, trackId))
        .get()
      if (where !== 'remote' && file) {
        db.insert(tombstones)
          .values({
            id: randomUUID(),
            trackId,
            kind: 'local',
            path: file.relativePath,
            reason: 'deleted',
            createdAt: at,
          })
          .run()
        if (file.lrcSha256)
          db.insert(tombstones)
            .values({
              id: randomUUID(),
              trackId,
              kind: 'local',
              path: sidecarPath(file.relativePath),
              reason: 'deleted',
              createdAt: at,
            })
            .run()
        db.delete(files).where(eq(files.trackId, trackId)).run()
      }
      if (where !== 'local' && upload) {
        if (upload.remotePath)
          db.insert(tombstones)
            .values({
              id: randomUUID(),
              trackId,
              kind: 'remote',
              path: upload.remotePath,
              remoteTarget: upload.remoteTarget,
              reason: 'deleted',
              createdAt: at,
            })
            .run()
        if (upload.lrcRemotePath)
          db.insert(tombstones)
            .values({
              id: randomUUID(),
              trackId,
              kind: 'remote',
              path: upload.lrcRemotePath,
              remoteTarget: upload.remoteTarget,
              reason: 'deleted',
              createdAt: at,
            })
            .run()
        db.delete(uploads).where(eq(uploads.trackId, trackId)).run()
      }
      const stillFile = db
        .select()
        .from(files)
        .where(eq(files.trackId, trackId))
        .get()
      const stillUpload = db
        .select()
        .from(uploads)
        .where(eq(uploads.trackId, trackId))
        .get()
      const hasTombstone = db
        .select()
        .from(tombstones)
        .where(eq(tombstones.trackId, trackId))
        .get()
      if (!stillFile && !stillUpload && !hasTombstone) {
        db.delete(trackArtists).where(eq(trackArtists.trackId, trackId)).run()
        db.delete(contributions)
          .where(
            and(
              eq(contributions.trackId, trackId),
              eq(contributions.active, false)
            )
          )
          .run()
        db.delete(tracks).where(eq(tracks.id, trackId)).run()
      } else {
        db.update(tracks)
          .set({ state: 'no_longer_wanted', updatedAt: at })
          .where(eq(tracks.id, trackId))
          .run()
      }
    }
  })
  return deleted
}
