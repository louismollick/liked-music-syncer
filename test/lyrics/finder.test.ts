import { describe, expect, it } from 'vitest'
import type {
  CatalogLyrics,
  YouTubeMusicCatalog,
} from '../../src/main/catalog/types'
import { createLyricsFinder } from '../../src/main/lyrics/finder'
import { formatLrcLine } from '../../src/main/lyrics/lrc'
import { candidateScore, generateTotp } from '../../src/main/lyrics/spotify'
import type { LyricsQuery } from '../../src/main/lyrics/types'
import {
  type HttpClient,
  HttpError,
  type RequestOptions,
} from '../../src/main/net/http'

const query: LyricsQuery = {
  title: 'Halo',
  artists: [{ name: 'Beyoncé', channelId: null }],
  album: 'I Am... Sasha Fierce',
  durationSeconds: 261,
  lyricsBrowseId: 'MPLYlyrics',
  spotifyTrackId: 'known',
}

type Route = (url: URL, options: RequestOptions) => unknown | Promise<unknown>
function fakeHttp(route: Route) {
  const calls: { url: URL; options: RequestOptions }[] = []
  const request = async (raw: string, options: RequestOptions) => {
    const url = new URL(raw)
    calls.push({ url, options })
    const value = await route(url, options)
    if (value instanceof Error) throw value
    return value instanceof Response ? value : Response.json(value)
  }
  const http: HttpClient = {
    request,
    async json<T>(url, options) {
      return (await (await request(url, options)).json()) as T
    },
    async text(url, options) {
      return (await request(url, options)).text()
    },
    async bytes(url, options) {
      return new Uint8Array(await (await request(url, options)).arrayBuffer())
    },
  }
  return { http, calls }
}

function fakeCatalog(
  value: CatalogLyrics | null,
  calls: string[]
): YouTubeMusicCatalog {
  return {
    async lyrics(id) {
      calls.push(id)
      return value
    },
  } as YouTubeMusicCatalog
}

const lyricServer = { lyricsServerUrl: 'https://lyrics.example/lyrics' }
const noServer = { lyricsServerUrl: null }

