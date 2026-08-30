import type { AuthSessionView, ElectronApi } from '@shared/contracts'
import { describe, expect, it, vi } from 'vitest'
import { subscribeToAuthSession } from '../src/renderer/src/hooks/useAuthSession'

function snapshot(selectedSourceId: string | null): AuthSessionView {
  return {
    state: selectedSourceId ? 'signed_in' : 'loading',
    selectedSourceId,
    selectedAccountKey: null,
    activeAccount: null,
    sources: [],
    accounts: [],
    accountsComplete: false,
    isRefreshing: false,
    switchingDisabledReason: null,
    issue: null,
  }
}

describe('auth session subscription', () => {
  it('does not let a stale initial snapshot replace a pushed bootstrap snapshot', async () => {
    let resolveInitial: ((value: AuthSessionView) => void) | undefined
    let push: ((value: AuthSessionView) => void) | undefined
    const auth = {
      getSnapshot: vi.fn(
        () =>
          new Promise<AuthSessionView>((resolve) => {
            resolveInitial = resolve
          })
      ),
      subscribe: vi.fn((listener: (value: AuthSessionView) => void) => {
        push = listener
        return vi.fn()
      }),
    } satisfies Pick<ElectronApi['auth'], 'getSnapshot' | 'subscribe'>
    const received: AuthSessionView[] = []

    subscribeToAuthSession(auth, (value) => received.push(value))
    push?.(snapshot('zen'))
    resolveInitial?.(snapshot(null))
    await Promise.resolve()

    expect(received.map((value) => value.selectedSourceId)).toEqual(['zen'])
  })
})
