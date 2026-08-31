import type {
  AuthRefreshReason,
  AuthSessionView,
  ElectronApi,
} from '@shared/contracts'
import { useCallback, useEffect, useState } from 'react'

type AuthApi = Pick<ElectronApi['auth'], 'getSnapshot' | 'subscribe'>

export function subscribeToAuthSession(
  auth: AuthApi,
  setSession: (snapshot: AuthSessionView) => void
) {
  let receivedPush = false
  const unsubscribe = auth.subscribe((snapshot) => {
    receivedPush = true
    setSession(snapshot)
  })
  void auth.getSnapshot().then((snapshot) => {
    if (!receivedPush) setSession(snapshot)
  })
  return unsubscribe
}

const EMPTY: AuthSessionView = {
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

export function useAuthSession() {
  const [session, setSession] = useState(EMPTY)
  const [switchingAccountKey, setSwitchingAccountKey] = useState<string | null>(
    null
  )
  const [accountSwitchError, setAccountSwitchError] = useState<string | null>(
    null
  )
  useEffect(() => {
    return subscribeToAuthSession(window.api.auth, setSession)
  }, [])
  const refresh = useCallback(
    async (scope: 'selected' | 'all', reason: AuthRefreshReason = 'retry') =>
      setSession(await window.api.auth.refresh(scope, reason)),
    []
  )
  const selectSource = useCallback(
    async (id: string) => setSession(await window.api.auth.selectSource(id)),
    []
  )
  const selectAccount = useCallback(async (key: string) => {
    setSwitchingAccountKey(key)
    setAccountSwitchError(null)
    try {
      const next = await window.api.auth.selectAccount(key)
      setSession(next)
      return true
    } catch (error) {
      setAccountSwitchError(
        error instanceof Error ? error.message : String(error)
      )
      return false
    } finally {
      setSwitchingAccountKey(null)
    }
  }, [])
  const loadAccountCounts = useCallback(async () => {
    setSession(await window.api.auth.loadAccountCounts())
  }, [])
  return {
    session,
    refresh,
    selectSource,
    selectAccount,
    loadAccountCounts,
    switchingAccountKey,
    accountSwitchError,
    openSignIn: window.api.auth.openSignIn,
  }
}
