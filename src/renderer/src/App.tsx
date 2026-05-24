import type { CommandResult, LibraryIndexStatus } from '@shared/contracts'
import { type JSX, useEffect, useState } from 'react'
import { MainLayout } from './components/layout/MainLayout'
import type { Screen } from './components/layout/Sidebar'
import { AlbumsView } from './components/library/AlbumsView'
import { ArtistsView } from './components/library/ArtistsView'
import { SongsView } from './components/library/SongsView'
import { SettingsView } from './components/settings/SettingsView'
import { SyncApprovalView } from './components/sync/SyncApprovalView'
import { SyncCompletedView } from './components/sync/SyncCompletedView'
import { SyncFailuresView } from './components/sync/SyncFailuresView'
import { SyncQueueView } from './components/sync/SyncQueueView'
import { useArtists } from './hooks/useArtists'
import { useSettings } from './hooks/useSettings'
import { useSyncSnapshot } from './hooks/useSyncSnapshot'

const EMPTY_INDEX_STATUS: LibraryIndexStatus = {
  currentLocalRootUri: null,
  ready: false,
  inProgress: false,
  reason: 'missing_root',
  lastScannedAt: null,
  lastScanStatus: null,
  indexVersion: null,
}

function Toast({
  message,
  onDismiss,
}: {
  message: string
  onDismiss: () => void
}): JSX.Element {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000)
    return () => clearTimeout(t)
  }, [onDismiss])

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-surface-secondary border border-border rounded-xl px-4 py-3 shadow-xl max-w-sm">
      <p className="text-sm text-text-primary">{message}</p>
    </div>
  )
}

function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('library-artists')
  const [message, setMessage] = useState('')
  const [libraryIndexStatus, setLibraryIndexStatus] =
    useState<LibraryIndexStatus>(EMPTY_INDEX_STATUS)

  const { artists } = useArtists()
  const snapshot = useSyncSnapshot()
  const { settings, setSettings, authStatus, setAuthStatus, save } =
    useSettings()

  useEffect(() => {
    void window.api.library.getIndexStatus().then(setLibraryIndexStatus)
    const unsub = window.api.library.subscribeIndexStatus(() => {
      void window.api.library.getIndexStatus().then(setLibraryIndexStatus)
    })
    return unsub
  }, [])

  const runAction = async (action: Promise<CommandResult>) => {
    const result: CommandResult = await action.catch((err: unknown) => ({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }))
    setMessage(
      result.details ? `${result.message} ${result.details}` : result.message
    )
  }

  return (
    <MainLayout screen={screen} onNavigate={setScreen} counts={snapshot.counts}>
      {screen === 'library-artists' ? (
        <ArtistsView
          artists={artists}
          libraryIndexStatus={libraryIndexStatus}
          authStatus={authStatus}
          onAction={runAction}
        />
      ) : null}

      {screen === 'library-albums' ? <AlbumsView /> : null}

      {screen === 'library-songs' ? <SongsView /> : null}

      {screen === 'sync-queue' ? (
        <SyncQueueView snapshot={snapshot} onAction={runAction} />
      ) : null}

      {screen === 'sync-approval' ? (
        <SyncApprovalView snapshot={snapshot} onAction={runAction} />
      ) : null}

      {screen === 'sync-completed' ? (
        <SyncCompletedView snapshot={snapshot} />
      ) : null}

      {screen === 'sync-failures' ? (
        <SyncFailuresView snapshot={snapshot} />
      ) : null}

      {screen === 'settings' ? (
        <SettingsView
          settings={settings}
          authStatus={authStatus}
          onChange={(partial) =>
            setSettings((prev) => ({ ...prev, ...partial }))
          }
          onSave={async () => {
            const result = await save()
            setMessage(
              result.details
                ? `${result.message} ${result.details}`
                : result.message
            )
            const nextAuth = await window.api.auth.getStatus()
            setAuthStatus(nextAuth)
          }}
          onAction={runAction}
        />
      ) : null}

      {message ? (
        <Toast message={message} onDismiss={() => setMessage('')} />
      ) : null}
    </MainLayout>
  )
}

export default App
