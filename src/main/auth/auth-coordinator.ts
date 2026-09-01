import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type {
  AuthIssueCode,
  AuthIssueView,
  AuthRefreshReason,
  AuthSessionView,
  AuthSourceView,
  YouTubeMusicAccountView,
} from '@shared/contracts'
import type { ArtistPhotoCache } from '../services/artist-photo-cache'
import type { PythonWorkerService } from '../services/python-worker'
import type { SettingsService } from '../services/settings-service'
import {
  discoverInstalledBrowsers,
  type InstalledAuthSource,
} from './browser-registry'

const execFileAsync = promisify(execFile)
interface WorkerResult {
  ok: boolean
  is_authenticated: boolean
  message: string
  credential_json?: string
  issue_code?: string
  account?: {
    display_name?: string
    handle?: string | null
    image_url?: string | null
  }
  accounts?: Array<{
    display_name?: string
    handle?: string | null
    image_url?: string | null
    auth_user: number
    credential_json: string
  }>
}
type Listener = (snapshot: AuthSessionView) => void

const AUTH_ISSUES: Record<
  AuthIssueCode,
  { message: string; recovery: string }
> = {
  cookie_store_unreadable: {
    message: 'The browser cookie store could not be read.',
    recovery:
      'Fully quit the selected browser, reopen it, then retry. If the issue continues, check that its profile is readable.',
  },
  keychain_denied: {
    message: 'macOS did not allow access to the browser encryption key.',
    recovery: 'Allow Keychain access when macOS asks, then retry.',
  },
  permission_denied: {
    message: 'macOS denied access to the browser data.',
    recovery:
      'Open YouTube Music in this browser, confirm you are signed in, then retry.',
  },
  browser_profile_missing: {
    message: 'The selected browser profile could not be found.',
    recovery:
      'Open YouTube Music in this browser, confirm you are signed in, then retry.',
  },
  network_unavailable: {
    message: 'YouTube Music could not be reached.',
    recovery:
      'Open YouTube Music in this browser, confirm you are signed in, then retry.',
  },
  credential_rejected: {
    message: 'YouTube Music rejected the browser session.',
    recovery:
      'Open YouTube Music in this browser, confirm you are signed in, then retry.',
  },
  account_enumeration_failed: {
    message: 'The active YouTube Music identity could not be read.',
    recovery:
      'Open YouTube Music in this browser, confirm you are signed in, then retry.',
  },
  unexpected_response: {
    message: 'YouTube Music returned an unexpected response.',
    recovery:
      'Open YouTube Music in this browser, confirm you are signed in, then retry.',
  },
}

export class AuthCoordinator {
  private listeners = new Set<Listener>()
  private sources = new Map<string, InstalledAuthSource>()
  private rows = new Map<string, AuthSourceView>()
  private inFlight = new Map<string, Promise<void>>()
  private commitRequested = new Set<string>()
  private credentialsByAccountKey = new Map<string, string>()
  private countLoads = new Map<string, Promise<void>>()
  private snapshot: AuthSessionView = {
    state: 'loading',
    selectedSourceId: null,
    selectedAccountKey: null,
    activeAccount: null,
    sources: [],
    accounts: [],
    accountsComplete: false,
    isRefreshing: false,
    switchingDisabledReason: null,
    issue: null,
  }

