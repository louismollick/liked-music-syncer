import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { YouTubeMusicCatalog } from '../../src/main/catalog/types'
import { createLyricsFinder } from '../../src/main/lyrics/finder'
import { petitLyrics } from '../../src/main/lyrics/petitlyrics'
import { prepareLyricsQuery } from '../../src/main/lyrics/query'
import type { LyricsQuery } from '../../src/main/lyrics/types'
import { createHttpClient } from '../../src/main/net/http'

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/lyrics/petit-${name}.xml`, import.meta.url),
    'utf8'
  )
const query: LyricsQuery = {
  title: '女の穴',
  artists: [{ name: 'MAMADRIVE', channelId: null }],
  album: null,
  durationSeconds: 208.45,
  lyricsBrowseId: null,
  spotifyTrackId: null,
}
const lineExpected =
  '[00:15.01]そこは深い深い深い私の穴\n[00:18.39]温かくて気持ち良いでしょう?\n[00:20.63]トロトロと溶けたあなたの愛も'

function httpFor(response: (tier: string | null) => string) {
  const calls: URLSearchParams[] = []
  const http = createHttpClient(
    async (_url, options) => {
      const body = new URLSearchParams(String(options?.body))
      calls.push(body)
      return new Response(response(body.get('lyricsType')))
    },
    Date.now,
    async () => {}
  )
  return { http, calls }
}

describe('PetitLyrics captures', () => {
  it.each([
    'plain',
    'synced',
  ])('stops variants after the first accepted %s result', async (kind) => {
    const { http, calls } = httpFor((tier) =>
      fixture(kind === 'plain' || tier === '1' ? 'plain' : 'line')
    )
    const result = await petitLyrics(
      http,
      prepareLyricsQuery({
        ...query,
        title: '女の穴 - Onna no Ana',
        artistVariants: ['別名'],
      })
    )
    expect(result).toBe(
      kind === 'synced'
        ? lineExpected
        : 'そこは深い深い深い私の穴\n温かくて気持ち良いでしょう?\nトロトロと溶けたあなたの愛も'
    )
    expect(calls.map((body) => body.get('key_title'))).toEqual(
      kind === 'plain'
        ? ['女の穴 - Onna no Ana']
        : ['女の穴 - Onna no Ana', '女の穴 - Onna no Ana']
    )
  })

  it.each([
    'plain',
    'synced',
  ])('continues past a malformed candidate to valid %s lyrics', async (kind) => {
    const good = fixture(kind === 'plain' ? 'plain' : 'line')
    const bad = good
      .match(/<song>[\s\S]*?<\/song>/)![0]
      .replace(
        /<lyricsData>.*?<\/lyricsData>/,
        `<lyricsData>${Buffer.from('MHDROBJT').toString('base64')}</lyricsData>`
      )
    const { http } = httpFor((tier) =>
      tier === '1' ? fixture('plain') : good.replace('<songs>', `<songs>${bad}`)
    )
    const result = await petitLyrics(http, prepareLyricsQuery(query))
    expect(result).toBe(
      kind === 'synced'
        ? lineExpected
        : 'そこは深い深い深い私の穴\n温かくて気持ち良いでしょう?\nトロトロと溶けたあなたの愛も'
    )
  })

  it('pairs line timings with plain text from the same lyrics ID', async () => {
    const { http, calls } = httpFor((tier) =>
      fixture(tier === '1' ? 'plain' : 'line')
    )
    expect(await petitLyrics(http, prepareLyricsQuery(query))).toBe(
      lineExpected
    )
    expect(calls.map((body) => body.get('lyricsType'))).toEqual(['3', '1'])
    expect(Object.fromEntries(calls[0])).toEqual({
      clientAppId: 'p1110417',
      terminalType: '10',
      lyricsType: '3',
      key_title: '女の穴',
      key_artist: 'MAMADRIVE',
      key_album: '',
    })
  })

  it('reduces word timings to valid line LRC', async () => {
    const { http, calls } = httpFor(() => fixture('word'))
    expect(
      await petitLyrics(
        http,
        prepareLyricsQuery({
          ...query,
          title: 'Breaker',
          artists: [{ name: 'East Of Eden', channelId: null }],
          durationSeconds: 235.008,
        })
      )
    ).toBe('[00:19.54]齧った赤林檎\n[00:21.86]かげった森のなか')
    expect(calls).toHaveLength(1)
  })

  it.each([
    'id',
    'count',
  ])('rejects a timing/text %s mismatch', async (kind) => {
    const plain =
      kind === 'id'
        ? fixture('plain').replace('3375697', 'other')
        : fixture('plain').replace(
            /<lyricsData>.*?<\/lyricsData>/,
            `<lyricsData>${Buffer.from('one line').toString('base64')}</lyricsData>`
          )
    const { http } = httpFor((tier) => (tier === '1' ? plain : fixture('line')))
    await expect(petitLyrics(http, prepareLyricsQuery(query))).rejects.toThrow(
      kind === 'id' ? 'ID mismatch' : 'line mismatch'
    )
  })

  it('rejects incompatible versions and durations before decoding', async () => {
    for (const xml of [
      fixture('line').replace(
        '<title>女の穴</title>',
        '<title>女の穴 (Live)</title>'
      ),
      fixture('line').replace('208450', '212000'),
    ]) {
      const { http, calls } = httpFor(() => xml)
      expect(await petitLyrics(http, prepareLyricsQuery(query))).toBeNull()
      expect(calls).toHaveLength(1)
    }
  })

  it('runs after LRCLIB and wins over its plain fallback', async () => {
    const hosts: string[] = []
    const http = createHttpClient(
      async (raw, options) => {
        const url = new URL(raw)
        hosts.push(url.hostname)
        if (url.hostname === 'lrclib.net')
          return Response.json(
            url.pathname.endsWith('/get')
              ? {
                  trackName: query.title,
                  artistName: 'MAMADRIVE',
                  duration: 208.45,
                  plainLyrics: 'plain',
                }
              : []
          )
        return new Response(
          fixture(
            new URLSearchParams(String(options?.body)).get('lyricsType') === '1'
              ? 'plain'
              : 'line'
          )
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
    expect(found.lyrics).toMatchObject({
      synced: true,
      source: 'petitlyrics',
      text: lineExpected,
    })
    expect(found.errors).toEqual({})
    expect(hosts).toEqual([
      'lrclib.net',
      'lrclib.net',
      'p0.petitlyrics.com',
      'p0.petitlyrics.com',
    ])
  })

  it('reports provider errors', async () => {
    const { http } = httpFor(
      () => '<response><status>10000001</status></response>'
    )
    await expect(petitLyrics(http, prepareLyricsQuery(query))).rejects.toThrow(
      '10000001'
    )
  })
})
