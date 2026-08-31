import {
  createRoute,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import type { JSX } from 'react'
import { useEffect } from 'react'
import { useAppState } from '../App'
import { refreshBrowserPicker } from '../auth/refreshBrowserPicker'
import { SettingsView } from '../components/settings/SettingsView'
import { rootRoute } from './root'

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  validateSearch: (search: Record<string, unknown>) => ({
    detectAuth: search.detectAuth === true ? true : undefined,
    browserPicker: search.browserPicker === true ? true : undefined,
  }),
  component: SettingsRouteComponent,
})

export function SettingsRouteComponent(): JSX.Element {
  const navigate = useNavigate()
  const location = useRouterState({ select: (state) => state.location })
  const {
    settings,
    authSession,
    updateSettings,
    flushSettings,
    refreshAuth,
    selectAuthSource,
    selectAuthAccount,
    loadAuthAccountCounts,
    switchingAuthAccountKey,
    authAccountSwitchError,
    runAction,
    showMessage,
  } = useAppState()
  const browserPickerOpen = location.search.browserPicker === true

  useEffect(() => {
    void refreshBrowserPicker(browserPickerOpen, refreshAuth, showMessage)
  }, [browserPickerOpen, refreshAuth, showMessage])

  useEffect(() => {
    if (
      location.pathname !== '/settings' ||
      location.search.detectAuth !== true
    )
      return
    void refreshAuth('all', 'retry')
      .catch((error) =>
        showMessage(error instanceof Error ? error.message : String(error))
      )
      .finally(() => {
        void navigate({
          to: '/settings',
          search: { detectAuth: undefined, browserPicker: undefined },
          replace: true,
        })
      })
  }, [location.pathname, location.search, navigate, refreshAuth, showMessage])

  return (
    <SettingsView
      settings={settings}
      authSession={authSession}
      browserPickerOpen={browserPickerOpen}
      onBrowserPickerOpenChange={(open) => {
        void navigate({
          to: '/settings',
          search: {
            detectAuth: undefined,
            browserPicker: open ? true : undefined,
          },
          replace: true,
        })
      }}
      onChange={(partial) => {
        void updateSettings(partial).then((result) => {
          if (!result.ok) showMessage(result.message)
        })
      }}
      onFlush={(keys) => {
        void flushSettings(keys).then((result) => {
          if (!result.ok) showMessage(result.message)
        })
      }}
      onSelectSource={(id) => {
        void selectAuthSource(id).catch((error) =>
          showMessage(error instanceof Error ? error.message : String(error))
        )
      }}
      onSelectAccount={(key) => {
        void selectAuthAccount(key)
      }}
      onLoadAccountCounts={() => {
        void loadAuthAccountCounts().catch((error) =>
          showMessage(error instanceof Error ? error.message : String(error))
        )
      }}
      switchingAccountKey={switchingAuthAccountKey}
      accountSwitchError={authAccountSwitchError}
      onAction={runAction}
    />
  )
}