  constructor(
    private settings: SettingsService,
    private worker: PythonWorkerService,
    private jobsBusy: () => Promise<boolean>,
    private preferredBrowserPath: () => Promise<string | null> = async () =>
      null,
    private accountImageCache?: Pick<
      ArtistPhotoCache,
      'resolvePhotoUrl' | 'cacheRemotePhoto'
    >
  ) {}
  getSnapshot = () => this.snapshot
  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(patch: Partial<AuthSessionView> = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      sources: [...this.rows.values()],
    }
    for (const listener of this.listeners) listener(this.snapshot)
  }

  async bootstrap() {
    await this.discover()
    if (!this.sources.size) {
      this.publish({ state: 'no_supported_browser', isRefreshing: false })
      return this.snapshot
    }
    const persisted = await this.settings.getAuthSelection()
    const persistedAccount = persisted.account
      ? {
          ...persisted.account,
          likedSongCount: null,
          likedSongCountState: 'unrequested' as const,
        }
      : null
    const selected =
      persisted.sourceId && this.sources.has(persisted.sourceId)
        ? persisted.sourceId
        : await this.fallbackSourceId()
    this.publish({
      selectedSourceId: selected,
      activeAccount: persistedAccount,
      selectedAccountKey: persistedAccount?.key ?? null,
      state: persistedAccount ? 'signed_in' : 'loading',
    })
    const credential = await this.settings.getStoredYtMusicBrowserAuth()
    if (credential) {
      const checked = await this.worker.runJsonCommand<WorkerResult>(
        'auth-status',
        { browser_auth_input: credential }
      )
      if (checked.ok) {
        const accounts = this.accountsFromResult(
          selected,
          {
            ...checked,
            credential_json: credential,
          },
          true,
          false
        )
        const account = accounts[0]
        if (account) await this.commitAccount(selected, account, false)
        void this.refresh('selected', 'startup').catch(() => undefined)
        return this.snapshot
      }
    }
    await this.refresh('selected', 'startup')
    return this.snapshot
  }

  private async discover() {
    const discovered = await discoverInstalledBrowsers()
    this.sources = new Map(discovered.map((source) => [source.id, source]))
    for (const source of discovered)
      if (!this.rows.has(source.id)) this.rows.set(source.id, this.row(source))
    for (const id of this.rows.keys())
      if (!this.sources.has(id)) this.rows.delete(id)
    this.publish()
  }
  private async fallbackSourceId(): Promise<string> {
    if (this.sources.has('chrome')) return 'chrome'
    const preferredPath = await this.preferredBrowserPath()
    const preferredSource = [...this.sources.values()].find(
      (source) => source.applicationPath === preferredPath
    )
    return preferredSource?.id ?? (this.sources.keys().next().value as string)
  }
  private row(source: InstalledAuthSource): AuthSourceView {
    return {
      id: source.id,
      browserName: source.browserName,
      browserLogoUrl: '',
      applicationPath: source.applicationPath,
      profileName: source.profileName,
      status: 'unchecked',
      accountCount: null,
      accountsComplete: false,
      issue: null,
    }
  }

  async refresh(scope: 'selected' | 'all', reason: AuthRefreshReason) {
    const priorSelection = this.snapshot.selectedSourceId
    if (scope === 'all') await this.discover()
    if (scope === 'all' && this.sources.size === 0) {
      await this.settings.setSelectedAuthSource('')
      this.publish({
        selectedSourceId: null,
        selectedAccountKey: null,
        activeAccount: null,
        accounts: [],
        accountsComplete: false,
        state: 'no_supported_browser',
        issue: null,
      })
      return this.snapshot
    }
    const selectionDisappeared = Boolean(
      priorSelection && !this.sources.has(priorSelection)
    )
    if (selectionDisappeared && this.sources.size > 0) {
      const fallback = await this.fallbackSourceId()
      await this.settings.setSelectedAuthSource(fallback)
      this.publish({
        selectedSourceId: fallback,
        selectedAccountKey: null,
        activeAccount: null,
        accounts: [],
        accountsComplete: false,
        state: 'loading',
        issue: null,
      })
    }
    let ids =
      scope === 'selected'
        ? ([this.snapshot.selectedSourceId].filter(Boolean) as string[])
        : [...this.sources.keys()]
    if (reason === 'picker_opened')
      ids = ids.filter((id) => this.rows.get(id)?.status === 'unchecked')
    if (!ids.length) return this.snapshot
    this.publish({ isRefreshing: true })
    try {
      for (const id of ids) {
        const commit =
          scope === 'selected' ||
          (selectionDisappeared && id === this.snapshot.selectedSourceId)
        await this.probe(id, commit)
      }
    } finally {
      this.publish({ isRefreshing: false })
    }
    return this.snapshot
  }
  private async probe(id: string, commit: boolean) {
    if (commit) this.commitRequested.add(id)
    const existing = this.inFlight.get(id)
    if (existing) return existing
    const task = (async () => {
      const source = this.sources.get(id)
      if (!source) return
      const previous = this.rows.get(id)!
      if (previous.status === 'unchecked') {
        this.rows.set(id, { ...previous, status: 'checking' })
        this.publish()
      }
      let result: WorkerResult
      try {
        result = await this.worker.runJsonCommand<WorkerResult>(
          'auth-capture-browser',
          { browser: source.cookieBackend, profile_name: source.profileName }
        )
      } catch (error) {
        result = {
          ok: false,
          is_authenticated: false,
          message: error instanceof Error ? error.message : String(error),
          issue_code: 'cookie_store_unreadable',
        }
      }
      const shouldCommit =
        this.commitRequested.has(id) && this.snapshot.selectedSourceId === id
      if (result.ok && result.credential_json) {
        const accounts = this.accountsFromResult(id, result, shouldCommit)
        this.rows.set(id, {
          ...this.rows.get(id)!,
          status: 'signed_in',
          accountCount: accounts.length,
          accountsComplete: true,
          issue: null,
        })
        if (shouldCommit) {
          const remembered = this.snapshot.activeAccount
          const selected =
            accounts.find(
              (account) =>
                account.key === remembered?.key ||
                (remembered?.handle && account.handle === remembered.handle)
            ) ?? accounts[0]
          if (selected) {
            await this.commitAccount(id, selected)
          }
        }
      } else if (result.issue_code === 'no_session') {
        this.rows.set(id, {
          ...this.rows.get(id)!,
          status: 'signed_out',
          issue: null,
        })
        if (shouldCommit) {
          await this.settings.clearYtMusicBrowserAuth()
          this.publish({
            state: 'signed_out',
            activeAccount: null,
            selectedAccountKey: null,
            accounts: [],
            issue: null,
          })
        }
      } else {
        const issue = this.issue(result.issue_code, result.message, id)
        this.rows.set(id, { ...this.rows.get(id)!, status: 'issue', issue })
        if (shouldCommit) {
          await this.settings.clearYtMusicBrowserAuth()
          this.publish({
            state: 'issue',
            activeAccount: null,
            selectedAccountKey: null,
            accounts: [],
            issue,
          })
        }
      }
      this.publish()
    })().finally(() => {
      this.inFlight.delete(id)
      this.commitRequested.delete(id)
    })
    this.inFlight.set(id, task)
    return task
  }
  private accountKey(
    id: string,
    raw: { display_name?: string; handle?: string | null; auth_user?: number }
  ) {
    return createHash('sha256')
      .update(
        `${id}:${raw.handle ?? ''}:${raw.display_name ?? ''}:${raw.auth_user ?? 0}`
      )
      .digest('hex')
      .slice(0, 20)
  }
  private accountsFromResult(
    id: string,
    result: WorkerResult,
    publishAccounts: boolean,
    accountsComplete = true
  ) {
    const previousAccounts = new Map(
      [
        ...this.snapshot.accounts,
        ...(this.snapshot.activeAccount ? [this.snapshot.activeAccount] : []),
      ].map((account) => [account.key, account])
    )
    const rawAccounts =
      result.accounts?.length && result.accounts
        ? result.accounts
        : result.account && result.credential_json
          ? [
              {
                ...result.account,
                auth_user: 0,
                credential_json: result.credential_json,
              },
            ]
          : []
    const accounts = rawAccounts.map((raw): YouTubeMusicAccountView => {
      const key = this.accountKey(id, raw)
      const previousAccount = previousAccounts.get(key)
      this.credentialsByAccountKey.set(key, raw.credential_json)
      const cachedImageUrl = raw.image_url
        ? this.accountImageCache?.resolvePhotoUrl(raw.image_url)
        : null
      return {
        key,
        displayName: raw.display_name || 'YouTube Music',
        handle: raw.handle ?? null,
        imageUrl: raw.image_url ?? null,
        cachedImageUrl:
          cachedImageUrl && cachedImageUrl !== raw.image_url
            ? cachedImageUrl
            : null,
        likedSongCount: previousAccount?.likedSongCount ?? null,
        likedSongCountState:
          previousAccount?.likedSongCountState ?? 'unrequested',
      }
    })
    if (publishAccounts) this.publish({ accounts, accountsComplete })
    for (const account of accounts) void this.cacheAccountImage(account)
    return accounts
  }
  private async cacheAccountImage(account: YouTubeMusicAccountView) {
    if (!account.imageUrl || !this.accountImageCache) return
    try {
      const cachedImageUrl = await this.accountImageCache.cacheRemotePhoto(
        account.imageUrl
      )
      const update = (item: YouTubeMusicAccountView) =>
        item.key === account.key ? { ...item, cachedImageUrl } : item
      this.publish({
        accounts: this.snapshot.accounts.map(update),
        activeAccount: this.snapshot.activeAccount
          ? update(this.snapshot.activeAccount)
          : null,
      })
    } catch {
      // Keep using the remote URL. A later account refresh will try the cache again.
    }
  }
  private async commitAccount(
    id: string,
    account: YouTubeMusicAccountView,
    accountsComplete = true
  ) {
    const credential = this.credentialsByAccountKey.get(account.key)
    if (!credential)
      throw new Error('The selected account is no longer available.')
    await this.settings.commitAuthSelection(id, credential, account)
    this.publish({
      state: 'signed_in',
      selectedSourceId: id,
      selectedAccountKey: account.key,
      activeAccount: account,
      accounts: this.snapshot.accounts.map((item) =>
        item.key === account.key ? account : item
      ),
      accountsComplete,
      issue: null,
    })
  }
  async selectSource(id: string) {
    if (!this.sources.has(id))
      throw new Error('That browser is not installed or supported.')
    if (id === this.snapshot.selectedSourceId) return this.snapshot
    if (await this.jobsBusy())
      throw new Error(
        'Browser switching is disabled while sync work is queued or running.'
      )
    await this.settings.setSelectedAuthSource(id)
    const remembered = await this.settings.getRememberedAuthAccount(id)
    this.publish({
      selectedSourceId: id,
      activeAccount: remembered,
      selectedAccountKey: remembered?.key ?? null,
      accounts: remembered ? [remembered] : [],
      accountsComplete: false,
      state: 'loading',
      issue: null,
    })
    const row = this.rows.get(id)!
    if (row.status === 'signed_out') {
      await this.settings.clearYtMusicBrowserAuth()
      this.publish({ state: 'signed_out', activeAccount: null, accounts: [] })
      return this.snapshot
    }
    await this.probe(id, true)
    return this.snapshot
  }
  async selectAccount(key: string) {
    if (await this.jobsBusy())
      throw new Error(
        'Account switching is disabled while sync work is queued or running.'
      )
    const account = this.snapshot.accounts.find((item) => item.key === key)
    const credential = this.credentialsByAccountKey.get(key)
    if (!account || !credential)
      throw new Error('The selected account is no longer available.')
    const checked = await this.worker.runJsonCommand<WorkerResult>(
      'auth-status',
      {
        browser_auth_input: credential,
      }
    )
    if (!checked.ok)
      throw new Error('YouTube Music rejected the selected account.')
    await this.commitAccount(this.snapshot.selectedSourceId!, account)
    return this.snapshot
  }
  async loadAccountCounts() {
    const accounts = this.snapshot.accounts.filter(
      (account) => account.likedSongCountState === 'unrequested'
    )
    if (!accounts.length) return this.snapshot
    this.publish({
      accounts: this.snapshot.accounts.map((account) =>
        accounts.some((candidate) => candidate.key === account.key)
          ? { ...account, likedSongCountState: 'loading' }
          : account
      ),
      activeAccount:
        this.snapshot.activeAccount &&
        accounts.some(
          (candidate) => candidate.key === this.snapshot.activeAccount?.key
        )
          ? { ...this.snapshot.activeAccount, likedSongCountState: 'loading' }
          : this.snapshot.activeAccount,
    })
    const load = async (account: YouTubeMusicAccountView) => {
      const existing = this.countLoads.get(account.key)
      if (existing) return existing
      const task = (async () => {
        const credential = this.credentialsByAccountKey.get(account.key)
        let result: { ok: boolean; count: number | null } = {
          ok: false,
          count: null,
        }
        if (credential) {
          try {
            result = await this.worker.runJsonCommand<{
              ok: boolean
              count: number | null
            }>('auth-liked-song-count', { browser_auth_input: credential })
          } catch {
            result = { ok: false, count: null }
          }
        }
        const updated = (item: YouTubeMusicAccountView) =>
          item.key === account.key
            ? {
                ...item,
                likedSongCount:
                  result.ok && typeof result.count === 'number'
                    ? result.count
                    : null,
                likedSongCountState: (result.ok &&
                typeof result.count === 'number'
                  ? 'loaded'
                  : 'unavailable') as YouTubeMusicAccountView['likedSongCountState'],
              }
            : item
        this.publish({
          accounts: this.snapshot.accounts.map(updated),
          activeAccount: this.snapshot.activeAccount
            ? updated(this.snapshot.activeAccount)
            : null,
        })
      })().finally(() => this.countLoads.delete(account.key))
      this.countLoads.set(account.key, task)
      return task
    }
    for (let index = 0; index < accounts.length; index += 2)
      await Promise.all(accounts.slice(index, index + 2).map(load))
    return this.snapshot
  }
  async getValidatedCredential(): Promise<string> {
    const current = await this.settings.getStoredYtMusicBrowserAuth()
    if (current) {
      try {
        const checked = await this.worker.runJsonCommand<WorkerResult>(
          'auth-status',
          { browser_auth_input: current }
        )
        if (checked.ok && checked.is_authenticated) {
          const normalized = checked.credential_json ?? current
          if (normalized !== current) {
            await this.settings.saveYtMusicBrowserAuth(normalized)
          }
          return normalized
        }
      } catch {
        // Recapture below. Authentication failures are normalized by probe().
      }
    }

    await this.refresh('selected', 'credential_rejected')
    const recovered = await this.settings.getStoredYtMusicBrowserAuth()
    if (this.snapshot.state !== 'signed_in' || !recovered) {
      throw new Error(
        this.snapshot.issue?.message ??
          'YouTube Music authentication is unavailable.'
      )
    }
    return recovered
  }
  async openSignIn() {
    const source = this.snapshot.selectedSourceId
      ? this.sources.get(this.snapshot.selectedSourceId)
      : null
    if (!source) throw new Error('No supported browser is selected.')
    await execFileAsync('/usr/bin/open', [
      '-a',
      source.applicationPath,
      'https://music.youtube.com',
    ])
  }
  setSwitchingDisabled(disabled: boolean) {
    this.publish({
      switchingDisabledReason: disabled
        ? 'Browser and account switching are disabled while sync work is queued or running.'
        : null,
    })
  }
  private issue(
    code: string | undefined,
    _message: string,
    sourceId: string
  ): AuthIssueView {
    const safe = Object.hasOwn(AUTH_ISSUES, code ?? '')
      ? (code as AuthIssueCode)
      : 'unexpected_response'
    const detail = AUTH_ISSUES[safe]
    return {
      code: safe,
      message: detail.message,
      recovery:
        safe === 'permission_denied' && sourceId === 'safari'
          ? 'Allow Full Disk Access for Liked Music Syncer in macOS Privacy & Security, then retry.'
          : detail.recovery,
    }
  }
}
