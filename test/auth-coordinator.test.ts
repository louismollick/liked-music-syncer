import { describe, expect, it, vi } from 'vitest'
import { AuthCoordinator } from '../src/main/auth/auth-coordinator'

describe('AuthCoordinator', () => {
  it('preserves a loaded song count when account discovery refreshes the account', () => {
    const coordinator = new AuthCoordinator(
      {} as never,
      {} as never,
      async () => false
    )
    const internal = coordinator as unknown as {
      snapshot: ReturnType<AuthCoordinator['getSnapshot']>
      accountsFromResult: (
        id: string,
        result: unknown,
        publish: boolean
      ) => ReturnType<AuthCoordinator['getSnapshot']>['accounts']
    }
    const result = {
      ok: true,
      is_authenticated: true,
      message: 'ok',
      credential_json: 'credential',
      accounts: [
        {
          display_name: 'Listener',
          handle: '@listener',
          auth_user: 0,
          credential_json: 'credential',
        },
      ],
    }
    const [account] = internal.accountsFromResult('chrome', result, false)
    internal.snapshot = {
      ...coordinator.getSnapshot(),
      activeAccount: {
        ...account!,
        likedSongCount: 321,
        likedSongCountState: 'loaded',
      },
      accounts: [
        {
          ...account!,
          likedSongCount: 321,
          likedSongCountState: 'loaded',
        },
      ],
    }

    internal.accountsFromResult('chrome', result, true)

    expect(coordinator.getSnapshot().accounts[0]).toMatchObject({
      likedSongCount: 321,
      likedSongCountState: 'loaded',
    })
  })

  it('marks accounts incomplete while switching to another auth source', async () => {
    const rememberedAccount = {
      key: 'remembered',
      displayName: 'Remembered',
      handle: '@remembered',
      imageUrl: null,
      cachedImageUrl: null,
      likedSongCount: null,
      likedSongCountState: 'unrequested' as const,
    }
    const settings = {
      setSelectedAuthSource: vi.fn(async () => undefined),
      getRememberedAuthAccount: vi.fn(async () => rememberedAccount),
    }
    const worker = {
      runJsonCommand: vi.fn(() => new Promise(() => undefined)),
    }
    const coordinator = new AuthCoordinator(
      settings as never,
      worker as never,
      async () => false
    )
    const source = {
      id: 'safari',
      browserName: 'Safari',
      applicationPath: '/Applications/Safari.app',
      profileName: null,
      cookieBackend: 'safari',
    }
    const internal = coordinator as unknown as {
      sources: Map<string, typeof source>
      rows: Map<string, unknown>
      snapshot: { selectedSourceId: string; accountsComplete: boolean }
      row: (source: typeof source) => unknown
    }
    internal.sources.set(source.id, source)
    internal.rows.set(source.id, internal.row(source))
    internal.snapshot.selectedSourceId = 'chrome'
    internal.snapshot.accountsComplete = true

    void coordinator.selectSource(source.id)
    await vi.waitFor(() => {
      expect(worker.runJsonCommand).toHaveBeenCalled()
    })

    expect(coordinator.getSnapshot().accountsComplete).toBe(false)
  })

  it('uses a persisted local account image when one is cached', () => {
    const remoteUrl = 'https://example.test/avatar.jpg'
    const accountImageCache = {
      resolvePhotoUrl: vi.fn(() => 'app-media://account-image/cached.jpg'),
      cacheRemotePhoto: vi.fn(),
    }
    const coordinator = new AuthCoordinator(
      {} as never,
      {} as never,
      async () => false,
      async () => null,
      accountImageCache as never
    )
    const internal = coordinator as unknown as {
      accountsFromResult: (
        id: string,
        result: unknown,
        publish: boolean
      ) => Array<{ cachedImageUrl: string | null }>
    }

    const accounts = internal.accountsFromResult(
      'chrome',
      {
        ok: true,
        is_authenticated: true,
        message: 'ok',
        credential_json: '{}',
        account: {
          display_name: 'Listener',
          handle: '@listener',
          image_url: remoteUrl,
        },
      },
      false
    )

    expect(accountImageCache.resolvePhotoUrl).toHaveBeenCalledWith(remoteUrl)
    expect(accounts[0]?.cachedImageUrl).toBe(
      'app-media://account-image/cached.jpg'
    )
  })

  it('publishes a local account image after caching the remote image', async () => {
    const accountImageCache = {
      resolvePhotoUrl: vi.fn((url: string) => url),
      cacheRemotePhoto: vi.fn(async () => 'app-media://account-image/new.jpg'),
    }
    const coordinator = new AuthCoordinator(
      {} as never,
      {} as never,
      async () => false,
      async () => null,
      accountImageCache as never
    )
    const internal = coordinator as unknown as {
      accountsFromResult: (
        id: string,
        result: unknown,
        publish: boolean
      ) => unknown
    }

    internal.accountsFromResult(
      'chrome',
      {
        ok: true,
        is_authenticated: true,
        message: 'ok',
        credential_json: '{}',
        account: {
          display_name: 'Listener',
          handle: '@listener',
          image_url: 'https://example.test/avatar.jpg',
        },
      },
      true
    )

    await vi.waitFor(() => {
      expect(coordinator.getSnapshot().accounts[0]?.cachedImageUrl).toBe(
        'app-media://account-image/new.jpg'
      )
    })
  })

  it('checks only unchecked sources when the browser picker opens', async () => {
    const worker = {
      runJsonCommand: vi.fn(async () => ({
        ok: false,
        is_authenticated: false,
        message: 'No session',
        issue_code: 'no_session',
      })),
    }
    const coordinator = new AuthCoordinator(
      {} as never,
      worker as never,
      async () => false
    )
    const zen = {
      id: 'zen',
      browserName: 'Zen',
      applicationPath: '/Applications/Zen.app',
      profileName: null,
      cookieBackend: 'zen',
    }
    const firefox = {
      ...zen,
      id: 'firefox',
      browserName: 'Firefox',
      applicationPath: '/Applications/Firefox.app',
      cookieBackend: 'firefox',
    }
    const internal = coordinator as unknown as {
      sources: Map<string, typeof zen>
      rows: Map<string, ReturnType<(typeof internal)['row']>>
      discover: () => Promise<void>
      row: (source: typeof zen) => {
        status: 'unchecked' | 'signed_in'
        [key: string]: unknown
      }
    }
    internal.sources.set(zen.id, zen)
    internal.sources.set(firefox.id, firefox)
    internal.rows.set(zen.id, {
      ...internal.row(zen),
      status: 'signed_in',
    })
    internal.rows.set(firefox.id, internal.row(firefox))
    internal.discover = vi.fn(async () => undefined)

    await coordinator.refresh('all', 'picker_opened')

    expect(worker.runJsonCommand).toHaveBeenCalledTimes(1)
    expect(worker.runJsonCommand).toHaveBeenCalledWith(
      'auth-capture-browser',
      expect.objectContaining({ browser: 'firefox' })
    )
  })

  it('does nothing when selecting the already-selected source', async () => {
    const worker = { runJsonCommand: vi.fn() }
    const settings = {
      setSelectedAuthSource: vi.fn(),
      getRememberedAuthAccount: vi.fn(),
    }
    const jobsBusy = vi.fn(async () => false)
    const coordinator = new AuthCoordinator(
      settings as never,
      worker as never,
      jobsBusy
    )
    const source = {
      id: 'zen',
      browserName: 'Zen',
      applicationPath: '/Applications/Zen.app',
      profileName: null,
      cookieBackend: 'zen',
    }
    const internal = coordinator as unknown as {
      sources: Map<string, typeof source>
      snapshot: ReturnType<AuthCoordinator['getSnapshot']>
    }
    internal.sources.set(source.id, source)
    internal.snapshot = {
      ...coordinator.getSnapshot(),
      state: 'signed_in',
      selectedSourceId: source.id,
    }
    const before = coordinator.getSnapshot()

    await expect(coordinator.selectSource(source.id)).resolves.toBe(before)

    expect(jobsBusy).not.toHaveBeenCalled()
    expect(settings.setSelectedAuthSource).not.toHaveBeenCalled()
    expect(settings.getRememberedAuthAccount).not.toHaveBeenCalled()
    expect(worker.runJsonCommand).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot().state).toBe('signed_in')
  })

  it('starts enumerating the selected browser after restoring a saved account', async () => {
    let finishEnumeration: ((value: unknown) => void) | undefined
    const persistedAccount = {
      key: 'saved',
      displayName: 'Saved',
      handle: '@saved',
      imageUrl: null,
      cachedImageUrl: null,
      likedSongCount: null,
      likedSongCountState: 'unrequested' as const,
    }
    const worker = {
      runJsonCommand: vi.fn(async (command: string) => {
        if (command === 'auth-status')
          return {
            ok: true,
            is_authenticated: true,
            message: 'ok',
            account: { display_name: 'Saved', handle: '@saved' },
          }
        return new Promise((resolve) => {
          finishEnumeration = resolve
        })
      }),
    }
    const settings = {
      getAuthSelection: vi.fn(async () => ({
        sourceId: 'zen',
        account: persistedAccount,
      })),
      getStoredYtMusicBrowserAuth: vi.fn(async () => '{"saved":true}'),
      commitAuthSelection: vi.fn(async () => undefined),
    }
    const coordinator = new AuthCoordinator(
      settings as never,
      worker as never,
      async () => false
    )
    const source = {
      id: 'zen',
      browserName: 'Zen',
      applicationPath: '/Applications/Zen.app',
      profileName: null,
      cookieBackend: 'zen',
    }
    const internal = coordinator as unknown as {
      sources: Map<string, typeof source>
      rows: Map<string, unknown>
      discover: () => Promise<void>
      row: (source: typeof source) => unknown
    }
    internal.discover = vi.fn(async () => {
      internal.sources.set(source.id, source)
      internal.rows.set(source.id, internal.row(source))
    })

    await coordinator.bootstrap()

    expect(coordinator.getSnapshot()).toMatchObject({
      state: 'signed_in',
      accountsComplete: false,
      isRefreshing: true,
    })
    expect(worker.runJsonCommand).toHaveBeenCalledWith(
      'auth-capture-browser',
      expect.objectContaining({ browser: 'zen' })
    )

    finishEnumeration?.({
      ok: true,
      is_authenticated: true,
      message: 'ok',
      credential_json: '{"saved":true}',
      accounts: [
        {
          display_name: 'Saved',
          handle: '@saved',
          auth_user: 0,
          credential_json: '{"saved":true}',
        },
        {
          display_name: 'Other',
          handle: '@other',
          auth_user: 1,
          credential_json: '{"other":true}',
        },
      ],
    })
    await vi.waitFor(() => {
      expect(coordinator.getSnapshot().accountsComplete).toBe(true)
    })
    expect(coordinator.getSnapshot().accounts).toHaveLength(2)
  })

  it('commits a selected source when its picker scan is already in flight', async () => {
    let finishProbe: ((value: unknown) => void) | undefined
    const worker = {
      runJsonCommand: vi.fn(
        () =>
          new Promise((resolve) => {
            finishProbe = resolve
          })
      ),
    }
    const settings = {
      commitAuthSelection: vi.fn(async () => undefined),
      clearYtMusicBrowserAuth: vi.fn(async () => undefined),
    }
    const coordinator = new AuthCoordinator(
      settings as never,
      worker as never,
      async () => false
    )
    const source = {
      id: 'zen',
      browserName: 'Zen',
      applicationPath: '/Applications/Zen.app',
      profileName: null,
      cookieBackend: 'zen',
    }
    const internal = coordinator as unknown as {
      sources: Map<string, typeof source>
      rows: Map<string, unknown>
      snapshot: { selectedSourceId: string | null }
      row: (source: typeof source) => unknown
      probe: (id: string, commit: boolean) => Promise<void>
    }
    internal.sources.set('zen', source)
    internal.rows.set('zen', internal.row(source))
    internal.snapshot.selectedSourceId = 'zen'

    const pickerScan = internal.probe('zen', false)
    const selection = internal.probe('zen', true)
    finishProbe?.({
      ok: true,
      is_authenticated: true,
      message: 'ok',
      credential_json: '{"cookie":"<REDACTED>"}',
      account: { display_name: 'Listener', handle: '@listener' },
    })
    await Promise.all([pickerScan, selection])

    expect(worker.runJsonCommand).toHaveBeenCalledTimes(1)
    expect(settings.commitAuthSelection).toHaveBeenCalledTimes(1)
    expect(coordinator.getSnapshot().state).toBe('signed_in')
    expect(coordinator.getSnapshot().issue).toBeNull()
  })

  it('switches between discovered accounts and commits the selected credential', async () => {
    const worker = {
      runJsonCommand: vi.fn(async (command: string) => {
        if (command === 'auth-capture-browser')
          return {
            ok: true,
            is_authenticated: true,
            message: 'ok',
            credential_json: '{"x-goog-authuser":"0"}',
            accounts: [
              {
                display_name: 'First',
                handle: '@first',
                image_url: null,
                auth_user: 0,
                credential_json: '{"x-goog-authuser":"0"}',
              },
              {
                display_name: 'Second',
                handle: '@second',
                image_url: null,
                auth_user: 2,
                credential_json: '{"x-goog-authuser":"2"}',
              },
            ],
          }
        return { ok: true, is_authenticated: true, message: 'ok' }
      }),
    }
    const settings = {
      commitAuthSelection: vi.fn(async () => undefined),
      clearYtMusicBrowserAuth: vi.fn(async () => undefined),
    }
    const coordinator = new AuthCoordinator(
      settings as never,
      worker as never,
      async () => false
    )
    const source = {
      id: 'zen',
      browserName: 'Zen',
      applicationPath: '/Applications/Zen.app',
      profileName: null,
      cookieBackend: 'zen',
    }
    const internal = coordinator as unknown as {
      sources: Map<string, typeof source>
      rows: Map<string, unknown>
      snapshot: { selectedSourceId: string | null }
      row: (source: typeof source) => unknown
      probe: (id: string, commit: boolean) => Promise<void>
    }
    internal.sources.set('zen', source)
    internal.rows.set('zen', internal.row(source))
    internal.snapshot.selectedSourceId = 'zen'

    await internal.probe('zen', true)
    const second = coordinator.getSnapshot().accounts[1]!
    await coordinator.selectAccount(second.key)

    expect(coordinator.getSnapshot().activeAccount?.handle).toBe('@second')
    expect(settings.commitAuthSelection).toHaveBeenLastCalledWith(
      'zen',
      '{"x-goog-authuser":"2"}',
      expect.objectContaining({ handle: '@second' })
    )
  })

  it('loads liked-song counts lazily without changing auth state on failure', async () => {
    const worker = {
      runJsonCommand: vi.fn(
        async (command: string, payload: { browser_auth_input: string }) => {
          if (command === 'auth-liked-song-count')
            return payload.browser_auth_input.includes('0')
              ? { ok: true, count: 42 }
              : { ok: false, count: null }
          return { ok: true, is_authenticated: true, message: 'ok' }
        }
      ),
    }
    const coordinator = new AuthCoordinator(
      {} as never,
      worker as never,
      async () => false
    )
    const internal = coordinator as unknown as {
      snapshot: ReturnType<AuthCoordinator['getSnapshot']>
      credentialsByAccountKey: Map<string, string>
    }
    const account = (key: string) => ({
      key,
      displayName: key,
      handle: `@${key}`,
      imageUrl: null,
      cachedImageUrl: null,
      likedSongCount: null,
      likedSongCountState: 'unrequested' as const,
    })
    internal.snapshot = {
      ...coordinator.getSnapshot(),
      state: 'signed_in',
      activeAccount: account('first'),
      selectedAccountKey: 'first',
      accounts: [account('first'), account('second')],
    }
    internal.credentialsByAccountKey.set('first', 'credential-0')
    internal.credentialsByAccountKey.set('second', 'credential-1')

    await coordinator.loadAccountCounts()

    expect(coordinator.getSnapshot().state).toBe('signed_in')
    expect(coordinator.getSnapshot().accounts[0]).toMatchObject({
      likedSongCount: 42,
      likedSongCountState: 'loaded',
    })
    expect(coordinator.getSnapshot().accounts[1]?.likedSongCountState).toBe(
      'unavailable'
    )
  })

  it('finalizes a count as unavailable when the worker rejects', async () => {
    const worker = {
      runJsonCommand: vi.fn(async () => {
        throw new Error('worker stopped')
      }),
    }
    const coordinator = new AuthCoordinator(
      {} as never,
      worker as never,
      async () => false
    )
    const account = {
      key: 'first',
      displayName: 'First',
      handle: '@first',
      imageUrl: null,
      cachedImageUrl: null,
      likedSongCount: null,
      likedSongCountState: 'unrequested' as const,
    }
    const internal = coordinator as unknown as {
      snapshot: ReturnType<AuthCoordinator['getSnapshot']>
      credentialsByAccountKey: Map<string, string>
    }
    internal.snapshot = {
      ...coordinator.getSnapshot(),
      state: 'signed_in',
      activeAccount: account,
      selectedAccountKey: account.key,
      accounts: [account],
    }
    internal.credentialsByAccountKey.set(account.key, 'credential')

    await expect(coordinator.loadAccountCounts()).resolves.toBeDefined()
    expect(coordinator.getSnapshot().accounts[0]?.likedSongCountState).toBe(
      'unavailable'
    )
  })

  it('clears the refresh flag when committing a probe fails', async () => {
    const worker = {
      runJsonCommand: vi.fn(async () => ({
        ok: true,
        is_authenticated: true,
        message: 'ok',
        credential_json: '{}',
        account: { display_name: 'First', handle: '@first' },
      })),
    }
    const settings = {
      commitAuthSelection: vi.fn(async () => {
        throw new Error('safe storage unavailable')
      }),
    }
    const coordinator = new AuthCoordinator(
      settings as never,
      worker as never,
      async () => false
    )
    const source = {
      id: 'chrome',
      browserName: 'Chrome',
      applicationPath: '/Applications/Google Chrome.app',
      profileName: null,
      cookieBackend: 'chrome',
    }
    const internal = coordinator as unknown as {
      sources: Map<string, typeof source>
      rows: Map<string, unknown>
      snapshot: { selectedSourceId: string | null }
      row: (source: typeof source) => unknown
    }
    internal.sources.set(source.id, source)
    internal.rows.set(source.id, internal.row(source))
    internal.snapshot.selectedSourceId = source.id

    await expect(coordinator.refresh('selected', 'retry')).rejects.toThrow(
      'safe storage unavailable'
    )
    expect(coordinator.getSnapshot().isRefreshing).toBe(false)
  })
})
