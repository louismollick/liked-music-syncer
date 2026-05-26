import { buildAlbumKey } from '@shared/album-key'
import type {
  CommandResult,
  LibraryIndexStatus,
  LibraryTrackView,
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
import { SyncView } from './components/sync/SyncView'
import { useAlbumGroups } from './hooks/useAlbumGroups'
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

const IS_DEV = import.meta.env.DEV

interface ArtistFilterState {
  artistName: string
}

interface AlbumFilterState {
  albumKey: string
  albumLabel: string
}

interface PendingLibraryPerf {
  measureName: string
  screen: Screen
  startMark: string
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
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-border bg-surface-secondary px-4 py-3 shadow-xl">
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
  const [_pendingLibraryPerf, setPendingLibraryPerf] =
    useState<PendingLibraryPerf | null>(null)

  const { artists } = useArtists()
  const {
    tracks,
    loaded: tracksLoaded,
    refreshing: tracksRefreshing,
  } = useTracks()
  const { groups: allAlbums, filterByArtist } = useAlbumGroups(tracks)
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

  const startLibraryPerf = (nextScreen: Screen) => {
    if (!IS_DEV || !nextScreen.startsWith('library-')) return

    const view = nextScreen.replace('library-', '')
    const startMark = `${nextScreen}-start-${performance.now()}`
    performance.mark(startMark)
    setPendingLibraryPerf({
      measureName: `library-tab-switch-${view}`,
      screen: nextScreen,
      startMark,
    })
  }

  const completeLibraryPerf = (screenName: Screen) => {
    if (!IS_DEV) return

    setPendingLibraryPerf((current) => {
      if (!current || current.screen !== screenName) return current

      const endMark = `${current.measureName}-end-${performance.now()}`
      performance.mark(endMark)
      performance.measure(current.measureName, current.startMark, endMark)
      const entry = performance.getEntriesByName(current.measureName).at(-1)

      console.info('[perf] library view committed', {
        view: current.measureName,
        durationMs: Math.round(entry?.duration ?? 0),
      })

      return null
    })
  }

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
    startLibraryPerf(nextScreen)

    if (nextScreen.startsWith('library-') && nextScreen === 'library-artists') {
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
    startLibraryPerf('library-albums')
    setArtistFilter({ artistName: artist.name })
    setAlbumFilter(null)
    setScreen('library-albums')
  }

  const openAlbumSongs = (album: AlbumGroup) => {
    startLibraryPerf('library-songs')
    setAlbumFilter({ albumKey: album.key, albumLabel: album.album })
    setScreen('library-songs')
  }

  const onSearchArtist = (artist: LikedArtistView) => {
    startLibraryPerf('library-albums')
    setArtistFilter({ artistName: artist.name })
    setAlbumFilter(null)
    setScreen('library-albums')
  }

  const onSearchAlbum = (album: AlbumGroup) => {
    startLibraryPerf('library-songs')
    setAlbumFilter({ albumKey: album.key, albumLabel: album.album })
    setArtistFilter(null)
    setScreen('library-songs')
  }

  const onSearchSong = (track: LibraryTrackView) => {
    startLibraryPerf('library-songs')
    const key = buildAlbumKey(track.album, track.albumArtist)
    setAlbumFilter({
      albumKey: key,
      albumLabel: track.album ?? 'Unknown Album',
    })
    setArtistFilter(null)
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
      artists={artists}
      tracks={tracks}
      onSearchArtist={onSearchArtist}
      onSearchAlbum={onSearchAlbum}
      onSearchSong={onSearchSong}
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
          onInitialRender={() => completeLibraryPerf('library-artists')}
        />
      ) : null}

      {screen === 'library-albums' ? (
        <AlbumsView
          tracks={tracks}
          albums={
            artistFilter ? filterByArtist(artistFilter.artistName) : allAlbums
          }
          tracksLoaded={tracksLoaded}
          tracksRefreshing={tracksRefreshing}
          artistFilter={artistFilter}
          onOpenAlbum={openAlbumSongs}
          onClearArtistFilter={() => setArtistFilter(null)}
          onSyncLikedSongs={syncLikedSongs}
          onReprocessLibrary={reprocessLibrary}
          onReprocessFavoriteArtists={reprocessFavoriteArtists}
          onSyncToRemote={syncToRemote}
          onInitialRender={() => completeLibraryPerf('library-albums')}
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
          onInitialRender={() => completeLibraryPerf('library-songs')}
        />
      ) : null}

      {screen === 'sync' ? (
        <SyncView snapshot={snapshot} onAction={runAction} />
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
