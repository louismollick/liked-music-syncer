import { describe, expect, it, vi } from 'vitest'
import { createMatcher } from '../../src/main/match/matcher'
import { spotifyCandidateScore } from '../../src/main/match/resolve'
import { versionCompatible } from '../../src/main/match/text'
import type { Match } from '../../src/main/match/types'
import type { SpotifyLikedTrack } from '../../src/main/spotify/library'
import { FakeCatalog, Harness, release, song } from '../reconcile/harness'

const source: SpotifyLikedTrack = {
  trackId: 'spotify',
  title: 'A Song',
  artists: [{ id: 'artist', name: 'Test Artist' }],
  album: { id: 'album', name: 'Test Album' },
  trackNumber: 1,
  durationMs: 200000,
  addedAt: '2026-09-01T12:00:00Z',
  position: 0,
}
function setup() {
  const catalog = new FakeCatalog()
  const item = { ...song('audio', 'A Song'), durationSeconds: 200 }
  const album = release('MPRE1', item)
  catalog.releases.set(album.browseId, album)
  const searchAlbums = vi
    .spyOn(catalog, 'searchAlbums')
    .mockResolvedValue([
      { browseId: album.browseId, title: album.title, artists: album.artists },
    ])
  const searchSongs = vi.spyOn(catalog, 'searchSongs').mockResolvedValue([])
  const browse = vi.spyOn(catalog, 'release')
  const h = new Harness()
  const matcher = createMatcher({ catalog, http: h.deps.http })
  return {
    catalog,
    album,
    item,
    searchAlbums,
    searchSongs,
    browse,
    matcher,
    close: () => h.close(),
  }
}
describe('Spotify Release Track matching', () => {
  it('uses album-first and caches one browsed track list for several likes', async () => {
    const s = setup()
    try {
      const second = { ...s.item, videoId: 'second', title: 'Another Song' }
      s.album.tracks.push(second)
      const match = await s.matcher.match({ kind: 'spotify', track: source })
      expect(match).toMatchObject({
        sourceVideoId: null,
        identityKey: 'MPRE1:audio',
        resolutionMethod: 'spotify_album',
      })
      await s.matcher.match({
        kind: 'spotify',
        track: { ...source, title: second.title, trackId: 'second-spotify' },
      })
      expect(s.browse).toHaveBeenCalledTimes(1)
      expect(s.searchAlbums).toHaveBeenCalledTimes(1)
      expect(s.searchSongs).not.toHaveBeenCalled()
      s.matcher.resetCache?.()
      await s.matcher.match({ kind: 'spotify', track: source })
      expect(s.browse).toHaveBeenCalledTimes(2)
    } finally {
      await s.close()
    }
  })
  it('falls back to songs, dedupes queries, and requires membership in a browsed Release', async () => {
    const s = setup()
    try {
      s.searchAlbums.mockResolvedValue([])
      s.searchSongs.mockResolvedValue([
        { ...s.item, album: { browseId: 'MPRE1', name: 'Test Album' } },
      ])
      expect(
        (await s.matcher.match({ kind: 'spotify', track: source }))
          .resolutionMethod
      ).toBe('spotify_search')
      expect(s.searchSongs.mock.calls.map((call) => call[0])).toEqual([
        'A Song Test Artist Test Album',
        'A Song Test Artist',
      ])
      expect(s.searchSongs.mock.calls[0][1]).toEqual({
        ignoreSpelling: false,
        limit: 20,
      })
      s.album.tracks = [
        { ...s.item, videoId: 'different', title: 'Different Song' },
      ]
      await expect(
        s.matcher.match({ kind: 'spotify', track: source })
      ).rejects.toMatchObject({ reason: 'no_match' })
    } finally {
      await s.close()
    }
  })
  it('rejects video-only results, unavailable tracks, and unknown duration', async () => {
    const s = setup()
    try {
      s.searchAlbums.mockResolvedValue([])
      s.searchSongs.mockResolvedValue([
        { ...s.item, album: null, videoType: 'OMV' },
      ])
      await expect(
        s.matcher.match({ kind: 'spotify', track: source })
      ).rejects.toThrow('Not found on YouTube Music')
      s.searchSongs.mockResolvedValue([
        {
          ...s.item,
          album: { browseId: 'MPRE1', name: 'Test Album' },
          durationSeconds: null,
        },
      ])
      await expect(
        s.matcher.match({ kind: 'spotify', track: source })
      ).rejects.toMatchObject({ reason: 'no_match' })
    } finally {
      await s.close()
    }
  })
  it('rejects distinct Recordings without a 0.04 runner-up gap', async () => {
    const s = setup()
    try {
      s.album.tracks.push({ ...s.item, videoId: 'other-recording' })
      await expect(
        s.matcher.match({ kind: 'spotify', track: source })
      ).rejects.toMatchObject({ reason: 'ambiguous', kind: 'permanent' })
    } finally {
      await s.close()
    }
  })
  it('counts shared catalog video IDs as one Recording and prefers the Spotify album', async () => {
    const s = setup()
    try {
      s.searchAlbums.mockResolvedValue([])
      const other = { ...release('MPRE2', s.item), title: 'Other Album' }
      s.catalog.releases.set(other.browseId, other)
      s.searchSongs.mockResolvedValue([
        { ...s.item, album: { browseId: 'MPRE2', name: other.title } },
        { ...s.item, album: { browseId: 'MPRE1', name: s.album.title } },
      ])
      expect(
        (await s.matcher.match({ kind: 'spotify', track: source })).identityKey
      ).toBe('MPRE1:audio')
    } finally {
      await s.close()
    }
  })
  it.each([
    -5, 5, -5.001, 5.001,
  ])('uses the inclusive five-second duration gate for delta %s', (delta) => {
    const candidate = {
      title: source.title,
      artists: [{ name: 'Test Artist', channelId: null }],
      album: source.album.name,
      durationSeconds: 200 + delta,
    }
    expect(spotifyCandidateScore(source, candidate) !== null).toBe(
      Math.abs(delta) <= 5
    )
  })
  it.each([
    'Live',
    'Remix',
    'Instrumental',
    'Acoustic',
    'Sped Up',
    'Slowed',
    'Karaoke',
    'Cover',
  ])('rejects %s mismatches in both directions', (version) => {
    const candidate: Pick<
      Match,
      'title' | 'artists' | 'album' | 'durationSeconds'
    > = {
      title: `A Song (${version})`,
      artists: [{ name: 'Test Artist', channelId: null }],
      album: 'Test Album',
      durationSeconds: 200,
    }
    expect(spotifyCandidateScore(source, candidate)).toBeNull()
    expect(
      spotifyCandidateScore(
        { ...source, title: candidate.title },
        { ...candidate, title: 'A Song' }
      )
    ).toBeNull()
    expect(
      spotifyCandidateScore({ ...source, title: candidate.title }, candidate)
    ).not.toBeNull()
    expect(
      versionCompatible('A Song', 'Test Artist', {
        title: candidate.title,
        album: null,
      })
    ).toBe(false)
  })
  it('preserves network and authentication failures instead of reporting a missing match', async () => {
    const s = setup()
    try {
      s.searchAlbums.mockRejectedValue(new Error('network offline'))
      await expect(
        s.matcher.match({ kind: 'spotify', track: source })
      ).rejects.toThrow('network offline')
    } finally {
      await s.close()
    }
  })
})
