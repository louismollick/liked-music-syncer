import { describe, expect, it, vi } from 'vitest'
import {
  type CatalogAlbumSearchResult,
  type CatalogRelease,
  CatalogShapeError,
  type CatalogTrack,
} from '../../src/main/catalog/types'
import { createMatcher } from '../../src/main/match/matcher'
import { spotifyCandidateScore } from '../../src/main/match/resolve'
import { HttpError } from '../../src/main/net/http'
import type { SpotifyLikedTrack } from '../../src/main/spotify/library'
import captures from '../fixtures/spotify-match-repair.json'
import { FakeCatalog, Harness, release, song } from '../reconcile/harness'

type Capture = {
  source: SpotifyLikedTrack
  albums: Record<string, CatalogAlbumSearchResult[]>
  songs: Record<string, CatalogTrack[]>
  releases: CatalogRelease[]
  nativeNames: Record<string, string>
  originalTitles: Record<string, string>
  expected: { videoId?: string; reason?: string }
}

describe('Spotify matching repair, real catalog evidence', () => {
  it.each(
    captures as unknown as Capture[]
  )('$source.title', async (fixture) => {
    const h = new Harness()
    try {
      const catalog = new FakeCatalog()
      catalog.releases = new Map(fixture.releases.map((r) => [r.browseId, r]))
      vi.spyOn(catalog, 'searchAlbums').mockImplementation(
        async (query) => fixture.albums[query] ?? []
      )
      vi.spyOn(catalog, 'searchSongs').mockImplementation(
        async (query) => fixture.songs[query] ?? []
      )
      vi.spyOn(catalog, 'artist').mockImplementation(
        async (id, _signal, language) => {
          expect(language).toBe('ja')
          const name = fixture.nativeNames[id]
          if (!name)
            throw new CatalogShapeError('No native alias in the capture')
          return {
            channelId: id,
            primaryChannelId: id,
            name,
            thumbnailUrl: null,
            albums: [],
            singles: [],
            albumsMore: null,
            singlesMore: null,
          }
        }
      )
      vi.spyOn(h.deps.http, 'json').mockImplementation(
        async <T>(url: string) => {
          const video = new URL(
            new URL(url).searchParams.get('url')!
          ).searchParams.get('v')!
          return { title: fixture.originalTitles[video] } as T
        }
      )
      const matcher = createMatcher({ catalog, http: h.deps.http })
      const result = matcher.match({ kind: 'spotify', track: fixture.source })
      if (fixture.expected.videoId) {
        expect(await result).toMatchObject({
          catalogVideoId: fixture.expected.videoId,
          resolutionMethod: expect.stringMatching(/^spotify_/),
        })
      } else {
        await expect(result).rejects.toMatchObject({
          reason: fixture.expected.reason,
        })
      }
    } finally {
      await h.close()
    }
  })
})

const source: SpotifyLikedTrack = {
  trackId: 'source',
  title: '春 - HARU',
  artists: [{ id: 'artist', name: '東京初期衝動' }],
  album: { id: 'album', name: 'Source Album' },
  durationMs: 200000,
  trackNumber: 1,
  addedAt: '2026-09-01T00:00:00Z',
  position: 0,
}
function candidate(title = '春 - HARU', artist = 'Tokyo Syoki Syodo') {
  return {
    title,
    artists: [{ name: artist, channelId: 'channel' }],
    album: 'Source Album',
    durationSeconds: 200,
  }
}

