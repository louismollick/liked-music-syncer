import { describe, expect, it, vi } from 'vitest'
import { enrichMusicBrainz } from '../../src/main/match/musicbrainz'
import type { Match } from '../../src/main/match/types'
import {
  createHttpClient,
  type HttpClient,
  HttpError,
} from '../../src/main/net/http'
import genres from '../fixtures/match/musicbrainz-genres.json'
import recordings from '../fixtures/match/musicbrainz-recordings.json'

const match: Match = {
  version: 1,
  sourceVideoId: 'video',
  catalogVideoId: 'video',
  identityKey: 'MPRE1:video',
  release: {
    browseId: 'MPRE1',
    title: 'First Love',
    kind: 'album',
    artists: [{ name: '宇多田ヒカル', channelId: null }],
    year: 1999,
    date: '1999',
    trackNumber: 1,
    trackTotal: 12,
    discNumber: null,
    discTotal: null,
    thumbnailUrl: null,
  },
  title: 'First Love',
  artists: [{ name: '宇多田ヒカル', channelId: null }],
  album: 'First Love',
  albumArtist: '宇多田ヒカル',
  durationSeconds: 254,
  coverUrl: null,
  lyricsBrowseId: null,
  resolutionMethod: 'liked_album_exact',
}
describe('MusicBrainz enrichment', () => {
  it('selects the matching recording and ranked release group genres', async () => {
    const calls: { url: string; host: string; agent: string | undefined }[] = []
    const http = {
      json: async (
        url: string,
        options: { host: string; headers?: Record<string, string> }
      ) => {
        calls.push({
          url,
          host: options.host,
          agent: options.headers?.['User-Agent'],
        })
        return url.includes('/recording/') ? recordings : genres
      },
    } as unknown as HttpClient
    expect(await enrichMusicBrainz(http, match)).toEqual({
      mbRecordingId: 'recording-1',
      genre: 'pop; J-pop; R&B',
      isrc: 'JPTO09900001',
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toContain('/release-group/group-1')
    expect(
      calls.every(
        (call) =>
          call.host === 'musicbrainz' &&
          call.agent ===
            'LikedMusicSyncer/2.0 ( https://github.com/louismollick/liked-music-syncer )'
      )
    ).toBe(true)
  })
  it('falls back from release group to recording then artist', async () => {
    const calls: string[] = []
    const http = {
      json: async (url: string) => {
        calls.push(url)
        if (url.includes('/recording/'))
          return url.includes('query=') ? recordings : { genres: [] }
        if (url.includes('/release-group/')) return { genres: [] }
        return genres
      },
    } as unknown as HttpClient
    const result = await enrichMusicBrainz(http, match)
    expect(result.genre).toBe('pop; J-pop; R&B')
    expect(calls.at(-1)).toContain('/artist/artist-1')
  })
  it('returns nulls when no recording qualifies', async () => {
    const http = {
      json: async () => ({ recordings: [] }),
    } as unknown as HttpClient
    expect(await enrichMusicBrainz(http, match)).toEqual({
      mbRecordingId: null,
      genre: null,
      isrc: null,
    })
  })
  it('propagates HttpError from the shared scheduler', async () => {
    const failure = new HttpError('musicbrainz: offline', 'transient', null)
    const http = {
      json: vi.fn().mockRejectedValue(failure),
    } as unknown as HttpClient
    await expect(enrichMusicBrainz(http, match)).rejects.toBe(failure)
  })
  it('paces successive MusicBrainz requests in the HttpClient', async () => {
    let now = 0
    const slept: number[] = []
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ genres: [] }), { status: 200 })
    )
    const http = createHttpClient(
      fetch,
      () => now,
      async (ms) => {
        slept.push(ms)
        now += ms
      }
    )
    await http.json('https://musicbrainz.org/ws/2/recording/one', {
      host: 'musicbrainz',
    })
    await http.json('https://musicbrainz.org/ws/2/recording/two', {
      host: 'musicbrainz',
    })
    expect(slept).toEqual([1100])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
