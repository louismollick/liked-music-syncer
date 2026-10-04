import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createHttpClient } from '../../src/main/net/http'
import { createSpotifyLibrary } from '../../src/main/spotify/library'
import { createSpotifyToken } from '../../src/main/spotify/token'

const fixture = JSON.parse(
  readFileSync('test/fixtures/spotify/library.json', 'utf8')
) as {
  data: {
    me: { library: { tracks: { totalCount: number; items: unknown[] } } }
  }
}
function setup(reply: (body: Record<string, unknown>) => unknown | Response) {
  const bodies: Record<string, unknown>[] = []
  let tokens = 0
  const http = createHttpClient(
    async (url, init) => {
      if (url.includes('secretDict')) return Response.json({ 1: [12, 34] })
      if (url.includes('server-time'))
        return Response.json({ serverTime: 1800000000 })
      if (url.includes('/api/token')) {
        tokens++
        return Response.json({
          accessToken: 'signed',
          accessTokenExpirationTimestampMs: Date.now() + 3600000,
          isAnonymous: false,
          username: 'me',
        })
      }
      if (url.endsWith('/query')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        bodies.push(body)
        const result = reply(body)
        return result instanceof Response ? result : Response.json(result)
      }
      if (url.includes('bundle.js'))
        return new Response(
          `{name:"fetchLibraryTracks",sha256Hash:"${'a'.repeat(64)}"}`
        )
      return new Response(
        `<script id="appServerConfig" type="text/plain">${Buffer.from(JSON.stringify({ clientVersion: '1' })).toString('base64')}</script><script src="/bundle.js"></script>`
      )
    },
    Date.now,
    async () => {}
  )
  return {
    library: createSpotifyLibrary(
      http,
      createSpotifyToken(http, { cookies: async () => 'sp_dc=secret' })
    ),
    bodies,
    tokens: () => tokens,
  }
}
function page(items: unknown[], totalCount = 3) {
  return { data: { me: { library: { tracks: { items, totalCount } } } } }
}

describe('Spotify library', () => {
  it('pages by raw count, skips local/episode rows, and accepts both documented shapes and durations', async () => {
    const items = fixture.data.me.library.tracks.items
    const s = setup((body) => {
      const offset = (body.variables as { offset: number }).offset
      return offset === 0
        ? page(items.slice(0, 2))
        : {
            data: {
              me: { libraryTracks: { totalCount: 3, items: items.slice(2) } },
            },
          }
    })
    const result = await s.library.likedSongs()
    expect(
      result.tracks.map((track) => [
        track.trackId,
        track.position,
        track.durationMs,
      ])
    ).toEqual([
      ['one', 0, 200000],
      ['two', 2, 201000],
    ])
    expect(s.bodies.map((body) => body.variables)).toEqual([
      { offset: 0, limit: 50 },
      { offset: 2, limit: 50 },
    ])
    const episodes = setup(() =>
      page([{ track: { data: { uri: 'spotify:episode:podcast' } } }], 1)
    )
    expect((await episodes.library.likedSongs()).tracks).toEqual([])
  })
  it('rejects a premature empty page and malformed shapes', async () => {
    const s = setup((body) =>
      (body.variables as { offset: number }).offset === 0
        ? page(fixture.data.me.library.tracks.items.slice(0, 1))
        : page([])
    )
    await expect(s.library.likedSongs()).rejects.toThrow(
      'empty page before totalCount'
    )
    await expect(setup(() => ({})).library.likedSongs()).rejects.toThrow(
      'missing library tracks'
    )
    await expect(
      setup(() => page([{}], 1)).library.likedSongs()
    ).rejects.toThrow('malformed library track')
  })
  it('refreshes a missing persisted hash once and retries the same page', async () => {
    const s = setup((body) =>
      (body.extensions as { persistedQuery: { sha256Hash: string } })
        .persistedQuery.sha256Hash === 'a'.repeat(64)
        ? fixture
        : { errors: [{ message: 'PersistedQueryNotFound' }] }
    )
    expect((await s.library.likedSongs()).tracks).toHaveLength(2)
    expect(s.bodies).toHaveLength(2)
    const failure = setup(() => ({
      errors: [{ message: 'PersistedQueryNotFound' }],
    }))
    await expect(failure.library.likedSongs()).rejects.toThrow(
      'fetchLibraryTracks errors'
    )
    expect(failure.bodies).toHaveLength(2)
  })
  it('refreshes a 401 once and fails a 429 without replaying the request', async () => {
    let calls = 0
    const s = setup(() =>
      ++calls === 1 ? new Response('', { status: 401 }) : fixture
    )
    await s.library.likedSongs()
    expect(s.tokens()).toBe(2)
    const limited = setup(
      () =>
        new Response('', { status: 429, headers: { 'Retry-After': '86400' } })
    )
    await expect(limited.library.likedSongs()).rejects.toMatchObject({
      retryAfterMs: 86400000,
    })
    expect(limited.bodies).toHaveLength(1)
  })
  it('rejects anonymous tokens for signed-in calls and keeps anonymous caches separate', async () => {
    const cookies: (string | undefined)[] = []
    const http = createHttpClient(
      async (url, init) => {
        if (url.includes('secretDict')) return Response.json({ 1: [12] })
        if (url.includes('server-time'))
          return Response.json({ serverTime: 1800000000 })
        cookies.push((init?.headers as Record<string, string>).Cookie)
        return Response.json({
          accessToken: 'anonymous',
          accessTokenExpirationTimestampMs: Date.now() + 3600000,
          isAnonymous: true,
        })
      },
      Date.now,
      async () => {}
    )
    const anonymous = createSpotifyToken(http)
    expect((await anonymous.accessToken()).value).toBe('anonymous')
    await expect(
      createSpotifyToken(http, {
        cookies: async () => 'sp_dc=secret',
      }).accessToken()
    ).rejects.toThrow('expired')
    expect(cookies).toEqual([undefined, 'sp_dc=secret'])
  })
})