describe('evidence cannot combine two weak identities', () => {
  it('requires exact native names and exact narrow titles, not substring credit', () => {
    const nativeNames = new Map([['channel', source.artists[0].name]])
    expect(
      spotifyCandidateScore(source, candidate(), { nativeNames })
    ).not.toBeNull()
    expect(
      spotifyCandidateScore(source, candidate('春の歌'), { nativeNames })
    ).toBeNull()
    expect(
      spotifyCandidateScore(
        { ...source, artists: [{ id: 'artist', name: 'ミドリ' }] },
        candidate(),
        { nativeNames: new Map([['channel', 'ミドリカワ書房']]) }
      )
    ).toBeNull()
    expect(
      spotifyCandidateScore(source, candidate('Translated Song'), {
        nativeNames,
        originalTitle: source.title,
      })
    ).toBeNull()
  })

  it('does not give short title variants new substring credit even with the same artist', () => {
    expect(
      spotifyCandidateScore(source, candidate('春の歌', source.artists[0].name))
    ).toBeNull()
  })

  it.each([
    ['春', '春の歌 - Spring Song'],
    ['春の歌 - Spring Song', '春'],
    ['Home', 'Home Again'],
    ['Interlude', 'Interlude II'],
    ['Stay', 'Stay With Me'],
    ['Love', 'Love Song'],
    ['春', '春の歌'],
  ])('rejects containment between full bilingual titles: %s / %s', (title, other) => {
    expect(
      spotifyCandidateScore(
        { ...source, title },
        candidate(other, source.artists[0].name)
      )
    ).toBeNull()
  })

  it.each([
    ['But Tonight We Dance', 'But Tonight We Dance (Single Version)'],
    ['A Beautiful Mine', 'A Beautiful Mine (Theme Music From Mad Men)'],
  ])('retains title evidence for the delimited suffix: %s / %s', (title, other) => {
    for (const [left, right] of [
      [title, other],
      [other, title],
    ])
      expect(
        spotifyCandidateScore(
          { ...source, title: left },
          candidate(right, source.artists[0].name)
        )
      ).not.toBeNull()
  })

  it.each([
    'Album Version',
    'Single Ver.',
    'Original Mix',
    'Alternate Recording',
    'Special Edition',
  ])('does not use %s as a bilingual title with a relaxed artist', (suffix) => {
    const nativeNames = new Map([['channel', source.artists[0].name]])
    const title = 'No Boy No Cry'
    for (const [left, right] of [
      [title, `${title} - ${suffix}`],
      [`${title} - ${suffix}`, title],
    ])
      expect(
        spotifyCandidateScore({ ...source, title: left }, candidate(right), {
          nativeNames,
        })
      ).toBeNull()
  })

  it('token-order equivalence retains multiplicity and requires an exact title', () => {
    const input = {
      ...source,
      title: 'Lazy river',
      artists: [{ id: 'artist', name: 'Mamiko Suzuki' }],
    }
    const item = candidate('Lazy river', 'suzuki mamiko')
    expect(spotifyCandidateScore(input, item)).toBeNull()
    expect(
      spotifyCandidateScore(input, item, { nativeNames: new Map() })
    ).not.toBeNull()
    expect(
      spotifyCandidateScore(
        input,
        { ...item, title: 'Lazy river song' },
        { nativeNames: new Map() }
      )
    ).toBeNull()
    expect(
      spotifyCandidateScore(
        input,
        candidate('Lazy river', 'Suzuki Suzuki Mamiko'),
        { nativeNames: new Map() }
      )
    ).toBeNull()
  })
})

function setup() {
  const h = new Harness()
  const catalog = new FakeCatalog()
  const item = {
    ...song('video', source.title),
    durationSeconds: 200,
    artists: candidate().artists,
  }
  const album = {
    ...release('release', item),
    title: 'Source Album',
    artists: item.artists,
  }
  catalog.releases.set(album.browseId, album)
  const searches = vi
    .spyOn(catalog, 'searchSongs')
    .mockResolvedValue([
      { ...item, album: { browseId: album.browseId, name: album.title } },
    ])
  const artist = vi.spyOn(catalog, 'artist').mockResolvedValue({
    channelId: 'channel',
    primaryChannelId: 'channel',
    name: source.artists[0].name,
    thumbnailUrl: null,
    albums: [],
    singles: [],
    albumsMore: null,
    singlesMore: null,
  })
  const matcher = createMatcher({ catalog, http: h.deps.http })
  return { h, catalog, item, album, searches, artist, matcher }
}

