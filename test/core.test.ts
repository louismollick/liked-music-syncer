import { describe, expect, it, vi } from 'vitest'
import { fetchLyricsLrc } from '../src/main/services/lyrics'
import {
  calculateSpotifyCandidateScore,
  SpotifyMatcher,
} from '../src/main/services/spotify-match'
import {
  buildLibraryPath,
  cleanYoutubeTitle,
  durationSimilarity,
  jaccardSimilarity,
  parseYoutubeDuration,
  sanitizePathSegment,
} from '../src/main/services/utils'

describe('utilities', () => {
  it('cleans youtube titles and preserves artist guess', () => {
    expect(cleanYoutubeTitle('YOASOBI - Idol (Official Video)')).toEqual({
      title: 'Idol',
      artistGuess: 'YOASOBI',
    })
  })

  it('sanitizes output paths deterministically', () => {
    expect(sanitizePathSegment('  YOASOBI / Idol: Live  ', '_')).toBe(
      'YOASOBI _ Idol_ Live'
    )
    expect(
      buildLibraryPath(
        '/music',
        'YOASOBI',
        '_Singles',
        'アイドル',
        '.m4a'
      ).endsWith('YOASOBI/_Singles/アイドル.m4a')
    ).toBe(true)
  })

  it('parses youtube durations and similarity scores', () => {
    expect(parseYoutubeDuration('PT3M34S')).toBe(214)
    expect(
      jaccardSimilarity('Island In The Sun', 'Island in the Sun')
    ).toBeGreaterThan(0.9)
    expect(durationSimilarity(214, 214)).toBe(1)
  })
})

describe('spotify matching', () => {
  it('scores close candidates higher', () => {
    const best = calculateSpotifyCandidateScore(
      { title: 'Idol', artist: 'YOASOBI', durationSec: 214 },
      { name: 'Idol', artists: ['YOASOBI'], durationMs: 214000 }
    )

    const weak = calculateSpotifyCandidateScore(
      { title: 'Idol', artist: 'YOASOBI', durationSec: 214 },
      {
        name: 'Different Song',
        artists: ['Another Artist'],
        durationMs: 120000,
      }
    )

    expect(best).toBeGreaterThan(weak)
  })

  it('matches spotify tracks through the anonymous web-player flow', async () => {
    const appConfig = Buffer.from(
      JSON.stringify({ clientVersion: '1.2.88.23.g657c2f0d' })
    ).toString('base64')

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input instanceof URL ? input : input.url || input)

      if (url === 'https://open.spotify.com') {
        return new Response(
          `<script id="appServerConfig" type="text/plain">${appConfig}</script>`,
          { status: 200, headers: { 'content-type': 'text/html' } }
        )
      }

      if (
        url ===
        'https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json'
      ) {
        return new Response(JSON.stringify({ 42: [1, 2, 3] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://open.spotify.com/api/server-time') {
        return new Response(JSON.stringify({ serverTime: 180 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url.startsWith('https://open.spotify.com/api/token?')) {
        return new Response(
          JSON.stringify({
            accessToken: 'anon-token',
            accessTokenExpirationTimestampMs: Date.now() + 60_000,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      }

      if (url === 'https://api-partner.spotify.com/pathfinder/v2/query') {
        expect(init?.method).toBe('POST')
        return new Response(
          JSON.stringify({
            data: {
              searchV2: {
                tracksV2: {
                  items: [
                    {
                      item: {
                        data: {
                          uri: 'spotify:track:best-track-id',
                          name: 'Island In The Sun',
                          artists: { items: [{ profile: { name: 'Weezer' } }] },
                          duration: { totalMilliseconds: 200306 },
                          albumOfTrack: { name: 'Weezer' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const matcher = new SpotifyMatcher(fetchMock)
    const result = await matcher.matchTrack(
      { title: 'Island In The Sun', artist: 'Weezer', durationSec: 200 },
      0.55
    )

    expect(result.spotifyTrackId).toBe('best-track-id')
    expect(result.candidateCount).toBe(1)
  })
})

describe('lyrics', () => {
  it('formats lyric api responses into lrc', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          lines: [
            { startTimeMs: '1200', words: 'line one' },
            { timeTag: '[00:02.00]', words: 'line two' },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    }) as typeof fetch

    const result = await fetchLyricsLrc(
      'track-id',
      'https://lyrics.example.test'
    )
    expect(result.lyrics).toContain('[00:01.20]line one')
    expect(result.syncedLines).toBe(2)

    globalThis.fetch = originalFetch
  })
})
