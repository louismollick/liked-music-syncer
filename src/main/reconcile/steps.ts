import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { Settings } from '../../shared/ipc'
import type { AudioDownloader } from '../acquire/audio'
import { makeSquareCover } from '../acquire/cover'
import { fetchArtistPage } from '../artist-pages'
import type { CatalogRelease, YouTubeMusicCatalog } from '../catalog/types'
import type { ArtistCredit, StepKind } from '../domain'
import {
  copyToStaging,
  exists,
  onDiskRelative,
  PathTakenError,
  placeNoClobber,
  pruneEmptyDirs,
  replaceOwned,
  STAGING_DIR,
  sha256File,
} from '../inventory/files'
import { readableDirectory } from '../inventory/inventory'
import { pathKey, resolveCollision, sidecarPath } from '../inventory/layout'
import {
  artistIdFor,
  canonicalArtist,
  canonicalTrackNames,
  linkTrackArtists,
  releaseCredits,
} from '../library/artists'
import type { Db } from '../library/db'
import {
  artists,
  type ContributionRow,
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
  unmanagedFiles,
  uploads,
} from '../library/schema'
import { isInstrumentalTitle } from '../lyrics/query'
import type { LyricsFinder } from '../lyrics/types'
import {
  compareSpotifyCandidates,
  spotifyCandidateScore,
} from '../match/resolve'
import {
  type Match,
  type Matcher,
  type MatchInput,
  releaseIdentityKey,
} from '../match/types'
import type { HttpClient } from '../net/http'
import type { ToolPaths } from '../platform/tools'
import type { HashAlgo, Rclone, RemoteTarget } from '../remote/rclone'
import {
  BOTH_LIKED_SOURCE_ORIGIN,
  CATALOG_SOURCE_ORIGIN,
  changedTagParts,
  fieldDiff,
  readTags,
  SPOTIFY_LIKED_SOURCE_ORIGIN,
  sha256,
  type TagFields,
  writeTags,
  YOUTUBE_LIKED_SOURCE_ORIGIN,
} from '../tags/schema'
import {
  desiredPath,
  desiredSidecar,
  desiredTagFields,
  parseMatch,
} from './desired'
import {
  type CatalogRaw,
  checkArtistCatalog,
  type LikedRaw,
  type SpotifyLikedRaw,
} from './sources'

export type { StepKind } from '../domain'

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
  const youtube = rows.some((row) => row.kind === 'liked')
  const spotify = rows.some((row) => row.kind === 'spotify_liked')
  return youtube && spotify
    ? BOTH_LIKED_SOURCE_ORIGIN
    : youtube
      ? YOUTUBE_LIKED_SOURCE_ORIGIN
      : spotify
        ? SPOTIFY_LIKED_SOURCE_ORIGIN
        : CATALOG_SOURCE_ORIGIN
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
  const fields = desiredTagFields(
    track,
    coverShaFromPath(track.coverPath),
    origin
  )
  const sources = db
    .select()
    .from(contributions)
    .where(
      and(eq(contributions.trackId, track.id), eq(contributions.active, true))
    )
    .all()
  const youtube = sources.find((source) => source.kind === 'liked')
  const spotify = sources.find((source) => source.kind === 'spotify_liked')
  if (youtube) fields.lms.sourceVideoId = youtube.sourceVideoId
  if (spotify)
    fields.lms.spotifyTrackId = (
      JSON.parse(spotify.raw) as SpotifyLikedRaw
    ).track.trackId
  return fields
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
  if (!match || track.refreshRequested) return 'match'
  const names = canonicalTrackNames(db, track, match)
  if (!names) return null
  // A backfill page read may finish before its batch recomputes saved tag names.
  if (track.artist !== names.artist || track.albumArtist !== names.albumArtist)
    return null
  if (file?.outsideEdit) return null
  if (
    !file ||
    (match && file.audioVideoId && file.audioVideoId !== match.catalogVideoId)
  ) {
    return 'acquire'
  }
  if (settings.lyricsEnabled && track.lyricsCheckedAt === null) return 'lyrics'
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

type LyricsValues = Pick<
  TrackRow,
  | 'lyricsText'
  | 'lyricsStatus'
  | 'lyricsSource'
  | 'language'
  | 'spotifyTrackId'
  | 'lyricsCheckedAt'
>

function lyricsForRecording(track: TrackRow, match: Match): LyricsValues {
  const changed = parseMatch(track)?.catalogVideoId !== match.catalogVideoId
  return {
    lyricsText: changed ? null : track.lyricsText,
    lyricsStatus: changed ? 'none' : track.lyricsStatus,
    lyricsSource: changed ? null : track.lyricsSource,
    language: changed ? null : track.language,
    spotifyTrackId: changed ? null : track.spotifyTrackId,
    lyricsCheckedAt: changed ? null : track.lyricsCheckedAt,
  }
}

/** Compare with the current survivor, since matching may merge into another track. */
function betterLyrics(
  stored: LyricsValues,
  lookedUp: LyricsValues
): LyricsValues {
  const rank = (status: string) =>
    status === 'synced' ? 2 : status === 'plain' ? 1 : 0
  const selected =
    rank(stored.lyricsStatus) > rank(lookedUp.lyricsStatus) ? stored : lookedUp
  return {
    ...selected,
    spotifyTrackId: lookedUp.spotifyTrackId ?? stored.spotifyTrackId,
    lyricsCheckedAt: lookedUp.lyricsCheckedAt ?? stored.lyricsCheckedAt,
  }
}

