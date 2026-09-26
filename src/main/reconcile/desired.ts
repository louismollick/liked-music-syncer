import {
  type ArtistCredit,
  joinArtistNames,
  normalizeArtistCredits,
} from '../domain'
import { layoutPath } from '../inventory/layout'
import type { TrackRow } from '../library/schema'
import type { Match } from '../match/types'
import { LMS_TAG_SCHEMA_VERSION, type TagFields } from '../tags/schema'

/**
 * What a track's Managed File should contain, computed only from saved facts
 * (the Match, lyrics text, processed cover). No network: this is what makes
 * retagging after a tag-rule change free.
 */

export function parseMatch(track: TrackRow): Match | null {
  if (!track.match) return null
  try {
    return JSON.parse(track.match) as Match
  } catch {
    return null
  }
}

export function trackCredits(track: TrackRow): ArtistCredit[] {
  try {
    return normalizeArtistCredits(JSON.parse(track.artistCredits))
  } catch {
    return []
  }
}

export function desiredTagFields(
  track: TrackRow,
  coverSha256: string | null,
  sourceOrigin: string | null
): TagFields {
  const match = parseMatch(track)
  const credits = trackCredits(track)
  const release = match?.release ?? null
  return {
    title: track.title || null,
    artist: track.artist || joinArtistNames(credits) || null,
    album: track.album || null,
    albumArtist: track.albumArtist || null,
    trackNumber: release ? (track.trackNumber ?? null) : 1,
    trackTotal: release ? (track.trackTotal ?? null) : 1,
    discNumber: release ? (track.discNumber ?? null) : null,
    discTotal: release ? (track.discTotal ?? null) : null,
    date: track.date ?? (track.year ? String(track.year) : null),
    genre: track.genre ?? null,
    language: track.language ?? null,
    isrc: track.isrc ?? null,
    mbRecordingId: track.mbRecordingId ?? null,
    lyrics: track.lyricsText?.trim() || null,
    coverSha256,
    lms: {
      schemaVersion: LMS_TAG_SCHEMA_VERSION,
      sourceVideoId: match?.sourceVideoId ?? null,
      resolvedVideoId: match?.catalogVideoId ?? null,
      spotifyTrackId: track.spotifyTrackId ?? null,
      sourceOrigin,
      resolutionMethod: match?.resolutionMethod ?? null,
      releaseBrowseId: release?.browseId ?? null,
      releaseTitle: release?.title ?? null,
      releaseKind: release?.kind ?? null,
      artistCredits: credits,
    },
  }
}

export function desiredPath(track: TrackRow): string {
  const match = parseMatch(track)
  return layoutPath({
    title: track.title,
    album: track.album,
    albumArtist: track.albumArtist,
    trackNumber: track.trackNumber,
    hasRelease: Boolean(match?.release ?? track.releaseId),
  })
}

/** The `.lrc` sidecar content, or null when the track has no synced lyrics. */
export function desiredSidecar(track: TrackRow): string | null {
  if (track.lyricsStatus !== 'synced' || !track.lyricsText) return null
  return `${track.lyricsText.trim()}\n`
}