describe('optional lookup lifecycle', () => {
  it.each([
    ['春', '春の歌 - Spring Song'],
    ['春の歌 - Spring Song', '春'],
    ['Home', 'Home Again'],
    ['Interlude', 'Interlude II'],
    ['Stay', 'Stay With Me'],
    ['Love', 'Love Song'],
    ['春', '春の歌'],
  ])('does not select a different song through bilingual containment: %s / %s', async (title, other) => {
    const s = setup()
    try {
      const artists = [{ name: source.artists[0].name, channelId: 'channel' }]
      s.album.tracks[0] = { ...s.item, title: other, artists }
      s.searches.mockResolvedValue([
        {
          ...s.item,
          title: other,
          artists,
          album: { browseId: s.album.browseId, name: s.album.title },
        },
      ])
      vi.spyOn(s.h.deps.http, 'json').mockImplementation(
        async <T>() => ({}) as T
      )
      await expect(
        s.matcher.match({ kind: 'spotify', track: { ...source, title } })
      ).rejects.toMatchObject({ reason: 'no_match' })
    } finally {
      await s.h.close()
    }
  })

  it('caches native names, evicts transient failures, and resets the cache', async () => {
    const s = setup()
    try {
      s.artist.mockRejectedValueOnce(
        new HttpError('offline', 'transient', null)
      )
      await expect(
        s.matcher.match({ kind: 'spotify', track: source })
      ).rejects.toThrow('offline')
      await s.matcher.match({ kind: 'spotify', track: source })
      await s.matcher.match({ kind: 'spotify', track: source })
      expect(s.artist).toHaveBeenCalledTimes(2)
      s.matcher.resetCache?.()
      await s.matcher.match({ kind: 'spotify', track: source })
      expect(s.artist).toHaveBeenCalledTimes(3)
    } finally {
      await s.h.close()
    }
  })

  it('never reads optional evidence if ordinary matching has a winner', async () => {
    const s = setup()
    try {
      const ordinary = {
        ...s.item,
        videoId: 'ordinary',
        artists: [
          { name: source.artists[0].name, channelId: 'ordinary-channel' },
        ],
      }
      s.album.tracks.push(ordinary)
      s.searches.mockResolvedValue([
        {
          ...s.item,
          album: { name: s.album.title, browseId: s.album.browseId },
        },
        {
          ...ordinary,
          album: { name: s.album.title, browseId: s.album.browseId },
        },
      ])
      s.artist.mockRejectedValue(
        new HttpError('irrelevant channel offline', 'transient', null)
      )
      const originalTitle = vi
        .spyOn(s.h.deps.http, 'json')
        .mockRejectedValue(new HttpError('oEmbed denied', 'permanent', 401))
      expect(
        await s.matcher.match({ kind: 'spotify', track: source })
      ).toMatchObject({ catalogVideoId: 'ordinary' })
      expect(s.artist).not.toHaveBeenCalled()
      expect(originalTitle).not.toHaveBeenCalled()
    } finally {
      await s.h.close()
    }
  })

  it.each([
    new CatalogShapeError('missing artist'),
    new HttpError('missing artist', 'permanent', 404),
  ])('treats unavailable alias pages as missing evidence', async (error) => {
    const s = setup()
    try {
      s.artist.mockRejectedValue(error)
      await expect(
        s.matcher.match({ kind: 'spotify', track: source })
      ).rejects.toMatchObject({ reason: 'no_match' })
    } finally {
      await s.h.close()
    }
  })

  it('evicts aborted alias promises and does not turn cancellation into no match', async () => {
    const s = setup()
    try {
      const controller = new AbortController()
      s.artist.mockImplementationOnce(async () => {
        controller.abort(new Error('cancelled'))
        throw new CatalogShapeError('missing')
      })
      await expect(
        s.matcher.match({ kind: 'spotify', track: source }, controller.signal)
      ).rejects.toThrow('cancelled')
      await expect(
        s.matcher.match({ kind: 'spotify', track: source })
      ).resolves.toMatchObject({ catalogVideoId: 'video' })
      expect(s.artist).toHaveBeenCalledTimes(2)
    } finally {
      await s.h.close()
    }
  })

  it('filters before reading and caps new channel reads at three', async () => {
    const s = setup()
    try {
      s.artist.mockResolvedValue({
        channelId: 'channel',
        primaryChannelId: 'channel',
        name: 'Wrong artist',
        thumbnailUrl: null,
        albums: [],
        singles: [],
        albumsMore: null,
        singlesMore: null,
      })
      const result = {
        ...s.item,
        album: { name: s.album.title, browseId: s.album.browseId },
      }
      s.searches.mockResolvedValue([
        {
          ...result,
          videoId: 'wrong-title',
          title: '春の歌',
          artists: [{ name: 'Wrong', channelId: 'skip-title' }],
        },
        {
          ...result,
          videoId: 'wrong-version',
          title: `${source.title} (Live)`,
          artists: [{ name: 'Wrong', channelId: 'skip-version' }],
        },
        {
          ...result,
          videoId: 'wrong-duration',
          durationSeconds: 206,
          artists: [{ name: 'Wrong', channelId: 'skip-duration' }],
        },
        ...[1, 2, 3, 4].map((id) => ({
          ...result,
          videoId: `video-${id}`,
          artists: [{ name: 'Wrong', channelId: `channel-${id}` }],
        })),
      ])
      await expect(
        s.matcher.match({ kind: 'spotify', track: source })
      ).rejects.toMatchObject({ reason: 'no_match' })
      expect(s.artist.mock.calls.map(([id]) => id)).toEqual([
        'channel-1',
        'channel-2',
        'channel-3',
      ])
    } finally {
      await s.h.close()
    }
  })
})