/** Shared by matching and lyrics-only work; provider failures still complete the lookup. */
export async function lookUpLyrics(
  deps: StepDeps,
  track: TrackRow,
  match: Match,
  run: StepRun
) {
  const values = lyricsForRecording(track, match)
  const spotifyId = spotifyLikeId(deps.db, track.id)
  values.spotifyTrackId = spotifyId ?? values.spotifyTrackId
  const errors: Record<string, string> = {}
  const settings = deps.settings()
  if (!settings.lyricsEnabled) return { values, errors }
  try {
    if (!isInstrumentalTitle(match.title)) {
      const original = match.artists.map((credit) => credit.name).join(', ')
      const pages = match.artists.map((credit) =>
        canonicalArtist(deps.db, artistIdFor(credit))
      )
      const canonical = match.artists
        .map((credit, index) => {
          const row = pages[index]
          return row?.name ?? credit.name
        })
        .join(', ')
      const native = match.artists
        .map((credit, index) => {
          const row = pages[index]
          return row?.nativeName ?? row?.name ?? credit.name
        })
        .join(', ')
      const found = await deps.lyrics.find(
        {
          title: match.title,
          artists: match.artists,
          artistVariants: [...new Set([canonical, original, native])],
          album: match.release?.title ?? null,
          durationSeconds:
            parseMatch(track)?.catalogVideoId === match.catalogVideoId
              ? (track.durationSeconds ?? match.durationSeconds)
              : match.durationSeconds,
          lyricsBrowseId: match.lyricsBrowseId,
          spotifyTrackId: values.spotifyTrackId,
          spotifyLiked: spotifyId !== null,
        },
        { lyricsServerUrl: settings.lyricsServerUrl.trim() || null },
        run.signal
      )
      Object.assign(
        errors,
        Object.fromEntries(
          Object.entries(found.errors).map(([key, value]) => [
            `lyrics:${key}`,
            value,
          ])
        )
      )
      values.spotifyTrackId =
        spotifyId ?? found.spotifyTrackId ?? values.spotifyTrackId
      if (found.lyrics) {
        Object.assign(
          values,
          betterLyrics(values, {
            ...values,
            lyricsText: found.lyrics.text,
            lyricsStatus: found.lyrics.synced ? 'synced' : 'plain',
            lyricsSource: found.lyrics.source,
            language: found.lyrics.language,
          })
        )
      }
    }
  } catch (error) {
    if (run.signal.aborted) throw error
    errors['lyrics:lookup'] =
      error instanceof Error ? error.message : String(error)
  }
  values.lyricsCheckedAt = iso(deps)
  return { values, errors }
}

export async function runLyrics(
  deps: StepDeps,
  track: TrackRow,
  run: StepRun
): Promise<void> {
  const match = parseMatch(track)
  if (!match) return
  const lookup = await lookUpLyrics(deps, track, match, run)
  run.signal.throwIfAborted()
  const current = deps.db
    .select()
    .from(tracks)
    .where(eq(tracks.id, track.id))
    .get()
  if (
    !current ||
    current.state === 'released' ||
    current.state === 'no_longer_wanted' ||
    current.match !== track.match
  )
    return
  const errors = JSON.parse(current.enrichmentErrors) as Record<string, string>
  for (const key of Object.keys(errors))
    if (key.startsWith('lyrics:')) delete errors[key]
  Object.assign(errors, lookup.errors)
  deps.db
    .update(tracks)
    .set({
      ...betterLyrics(lyricsForRecording(current, match), lookup.values),
      enrichmentErrors: JSON.stringify(errors),
      updatedAt: iso(deps),
    })
    .where(eq(tracks.id, track.id))
    .run()
  run.progress(1)
}

// ---------------------------------------------------------------- match

const RELEASE_CACHE_MS = 10 * 60_000
const releaseCache = new Map<
  string,
  { at: number; release: Promise<CatalogRelease> }
>()

/** User-requested Refresh must look up releases again, even inside the cache window. */
export function invalidateReleaseCache(): void {
  releaseCache.clear()
}

/** Release pages are shared by every track of a catalog; cache them briefly. */
async function releaseWithTracks(
  catalog: YouTubeMusicCatalog,
  browseId: string,
  signal: AbortSignal,
  expectedVideoId: string
): Promise<CatalogRelease> {
  const cached = releaseCache.get(browseId)
  if (cached && Date.now() - cached.at < RELEASE_CACHE_MS) {
    const release = await cached.release
    if (release.tracks.some((track) => track.videoId === expectedVideoId))
      return release
  }
  const release = catalog.release(browseId, signal)
  releaseCache.set(browseId, { at: Date.now(), release })
  release.catch(() => releaseCache.delete(browseId))
  return release
}

/**
 * The contribution a Match is looked up from. An active catalog contribution
 * names its exact Release Track, so it wins over a like; otherwise an active
 * like, and only then inactive ones.
 */
function matchSource(db: Db, trackId: string): ContributionRow | undefined {
  const rows = db
    .select()
    .from(contributions)
    .where(eq(contributions.trackId, trackId))
    .all()
  for (const active of [true, false])
    for (const kind of ['catalog', 'liked', 'spotify_liked']) {
      const found = rows.find(
        (row) => row.active === active && row.kind === kind
      )
      if (found) return found
    }
  return undefined
}

/** A liked Spotify ID is stronger evidence than a lyrics-search guess. */
function spotifyLikeId(db: Db, trackId: string): string | null {
  const row = db
    .select()
    .from(contributions)
    .where(
      and(
        eq(contributions.trackId, trackId),
        eq(contributions.kind, 'spotify_liked'),
        eq(contributions.active, true)
      )
    )
    .get()
  return row ? (JSON.parse(row.raw) as SpotifyLikedRaw).track.trackId : null
}

