import { createHash } from 'node:crypto'
import {
  ByteVector,
  File,
  type Mpeg4AppleTag,
  Mpeg4BoxType,
  Picture,
  PictureType,
  TagTypes,
} from 'node-taglib-sharp'
import { type ArtistCredit, normalizeArtistCredits } from '../domain'

/**
 * Tag schema: the single definition of every tag the app writes and reads.
 * Writer and readers share this module, so a field read back from a file means
 * exactly what the writer put there.
 */

export const LMS_TAG_SCHEMA_VERSION = 6
const ITUNES = 'com.apple.iTunes'

export interface LmsFields {
  schemaVersion: number | null
  sourceVideoId: string | null
  resolvedVideoId: string | null
  spotifyTrackId: string | null
  sourceOrigin: string | null
  resolutionMethod: string | null
  releaseBrowseId: string | null
  releaseTitle: string | null
  releaseKind: string | null
  artistCredits: ArtistCredit[]
}

export interface TagFields {
  title: string | null
  /** Display artist string, e.g. "A, B". */
  artist: string | null
  album: string | null
  albumArtist: string | null
  trackNumber: number | null
  trackTotal: number | null
  discNumber: number | null
  discTotal: number | null
  /** Raw ©day value with its precision: YYYY, YYYY-MM, or YYYY-MM-DD. */
  date: string | null
  genre: string | null
  language: string | null
  isrc: string | null
  mbRecordingId: string | null
  /** Embedded lyrics text (synced LRC text or plain), trimmed. */
  lyrics: string | null
  /** SHA-256 of the embedded cover image bytes, or null when there is none. */
  coverSha256: string | null
  lms: LmsFields
}

export interface ReadResult {
  fields: TagFields
  cover: Uint8Array | null
  durationSeconds: number | null
  bitrateKbps: number | null
}

/**
 * LMS_SOURCE_ORIGIN value for a track that only a Full Discography catalog
 * wants. Files written before the rename from Favorite Artist carry this value,
 * so it stays as it is.
 */
export const CATALOG_SOURCE_ORIGIN = 'favorite_artist_release'

const LMS_KEYS: Record<Exclude<keyof LmsFields, 'artistCredits'>, string> = {
  schemaVersion: 'LMS_TAG_SCHEMA_VERSION',
  sourceVideoId: 'LMS_YOUTUBE_MUSIC_TRACK_ID',
  resolvedVideoId: 'LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID',
  spotifyTrackId: 'LMS_SPOTIFY_TRACK_ID',
  sourceOrigin: 'LMS_SOURCE_ORIGIN',
  resolutionMethod: 'LMS_RESOLUTION_METHOD',
  releaseBrowseId: 'LMS_CATALOG_RELEASE_BROWSE_ID',
  releaseTitle: 'LMS_CATALOG_RELEASE_TITLE',
  releaseKind: 'LMS_CATALOG_RELEASE_KIND',
}
const LMS_CREDITS_KEY = 'LMS_ARTIST_CREDITS'
/** Freeform atoms v5 wrote that the app no longer writes; removed on rewrite. */
const RETIRED_KEYS = [
  'LMS_SOUNDCLOUD_TRACK_ID',
  'MusicBrainz Album Id',
  'MusicBrainz Release Group Id',
]

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function blank(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null
}

function freeform(apple: Mpeg4AppleTag, name: string): string | null {
  return blank(apple.getFirstItunesString(ITUNES, name))
}

function parseCredits(raw: string | null): ArtistCredit[] {
  if (!raw) return []
  try {
    return normalizeArtistCredits(JSON.parse(raw))
  } catch {
    return []
  }
}

export function emptyLmsFields(): LmsFields {
  return {
    schemaVersion: null,
    sourceVideoId: null,
    resolvedVideoId: null,
    spotifyTrackId: null,
    sourceOrigin: null,
    resolutionMethod: null,
    releaseBrowseId: null,
    releaseTitle: null,
    releaseKind: null,
    artistCredits: [],
  }
}

/** Legacy files stored the YouTube URL in the comment instead of LMS tags. */
function legacyVideoId(comment: string | null): string | null {
  if (!comment) return null
  const match = comment.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/
  )
  return match ? match[1] : null
}

