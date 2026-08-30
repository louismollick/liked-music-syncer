import { createRoute } from '@tanstack/react-router'
import type { JSX } from 'react'
import { useAppState } from '../App'
import { SettingsView } from '../components/settings/SettingsView'
import { rootRoute } from './root'

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  component: SettingsRouteComponent,
})

export function SettingsRouteComponent(): JSX.Element {
  const {
    settings,
    authSession,
    updateSettings,
    refreshAuth,
    selectAuthSource,
    selectAuthAccount,
    loadAuthAccountCounts,
    switchingAuthAccountKey,
    authAccountSwitchError,
    runAction,
    showMessage,
  } = useAppState()

  return (
    <SettingsView
      settings={settings}
      authSession={authSession}
      onChange={(partial) => {
        void updateSettings(partial).then((result) => {
          if (!result.ok) showMessage(result.message)
        })
      }}
      onRefreshAuth={() => {
        void refreshAuth('all')
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
        void loadAuthAccountCounts()
      }}
      switchingAccountKey={switchingAuthAccountKey}
      accountSwitchError={authAccountSwitchError}
      onAction={runAction}
    />
  )
}
