import { beforeEach, expect, it, vi } from 'vitest'
import { createHttpClient } from '../../src/main/net/http'
import { SpotifySession } from '../../src/main/session/spotify-session'

interface SignInWindow {
  url: string
  options: { webPreferences: { partition: string } }
  webContents: { emit(event: string, ...args: unknown[]): boolean }
  close(): void
  isDestroyed(): boolean
}
const state = vi.hoisted(() => ({
  cookies: [] as { name: string; value: string }[],
  windows: [] as SignInWindow[],
  partitions: [] as string[],
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    url = ''
    destroyed = false
    webContents = new EventEmitter()
    constructor(readonly options: SignInWindow['options']) {
      super()
      state.windows.push(this)
    }
    focus() {}
    isDestroyed() {
      return this.destroyed
    }
    close() {
      this.destroyed = true
      this.emit('closed')
    }
    async loadURL(url: string) {
      this.url = url
    }
  }
  return {
    BrowserWindow: Window,
    session: {
      fromPartition: (partition: string) => {
        state.partitions.push(partition)
        return {
          getUserAgent: () => 'Honest Electron',
          cookies: {
            get: async (filter: { name?: string }) =>
              state.cookies.filter(
                (cookie) => !filter.name || cookie.name === filter.name
              ),
          },
          clearStorageData: async () => {
            state.cookies = []
          },
        }
      },
    },
  }
})
beforeEach(() => {
  state.cookies = []
  state.windows = []
  state.partitions = []
})
function session() {
  const calls: { url: string; headers: HeadersInit | undefined }[] = []
  const http = createHttpClient(
    async (url, init) => {
      calls.push({ url, headers: init?.headers })
      if (url.includes('secretDict')) return Response.json({ 1: [12] })
      if (url.includes('server-time'))
        return Response.json({ serverTime: 1800000000 })
      if (url.includes('/api/token'))
        return Response.json({
          accessToken: 'signed',
          accessTokenExpirationTimestampMs: Date.now() + 3600000,
          isAnonymous: false,
        })
      if (url.includes('/query'))
        return Response.json({
          data: {
            me: { profile: { username: 'account', name: 'Display Name' } },
          },
        })
      return new Response(
        `<script id="appServerConfig" type="text/plain">${Buffer.from(JSON.stringify({ clientVersion: '1' })).toString('base64')}</script>`
      )
    },
    Date.now,
    async () => {}
  )
  return { session: new SpotifySession({ http, onChange: () => {} }), calls }
}
it('uses a separate persistent partition and the honest Electron agent for signed-in account probes', async () => {
  state.cookies = [
    { name: 'sp_dc', value: 'secret' },
    { name: 'sp_t', value: 'device' },
  ]
  const s = session()
  expect((await s.session.refresh()).account).toEqual({
    id: 'account',
    name: 'Display Name',
    likedCount: null,
  })
  expect(state.partitions).toEqual(['persist:spotify'])
  const request = s.calls.find((call) => call.url.includes('/api/token'))!
  expect(request.headers).toMatchObject({
    'User-Agent': 'Honest Electron',
    Cookie: 'sp_dc=secret; sp_t=device',
  })
  s.session.setLikedCount('account', 42)
  expect(s.session.view().account?.likedCount).toBe(42)
  const generation = s.session.generation()
  await s.session.signOut()
  expect(s.session.accountId()).toBeNull()
  expect(s.session.generation()).toBeGreaterThan(generation)
})
it('keeps the login window open despite an old sp_dc cookie until navigation reaches the web player', async () => {
  state.cookies = [{ name: 'sp_dc', value: 'expired' }]
  const s = session()
  const result = s.session.openSignIn()
  const win = state.windows[0]
  expect(win.options.webPreferences.partition).toBe('persist:spotify')
  expect(win.url).toBe(
    'https://accounts.spotify.com/login?continue=https://open.spotify.com/'
  )
  win.webContents.emit('did-navigate', {}, win.url)
  await Promise.resolve()
  expect(win.isDestroyed()).toBe(false)
  win.webContents.emit('did-navigate', {}, 'https://open.spotify.com/')
  expect((await result).state).toBe('signed_in')
  expect(win.isDestroyed()).toBe(true)
})
it('sign-out closes an open login without racing a new account probe', async () => {
  state.cookies = [{ name: 'sp_dc', value: 'secret' }]
  const s = session()
  const result = s.session.openSignIn()
  await s.session.signOut()
  expect((await result).state).toBe('signed_out')
  expect(s.calls).toEqual([])
  expect(s.session.accountId()).toBeNull()
})