describe('lyrics finder', () => {
  it('prefers Spotify synced lyrics and stops before YouTube Music and LRCLIB', async () => {
    const catalogCalls: string[] = []
    const { http, calls } = fakeHttp((url) => {
      expect(url.searchParams.get('trackid')).toBe('known')
      expect(url.searchParams.get('format')).toBe('lrc')
      return { lines: [{ timeTag: '00:12.34', words: 'Here comes the light' }] }
    })
    const result = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, catalogCalls),
    }).find(query, lyricServer)
    expect(result.lyrics).toMatchObject({
      text: '[00:12.34]Here comes the light',
      synced: true,
      source: 'spotify',
    })
    expect(result.spotifyTrackId).toBe('known')
    expect(catalogCalls).toEqual([])
    expect(calls.map((call) => call.options.host)).toEqual(['lyrics-server'])
  })

  it('returns YouTube Music synced lyrics after Spotify plain and skips LRCLIB', async () => {
    const catalogCalls: string[] = []
    const { http, calls } = fakeHttp(() => ({
      lines: [{ words: 'Spotify plain' }],
    }))
    const catalog = fakeCatalog(
      {
        timed: [{ startMs: 61789, endMs: null, text: 'Timed line' }],
        plain: null,
        source: null,
      },
      catalogCalls
    )
    const result = await createLyricsFinder({ http, catalog }).find(
      query,
      lyricServer
    )
    expect(result.lyrics).toMatchObject({
      text: '[01:01.79]Timed line',
      synced: true,
      source: 'youtube-music',
    })
    expect(catalogCalls).toEqual(['MPLYlyrics'])
    expect(calls).toHaveLength(1)
  })

  it('chooses first plain result after checking every provider', async () => {
    const catalogCalls: string[] = []
    const { http, calls } = fakeHttp((url) =>
      url.hostname === 'lrclib.net'
        ? { plainLyrics: 'LRCLIB plain' }
        : { lines: [{ words: 'Spotify plain' }] }
    )
    const catalog = fakeCatalog(
      { timed: null, plain: 'YouTube plain', source: null },
      catalogCalls
    )
    const result = await createLyricsFinder({ http, catalog }).find(
      query,
      lyricServer
    )
    expect(result.lyrics).toMatchObject({
      text: 'Spotify plain',
      synced: false,
      source: 'spotify',
    })
    expect(calls.map((call) => call.options.host)).toEqual([
      'lyrics-server',
      'lrclib',
    ])
  })

  it('does no Spotify requests without a server and uses YouTube Music timed lyrics', async () => {
    const { http, calls } = fakeHttp(() => {
      throw new Error('unexpected HTTP call')
    })
    const catalog = fakeCatalog(
      {
        timed: [{ startMs: 1200, endMs: null, text: 'Hello' }],
        plain: null,
        source: null,
      },
      []
    )
    const result = await createLyricsFinder({ http, catalog }).find(
      query,
      noServer
    )
    expect(result.lyrics).toMatchObject({
      text: '[00:01.20]Hello',
      source: 'youtube-music',
    })
    expect(calls).toHaveLength(0)
  })

  it('uses LRCLIB get parameters, user agent, and synced lyrics', async () => {
    const { http, calls } = fakeHttp(() => ({
      syncedLyrics: '[00:01.20]Hello there',
      plainLyrics: 'Hello there',
    }))
    const result = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find({ ...query, lyricsBrowseId: null }, noServer)
    expect(result.lyrics).toMatchObject({ source: 'lrclib', synced: true })
    expect(calls[0].url.pathname).toBe('/api/get')
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      track_name: 'Halo',
      artist_name: 'Beyoncé',
      album_name: query.album,
      duration: '261',
    })
    expect(new Headers(calls[0].options.headers).get('User-Agent')).toContain(
      'LikedMusicSyncer/2.0'
    )
  })

  it('searches after LRCLIB get 404 and picks the first result within three seconds', async () => {
    const { http, calls } = fakeHttp((url) =>
      url.pathname.endsWith('/get')
        ? new HttpError('not found', 'permanent', 404)
        : [
            { duration: 250, syncedLyrics: '[00:01.00]Wrong' },
            { duration: 264, syncedLyrics: '[00:02.00]Right' },
          ]
    )
    const result = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find({ ...query, lyricsBrowseId: null }, noServer)
    expect(result.lyrics?.text).toBe('[00:02.00]Right')
    expect(result.errors).toEqual({})
    expect(calls.map((call) => call.url.pathname)).toEqual([
      '/api/get',
      '/api/search',
    ])
  })

  it('selects the first LRCLIB search result when duration is unknown', async () => {
    const { http, calls } = fakeHttp((url) =>
      url.pathname.endsWith('/get')
        ? new HttpError('not found', 'permanent', 404)
        : [
            { duration: 100, plainLyrics: 'First lyric' },
            { duration: 200, plainLyrics: 'Second lyric' },
          ]
    )
    const result = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(
      { ...query, album: null, durationSeconds: null, lyricsBrowseId: null },
      noServer
    )
    expect(result.lyrics?.text).toBe('First lyric')
    expect(calls[0].url.searchParams.has('album_name')).toBe(false)
    expect(calls[0].url.searchParams.has('duration')).toBe(false)
  })

  it('treats all-zero LRC as plain and strips tags', async () => {
    const { http } = fakeHttp(() => ({
      syncedLyrics: '[00:00.00]First line\n[00:00.00]Second line',
    }))
    const result = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find({ ...query, lyricsBrowseId: null }, noServer)
    expect(result.lyrics).toMatchObject({
      text: 'First line\nSecond line',
      synced: false,
    })
  })

  it('records provider failures and continues; AbortError propagates', async () => {
    const catalogCalls: string[] = []
    const { http } = fakeHttp((url) =>
      url.hostname === 'lyrics.example'
        ? new Error('server down')
        : { plainLyrics: 'From LRCLIB' }
    )
    const catalog = fakeCatalog(null, catalogCalls)
    const result = await createLyricsFinder({ http, catalog }).find(
      query,
      lyricServer
    )
    expect(result.errors).toEqual({ spotify: 'server down' })
    expect(result.lyrics?.source).toBe('lrclib')
    expect(catalogCalls).toEqual(['MPLYlyrics'])

    const aborted = fakeHttp(() => new DOMException('cancelled', 'AbortError'))
    await expect(
      createLyricsFinder({ http: aborted.http, catalog }).find(
        query,
        lyricServer
      )
    ).rejects.toMatchObject({ name: 'AbortError' })

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      createLyricsFinder({ http, catalog }).find(
        query,
        lyricServer,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('returns no lyrics and one error for each failed provider', async () => {
    const { http } = fakeHttp((url) => new Error(`${url.hostname} unavailable`))
    const catalog = {
      async lyrics() {
        throw new Error('catalog unavailable')
      },
    } as unknown as YouTubeMusicCatalog
    const result = await createLyricsFinder({ http, catalog }).find(
      query,
      lyricServer
    )
    expect(result.lyrics).toBeNull()
    expect(result.errors).toEqual({
      spotify: 'lyrics.example unavailable',
      'youtube-music': 'catalog unavailable',
      lrclib: 'lrclib.net unavailable',
    })
  })

  it('detects Japanese, English and Korean from lyrics without timestamps', async () => {
    const samples = [
      [
        'ja',
        '夜空に輝く星を見上げて、あなたの声を思い出す。静かな風が私の心を優しく包み込む。',
      ],
      [
        'en',
        'When the morning sunlight reaches through my window, I remember every word you said and sing it once again.',
      ],
      [
        'ko',
        '오늘 밤 하늘에 빛나는 별을 바라보며 너와 함께 걸었던 길을 다시 생각해요. 바람이 불어와 내 마음을 따뜻하게 감싸요.',
      ],
    ] as const
    for (const [code, sample] of samples) {
      const { http } = fakeHttp(() => ({ plainLyrics: sample }))
      const result = await createLyricsFinder({
        http,
        catalog: fakeCatalog(null, []),
      }).find({ ...query, lyricsBrowseId: null }, noServer)
      expect(result.lyrics?.language).toBe(code)
    }
  })
})

describe('Spotify reference goldens', () => {
  it('formats timestamp rounding like Python', () => {
    expect(formatLrcLine(125, 'x')).toBe('[00:00.12]x')
    expect(formatLrcLine(615, 'x')).toBe('[00:00.61]x')
    expect(formatLrcLine(59999, 'x')).toBe('[00:60.00]x')
  })

  it('matches Python TOTP values', () => {
    expect(generateTotp(1_700_000_000, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(
      '321362'
    )
    expect(generateTotp(1_723_456_789, [12, 34, 56, 78, 90, 123, 234])).toBe(
      '701077'
    )
    expect(generateTotp(0, [1, 2, 3])).toBe('838915')
  })

  it('matches Python candidate scores', () => {
    const source = {
      title: 'Beyoncé Halo (Live)',
      artist: 'Beyoncé',
      durationSeconds: 261,
    }
    expect(
      candidateScore(source, {
        name: 'Halo (Live)',
        artists: ['Beyoncé'],
        durationMs: 261000,
      })
    ).toBe(0.8167)
    expect(
      candidateScore(source, {
        name: 'Halo',
        artists: ['Beyonce'],
        durationMs: 261000,
      })
    ).toBe(0.2833)
    expect(
      candidateScore(source, {
        name: 'Halo (Live)',
        artists: ['Beyoncé'],
        durationMs: 290000,
      })
    ).toBe(0.7167)
    expect(
      candidateScore(source, {
        name: 'Halo (Live)',
        artists: ['Other'],
        durationMs: 261000,
      })
    ).toBe(0.4667)
  })

  it('bootstraps, searches candidates, and converts lyric-server lines', async () => {
    const searchQuery = {
      ...query,
      title: 'Beyoncé Halo (Live)',
      spotifyTrackId: null,
    }
    const { http, calls } = fakeHttp((url, options) => {
      if (url.hostname === 'open.spotify.com' && url.pathname === '/') {
        return new Response(
          `<script id="appServerConfig" type="text/plain">${Buffer.from(JSON.stringify({ clientVersion: 'v1' })).toString('base64')}</script>`
        )
      }
      if (url.pathname.endsWith('secretDict.json'))
        return { '9': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }
      if (url.pathname === '/api/server-time') return { serverTime: 1700000000 }
      if (url.pathname === '/api/token') {
        expect(url.searchParams.get('totp')).toBe('321362')
        return {
          accessToken: 'token',
          accessTokenExpirationTimestampMs: Date.now() + 3600000,
        }
      }
      if (url.pathname.endsWith('/query')) {
        const body = JSON.parse(String(options.body))
        expect(body.extensions.persistedQuery.sha256Hash).toHaveLength(64)
        return {
          data: {
            searchV2: {
              tracksV2: {
                items: [
                  {
                    item: {
                      data: {
                        uri: 'spotify:track:wrong',
                        name: 'Halo',
                        artists: { items: [{ profile: { name: 'Beyonce' } }] },
                        duration: { totalMilliseconds: 261000 },
                      },
                    },
                  },
                  {
                    item: {
                      data: {
                        uri: 'spotify:track:right',
                        name: 'Halo (Live)',
                        artists: { items: [{ profile: { name: 'Beyoncé' } }] },
                        duration: { totalMilliseconds: 261000 },
                      },
                    },
                  },
                ],
              },
            },
          },
        }
      }
      if (url.hostname === 'lyrics.example') {
        expect(url.searchParams.get('trackid')).toBe('right')
        return {
          lines: [
            { startTimeMs: '61789', words: '  First line  ' },
            { timeTag: '[01:03.45]', words: 'Second line' },
          ],
        }
      }
      throw new Error(`unexpected ${url}`)
    })
    const result = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(searchQuery, lyricServer)
    expect(result.spotifyTrackId).toBe('right')
    expect(result.lyrics).toMatchObject({
      text: '[01:01.79]First line\n[01:03.45]Second line',
      synced: true,
      source: 'spotify',
    })
    expect(calls.map((call) => call.options.host)).toEqual([
      'spotify',
      'spotify',
      'spotify',
      'spotify',
      'spotify',
      'lyrics-server',
    ])
  })
})
