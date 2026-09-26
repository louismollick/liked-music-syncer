import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  BrowserWindow,
  session as electronSession,
  type Session,
} from 'electron'
import type { AccountView, SessionView } from '../../shared/ipc'
import { createInnertubeTransport } from '../catalog/transport'
import type { InnertubeTransport } from '../catalog/types'
import { type HttpClient, HttpError } from '../net/http'
import type { SettingsStore } from '../settings'
import {
  cookieHeader,
  parseAccountMenu,
  type SimpleCookie,
  sapisidFrom,
  sapisidHash,
  YTM_ORIGIN,
} from './headers'

const PARTITION = 'persist:ytmusic'
const MAX_SLOTS = 5

interface SlotAccount extends AccountView {
  slot: number
}

/**
 * Google Session: the app's own persistent Electron session (ADR 0004). The
 * app never reads installed browsers' cookies, except the dev-only importer
 * used for automated verification when the app is not packaged.
 */
export class GoogleSession {
  private readonly partition: Session
  private accounts: SlotAccount[] = []
  private state: SessionView['state'] = 'checking'
  private message: string | null = null
  private gen = 0
  private signInWindow: BrowserWindow | null = null
  readonly transport: InnertubeTransport

  constructor(
    private readonly options: {
      http: HttpClient
      settings: SettingsStore
      isPackaged: boolean
      onChange: (view: SessionView) => void
      /** Called when a background re-probe succeeds (e.g. the network came back). */
      onRecovered?: () => void
    }
  ) {
    this.partition = electronSession.fromPartition(PARTITION)
    this.transport = createInnertubeTransport({
      http: options.http,
      auth: { headers: () => this.headers() },
    })
  }

  generation(): number {
    return this.gen
  }

  accountId(): string | null {
    if (this.state !== 'signed_in') return null
    return this.selected()?.id ?? null
  }

  private selected(): SlotAccount | undefined {
    const wanted = this.options.settings.get().selectedAccountId
    // Never fall back to another account when the chosen one is missing from a
    // probe: checking the wrong account's likes would flag the library unwanted.
    if (wanted) return this.accounts.find((account) => account.id === wanted)
    return this.accounts[0]
  }

  view(): SessionView {
    return {
      state: this.state,
      accounts: this.accounts.map(({ slot: _slot, ...account }) => account),
      selectedAccountId: this.selected()?.id ?? null,
      message: this.message,
    }
  }

