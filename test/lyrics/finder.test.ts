import { describe, expect, it } from 'vitest'
import type {
  CatalogLyrics,
  YouTubeMusicCatalog,
} from '../../src/main/catalog/types'
import { createLyricsFinder } from '../../src/main/lyrics/finder'
import { formatLrcLine } from '../../src/main/lyrics/lrc'
import { prepareLyricsQuery } from '../../src/main/lyrics/query'
import {
  candidateScore,
  createSpotifyClient,
  generateTotp,
} from '../../src/main/lyrics/spotify'
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
    let value = await route(url, options)
    if (value instanceof Error) throw value
    if (value instanceof Response) return value
    // Old fixtures omitted metadata. Real LRCLIB responses include these fields.
    if (url.hostname === 'lrclib.net') {
      const metadata = {
        trackName: url.searchParams.get('track_name'),
        artistName: url.searchParams.get('artist_name'),
        duration: Number(url.searchParams.get('duration') ?? 261),
      }
      const item = (raw: unknown) => ({ ...metadata, ...(raw as object) })
      value = Array.isArray(value)
        ? value.map(item)
        : url.pathname.endsWith('/search')
          ? [item(value)]
          : item(value)
    }
    if (url.hostname === 'p0.petitlyrics.com')
      return new Response(
        '<response><status>00000000</status><songs/></response>'
      )
    if (url.hostname === 'open.spotify.com' && url.pathname === '/')
      return spotifyBootstrap()
    if (url.pathname.endsWith('secretDict.json') && !('9' in Object(value)))
      value = { '9': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }
    if (url.pathname === '/api/server-time') value = { serverTime: 1700000000 }
    if (url.pathname === '/api/token')
      value = {
        accessToken: 'token',
        accessTokenExpirationTimestampMs: Date.now() + 3600000,
      }
    if (
      url.pathname.endsWith('/query') &&
      !('data' in Object(value)) &&
      !('errors' in Object(value))
    )
      value = spotifyResults([])
    return Response.json(value)
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

function spotifyBootstrap() {
  return new Response(
    `<script id="appServerConfig" type="text/plain">${Buffer.from(JSON.stringify({ clientVersion: 'v1' })).toString('base64')}</script>`
  )
}
function spotifyResults(
  items: { id: string; title: string; duration: number; artist?: string }[]
) {
  return {
    data: {
      searchV2: {
        tracksV2: {
          items: items.map((item) => ({
            item: {
              data: {
                uri: `spotify:track:${item.id}`,
                name: item.title,
                artists: {
                  items: [{ profile: { name: item.artist ?? 'Beyoncé' } }],
                },
                duration: { totalMilliseconds: item.duration * 1000 },
              },
            },
          })),
        },
      },
    },
  }
}

const lyricServer = { lyricsServerUrl: 'https://lyrics.example/lyrics' }
const noServer = { lyricsServerUrl: null }

