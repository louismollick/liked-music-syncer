import { describe, expect, it, vi } from 'vitest'
import { runBrowserAuthCapture } from '../src/renderer/src/components/settings/auth-capture'
import type {
  AuthStatus,
  BrowserAuthCaptureResult,
} from '../src/shared/contracts'

const authenticatedStatus: AuthStatus = {
  authMode: 'browser_headers',
  isAuthenticated: true,
  hasBrowserAuth: true,
  lastError: null,
}

describe('browser auth capture', () => {
  it('publishes the returned auth status as well as the command result', async () => {
    const capture = vi.fn(
      async (): Promise<BrowserAuthCaptureResult> => ({
        ok: true,
        message: 'Loaded YT Music browser auth from firefox.',
        authStatus: authenticatedStatus,
      })
    )
    const onAction = vi.fn()
    const onAuthStatusChange = vi.fn()

    await runBrowserAuthCapture({
      browser: 'firefox',
      capture,
      onAction,
      onAuthStatusChange,
    })

    expect(capture).toHaveBeenCalledWith('firefox')
    expect(onAuthStatusChange).toHaveBeenCalledWith(authenticatedStatus)
    await expect(onAction.mock.calls[0]?.[0]).resolves.toMatchObject({
      ok: true,
      message: 'Loaded YT Music browser auth from firefox.',
    })
  })
})