describe('original-title evidence stays attached to its video', () => {
  it.each([
    401, 404,
  ])('treats oEmbed %s as missing evidence in fallback', async (status) => {
    const s = setup()
    try {
      const input = {
        ...source,
        artists: [{ id: 'artist', name: 'Tokyo Syoki Syodo' }],
      }
      s.item.title = 'Translated Song'
      s.album.tracks[0].title = 'Translated Song'
      s.searches.mockResolvedValue([
        {
          ...s.item,
          album: { browseId: s.album.browseId, name: s.album.title },
        },
      ])
      vi.spyOn(s.h.deps.http, 'json').mockRejectedValue(
        new HttpError('not embeddable', 'permanent', status)
      )
      await expect(
        s.matcher.match({ kind: 'spotify', track: input })
      ).rejects.toMatchObject({ reason: 'no_match' })
    } finally {
      await s.h.close()
    }
  })

  it('validates original-title evidence on the exact browsed video and caches it', async () => {
    const s = setup()
    try {
      const input = {
        ...source,
        artists: [{ id: 'artist', name: 'Tokyo Syoki Syodo' }],
      }
      s.item.title = 'Translated Song'
      s.album.tracks[0].title = 'Translated Song'
      s.searches.mockResolvedValue([
        {
          ...s.item,
          album: { browseId: s.album.browseId, name: s.album.title },
        },
      ])
      const reads = vi
        .spyOn(s.h.deps.http, 'json')
        .mockImplementation(async <T>() => ({ title: source.title }) as T)
      await expect(
        s.matcher.match({ kind: 'spotify', track: input })
      ).resolves.toMatchObject({ catalogVideoId: 'video' })
      await s.matcher.match({ kind: 'spotify', track: input })
      expect(reads).toHaveBeenCalledTimes(1)
      s.album.tracks = [{ ...s.item, videoId: 'different-video' }]
      await expect(
        s.matcher.match({ kind: 'spotify', track: input })
      ).rejects.toMatchObject({ reason: 'no_match' })
    } finally {
      await s.h.close()
    }
  })

  it('does not accept an unavailable release member even with an exact original title', async () => {
    const s = setup()
    try {
      const input = {
        ...source,
        artists: [{ id: 'artist', name: 'Tokyo Syoki Syodo' }],
      }
      s.item.title = 'Translated Song'
      s.album.tracks[0].title = 'Translated Song'
      s.searches.mockResolvedValue([
        {
          ...s.item,
          album: { browseId: s.album.browseId, name: s.album.title },
        },
      ])
      s.album.tracks[0].isAvailable = false
      vi.spyOn(s.h.deps.http, 'json').mockImplementation(
        async <T>() => ({ title: source.title }) as T
      )
      await expect(
        s.matcher.match({ kind: 'spotify', track: input })
      ).rejects.toMatchObject({ reason: 'unavailable' })
    } finally {
      await s.h.close()
    }
  })

  it('caps original-title reads and preserves transient errors', async () => {
    const s = setup()
    try {
      const input = {
        ...source,
        artists: [{ id: 'artist', name: 'Tokyo Syoki Syodo' }],
      }
      s.searches.mockResolvedValue(
        [1, 2, 3, 4].map((id) => ({
          ...s.item,
          title: `Untranslated ${id}`,
          videoId: `video-${id}`,
          album: { browseId: s.album.browseId, name: s.album.title },
        }))
      )
      const reads = vi
        .spyOn(s.h.deps.http, 'json')
        .mockImplementation(async <T>() => ({}) as T)
      await expect(
        s.matcher.match({ kind: 'spotify', track: input })
      ).rejects.toMatchObject({ reason: 'no_match' })
      expect(reads).toHaveBeenCalledTimes(3)
      s.matcher.resetCache?.()
      reads.mockRejectedValueOnce(
        new HttpError('rate limited', 'transient', 429)
      )
      await expect(
        s.matcher.match({ kind: 'spotify', track: input })
      ).rejects.toMatchObject({ kind: 'transient', status: 429 })
    } finally {
      await s.h.close()
    }
  })
})