  private async cookies(): Promise<SimpleCookie[]> {
    const cookies = await this.partition.cookies.get({ url: YTM_ORIGIN })
    return cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
    }))
  }

  private async headersForSlot(slot: number): Promise<Record<string, string>> {
    const cookies = await this.cookies()
    const sapisid = sapisidFrom(cookies)
    if (!sapisid)
      throw Object.assign(new Error('Not signed in to YouTube Music'), {
        kind: 'permanent',
      })
    return {
      cookie: cookieHeader(cookies),
      authorization: sapisidHash(sapisid, Math.floor(Date.now() / 1000)),
      'x-goog-authuser': String(slot),
    }
  }

  async headers(): Promise<Record<string, string>> {
    return this.headersForSlot(this.selected()?.slot ?? 0)
  }

  async init(): Promise<void> {
    if (
      !this.options.isPackaged &&
      process.env.LMS_DEV_IMPORT_COOKIES === 'zen'
    ) {
      try {
        const imported = await this.importZenCookies()
        console.log(`[session] dev: imported ${imported} cookies from Zen`)
      } catch (error) {
        console.warn('[session] dev cookie import failed', error)
      }
    }
    await this.refresh()
  }

  /** Probes account slots and updates the session state. */
  async refresh(): Promise<SessionView> {
    this.state = 'checking'
    this.emit()
    try {
      const cookies = await this.cookies()
      if (!sapisidFrom(cookies)) {
        this.accounts = []
        this.state = 'signed_out'
        this.message = null
        return this.emit()
      }
      const found: SlotAccount[] = []
      let partial = false
      for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
        const transport = createInnertubeTransport({
          http: this.options.http,
          auth: { headers: () => this.headersForSlot(slot) },
        })
        let parsed: ReturnType<typeof parseAccountMenu> = null
        try {
          parsed = parseAccountMenu(
            await transport.call({
              endpoint: 'account/account_menu',
              body: {},
              authenticated: true,
            })
          )
        } catch (error) {
          // 4xx: this slot has no account. Anything else (offline, 5xx): try again later.
          if (error instanceof HttpError && error.kind === 'permanent') break
          partial = true
          continue
        }
        if (!parsed) break
        if (
          !parsed.channelId ||
          found.some((account) => account.id === parsed!.channelId)
        )
          continue
        found.push({
          id: parsed.channelId,
          name: parsed.name,
          handle: parsed.handle,
          photoUrl: parsed.photoUrl,
          likedCount: null,
          slot,
        })
      }
      this.accounts = found
      this.state = found.length ? 'signed_in' : 'error'
      this.message = found.length
        ? null
        : partial
          ? 'Could not reach YouTube Music. Trying again shortly.'
          : 'Signed in, but no YouTube Music account with a channel was found.'
      const current = this.options.settings.get().selectedAccountId
      // Only pick a default from a complete probe.
      if (
        !partial &&
        found.length &&
        !found.some((account) => account.id === current)
      ) {
        this.options.settings.update({ selectedAccountId: found[0].id })
        this.gen += 1
      }
      if (partial) this.scheduleRetry()
      else this.retryDelayMs = 60_000
    } catch (error) {
      this.state = 'error'
      this.message = error instanceof Error ? error.message : String(error)
      this.scheduleRetry()
    }
    return this.emit()
  }

  private retryDelayMs = 60_000
  private retryTimer: NodeJS.Timeout | null = null

  /** Re-probe after a failed or partial probe, backing off up to 10 minutes. */
  private scheduleRetry(): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.refresh().then((view) => {
        if (view.state === 'signed_in') this.options.onRecovered?.()
      })
    }, this.retryDelayMs)
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 10 * 60_000)
  }

  private emit(): SessionView {
    const view = this.view()
    this.options.onChange(view)
    return view
  }

  setLikedCount(accountId: string, count: number | null): void {
    const account = this.accounts.find((a) => a.id === accountId)
    if (account && account.likedCount !== count) {
      account.likedCount = count
      this.emit()
    }
  }

  async selectAccount(id: string): Promise<SessionView> {
    if (!this.accounts.some((account) => account.id === id))
      throw new Error('Unknown account')
    this.options.settings.update({ selectedAccountId: id })
    this.gen += 1
    return this.emit()
  }

  openSignIn(): Promise<SessionView> {
    if (this.signInWindow && !this.signInWindow.isDestroyed()) {
      this.signInWindow.focus()
      return Promise.resolve(this.view())
    }
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 480,
        height: 720,
        title: 'Sign in to YouTube Music',
        backgroundColor: '#0b0b0c',
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          sandbox: true,
        },
      })
      this.signInWindow = win
      const finish = async () => {
        if (!win.isDestroyed()) win.close()
      }
      win.webContents.on('did-navigate', async (_event, url) => {
        if (
          new URL(url).host === 'music.youtube.com' &&
          sapisidFrom(await this.cookies())
        )
          void finish()
      })
      win.on('closed', async () => {
        this.signInWindow = null
        this.gen += 1
        resolve(await this.refresh())
      })
      void win.loadURL(
        `https://accounts.google.com/ServiceLogin?service=youtube&continue=${encodeURIComponent(`${YTM_ORIGIN}/`)}`
      )
    })
  }

  async signOut(): Promise<SessionView> {
    await this.partition.clearStorageData()
    this.accounts = []
    this.gen += 1
    this.options.settings.update({ selectedAccountId: null })
    return this.refresh()
  }

  /** Dev only: copies YouTube/Google cookies from the newest Zen profile into the partition. */
  private async importZenCookies(): Promise<number> {
    const profilesDir = path.join(
      homedir(),
      'Library',
      'Application Support',
      'zen',
      'Profiles'
    )
    const profiles = readdirSync(profilesDir)
      .map((name) => path.join(profilesDir, name, 'cookies.sqlite'))
      .filter((file) => existsSync(file))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    if (!profiles[0]) throw new Error('No Zen profile with cookies found')
    const dir = mkdtempSync(path.join(tmpdir(), 'lms-zen-'))
    try {
      const copy = path.join(dir, 'cookies.sqlite')
      copyFileSync(profiles[0], copy)
      for (const ext of ['-wal', '-shm'])
        if (existsSync(profiles[0] + ext))
          copyFileSync(profiles[0] + ext, copy + ext)
      const db = new Database(copy, { readonly: true })
      const rows = db
        .prepare(
          `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies
           WHERE host LIKE '%youtube.com' OR host LIKE '%google.com'`
        )
        .all() as Array<{
        name: string
        value: string
        host: string
        path: string
        expiry: number
        isSecure: number
        isHttpOnly: number
        sameSite: number
      }>
      db.close()
      let count = 0
      for (const row of rows) {
        if (row.name.startsWith('ST-')) continue
        const host = row.host.replace(/^\./, '')
        try {
          await this.partition.cookies.set({
            url: `https://${host}${row.path || '/'}`,
            name: row.name,
            value: row.value,
            domain: row.host.startsWith('.') ? row.host : undefined,
            path: row.path || '/',
            secure: Boolean(row.isSecure),
            httpOnly: Boolean(row.isHttpOnly),
            expirationDate:
              row.expiry > 1e11 ? Math.floor(row.expiry / 1000) : row.expiry,
            sameSite:
              row.sameSite === 2
                ? 'strict'
                : row.sameSite === 1
                  ? 'lax'
                  : 'no_restriction',
          })
          count += 1
        } catch {
          // Skip cookies Chromium rejects (e.g. invalid prefixes).
        }
      }
      return count
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
