import { BrowserWindow, session as electronSession } from 'electron'
import type { SpotifySessionView } from '../../shared/ipc'
import type { HttpClient } from '../net/http'
import { createSpotifyLibrary } from '../spotify/library'
import { createSpotifyToken, SpotifyAuthError, WEB } from '../spotify/token'

const PARTITION = 'persist:spotify'

/** The app's own Spotify Account. Sign-out leaves its last successful likes intact. */
export class SpotifySession {
  private readonly partition = electronSession.fromPartition(PARTITION)
  private gen = 0
  private current: SpotifySessionView = {
    state: 'checking',
    account: null,
    message: null,
  }
  private signInWindow: BrowserWindow | null = null
  private readonly token
  readonly library

  constructor(
    private readonly options: {
      http: HttpClient
      onChange: (view: SpotifySessionView) => void
    }
  ) {
    this.token = createSpotifyToken(options.http, {
      userAgent: this.partition.getUserAgent(),
      cookies: async () => {
        const cookies = await this.partition.cookies.get({ url: WEB })
        if (!cookies.some((cookie) => cookie.name === 'sp_dc'))
          throw new SpotifyAuthError('Not signed in to Spotify')
        return cookies
          .filter((cookie) => cookie.name === 'sp_dc' || cookie.name === 'sp_t')
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join('; ')
      },
      onExpired: () => {
        this.gen += 1
        this.current = {
          state: 'signed_out',
          account: null,
          message: 'Your Spotify session has expired. Sign in again.',
        }
        this.emit()
      },
    })
    this.library = createSpotifyLibrary(options.http, this.token, {
      userAgent: this.partition.getUserAgent(),
      deviceId: async () =>
        (await this.partition.cookies.get({ url: WEB, name: 'sp_t' }))[0]
          ?.value ?? null,
    })
  }
  generation() {
    return this.gen
  }
  accountId() {
    return this.current.state === 'signed_in'
      ? (this.current.account?.id ?? null)
      : null
  }
  view(): SpotifySessionView {
    return this.current
  }
  private emit() {
    this.options.onChange(this.view())
    return this.view()
  }
  setLikedCount(accountId: string, count: number) {
    if (this.current.account?.id === accountId) {
      this.current = {
        ...this.current,
        account: { ...this.current.account, likedCount: count },
      }
      this.emit()
    }
  }
  async refresh(): Promise<SpotifySessionView> {
    const generation = this.gen
    try {
      const cookies = await this.partition.cookies.get({
        url: WEB,
        name: 'sp_dc',
      })
      if (generation !== this.gen) return this.view()
      if (!cookies.length) {
        this.current = { state: 'signed_out', account: null, message: null }
      } else {
        const account = await this.library.account()
        if (generation !== this.gen) return this.view()
        this.current = {
          state: 'signed_in',
          account: {
            id: account.id,
            name: account.name,
            likedCount:
              this.current.account?.id === account.id
                ? (this.current.account?.likedCount ?? null)
                : null,
          },
          message: null,
        }
      }
    } catch (error) {
      if (generation !== this.gen) return this.view()
      this.current = {
        state: error instanceof SpotifyAuthError ? 'signed_out' : 'error',
        account: null,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    return this.emit()
  }
  openSignIn(): Promise<SpotifySessionView> {
    if (this.signInWindow && !this.signInWindow.isDestroyed()) {
      this.signInWindow.focus()
      return Promise.resolve(this.view())
    }
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 480,
        height: 720,
        title: 'Sign in to Spotify',
        backgroundColor: '#000',
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          sandbox: true,
        },
      })
      this.signInWindow = win
      const finish = async (url: string) => {
        if (new URL(url).host !== 'open.spotify.com') return
        if (
          (await this.partition.cookies.get({ url: WEB, name: 'sp_dc' }))
            .length &&
          !win.isDestroyed()
        )
          win.close()
      }
      win.webContents.on('did-navigate', (_event, url) => void finish(url))
      win.webContents.on(
        'did-navigate-in-page',
        (_event, url) => void finish(url)
      )
      win.on('closed', () => {
        if (this.signInWindow !== win) {
          resolve(this.view())
          return
        }
        this.signInWindow = null
        this.gen += 1
        this.token.invalidate()
        void this.refresh().then(resolve)
      })
      void win.loadURL(
        'https://accounts.spotify.com/login?continue=https://open.spotify.com/'
      )
    })
  }
  async signOut(): Promise<SpotifySessionView> {
    this.gen += 1
    this.token.invalidate()
    this.current = { state: 'signed_out', account: null, message: null }
    const win = this.signInWindow
    this.signInWindow = null
    win?.close()
    await this.partition.clearStorageData()
    return this.emit()
  }
}