function existingSpotifyMatch(
  db: Db,
  input: Extract<MatchInput, { kind: 'spotify' }>,
  currentId: string
): Match | null {
  const nativeNames = new Map(
    db
      .select({ channel: artists.channelId, native: artists.nativeName })
      .from(artists)
      .all()
      .flatMap((artist) =>
        artist.channel ? [[artist.channel, artist.native] as const] : []
      )
  )
  const existing = db
    .select()
    .from(tracks)
    .where(
      and(
        ne(tracks.id, currentId),
        or(
          eq(tracks.spotifyTrackId, input.track.trackId),
          sql`EXISTS (SELECT 1 FROM contributions c WHERE c.track_id = ${tracks.id} AND c.kind IN ('liked', 'spotify_liked') AND c.active = 1)`
        )
      )
    )
    .all()
  const score = (relaxed: boolean) =>
    existing.flatMap((track) => {
      const match = parseMatch(track)
      if (!match?.release || track.state === 'released' || !match.confirmed)
        return []
      const scores = spotifyCandidateScore(
        input.track,
        {
          ...match,
          durationSeconds: track.durationSeconds ?? match.durationSeconds,
        },
        relaxed ? { nativeNames } : undefined
      )
      return scores ? [{ match, ...scores }] : []
    })
  let candidates = score(false)
  if (!candidates.length) candidates = score(true)
  candidates.sort(compareSpotifyCandidates)
  return candidates[0]?.match ?? null
}

/** Likes join a known Recording; catalog inputs keep their exact Release Track. */
function recordingTarget(
  db: Db,
  current: TrackRow,
  match: Match
): TrackRow | undefined {
  if (catalogIdentities(db, current.id).length) return undefined
  const candidates = db
    .select()
    .from(tracks)
    .where(
      and(
        ne(tracks.id, current.id),
        ne(tracks.state, 'released'),
        sql`json_extract(${tracks.match}, '$.catalogVideoId') = ${match.catalogVideoId}`,
        sql`json_extract(${tracks.match}, '$.confirmed') = 1`
      )
    )
    .all()
  return (
    candidates.find((track) => track.identityKey === match.identityKey) ??
    candidates[0]
  )
}

/** What the match of a track depends on; a change while matching makes the result stale. */
function matchSources(db: Db, trackId: string): string {
  const active = db
    .select({ id: contributions.id, key: contributions.sourceKey })
    .from(contributions)
    .where(
      and(eq(contributions.trackId, trackId), eq(contributions.active, true))
    )
    .all()
    .map((row) => `${row.id}:${row.key}`)
    .sort()
  return JSON.stringify({
    source: matchSource(db, trackId)?.id ?? null,
    active,
  })
}

/** Release Track identities that the track's active catalog contributions require. */
function catalogIdentities(db: Db, trackId: string): string[] {
  return db
    .select({
      releaseId: contributions.releaseId,
      videoId: contributions.sourceVideoId,
    })
    .from(contributions)
    .where(
      and(
        eq(contributions.trackId, trackId),
        eq(contributions.kind, 'catalog'),
        eq(contributions.active, true)
      )
    )
    .all()
    .map((row) => releaseIdentityKey(row.releaseId ?? '', row.videoId ?? ''))
}

