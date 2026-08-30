import { describe, expect, it, vi } from 'vitest'
import { AuthCoordinator } from '../src/main/auth/auth-coordinator'

describe('AuthCoordinator', () => {
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
})