export function readTags(path: string): ReadResult {
  const file = File.createFromPath(path)
  try {
    const tag = file.tag
    const apple = file.getTag(TagTypes.Apple, false) as Mpeg4AppleTag | null
    const cover = tag.pictures[0]?.data.toByteArray() ?? null
    const lms = emptyLmsFields()
    let date: string | null = null
    let language: string | null = null
    let isrc: string | null = null
    let mbRecordingId: string | null = null
    if (apple) {
      const version = freeform(apple, LMS_KEYS.schemaVersion)
      lms.schemaVersion =
        version && /^\d+$/.test(version) ? Number(version) : null
      lms.sourceVideoId = freeform(apple, LMS_KEYS.sourceVideoId)
      lms.resolvedVideoId = freeform(apple, LMS_KEYS.resolvedVideoId)
      lms.spotifyTrackId = freeform(apple, LMS_KEYS.spotifyTrackId)
      lms.sourceOrigin = freeform(apple, LMS_KEYS.sourceOrigin)
      lms.resolutionMethod = freeform(apple, LMS_KEYS.resolutionMethod)
      lms.releaseBrowseId = freeform(apple, LMS_KEYS.releaseBrowseId)
      lms.releaseTitle = freeform(apple, LMS_KEYS.releaseTitle)
      lms.releaseKind = freeform(apple, LMS_KEYS.releaseKind)
      lms.artistCredits = parseCredits(freeform(apple, LMS_CREDITS_KEY))
      date = blank(apple.getFirstQuickTimeString(Mpeg4BoxType.DAY))
      language = freeform(apple, 'LANGUAGE')
      isrc = freeform(apple, 'ISRC')
      mbRecordingId = freeform(apple, 'MusicBrainz Track Id')
    }
    if (!lms.sourceVideoId)
      lms.sourceVideoId = legacyVideoId(blank(tag.comment))
    if (!lms.resolvedVideoId) lms.resolvedVideoId = lms.sourceVideoId
    const props = file.properties
    return {
      fields: {
        title: blank(tag.title),
        artist: blank(tag.performers.join(', ')),
        album: blank(tag.album),
        albumArtist: blank(tag.albumArtists.join(', ')),
        trackNumber: positive(tag.track),
        trackTotal: positive(tag.trackCount),
        discNumber: positive(tag.disc),
        discTotal: positive(tag.discCount),
        date,
        genre: blank(tag.genres.join('; ')),
        language,
        isrc,
        mbRecordingId,
        lyrics: blank(tag.lyrics),
        coverSha256: cover ? sha256(cover) : null,
        lms,
      },
      cover,
      durationSeconds: props?.durationMilliseconds
        ? props.durationMilliseconds / 1000
        : null,
      bitrateKbps: props?.audioBitrate ? Math.round(props.audioBitrate) : null,
    }
  } finally {
    file.dispose()
  }
}

function setFreeform(apple: Mpeg4AppleTag, name: string, value: string | null) {
  if (value === null || value === '') apple.setItunesStrings(ITUNES, name)
  else apple.setItunesStrings(ITUNES, name, value)
}

/**
 * Writes every app-owned field. `cover` replaces the embedded artwork; pass
 * null to remove it. Fields not owned by the app (other atoms) are preserved.
 */
export function writeTags(
  path: string,
  fields: TagFields,
  cover: Uint8Array | null
): void {
  const file = File.createFromPath(path)
  try {
    const tag = file.tag
    const apple = file.getTag(TagTypes.Apple, true) as Mpeg4AppleTag
    tag.title = fields.title ?? ''
    tag.performers = fields.artist ? [fields.artist] : []
    tag.album = fields.album ?? ''
    tag.albumArtists = fields.albumArtist ? [fields.albumArtist] : []
    tag.track = fields.trackNumber ?? 0
    tag.trackCount = fields.trackTotal ?? 0
    tag.disc = fields.discNumber ?? 0
    tag.discCount = fields.discTotal ?? 0
    tag.genres = fields.genre ? [fields.genre] : []
    tag.lyrics = fields.lyrics?.trim() ?? ''
    tag.comment = ''
    if (fields.date) apple.setQuickTimeString(Mpeg4BoxType.DAY, fields.date)
    else apple.setQuickTimeStrings(Mpeg4BoxType.DAY, [])
    setFreeform(apple, 'LANGUAGE', fields.language)
    setFreeform(apple, 'ISRC', fields.isrc)
    setFreeform(apple, 'MusicBrainz Track Id', fields.mbRecordingId)
    for (const key of RETIRED_KEYS) apple.setItunesStrings(ITUNES, key)

    const lms = fields.lms
    setFreeform(apple, LMS_KEYS.schemaVersion, String(LMS_TAG_SCHEMA_VERSION))
    setFreeform(apple, LMS_KEYS.sourceVideoId, lms.sourceVideoId)
    setFreeform(apple, LMS_KEYS.resolvedVideoId, lms.resolvedVideoId)
    setFreeform(apple, LMS_KEYS.spotifyTrackId, lms.spotifyTrackId)
    setFreeform(apple, LMS_KEYS.sourceOrigin, lms.sourceOrigin)
    setFreeform(apple, LMS_KEYS.resolutionMethod, lms.resolutionMethod)
    setFreeform(apple, LMS_KEYS.releaseBrowseId, lms.releaseBrowseId)
    setFreeform(apple, LMS_KEYS.releaseTitle, lms.releaseTitle)
    setFreeform(apple, LMS_KEYS.releaseKind, lms.releaseKind)
    setFreeform(
      apple,
      LMS_CREDITS_KEY,
      lms.artistCredits.length
        ? JSON.stringify(
            lms.artistCredits.map((credit) => ({
              name: credit.name,
              channel_id: credit.channelId,
            }))
          )
        : null
    )

    if (cover) {
      const picture = Picture.fromData(ByteVector.fromByteArray(cover))
      picture.type = PictureType.FrontCover
      tag.pictures = [picture]
    } else {
      tag.pictures = []
    }
    file.save()
  } finally {
    file.dispose()
  }
}

/** Names of fields whose values differ. Used for Remote State and Outside Edit detail. */
export function fieldDiff(a: TagFields, b: TagFields): string[] {
  const diffs: string[] = []
  const keys = new Set(
    [...Object.keys(a), ...Object.keys(b)].filter((key) => key !== 'lms')
  )
  for (const key of keys) {
    const left = (a as unknown as Record<string, unknown>)[key] ?? null
    const right = (b as unknown as Record<string, unknown>)[key] ?? null
    if (left !== right) diffs.push(key)
  }
  const lmsA = (a.lms ?? {}) as unknown as Record<string, unknown>
  const lmsB = (b.lms ?? {}) as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(lmsA), ...Object.keys(lmsB)])) {
    if (JSON.stringify(lmsA[key] ?? null) !== JSON.stringify(lmsB[key] ?? null))
      diffs.push(`lms.${key}`)
  }
  return diffs
}
