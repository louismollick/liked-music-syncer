import type {
  CommandResult,
  LibraryIndexStatus,
  LikedArtistView,
} from '@shared/contracts'
import { type JSX, useEffect, useState } from 'react'
import { MainLayout } from './components/layout/MainLayout'
import type { Screen } from './components/layout/Sidebar'
import { AlbumsView } from './components/library/AlbumsView'
import { ArtistsView } from './components/library/ArtistsView'
import type { AlbumGroup } from './components/library/library-utils'
import { SongsView } from './components/library/SongsView'
import { SettingsView } from './components/settings/SettingsView'
import { SyncApprovalView } from './components/sync/SyncApprovalView'
import { SyncCompletedView } from './components/sync/SyncCompletedView'
import { SyncFailuresView } from './components/sync/SyncFailuresView'
import { SyncQueueView } from './components/sync/SyncQueueView'
import { useArtists } from './hooks/useArtists'
import { useSettings } from './hooks/useSettings'
import { useSyncSnapshot } from './hooks/useSyncSnapshot'
import { useTracks } from './hooks/useTracks'

const EMPTY_INDEX_STATUS: LibraryIndexStatus = {
  currentLocalRootUri: null,
  ready: false,
  inProgress: false,
  reason: 'missing_root',
  lastScannedAt: null,
  lastScanStatus: null,
  indexVersion: null,
}

interface ArtistFilterState {
  artistName: string
}

interface AlbumFilterState {
  albumKey: string
  albumLabel: string
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
  const [selectionEnabled, setSelectionEnabled] = useState(false)
  const [selectedArtistIds, setSelectedArtistIds] = useState<string[]>([])
  const [artistFilter, setArtistFilter] = useState<ArtistFilterState | null>(
    null
  )
  const [albumFilter, setAlbumFilter] = useState<AlbumFilterState | null>(null)

  const { artists } = useArtists()
  const {
    tracks,
    loaded: tracksLoaded,
    refreshing: tracksRefreshing,
  } = useTracks()
  const snapshot = useSyncSnapshot()
  const { settings, setSettings, authStatus, setAuthStatus, save } =
    useSettings()
  const showNeedsApproval =
    !settings.autoApproveChanges && snapshot.counts.needsApproval > 0

  useEffect(() => {
    if (screen === 'sync-approval' && !showNeedsApproval) {
      setScreen('sync-queue')
    }
  }, [screen, showNeedsApproval])

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

  const navigateScreen = (nextScreen: Screen) => {
    if (nextScreen === 'library-artists') {
      setArtistFilter(null)
      setAlbumFilter(null)
    } else if (nextScreen === 'library-albums') {
      setArtistFilter(null)
      setAlbumFilter(null)
    } else if (nextScreen === 'library-songs') {
      setArtistFilter(null)
      setAlbumFilter(null)
    }

    setScreen(nextScreen)
  }

  const toggleArtistSelect = (artistId: string) => {
    setSelectedArtistIds((current) =>
      current.includes(artistId)
        ? current.filter((id) => id !== artistId)
        : [...current, artistId]
    )
  }

  const openArtistAlbums = (artist: LikedArtistView) => {
    setArtistFilter({ artistName: artist.name })
    setAlbumFilter(null)
    setScreen('library-albums')
  }

  const openAlbumSongs = (album: AlbumGroup) => {
    setAlbumFilter({ albumKey: album.key, albumLabel: album.album })
    setScreen('library-songs')
  }

  const syncLikedSongs = () => onAction(window.api.sync.startLikedSongsSync())
  const reprocessLibrary = () =>
    onAction(window.api.sync.startLibraryReprocess())
  const reprocessFavoriteArtists = () =>
    onAction(window.api.sync.refreshFavoriteArtists())
  const syncToRemote = () => onAction(window.api.sync.syncMissingToRemote())

  const onAction = runAction

  return (
    <MainLayout
      screen={screen}
      onNavigate={navigateScreen}
      counts={snapshot.counts}
      showNeedsApproval={showNeedsApproval}
    >
      {screen === 'library-artists' ? (
        <ArtistsView
          artists={artists}
          selectedIds={selectedArtistIds}
          selectionEnabled={selectionEnabled}
          libraryIndexStatus={libraryIndexStatus}
          authStatus={authStatus}
          onToggleSelectionMode={() =>
            setSelectionEnabled((current) => !current)
          }
          onToggleSelect={toggleArtistSelect}
          onOpenArtist={openArtistAlbums}
          onAction={runAction}
          onClearSelected={() => setSelectedArtistIds([])}
        />
      ) : null}

      {screen === 'library-albums' ? (
        <AlbumsView
          tracks={tracks}
          tracksLoaded={tracksLoaded}
          tracksRefreshing={tracksRefreshing}
          artistFilter={artistFilter}
          onOpenAlbum={openAlbumSongs}
          onClearArtistFilter={() => setArtistFilter(null)}
          onSyncLikedSongs={syncLikedSongs}
          onReprocessLibrary={reprocessLibrary}
          onReprocessFavoriteArtists={reprocessFavoriteArtists}
          onSyncToRemote={syncToRemote}
        />
      ) : null}

      {screen === 'library-songs' ? (
        <SongsView
          tracks={tracks}
          tracksLoaded={tracksLoaded}
          tracksRefreshing={tracksRefreshing}
          albumFilter={albumFilter}
          onClearAlbumFilter={() => setAlbumFilter(null)}
          onSyncLikedSongs={syncLikedSongs}
          onReprocessLibrary={reprocessLibrary}
          onReprocessFavoriteArtists={reprocessFavoriteArtists}
          onSyncToRemote={syncToRemote}
        />
      ) : null}

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
        <SyncFailuresView
          snapshot={snapshot}
          onClear={() => runAction(window.api.sync.clearFailures())}
        />
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
