import { describe, expect, it } from 'vitest'
import {
  lyricTypeLabel,
  matchesAlbumFilter,
  matchesArtistFilter,
  remoteStatusLabel,
} from '../src/renderer/src/components/library/library-utils'
import type { LibraryTrackView } from '../src/shared/contracts'

function makeTrack(
  overrides: Partial<LibraryTrackView> = {}
): LibraryTrackView {
  return {
    id: 'track_1',
    identityKind: 'lms_source',
    identityValue: 'youtube_music:track_1',
    managedByApp: true,
    tagSchemaVersion: 1,
    youtubeMusicTrackId: 'track_1',
    spotifyTrackId: null,
    soundcloudTrackId: null,
    resolvedYoutubeMusicTrackId: 'track_1',
    sourceOrigin: null,
    catalogReleaseBrowseId: null,
    catalogReleaseTitle: null,
    catalogReleaseKind: null,
    title: 'Song',
    artist: 'Artist Name',
    album: 'Album Name',
    albumArtist: 'Album Artist',
    trackNumber: 1,
    trackTotal: 1,
    discNumber: 1,
    discTotal: 1,
    year: 2026,
    date: null,
    genre: null,
    language: 'en',
    isrc: null,
    mbTrackId: null,
    mbAlbumId: null,
    mbReleaseGroupId: null,
    lyricsStatus: 'synced',
    hasEmbeddedLyrics: true,
    hasSidecarLyrics: false,
    coverArtPresent: true,
    hasLocalFile: true,
    hasRemoteFile: true,
    missingFields: [],
    preferredFileId: null,
    firstSeenAt: '2026-05-18T00:00:00.000Z',
    lastSeenAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
    ...overrides,
  }
}

describe('library view utils', () => {
  it('matches artist filters against artist or album artist', () => {
    expect(matchesArtistFilter(makeTrack(), 'artist name')).toBe(true)
    expect(matchesArtistFilter(makeTrack(), 'album artist')).toBe(true)
    expect(matchesArtistFilter(makeTrack(), 'someone else')).toBe(false)
  })

  it('matches album filters by album key', () => {
    expect(
      matchesAlbumFilter(makeTrack(), 'Album Name|||Album Artist')
    ).toBe(true)
    expect(matchesAlbumFilter(makeTrack(), 'Other|||Album Artist')).toBe(false)
  })

  it('maps lyric type labels', () => {
    expect(lyricTypeLabel('synced')).toBe('Synced')
    expect(lyricTypeLabel('plain')).toBe('Unsynced')
    expect(lyricTypeLabel('missing')).toBe('None')
  })

  it('maps remote status labels', () => {
    expect(
      remoteStatusLabel(makeTrack({ hasLocalFile: true, hasRemoteFile: true }))
    ).toBe('In Sync')
    expect(
      remoteStatusLabel(makeTrack({ hasLocalFile: true, hasRemoteFile: false }))
    ).toBe('Local Only')
    expect(
      remoteStatusLabel(makeTrack({ hasLocalFile: false, hasRemoteFile: true }))
    ).toBe('Remote Only')
    expect(
      remoteStatusLabel(
        makeTrack({ hasLocalFile: false, hasRemoteFile: false })
      )
    ).toBe('Missing')
  })
})