function matchInputFor(db: Db, track: TrackRow): MatchInput | null {
  const chosen = matchSource(db, track.id)
  if (chosen) {
    const raw = JSON.parse(chosen.raw) as
      | LikedRaw
      | CatalogRaw
      | SpotifyLikedRaw
    if (raw.kind === 'spotify_liked')
      return { kind: 'spotify', track: raw.track }
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
      videoId: match.sourceVideoId ?? match.catalogVideoId,
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

export { linkTrackArtists } from '../library/artists'

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

/**
 * The user deleted a merge survivor: its pending merge cleanup becomes part of
 * that delete for the chosen scope, and is cancelled for the other.
 */
function mergeCleanupIntoDelete(
  db: Db,
  trackId: string,
  where: 'local' | 'remote' | 'both'
): void {
  for (const kind of ['local', 'remote'] as const) {
    const chosen = where === 'both' || where === kind
    if (!chosen) continue
    db.update(tombstones)
      .set({ trackId, replacementTrackId: null, reason: 'deleted' })
      .where(
        and(
          eq(tombstones.replacementTrackId, trackId),
          eq(tombstones.kind, kind),
          isNull(tombstones.doneAt)
        )
      )
      .run()
  }
  if (where !== 'both')
    cancelMergeCleanup(db, trackId, where === 'local' ? 'remote' : 'local')
}

/** What a merge knows about one track's file, checked before its transaction. */
interface FileCheck {
  row: FileRow
  /** The audio file is on disk. */
  exists: boolean
  size: number
  mtimeMs: number
  /** On disk with the recorded bytes and no Outside Edit. */
  valid: boolean
}

async function inspectFile(
  root: string,
  file: FileRow | undefined
): Promise<FileCheck | undefined> {
  if (!file) return undefined
  const absolute = path.join(root, file.relativePath)
  try {
    const info = await stat(absolute)
    const valid =
      info.isFile() &&
      !file.outsideEdit &&
      info.size === file.size &&
      (await sha256File(absolute)) === file.contentSha256
    return {
      row: file,
      exists: true,
      size: info.size,
      mtimeMs: info.mtimeMs,
      valid,
    }
  } catch {
    return { row: file, exists: false, size: 0, mtimeMs: 0, valid: false }
  }
}

/**
 * Moves `from`'s contributions into `into` and deletes `from`. Of the two
 * files, the survivor keeps a valid one holding the matched video, else any
 * valid one until a download replaces it. A displaced healthy copy is deleted
 * only once the survivor's replacement is in place (see processTombstones);
 * a damaged one is kept on disk as a released Unmanaged File.
 */
function mergeTracks(
  db: Db,
  from: TrackRow,
  into: TrackRow,
  at: string,
  checks: { from?: FileCheck; into?: FileCheck },
  catalogVideoId: string
): void {
  db.update(contributions)
    .set({ trackId: into.id })
    .where(eq(contributions.trackId, from.id))
    .run()
  const holds = (check?: FileCheck) =>
    Boolean(check?.valid && check.row.audioVideoId === catalogVideoId)
  const kept = holds(checks.into)
    ? checks.into
    : holds(checks.from)
      ? checks.from
      : checks.into?.valid
        ? checks.into
        : checks.from?.valid
          ? checks.from
          : undefined
  const upload = (trackId: string) =>
    db.select().from(uploads).where(eq(uploads.trackId, trackId)).get()
  const fromUpload = upload(from.id)
  const intoUpload = upload(into.id)
  // The upload record describes the kept file's remote copy, so it moves with it.
  const keptUpload = !kept
    ? undefined
    : kept === checks.from
      ? fromUpload
      : intoUpload
  for (const check of [checks.from, checks.into]) {
    if (!check || check === kept) continue
    displaceFile(db, check, into.id, at)
  }
  if (kept && kept === checks.from) {
    db.update(files)
      .set({ trackId: into.id })
      .where(eq(files.trackId, from.id))
      .run()
  }
  for (const record of [fromUpload, intoUpload]) {
    if (!record || record === keptUpload) continue
    for (const remotePath of [record.remotePath, record.lrcRemotePath]) {
      if (!remotePath) continue
      db.insert(tombstones)
        .values({
          id: randomUUID(),
          trackId: null,
          kind: 'remote',
          path: remotePath,
          remoteTarget: record.remoteTarget,
          reason: 'merged',
          createdAt: at,
          replacementTrackId: into.id,
        })
        .run()
    }
    db.delete(uploads).where(eq(uploads.trackId, record.trackId)).run()
  }
  if (keptUpload && keptUpload.trackId !== into.id)
    db.update(uploads)
      .set({ trackId: into.id })
      .where(eq(uploads.trackId, keptUpload.trackId))
      .run()
  // Cleanup that waited for `from` now waits for the survivor.
  db.update(tombstones)
    .set({ replacementTrackId: into.id })
    .where(eq(tombstones.replacementTrackId, from.id))
    .run()
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

/** Drops a merged track's file record and decides what happens to the file on disk. */
function displaceFile(
  db: Db,
  check: FileCheck,
  survivorId: string,
  at: string
): void {
  const file = check.row
  db.delete(files).where(eq(files.trackId, file.trackId)).run()
  if (check.exists && !check.valid) {
    // Damaged or edited outside the app: never delete it, never adopt it again.
    releaseToUnmanaged(db, file.relativePath, check.size, check.mtimeMs, at)
    if (file.lrcSha256)
      deferLocalRelease(db, sidecarPath(file.relativePath), at)
    return
  }
  const cleanup = (relative: string, expectedSha256: string) =>
    db
      .insert(tombstones)
      .values({
        id: randomUUID(),
        trackId: null,
        kind: 'local',
        path: relative,
        reason: 'merged',
        createdAt: at,
        replacementTrackId: survivorId,
        expectedSha256,
      })
      .run()
  if (check.exists) cleanup(file.relativePath, file.contentSha256)
  if (file.lrcSha256) cleanup(sidecarPath(file.relativePath), file.lrcSha256)
}

export function releaseToUnmanaged(
  db: Db,
  relativePath: string,
  size: number,
  mtimeMs: number,
  at: string
): void {
  db.insert(unmanagedFiles)
    .values({ relativePath, size, mtimeMs, seenAt: at, released: true })
    .onConflictDoUpdate({
      target: unmanagedFiles.relativePath,
      set: { size, mtimeMs, seenAt: at, released: true },
    })
    .run()
}

/** Keeps a local path as a released Unmanaged File once the tombstone loop can look at it. */
function deferLocalRelease(db: Db, relativePath: string, at: string): void {
  db.insert(tombstones)
    .values({
      id: randomUUID(),
      trackId: null,
      kind: 'local',
      path: relativePath,
      reason: RELEASE_REASON,
      createdAt: at,
    })
    .run()
}

/** Tombstone reason for a path to keep as Unmanaged instead of deleting. */
const RELEASE_REASON = 'release'

/**
 * Cancels merge cleanup that waits for `trackId` (Stop managing, or the part of
 * a delete the user did not choose): local copies are kept as Unmanaged Files
 * and remote copies are left alone.
 */
export function cancelMergeCleanup(
  db: Db,
  trackId: string,
  scope: 'local' | 'remote' | 'both'
): void {
  if (scope !== 'remote')
    db.update(tombstones)
      .set({ replacementTrackId: null, reason: RELEASE_REASON })
      .where(
        and(
          eq(tombstones.replacementTrackId, trackId),
          eq(tombstones.kind, 'local'),
          isNull(tombstones.doneAt)
        )
      )
      .run()
  if (scope !== 'local')
    db.delete(tombstones)
      .where(
        and(
          eq(tombstones.replacementTrackId, trackId),
          eq(tombstones.kind, 'remote'),
          isNull(tombstones.doneAt)
        )
      )
      .run()
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

/** A Managed File changed outside the app; the track pauses instead of overwriting it. */
export class OutsideEditError extends Error {
  readonly kind = 'permanent' as const
  constructor(readonly parts: string[]) {
    super(`Changed outside the app (${parts.join(', ')})`)
    this.name = 'OutsideEditError'
  }
}

/** Sentinel for "the user asked to rewrite this file": replace it even though it changed. */
export const REWRITE_AUDIO = 'rewrite'

/**
 * Checks a Managed File still matches its record before the app writes over,
 * moves, or uploads it. On a mismatch it records an Outside Edit and throws.
 */
export async function assertUnchanged(
  deps: StepDeps,
  root: string,
  file: FileRow
): Promise<void> {
  const absolute = path.join(root, file.relativePath)
  const parts: string[] = []
  try {
    const info = await stat(absolute)
    if (
      info.size !== file.size ||
      (await sha256File(absolute)) !== file.contentSha256
    ) {
      try {
        parts.push(
          ...changedTagParts(readTags(absolute).fields, parseFields(file))
        )
      } catch {
        // Unreadable tags: report it as an audio change below.
      }
      if (parts.length === 0) parts.push('audio')
    }
  } catch {
    parts.push('deleted')
  }
  if (file.lrcSha256) {
    const lrc = path.join(root, sidecarPath(file.relativePath))
    const digest = (await exists(lrc)) ? sha256(await readFile(lrc)) : null
    if (digest !== file.lrcSha256) parts.push('sidecar')
  }
  if (parts.length === 0) return
  deps.db
    .update(files)
    .set({ outsideEdit: JSON.stringify(parts) })
    .where(eq(files.trackId, file.trackId))
    .run()
  throw new OutsideEditError(parts)
}

export interface MatchOutcome {
  /** Track that now carries the work (may differ from the input after a merge). */
  trackId: string
}

/**
 * The step can't run yet for a reason that isn't a failure (a delete still in
 * progress, sources still changing). The track waits without using retries.
 */
export class RetryLaterError extends Error {
  readonly kind = 'transient' as const
  constructor(
    message: string,
    readonly delayMs = 60_000
  ) {
    super(message)
    this.name = 'RetryLaterError'
  }
}

/** Sources changed while the lookup ran; re-running it is not a failure. */
const STALE = Symbol('stale match')
const STALE_RETRIES = 5

export async function runMatch(
  deps: StepDeps,
  track: TrackRow,
  run: StepRun
): Promise<MatchOutcome> {
  let current = track
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await matchOnce(deps, current, run)
    if (outcome !== STALE) return outcome
    const reloaded = deps.db
      .select()
      .from(tracks)
      .where(eq(tracks.id, current.id))
      .get()
    if (!reloaded) return { trackId: current.id }
    if (attempt + 1 >= STALE_RETRIES)
      throw new RetryLaterError(
        'Its sources kept changing while matching; will try again'
      )
    current = reloaded
  }
}

async function matchOnce(
  deps: StepDeps,
  track: TrackRow,
  run: StepRun
): Promise<MatchOutcome | typeof STALE> {
  const sourcesBefore = matchSources(deps.db, track.id)
  const sourceId = matchSource(deps.db, track.id)?.id ?? null
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
        run.signal,
        input.track.videoId
      ),
    }
  }
  const settings = deps.settings()
  let match =
    input.kind === 'spotify'
      ? existingSpotifyMatch(deps.db, input, track.id)
      : null
  match ??= await deps.matcher.match(input, run.signal)
  const recording =
    input.kind === 'catalog'
      ? undefined
      : recordingTarget(deps.db, track, match)
  if (recording && recording.identityKey !== match.identityKey)
    match = parseMatch(recording)!

  try {
    for (const credit of [...match.artists, ...releaseCredits(match)])
      await fetchArtistPage(deps.db, deps.catalog, credit, run.signal, deps.now)
  } catch (error) {
    if (run.signal.aborted) throw error
    throw new RetryLaterError(
      `Waiting for artist pages: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const conflictingArtists = deps.db
    .select({
      artistId: contributions.artistId,
      releaseId: contributions.releaseId,
      videoId: contributions.sourceVideoId,
    })
    .from(contributions)
    .where(
      and(
        eq(contributions.trackId, track.id),
        eq(contributions.kind, 'catalog'),
        eq(contributions.active, true)
      )
    )
    .all()
    .filter(
      (source) =>
        releaseIdentityKey(source.releaseId ?? '', source.videoId ?? '') !==
        match.identityKey
    )
    .map((source) => source.artistId)
  let refreshed = false
  for (const artistId of new Set(conflictingArtists)) {
    if (!artistId) continue
    const artist = deps.db
      .select()
      .from(artists)
      .where(eq(artists.id, artistId))
      .get()
    if (!artist?.fullDiscography || !artist.channelId) continue
    // Every catalog source must agree before a shared release can change identity.
    try {
      await checkArtistCatalog({
        db: deps.db,
        catalog: deps.catalog,
        artistId: artist.id,
        channelId: artist.channelId,
        now: deps.now,
        signal: run.signal,
      })
    } catch (error) {
      if (run.signal.aborted) throw error
      throw new RetryLaterError(
        `Waiting for ${artist.name}'s catalog: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    refreshed = true
  }
  if (refreshed) return STALE
  run.progress(0.4)
  const errors: Record<string, string> = {}
  // A provider outage must never strip what the track already has.
  let enrichment = {
    mbRecordingId: (recording ?? track).mbRecordingId,
    genre: (recording ?? track).genre,
    isrc: (recording ?? track).isrc,
  }
  try {
    enrichment = await deps.matcher.enrich(match, run.signal)
  } catch (error) {
    if (run.signal.aborted) throw error
    errors.musicbrainz = error instanceof Error ? error.message : String(error)
  }
  run.progress(0.6)
  const lyrics = await lookUpLyrics(
    deps,
    recording ? { ...recording, id: track.id } : track,
    match,
    run
  )
  Object.assign(errors, lyrics.errors)
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
  const fileOf = (trackId: string) =>
    deps.db.select().from(files).where(eq(files.trackId, trackId)).get()
  const root = libraryRoot(settings)
  const checks = {
    from: await inspectFile(root, fileOf(track.id)),
    into: candidate ? await inspectFile(root, fileOf(candidate.id)) : undefined,
  }
  run.signal.throwIfAborted()
  const status = deps.db.transaction((tx): MatchCommit => {
    const db = tx as unknown as Db
    const current = db
      .select()
      .from(tracks)
      .where(eq(tracks.id, track.id))
      .get()
    // Deleted, or the user stopped managing it while the lookup ran.
    // No Longer Wanted meanwhile: nothing may merge or move its file until
    // the user decides.
    if (
      !current ||
      current.state === 'released' ||
      current.state === 'no_longer_wanted'
    )
      return 'cancelled'
    if (matchSources(db, current.id) !== sourcesBefore) return 'stale'
    if (
      recording &&
      db.select().from(tracks).where(eq(tracks.id, recording.id)).get()
        ?.match !== recording.match
    )
      return 'stale'
    const artistCredits = JSON.stringify(match.artists)
    const names = canonicalTrackNames(db, { ...current, artistCredits }, match)
    if (!names) throw new RetryLaterError('Waiting for artist pages')
    const previousIdentityKey = current.identityKey
    let target = db
      .select()
      .from(tracks)
      .where(eq(tracks.identityKey, match.identityKey))
      .get()
    if (target?.id === current.id) target = undefined
    // A catalog contribution only ever belongs to its own Release Track.
    const required = [
      ...catalogIdentities(db, current.id),
      ...(target ? catalogIdentities(db, target.id) : []),
    ]
    if (required.some((key) => key !== match.identityKey)) return 'stale'
    if (target?.state === 'released') {
      // The user stopped managing this Release Track: record that this source
      // wants it too, without reviving the file or merging into it.
      if (sourceId)
        db.update(contributions)
          .set({ trackId: target.id })
          .where(eq(contributions.id, sourceId))
          .run()
      settleEmptiedTrack(db, current.id, at)
      return 'excluded'
    }
    if (
      target?.state === 'no_longer_wanted' &&
      db
        .select({ id: tombstones.id })
        .from(tombstones)
        .where(
          and(eq(tombstones.trackId, target.id), isNull(tombstones.doneAt))
        )
        .get()
    )
      return 'waiting'
    if (target && target.id !== current.id) {
      // The files were checked before this transaction; merge only what was checked.
      const unchanged = (trackId: string, check?: FileCheck) => {
        const row = db
          .select()
          .from(files)
          .where(eq(files.trackId, trackId))
          .get()
        return (
          (row?.contentSha256 ?? null) === (check?.row.contentSha256 ?? null)
        )
      }
      if (
        target.id !== candidate?.id ||
        !unchanged(current.id, checks.from) ||
        !unchanged(target.id, checks.into)
      )
        return 'stale'
      mergeTracks(db, current, target, at, checks, match.catalogVideoId)
      survivor = target.id
    }
    lyrics.values.spotifyTrackId =
      spotifyLikeId(db, survivor) ?? lyrics.values.spotifyTrackId
    const release = match.release
    db.update(tracks)
      .set({
        identityKey: match.identityKey,
        adopted: false,
        title: match.title,
        artistCredits,
        artist: names.artist,
        album: match.album,
        albumArtist: names.albumArtist,
        releaseId: release?.browseId ?? null,
        releaseKind: release?.kind ?? null,
        trackNumber: release?.trackNumber ?? null,
        trackTotal: release?.trackTotal ?? null,
        discNumber: release?.discNumber ?? null,
        discTotal: release?.discTotal ?? null,
        date: release?.date ?? null,
        year: release?.year ?? null,
        durationSeconds:
          parseMatch(target ?? current)?.catalogVideoId === match.catalogVideoId
            ? ((target ?? current).durationSeconds ?? match.durationSeconds)
            : match.durationSeconds,
        genre: enrichment.genre,
        isrc: enrichment.isrc,
        mbRecordingId: enrichment.mbRecordingId,
        ...betterLyrics(
          lyricsForRecording(target ?? current, match),
          lyrics.values
        ),
        coverUrl: match.coverUrl,
        coverPath,
        match: JSON.stringify({ ...match, confirmed: true } satisfies Match),
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
    return 'committed'
  })
  if (status === 'stale') return STALE
  if (status === 'waiting')
    throw new RetryLaterError(
      'Waiting for an earlier delete of this song to finish'
    )
  return { trackId: survivor }
}

type MatchCommit = 'committed' | 'stale' | 'cancelled' | 'excluded' | 'waiting'

/**
 * After its source moved to another track: a track left with no contribution,
 * file or upload is removed; one still holding files becomes No Longer Wanted.
 */
function settleEmptiedTrack(db: Db, trackId: string, at: string): void {
  const hasActive = db
    .select({ id: contributions.id })
    .from(contributions)
    .where(
      and(eq(contributions.trackId, trackId), eq(contributions.active, true))
    )
    .get()
  if (hasActive) return
  const keep =
    db
      .select({ id: contributions.id })
      .from(contributions)
      .where(eq(contributions.trackId, trackId))
      .get() ||
    db
      .select({ id: files.trackId })
      .from(files)
      .where(eq(files.trackId, trackId))
      .get() ||
    db
      .select({ id: uploads.trackId })
      .from(uploads)
      .where(eq(uploads.trackId, trackId))
      .get()
  if (keep) {
    db.update(tracks)
      .set({ state: 'no_longer_wanted', updatedAt: at })
      .where(eq(tracks.id, trackId))
      .run()
    return
  }
  cancelMergeCleanup(db, trackId, 'both')
  db.delete(trackArtists).where(eq(trackArtists.trackId, trackId)).run()
  db.delete(tracks).where(eq(tracks.id, trackId)).run()
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
  let keepPath =
    previous &&
    previous.relativePath === desiredPath(track) &&
    !(await taken(previous.relativePath))
      ? previous.relativePath
      : null
  let target = keepPath ?? (await chooseFreePath(deps.db, root, track))
  if (
    !keepPath &&
    previous &&
    pathKey(target) === pathKey(previous.relativePath)
  ) {
    // Same file under a different case or suffix: replace it where it is.
    keepPath = previous.relativePath
    target = previous.relativePath
  }
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
  target = await onDiskRelative(root, target)
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
    const state = db
      .select({ state: tracks.state })
      .from(tracks)
      .where(eq(tracks.id, track.id))
      .get()?.state
    if (state === 'released') {
      // Stopped managing while the file was written: keep it, as Unmanaged.
      releaseToUnmanaged(
        db,
        placed.relativePath,
        placed.size,
        placed.mtimeMs,
        at
      )
      if (placed.lrcSha256)
        deferLocalRelease(db, sidecarPath(placed.relativePath), at)
      clearJournal(db, track.id, step)
      return
    }
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
  const existing = deps.db
    .select()
    .from(files)
    .where(eq(files.trackId, track.id))
    .get()
  if (existing && existing.audioVideoId !== REWRITE_AUDIO)
    await assertUnchanged(deps, root, existing)
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
  await assertUnchanged(deps, root, file)
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
  await assertUnchanged(deps, root, file)
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
  target = await onDiskRelative(root, target)
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

/** Drop records for remote objects removed or resized outside the app. */
export async function auditRemote(deps: StepDeps): Promise<string[]> {
  const target = remoteTarget(deps.settings())
  if (!target) return []
  const listing = await deps.rclone.list(target, {})
  const key = targetKey(target)
  const recorded =
    deps.db
      .select({ n: sql<number>`count(*)` })
      .from(uploads)
      .where(eq(uploads.remoteTarget, key))
      .get()?.n ?? 0
  // An empty listing while uploads are recorded usually means the remote folder is
  // briefly unavailable, not that every file was deleted.
  if (listing.size === 0 && recorded >= 3) return []
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
  run: StepRun
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
  await assertUnchanged(deps, root, file)
  const recorded = deps.db
    .select()
    .from(uploads)
    .where(eq(uploads.trackId, track.id))
    .get()
  // A record for another remote target is not an upload to this one.
  const existing =
    recorded?.remoteTarget === targetKey(target) ? recorded : undefined
  const local = path.join(root, file.relativePath)
  const at = iso(deps)

  let audio: {
    size: number
    modTime: string
    hashAlgo: HashAlgo | null
    hash: string | null
  } | null = null
  let movedSidecar = false
  // Another track may have been uploaded to our old path since; leave it
  // alone. Case-insensitive, because some remotes (and APFS) are.
  const othersPaths = new Set(
    deps.db
      .select({ path: uploads.remotePath, lrc: uploads.lrcRemotePath })
      .from(uploads)
      .where(
        and(
          eq(uploads.remoteTarget, targetKey(target)),
          sql`${uploads.trackId} != ${track.id}`
        )
      )
      .all()
      .flatMap((row) => [row.path, row.lrc])
      .flatMap((value) => (value ? [pathKey(value)] : []))
  )
  const ownedByOther = (remotePath: string) =>
    othersPaths.has(pathKey(remotePath))
  // A spelling-only change is the same object on case-insensitive remotes:
  // never move or delete it (on a case-sensitive remote the old spelling is
  // merely left behind).
  const oldAudio =
    existing?.remotePath &&
    pathKey(existing.remotePath) !== pathKey(file.relativePath) &&
    !ownedByOther(existing.remotePath)
      ? existing.remotePath
      : null
  const oldSidecar =
    existing?.lrcRemotePath && !ownedByOther(existing.lrcRemotePath)
      ? existing.lrcRemotePath
      : null
  // Moved locally: move the remote copy instead of uploading again.
  if (existing && oldAudio && existing.localSha256 === file.contentSha256) {
    await deps.rclone
      .move(target, oldAudio, file.relativePath, run.signal)
      .catch(() => undefined)
    if (oldSidecar && file.lrcSha256 && existing.lrcHash === file.lrcSha256) {
      movedSidecar = await deps.rclone
        .move(target, oldSidecar, sidecarPath(file.relativePath), run.signal)
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
    // No upload record (fresh database or adoption): accept an identical
    // remote copy. Only this one object is hashed (ADR 0005).
    audio = await deps.rclone.verify(
      target,
      local,
      file.relativePath,
      run.signal
    )
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
  }
  // The old sidecar is gone or lives at a path we no longer use.
  if (
    oldSidecar &&
    !movedSidecar &&
    pathKey(oldSidecar) !== pathKey(lrcRemotePath ?? '')
  ) {
    await deps.rclone.delete(target, oldSidecar, run.signal)
  }
  if (oldAudio) {
    await deps.rclone
      .delete(target, oldAudio, run.signal)
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
    const state = db
      .select({ state: tracks.state })
      .from(tracks)
      .where(eq(tracks.id, track.id))
      .get()?.state
    // Stopped managing meanwhile: the app no longer tracks its remote copy.
    if (state === 'released') return
    if (db.select().from(uploads).where(eq(uploads.trackId, track.id)).get()) {
      db.update(uploads).set(row).where(eq(uploads.trackId, track.id)).run()
    } else {
      db.insert(uploads).values(row).run()
    }
  })
  run.progress(1)
}

/**
 * A merge survivor's replacement is in place locally when its file holds the
 * video its saved Match chose, with the recorded bytes and no Outside Edit.
 * `uploadedTo` names the remote target where that exact file is uploaded.
 */
async function replacementState(
  deps: StepDeps,
  trackId: string,
  rootReadable: boolean
): Promise<{ local: boolean; uploadedTo: string | null }> {
  const none = { local: false, uploadedTo: null }
  const track = deps.db
    .select()
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .get()
  const file = deps.db
    .select()
    .from(files)
    .where(eq(files.trackId, trackId))
    .get()
  const match = track ? parseMatch(track) : null
  if (!rootReadable || !track || !file || !match || file.outsideEdit)
    return none
  if (file.audioVideoId !== match.catalogVideoId) return none
  if (!(await validFile(deps.settings().libraryFolder, file))) return none
  const upload = deps.db
    .select()
    .from(uploads)
    .where(eq(uploads.trackId, trackId))
    .get()
  const uploaded =
    upload &&
    upload.localSha256 === file.contentSha256 &&
    upload.remotePath === file.relativePath &&
    (upload.lrcHash ?? null) === (file.lrcSha256 ?? null)
  return { local: true, uploadedTo: uploaded ? upload.remoteTarget : null }
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
  const rootReadable =
    Boolean(settings.libraryFolder) &&
    (await readableDirectory(settings.libraryFolder))
  // Case-insensitive, like the volume: `NE-YO/x.m4a` and `Ne-Yo/x.m4a` are one file.
  const ownedLocal = new Set(
    deps.db
      .select({ path: files.relativePath })
      .from(files)
      .all()
      .map((file) => pathKey(file.path))
  )
  // Whether a merge survivor's replacement is really in place: facts, not track state.
  const replacements = new Map<
    string,
    Promise<{ local: boolean; uploadedTo: string | null }>
  >()
  const replacement = (trackId: string) => {
    let known = replacements.get(trackId)
    if (!known) {
      known = replacementState(deps, trackId, rootReadable)
      replacements.set(trackId, known)
    }
    return known
  }
  const verified = new Map<string, Promise<boolean>>()
  const remoteReplacement = (trackId: string, remote: RemoteTarget) => {
    let known = verified.get(trackId)
    if (!known) {
      const file = deps.db
        .select()
        .from(files)
        .where(eq(files.trackId, trackId))
        .get()
      const check = (relative: string) =>
        deps.rclone
          .verify(
            remote,
            path.join(settings.libraryFolder, relative),
            relative,
            signal
          )
          .then(Boolean)
      known = file
        ? check(file.relativePath).then(
            async (audio) =>
              audio &&
              (!file.lrcSha256 || (await check(sidecarPath(file.relativePath))))
          )
        : Promise.resolve(false)
      verified.set(trackId, known)
    }
    return known
  }
  for (const row of pending) {
    if (signal.aborted) return
    // One failing tombstone (e.g. an unreachable remote) must not block the rest.
    try {
      if (row.replacementTrackId) {
        const ready = await replacement(row.replacementTrackId)
        if (!ready.local) continue
        // Remote copies go only once the replacement is on that same, enabled
        // remote, checked on the remote itself rather than from the record.
        if (
          row.kind === 'remote' &&
          (!target ||
            targetKey(target) !== row.remoteTarget ||
            ready.uploadedTo !== row.remoteTarget ||
            !(await remoteReplacement(row.replacementTrackId, target)))
        )
          continue
      }
      if (row.kind === 'local') {
        // An unmounted folder would make the delete a silent no-op; try again later.
        if (!rootReadable) continue
        const absolute = path.join(settings.libraryFolder, row.path)
        // Never delete a path another track now owns.
        const audioPath = row.path.replace(/\.lrc$/i, '.m4a')
        if (!ownedLocal.has(pathKey(audioPath))) {
          const info = await stat(absolute).catch(() => null)
          const keep =
            info &&
            (row.reason === RELEASE_REASON ||
              (row.expectedSha256 !== null &&
                (await sha256File(absolute)) !== row.expectedSha256))
          if (keep) {
            // Not the bytes the app meant to delete: keep them, as Unmanaged.
            releaseToUnmanaged(
              deps.db,
              row.path,
              info.size,
              info.mtimeMs,
              iso(deps)
            )
          } else if (info) {
            await rm(absolute, { force: true })
            await pruneEmptyDirs(settings.libraryFolder, path.dirname(absolute))
          }
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
    } catch (error) {
      if (signal.aborted) return
      console.warn(
        `[tombstones] ${row.kind} delete of ${row.path} failed; will retry`,
        error
      )
    }
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
    // Liked again since the delete: the track is wanted, keep it.
    const track = deps.db
      .select({ state: tracks.state })
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .get()
    const wanted = deps.db
      .select({ id: contributions.id })
      .from(contributions)
      .where(
        and(eq(contributions.trackId, trackId), eq(contributions.active, true))
      )
      .get()
    if (track && (track.state !== 'no_longer_wanted' || wanted)) {
      // Liked again: its finished tombstones are history now.
      deps.db.delete(tombstones).where(eq(tombstones.trackId, trackId)).run()
      continue
    }
    deps.db.transaction((tx) => {
      const db = tx as unknown as Db
      // Every tombstone of this track is done; nothing needs them any more.
      db.delete(tombstones).where(eq(tombstones.trackId, trackId)).run()
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
  deps.db
    .delete(tombstones)
    .where(sql`track_id IS NULL AND done_at IS NOT NULL`)
    .run()
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
      mergeCleanupIntoDelete(db, trackId, where)
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