describe('lyrics finder', () => {
  it('treats missing Spotify lyrics as a normal miss and continues to other providers', async () => {
    const { http } = fakeHttp((url) =>
      url.hostname === 'lyrics.example'
        ? new HttpError('not found', 'permanent', 404)
        : { plainLyrics: 'LRCLIB lyrics' }
    )
    const result = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(query, lyricServer)
    expect(result.errors).toEqual({})
    expect(result.lyrics).toMatchObject({
      source: 'lrclib',
      text: 'LRCLIB lyrics',
    })
  })

  it.each([
    401, 503,
  ])('still records a real Spotify lyrics failure (%s)', async (status) => {
    const { http } = fakeHttp((url) =>
      url.hostname === 'lyrics.example'
        ? new HttpError(
            'provider failed',
            status === 503 ? 'transient' : 'permanent',
            status
          )
        : { plainLyrics: 'LRCLIB lyrics' }
    )
    const result = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(query, lyricServer)
    expect(result.errors).toEqual({ spotify: 'provider failed' })
  })

  it('uses search for concert-length uploads instead of sending an invalid LRCLIB duration', async () => {
    const { http, calls } = fakeHttp(() => [
      { duration: 240, plainLyrics: 'Wrong recording' },
      { duration: 5159, plainLyrics: 'Concert lyrics' },
    ])
    const result = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find({ ...query, durationSeconds: 5159, lyricsBrowseId: null }, noServer)
    expect(calls.map((call) => call.url.pathname)).toEqual([
      '/api/search',
      '/api/GetPetitLyricsData.php',
    ])
    expect(result.errors).toEqual({})
    expect(result.lyrics?.text).toBe('Concert lyrics')
  })
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
    expect(
      calls.filter((call) => call.options.host === 'lyrics-server')
    ).toHaveLength(1)
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
      ...Array(5).fill('spotify'),
      'lrclib',
      'lrclib',
      'petitlyrics',
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
      petitlyrics: 'p0.petitlyrics.com unavailable',
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

describe('recording-aware lyrics matching', () => {
  it.each([
    'plain',
    'synced',
  ])('stops LRCLIB variants after the first accepted %s result', async (kind) => {
    const { http, calls } = fakeHttp(() => ({
      ...(kind === 'synced'
        ? { syncedLyrics: '[00:01.00]Words' }
        : { plainLyrics: 'Words' }),
    }))
    const found = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(
      { ...query, title: '相聞詩 - Soumonka', artistVariants: ['日本名'] },
      noServer
    )
    expect(found.lyrics?.text).toBe(
      kind === 'synced' ? '[00:01.00]Words' : 'Words'
    )
    expect(
      calls
        .filter((call) => call.options.host === 'lrclib')
        .map((call) => call.url.pathname)
    ).toEqual(kind === 'synced' ? ['/api/get'] : ['/api/get', '/api/search'])
  })

  it('keeps LRCLIB get plain as fallback while preferring compatible synced search results', async () => {
    const { http } = fakeHttp((url) =>
      url.pathname.endsWith('/get')
        ? { plainLyrics: 'Plain' }
        : [
            {
              trackName: 'Halo (Live)',
              syncedLyrics: '[00:01.00]Wrong version',
              duration: 261,
            },
            { plainLyrics: 'First compatible plain', duration: 261 },
            { syncedLyrics: '[00:02.00]Synced', duration: 264 },
          ]
    )
    const found = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(query, noServer)
    expect(found.lyrics).toMatchObject({
      synced: true,
      text: '[00:02.00]Synced',
    })
  })

  it('keeps LRCLIB plain fallback and records a later search error', async () => {
    const { http } = fakeHttp((url) => {
      if (url.hostname !== 'lrclib.net') return {}
      return url.pathname.endsWith('/get')
        ? { plainLyrics: 'Plain fallback' }
        : new Error('search unavailable')
    })
    const found = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(query, noServer)
    expect(found.lyrics).toMatchObject({
      source: 'lrclib',
      synced: false,
      text: 'Plain fallback',
    })
    expect(found.errors).toEqual({ lrclib: 'search unavailable' })
  })

  it.each([
    'Song (Instrumental)',
    'Song - Off Vocal',
    'Song (Karaoke)',
    'Song（Inst.）',
  ])('skips every provider for %s', async (title) => {
    const { http, calls } = fakeHttp(() => {
      throw new Error('must not request')
    })
    const catalogCalls: string[] = []
    expect(
      await createLyricsFinder({
        http,
        catalog: fakeCatalog(
          { plain: 'Vocal lyrics', timed: null, source: null },
          catalogCalls
        ),
      }).find({ ...query, title }, lyricServer)
    ).toEqual({ lyrics: null, spotifyTrackId: 'known', errors: {} })
    expect(calls).toEqual([])
    expect(catalogCalls).toEqual([])
  })

  it.each([
    'Live',
    'TV Size',
    'Remix',
    'Acoustic',
    'Cover',
    'Demo',
    'New Recording',
  ])('rejects %s differences in either direction', async (qualifier) => {
    for (const [local, candidate] of [
      [`Halo (${qualifier})`, 'Halo'],
      ['Halo', `Halo (${qualifier})`],
    ]) {
      const { http } = fakeHttp((url) =>
        url.pathname.endsWith('/get')
          ? { trackName: candidate, syncedLyrics: '[00:01.00]Wrong' }
          : []
      )
      const found = await createLyricsFinder({
        http,
        catalog: fakeCatalog(null, []),
      }).find({ ...query, title: local }, noServer)
      expect(found.lyrics).toBeNull()
    }
  })

  it('finds the native half of a bilingual title and uses the native artist variant', async () => {
    const { http, calls } = fakeHttp((url) => {
      const title = url.searchParams.get('track_name')
      const artist = url.searchParams.get('artist_name')
      return title === '相聞詩' && artist === 'そこに鳴る'
        ? { syncedLyrics: '[00:01.00]言葉' }
        : url.pathname.endsWith('/get')
          ? new HttpError('not found', 'permanent', 404)
          : []
    })
    const found = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(
      {
        ...query,
        title: '相聞詩 - Soumonka',
        artists: [{ name: 'Sokoninaru', channelId: 'channel' }],
        artistVariants: ['そこに鳴る'],
      },
      noServer
    )
    expect(found.lyrics).toMatchObject({ source: 'lrclib', synced: true })
    expect(
      calls.some(
        (call) => call.url.searchParams.get('artist_name') === 'そこに鳴る'
      )
    ).toBe(true)
    expect(
      prepareLyricsQuery({ ...query, title: '相聞詩 - Soumonka (Live)' }).titles
    ).toEqual(['相聞詩 - Soumonka (Live)'])
  })

  it('rejects Spotify candidates outside three seconds and mismatched versions', async () => {
    const { http } = fakeHttp(() =>
      spotifyResults([
        { id: 'wrong-duration', title: 'Halo', duration: 264.01 },
        { id: 'wrong-version', title: 'Halo (Live)', duration: 261 },
        { id: 'right', title: 'Halo', duration: 264 },
      ])
    )
    expect(
      await createSpotifyClient(http).search(prepareLyricsQuery(query))
    ).toBe('right')
  })

  it('searches native title and native artist variants on Spotify', async () => {
    const { http, calls } = fakeHttp((_url, options) => {
      const body = options.body
        ? (JSON.parse(String(options.body)) as {
            variables: { searchTerm: string }
          })
        : null
      return spotifyResults(
        body?.variables.searchTerm === '相聞詩 そこに鳴る'
          ? [
              {
                id: 'native',
                title: '相聞詩',
                artist: 'そこに鳴る',
                duration: 261,
              },
            ]
          : []
      )
    })
    expect(
      await createSpotifyClient(http).search(
        prepareLyricsQuery({
          ...query,
          title: '相聞詩 - Soumonka',
          artistVariants: ['そこに鳴る'],
        })
      )
    ).toBe('native')
    expect(
      calls.filter((call) => call.url.pathname.endsWith('/query'))
    ).toHaveLength(4)
  })

  it('tries a different best Spotify candidate after a saved ID has only plain lyrics', async () => {
    const { http, calls } = fakeHttp((url) =>
      url.hostname === 'lyrics.example'
        ? {
            lines: [
              {
                words: 'words',
                ...(url.searchParams.get('trackid') === 'alternate'
                  ? { timeTag: '00:01.00' }
                  : {}),
              },
            ],
          }
        : spotifyResults([
            { id: 'known', title: 'Halo', duration: 261 },
            { id: 'alternate', title: 'Halo', duration: 261 },
          ])
    )
    const found = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(query, lyricServer)
    expect(found.lyrics).toMatchObject({ source: 'spotify', synced: true })
    expect(found.spotifyTrackId).toBe('alternate')
    expect(
      calls.filter((call) => call.url.pathname.endsWith('/query'))
    ).toHaveLength(1)
  })

  it('rejects a high-scoring Spotify alternate with a different title', async () => {
    const { http, calls } = fakeHttp((url) =>
      url.hostname === 'lyrics.example'
        ? { lines: [{ words: 'Saved plain' }] }
        : url.hostname === 'lrclib.net'
          ? []
          : spotifyResults([{ id: 'wrong', title: 'Blue Star', duration: 261 }])
    )
    const found = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find({ ...query, title: 'Blue Moon' }, lyricServer)
    expect(found.spotifyTrackId).toBe('known')
    expect(found.lyrics?.text).toBe('Saved plain')
    expect(
      calls.filter((call) => call.options.host === 'lyrics-server')
    ).toHaveLength(1)
  })

  it('still remembers an initial Spotify ID when it supplies plain lyrics', async () => {
    const { http } = fakeHttp((url) =>
      url.hostname === 'lyrics.example'
        ? { lines: [{ words: 'Initial plain' }] }
        : url.hostname === 'lrclib.net'
          ? []
          : spotifyResults([{ id: 'initial', title: 'Halo', duration: 261 }])
    )
    const found = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find({ ...query, spotifyTrackId: null }, lyricServer)
    expect(found.spotifyTrackId).toBe('initial')
    expect(found.lyrics).toMatchObject({
      text: 'Initial plain',
      synced: false,
      source: 'spotify',
    })
  })

  it.each([
    'plain',
    'missing',
    'error',
  ])('keeps the saved Spotify ID and plain lyrics when alternate lyrics are %s', async (kind) => {
    const { http } = fakeHttp((url) => {
      if (url.hostname === 'lyrics.example') {
        if (url.searchParams.get('trackid') === 'known')
          return { lines: [{ words: 'Saved plain' }] }
        if (kind === 'missing')
          return new HttpError('missing', 'permanent', 404)
        if (kind === 'error') return new Error('alternate failed')
        return { lines: [{ words: 'Alternate plain' }] }
      }
      if (url.hostname === 'lrclib.net') return []
      return spotifyResults([
        { id: 'alternate', title: 'HALO!', duration: 261 },
      ])
    })
    const found = await createLyricsFinder({
      http,
      catalog: fakeCatalog(null, []),
    }).find(query, lyricServer)
    expect(found.spotifyTrackId).toBe('known')
    expect(found.lyrics).toMatchObject({
      source: 'spotify',
      synced: false,
      text: 'Saved plain',
    })
    expect(found.errors).toEqual(
      kind === 'error' ? { spotify: 'alternate failed' } : {}
    )
  })

  it('stops Spotify variants at the first accepted candidate', async () => {
    const { http, calls } = fakeHttp(() =>
      spotifyResults([
        { id: 'first', title: '相聞詩 - Soumonka', duration: 261 },
      ])
    )
    expect(
      await createSpotifyClient(http).search(
        prepareLyricsQuery({
          ...query,
          title: '相聞詩 - Soumonka',
          artistVariants: ['日本名'],
        })
      )
    ).toBe('first')
    expect(
      calls.filter((call) => call.url.pathname.endsWith('/query'))
    ).toHaveLength(1)
  })

  it('reports GraphQL and HTTP-200 lyric errors', async () => {
    const graphql = fakeHttp(() => ({ errors: [{ message: 'expired' }] }))
    await expect(
      createSpotifyClient(graphql.http).search(prepareLyricsQuery(query))
    ).rejects.toThrow('expired')
    const lyrics = fakeHttp(() => ({ error: 'unauthorized' }))
    await expect(
      createSpotifyClient(lyrics.http).lyrics(
        'known',
        lyricServer.lyricsServerUrl
      )
    ).rejects.toThrow('unauthorized')
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
