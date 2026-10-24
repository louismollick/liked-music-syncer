import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createLastfmGenres, lastfmGenres } from '../../src/main/match/lastfm'
import { createHttpClient } from '../../src/main/net/http'

const toptags = JSON.parse(
  readFileSync(
    new URL('../fixtures/lastfm-toptags.json', import.meta.url),
    'utf8'
  )
)

describe('Last.fm genres', () => {
  it('keeps real genres with enough votes, top three, in list spelling', () => {
    // "japanese" and "seen live" are not genres; "math rock" has 9 votes.
    expect(lastfmGenres(toptags)).toBe('rock; j-rock; post-punk')
    expect(
      lastfmGenres({
        toptags: {
          tag: [
            { name: 'Seen Live', count: 50 },
            { name: 'pop', count: '8' },
          ],
        },
      })
    ).toBeNull()
  })

  it('treats an unknown artist as no genres and other errors as failures', () => {
    expect(lastfmGenres({ error: 6, message: 'not found' })).toBeNull()
    expect(() =>
      lastfmGenres({ error: 10, message: 'Invalid API key' })
    ).toThrow('Last.fm error 10')
  })

  it('asks once per artist ID with the API key and no autocorrect', async () => {
    const urls: URL[] = []
    const http = createHttpClient(
      async (raw) => {
        urls.push(new URL(raw))
        return Response.json(toptags)
      },
      Date.now,
      async () => {}
    )
    const genres = createLastfmGenres(http)
    const tricot = { id: 'channel:UC-tricot', name: 'tricot' }
    expect(await genres.lookup(tricot, 'key')).toBe('rock; j-rock; post-punk')
    // Another spelling of the same trusted artist hits the cache.
    expect(await genres.lookup({ ...tricot, name: 'Tricot' }, 'key')).toBe(
      'rock; j-rock; post-punk'
    )
    expect(urls).toHaveLength(1)
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({
      method: 'artist.gettoptags',
      artist: 'tricot',
      api_key: 'key',
      autocorrect: '0',
      format: 'json',
    })
    genres.clear()
    await genres.lookup(tricot, 'key')
    expect(urls).toHaveLength(2)
  })

  it('does not share a cached answer between artists with the same name', async () => {
    const urls: URL[] = []
    const http = createHttpClient(
      async (raw) => {
        urls.push(new URL(raw))
        return Response.json(toptags)
      },
      Date.now,
      async () => {}
    )
    const genres = createLastfmGenres(http)
    await genres.lookup({ id: 'channel:a', name: 'Echo' }, 'key')
    await genres.lookup({ id: 'channel:b', name: 'Echo' }, 'key')
    expect(urls).toHaveLength(2)
  })

  it('does not cache a failure', async () => {
    let fail = true
    const http = createHttpClient(
      async () =>
        fail ? new Response('down', { status: 500 }) : Response.json(toptags),
      Date.now,
      async () => {}
    )
    const genres = createLastfmGenres(http)
    const tricot = { id: 'channel:UC-tricot', name: 'tricot' }
    await expect(genres.lookup(tricot, 'key')).rejects.toThrow('HTTP 500')
    fail = false
    expect(await genres.lookup(tricot, 'key')).toBe('rock; j-rock; post-punk')
  })
})
