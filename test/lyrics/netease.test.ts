import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { YouTubeMusicCatalog } from '../../src/main/catalog/types'
import { createLyricsFinder } from '../../src/main/lyrics/finder'
import {
  neteaseLyrics,
  stripNeteaseCredits,
} from '../../src/main/lyrics/netease'
import { prepareLyricsQuery } from '../../src/main/lyrics/query'
import type { LyricsQuery } from '../../src/main/lyrics/types'
import { createHttpClient } from '../../src/main/net/http'

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/lyrics/${name}.json`, import.meta.url),
      'utf8'
    )
  )
const search = fixture('netease-search')
const lyric = fixture('netease-lyric')
const query: LyricsQuery = {
  title: '夜に駆ける - Racing into the Night',
  artists: [{ name: 'YOASOBI', channelId: null }],
  album: null,
  durationSeconds: 261,
  lyricsBrowseId: null,
  spotifyTrackId: null,
}
const expected =
  '[00:01.430]沈むように溶けてゆくように\n[00:08.831]二人だけの空が広がる夜に\n[00:21.295]\n[00:31.481]「さよなら」だけだった'

/** Serves the fixtures; `songs` narrows which search hits exist. */
function fake(
  options: {
    songs?: (id: number) => boolean
    lyric?: unknown
    status?: number
    firstSearchEmpty?: boolean
  } = {}
) {
  const requests: { url: string; method: string; body: string | null }[] = []
  const http = createHttpClient(
    async (raw, init) => {
      const url = new URL(raw)
      requests.push({
        url: raw,
        method: init?.method ?? 'GET',
        body: init?.body ? String(init.body) : null,
      })
      if (options.status)
        return new Response('down', { status: options.status })
      if (url.pathname === '/api/search/get') {
        const first = requests.filter((r) => r.body).length === 1
        const songs = search.result.songs.filter((song: { id: number }) =>
          (options.songs ?? (() => true))(song.id)
        )
        return Response.json(
          first && options.firstSearchEmpty
            ? { code: 200, result: { songCount: 0 } }
            : { code: 200, result: { songs } }
        )
      }
      return Response.json(options.lyric ?? lyric)
    },
    Date.now,
    async () => {}
  )
  return { http, requests }
}

describe('NetEase lyrics', () => {
  it('searches by native title and artist, strips credits and ignores translations', async () => {
    const { http, requests } = fake()
    const result = await neteaseLyrics(http, prepareLyricsQuery(query))
    expect(result).toBe(expected)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://music.163.com/api/search/get',
      body: new URLSearchParams({
        s: '夜に駆ける YOASOBI',
        type: '1',
        limit: '10',
      }).toString(),
    })
    expect(requests.slice(1).map((r) => r.url)).toEqual([
      'https://music.163.com/api/song/lyric?id=1409311773&lv=1&tv=-1',
    ])
  })

  it('falls back to the native title alone', async () => {
    const { http, requests } = fake({ firstSearchEmpty: true })
    const result = await neteaseLyrics(http, prepareLyricsQuery(query))
    expect(result).toBe(expected)
    const terms = requests
      .filter((r) => r.body)
      .map((r) => new URLSearchParams(r.body!).get('s'))
    expect(terms).toEqual(['夜に駆ける YOASOBI', '夜に駆ける'])
  })

  it('rejects a same-duration hit with a different title', async () => {
    const { http, requests } = fake({ songs: (id) => id === 5 })
    expect(await neteaseLyrics(http, prepareLyricsQuery(query))).toBeNull()
    expect(requests.every((r) => !r.url.includes('/song/lyric'))).toBe(true)
  })

  it('rejects a wrong artist, a duration over 3s off and an unknown duration', async () => {
    for (const [id, durationSeconds] of [
      [9, 261],
      [8, 261],
      [1409311773, null],
    ] as const) {
      const { http, requests } = fake({ songs: (value) => value === id })
      const result = await neteaseLyrics(
        http,
        prepareLyricsQuery({ ...query, durationSeconds })
      )
      expect(result).toBeNull()
      expect(requests.every((r) => !r.url.includes('/song/lyric'))).toBe(true)
    }
  })

  it("rejects a guest's own song for a collaboration query", async () => {
    const collab = prepareLyricsQuery({
      ...query,
      artists: [
        { name: 'Alpha', channelId: null },
        { name: 'Beta', channelId: null },
      ],
      artistVariants: ['Alpha, Beta'],
    })
    const serve = (credited: string) =>
      createHttpClient(
        async (raw) =>
          Response.json(
            raw.includes('/search/')
              ? {
                  code: 200,
                  result: {
                    songs: [
                      {
                        id: 1,
                        name: query.title,
                        artists: [{ name: credited }],
                        duration: 261_000,
                      },
                    ],
                  },
                }
              : lyric
          ),
        Date.now,
        async () => {}
      )
    // Beta's solo song, same title and length.
    expect(await neteaseLyrics(serve('Beta'), collab)).toBeNull()
    // The primary artist credited alone still matches.
    expect(await neteaseLyrics(serve('Alpha'), collab)).toBe(expected)
  })

  it('protects recording versions in the title, alias and album', async () => {
    // A studio query must not take a live title, nor an Instrumental alias.
    for (const id of [6, 7]) {
      const { http } = fake({ songs: (value) => value === id })
      expect(await neteaseLyrics(http, prepareLyricsQuery(query))).toBeNull()
    }
    // A live query matches the live version only.
    const live = prepareLyricsQuery({ ...query, title: '夜に駆ける (Live)' })
    expect(
      await neteaseLyrics(fake({ songs: (id) => id === 6 }).http, live)
    ).toBe(expected)
    expect(
      await neteaseLyrics(fake({ songs: (id) => id === 1409311773 }).http, live)
    ).toBeNull()
  })

  it('rejects a studio hit from a live album', async () => {
    const songs = structuredClone(search)
    songs.result.songs[0].album.name = 'Live at Budokan'
    const http = createHttpClient(
      async (raw) => Response.json(raw.includes('/search/') ? songs : lyric),
      Date.now,
      async () => {}
    )
    expect(await neteaseLyrics(http, prepareLyricsQuery(query))).toBeNull()
  })

  it('returns plain lyrics when nothing is timed', async () => {
    const { http } = fake({
      lyric: {
        code: 200,
        lrc: { lyric: '作词 : Ayase\n沈むように\n溶けてゆくように' },
      },
    })
    expect(await neteaseLyrics(http, prepareLyricsQuery(query))).toBe(
      '沈むように\n溶けてゆくように'
    )
  })

  it('treats an empty or instrumental lyric as none', async () => {
    for (const text of ['', '[00:00.000]纯音乐，请欣赏']) {
      const { http } = fake({ lyric: { code: 200, lrc: { lyric: text } } })
      expect(await neteaseLyrics(http, prepareLyricsQuery(query))).toBeNull()
    }
  })

  it('strips leading credits only', () => {
    expect(
      stripNeteaseCredits(
        '[00:00.000] 原曲\t妖々跋扈\n[00:00.200] 版权支持 : Label\n[00:00.500] Lyrics by : A\n[00:00.900] Composed by : B\n[00:12.000]Hello: world\n[00:05.000]作词 : kept'
      )
    ).toBe('[00:12.000]Hello: world\n[00:05.000]作词 : kept')
  })

  it('keeps a sung line that looks like a credit', () => {
    expect(
      stripNeteaseCredits(
        '[00:00.000] 作词 : A\n[00:01.00]She said: hello\n[00:02.00]Produced by : kept'
      )
    ).toBe('[00:01.00]She said: hello\n[00:02.00]Produced by : kept')
    expect(stripNeteaseCredits('[00:01.00]She said: hello')).toBe(
      '[00:01.00]She said: hello'
    )
  })

  it('reports errors through the finder, after PetitLyrics', async () => {
    const hosts: string[] = []
    const http = createHttpClient(
      async (raw) => {
        const url = new URL(raw)
        hosts.push(url.hostname)
        if (url.hostname === 'music.163.com')
          return new Response('down', { status: 500 })
        if (url.hostname === 'lrclib.net') return Response.json([])
        return new Response(
          '<response><status>00000000</status><songs/></response>'
        )
      },
      Date.now,
      async () => {}
    )
    const catalog = {
      lyrics: async () => null,
    } as unknown as YouTubeMusicCatalog
    const found = await createLyricsFinder({ http, catalog }).find(query, {
      lyricsServerUrl: null,
    })
    expect(found.lyrics).toBeNull()
    expect(found.errors.netease).toContain('HTTP 500')
    expect(found.attempted).toEqual([
      'youtube-music',
      'lrclib',
      'petitlyrics',
      'netease',
    ])
    expect(hosts.indexOf('music.163.com')).toBeGreaterThan(
      hosts.lastIndexOf('p0.petitlyrics.com')
    )
  })
})
