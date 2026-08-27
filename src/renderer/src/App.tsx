import { buildAlbumKey } from '@shared/album-key'
import type {
  AuthStatus,
  CommandResult,
  LibraryTrackView,
  LikedArtistView,
  SyncSnapshot,
} from '@shared/contracts'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
  createContext,
  type JSX,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { MainLayout } from './components/layout/MainLayout'
import type { AlbumGroup } from './components/library/library-utils'
import { useArtists } from './hooks/useArtists'
import { useSettings } from './hooks/useSettings'
import { useSyncSnapshot } from './hooks/useSyncSnapshot'
import { useTracks } from './hooks/useTracks'
import {
  type LibrarySearch,
  LibraryViewContainer,
  normalizeLibrarySearchInput,
} from './routes/library'
import { SettingsRouteComponent } from './routes/settings'
import { SyncRouteComponent } from './routes/sync'

interface AppStateValue {
  artists: LikedArtistView[]
  tracks: LibraryTrackView[]
  tracksLoaded: boolean
  tracksRefreshing: boolean
  snapshot: SyncSnapshot
  authStatus: AuthStatus
  settings: ReturnType<typeof useSettings>['settings']
  setSettings: ReturnType<typeof useSettings>['setSettings']
  setAuthStatus: ReturnType<typeof useSettings>['setAuthStatus']
  saveSettings: ReturnType<typeof useSettings>['save']
  runAction: (action: Promise<CommandResult>) => Promise<void>
  showMessage: (message: string) => void
}

const AppStateContext = createContext<AppStateValue | null>(null)

function Toast({
  message,
  onDismiss,
}: {
  message: string
  onDismiss: () => void
}): JSX.Element {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-border bg-surface-secondary px-4 py-3 shadow-xl">
      <p className="text-sm text-text-primary">{message}</p>
    </div>
  )
}

function AppPane({
  active,
  children,
  scrollable = false,
}: {
  active: boolean
  children: JSX.Element
  scrollable?: boolean
}): JSX.Element {
  return (
    <section
      className={`absolute inset-0 bg-surface-primary ${scrollable ? 'overflow-auto' : 'overflow-hidden'} ${active ? 'visible pointer-events-auto z-10' : 'invisible pointer-events-none z-0'}`}
      aria-hidden={!active}
    >
      {children}
    </section>
  )
}

export function AppShell(): JSX.Element {
  const navigate = useNavigate()
  const location = useRouterState({
    select: (state) => state.location,
  })
  const [message, setMessage] = useState('')
  const [lastLibrarySearch, setLastLibrarySearch] = useState<LibrarySearch>(
    () => normalizeLibrarySearchInput(location.search)
  )
  const { artists } = useArtists()
  const {
    tracks,
    loaded: tracksLoaded,
    refreshing: tracksRefreshing,
  } = useTracks()
  const snapshot = useSyncSnapshot()
  const { settings, setSettings, authStatus, setAuthStatus, save } =
    useSettings()

  useEffect(() => {
    if (location.pathname !== '/library') return
    setLastLibrarySearch(normalizeLibrarySearchInput(location.search))
  }, [location.pathname, location.search])

  const runAction = useCallback(async (action: Promise<CommandResult>) => {
    const result: CommandResult = await action.catch((error: unknown) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))

    setMessage(
      result.details ? `${result.message} ${result.details}` : result.message
    )
  }, [])

  const onSearchArtist = (artist: LikedArtistView) =>
    void navigate({
      to: '/library',
      search: {
        tab: 'albums',
        artist: artist.name,
      },
    })

  const onSearchAlbum = (album: AlbumGroup) =>
    void navigate({
      to: '/library',
      search: {
        tab: 'songs',
        albumKey: album.key,
        albumLabel: album.album,
      },
    })

  const onSearchSong = (track: LibraryTrackView) =>
    void navigate({
      to: '/library',
      search: {
        tab: 'songs',
        albumKey: buildAlbumKey(track.album, track.albumArtist),
        albumLabel: track.album ?? 'Unknown Album',
      },
    })

  const appState = useMemo<AppStateValue>(
    () => ({
      artists,
      tracks,
      tracksLoaded,
      tracksRefreshing,
      snapshot,
      authStatus,
      settings,
      setSettings,
      setAuthStatus,
      saveSettings: save,
      runAction,
      showMessage: setMessage,
    }),
    [
      artists,
      tracks,
      tracksLoaded,
      tracksRefreshing,
      snapshot,
      authStatus,
      settings,
      setSettings,
      setAuthStatus,
      save,
      runAction,
    ]
  )

  return (
    <AppStateContext.Provider value={appState}>
      <MainLayout
        counts={snapshot.counts}
        artists={artists}
        tracks={tracks}
        onSearchArtist={onSearchArtist}
        onSearchAlbum={onSearchAlbum}
        onSearchSong={onSearchSong}
      >
        <div className="relative h-full overflow-hidden isolate bg-surface-primary">
          <AppPane active={location.pathname === '/library'}>
            <LibraryViewContainer search={lastLibrarySearch} />
          </AppPane>
          <AppPane active={location.pathname === '/sync'}>
            <SyncRouteComponent />
          </AppPane>
          <AppPane active={location.pathname === '/settings'} scrollable>
            <SettingsRouteComponent />
          </AppPane>
        </div>
      </MainLayout>
      {message ? (
        <Toast message={message} onDismiss={() => setMessage('')} />
      ) : null}
    </AppStateContext.Provider>
  )
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext)
  if (!value) {
    throw new Error('useAppState must be used within AppShell')
  }
  return value
}
