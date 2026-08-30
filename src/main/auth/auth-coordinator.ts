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
    private jobsBusy: () => Promise<boolean>
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
        : this.sources.has('chrome')
          ? 'chrome'
          : (this.sources.keys().next().value as string)
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
          true
        )
        const account = accounts[0]
        if (account) await this.commitAccount(selected, account)
        await this.refresh('selected', 'startup')
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

  async refresh(scope: 'selected' | 'all', _reason: AuthRefreshReason) {
    if (scope === 'all') await this.discover()
    const ids =
      scope === 'selected'
        ? ([this.snapshot.selectedSourceId].filter(Boolean) as string[])
        : [...this.sources.keys()]
    this.publish({ isRefreshing: true })
    for (const id of ids) await this.probe(id, scope === 'selected')
    this.publish({ isRefreshing: false })
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
          { browser: source.cookieBackend }
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
                remembered?.handle && account.handle === remembered.handle
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
    publishAccounts: boolean
  ) {
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
      this.credentialsByAccountKey.set(key, raw.credential_json)
      return {
        key,
        displayName: raw.display_name || 'YouTube Music',
        handle: raw.handle ?? null,
        imageUrl: raw.image_url ?? null,
        cachedImageUrl: null,
        likedSongCount: null,
        likedSongCountState: 'unrequested',
      }
    })
    if (publishAccounts) this.publish({ accounts, accountsComplete: true })
    return accounts
  }
  private async commitAccount(id: string, account: YouTubeMusicAccountView) {
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
      accountsComplete: true,
      issue: null,
    })
  }
  async selectSource(id: string) {
    if (!this.sources.has(id))
      throw new Error('That browser is not installed or supported.')
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
        const result = credential
          ? await this.worker.runJsonCommand<{
              ok: boolean
              count: number | null
            }>('auth-liked-song-count', { browser_auth_input: credential })
          : { ok: false, count: null }
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
  private issue(
    code: string | undefined,
    _message: string,
    sourceId: string
  ): AuthIssueView {
    const safe = (
      [
        'cookie_store_unreadable',
        'keychain_denied',
        'permission_denied',
        'browser_profile_missing',
        'network_unavailable',
        'credential_rejected',
        'account_enumeration_failed',
        'unexpected_response',
      ].includes(code ?? '')
        ? code
        : 'unexpected_response'
    ) as AuthIssueCode
    const messages: Record<AuthIssueCode, string> = {
      cookie_store_unreadable: 'The browser cookie store could not be read.',
      keychain_denied:
        'macOS did not allow access to the browser encryption key.',
      permission_denied: 'macOS denied access to the browser data.',
      browser_profile_missing:
        'The selected browser profile could not be found.',
      network_unavailable: 'YouTube Music could not be reached.',
      credential_rejected: 'YouTube Music rejected the browser session.',
      account_enumeration_failed:
        'The active YouTube Music identity could not be read.',
      unexpected_response: 'YouTube Music returned an unexpected response.',
    }
    return {
      code: safe,
      message: messages[safe],
      recovery:
        safe === 'permission_denied' && sourceId === 'safari'
          ? 'Allow Full Disk Access for Liked Music Syncer in macOS Privacy & Security, then retry.'
          : safe === 'keychain_denied'
            ? 'Allow Keychain access when macOS asks, then retry.'
            : safe === 'cookie_store_unreadable'
              ? 'Fully quit the selected browser, reopen it, then retry. If the issue continues, check that its profile is readable.'
              : 'Open YouTube Music in this browser, confirm you are signed in, then retry.',
    }
  }
}
