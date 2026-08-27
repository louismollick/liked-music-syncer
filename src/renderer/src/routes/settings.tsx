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
    authStatus,
    setSettings,
    setAuthStatus,
    saveSettings,
    runAction,
    showMessage,
  } = useAppState()

  return (
    <SettingsView
      settings={settings}
      authStatus={authStatus}
      onChange={(partial) =>
        setSettings((previous) => ({ ...previous, ...partial }))
      }
      onSave={async () => {
        const result = await saveSettings()
        showMessage(
          result.details
            ? `${result.message} ${result.details}`
            : result.message
        )
        const nextAuth = await window.api.auth.getStatus()
        setAuthStatus(nextAuth)
      }}
      onAction={runAction}
      onAuthStatusChange={setAuthStatus}
    />
  )
}
