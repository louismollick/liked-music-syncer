import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import { SearchBox } from './components/layout/SearchBox'
import { Sidebar } from './components/layout/Sidebar'
import { TabPages } from './components/layout/TabPages'
import { NeedsAttentionDrawer } from './components/NeedsAttention'
import { Palette } from './components/Palette'
import { SongPanel } from './components/SongPanel'
import { useAppState } from './lib/app-state'
import { TabSearchesProvider, useRememberedSearches } from './lib/tabs'
import { ActivityPage } from './pages/ActivityPage'
import { AlbumPage } from './pages/AlbumPage'
import type { AlbumsSearch } from './pages/AlbumsPage'
import { ArtistPage } from './pages/ArtistPage'
import type { ArtistsSearch } from './pages/ArtistsPage'
import { SettingsPage } from './pages/SettingsPage'
import type { SongsSearch } from './pages/SongsPage'

/** The Song panel follows the URL's `song` parameter; other navigation closes it. */
function useSongPanelFollowsUrl() {
  const { closeSong, openSong } = useAppState()
  const location = useRouterState({ select: (state) => state.location })
  const song = (location.search as { song?: string }).song ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to navigation
  useEffect(() => {
    if (song) openSong(song)
    else closeSong()
  }, [location.pathname, song])
}

function RootLayout() {
  useSongPanelFollowsUrl()
  const searches = useRememberedSearches()
  return (
    <TabSearchesProvider value={searches}>
      <div className="flex h-full">
        <Sidebar />
        <main className="flex-1 min-w-0 relative">
          {/* The whole top edge moves the window, like the sidebar's title bar. */}
          <div
            aria-hidden
            className="drag absolute inset-x-0 top-0 h-12 z-20 pointer-events-none"
          />
          <SearchBox />
          <div className="h-full relative">
            <TabPages searches={searches} />
            <Outlet />
          </div>
          <SongPanel />
        </main>
        <NeedsAttentionDrawer />
        <Palette />
      </div>
    </TabSearchesProvider>
  )
}

/** Tab routes render nothing themselves; TabPages keeps their pages mounted. */
const TabRoute = () => null

const pick = <T extends object>(
  search: Record<string, unknown>,
  keys: Array<keyof T>
): T => {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const value = search[key as string]
    if (value !== undefined && value !== '') out[key as string] = value
  }
  return out as T
}

const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/artists' })
  },
})

const artistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/artists',
  validateSearch: (search: Record<string, unknown>): ArtistsSearch =>
    pick<ArtistsSearch>(search, ['filter', 'sort']),
  component: TabRoute,
})

const albumsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/albums',
  validateSearch: (search: Record<string, unknown>): AlbumsSearch =>
    pick<AlbumsSearch>(search, ['sort', 'fullDiscography']),
  component: TabRoute,
})

const songsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/songs',
  validateSearch: (search: Record<string, unknown>): SongsSearch =>
    pick<SongsSearch>(search, [
      'likedOn',
      'lyrics',
      'remote',
      'state',
      'lang',
      'fullDiscography',
      'sort',
      'desc',
      'song',
    ]),
  component: TabRoute,
})

const artistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/artist/$artistId',
  component: ArtistPage,
})

const albumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/album/$albumKey',
  validateSearch: (
    search: Record<string, unknown>
  ): { from?: string; fromName?: string } =>
    pick<{ from?: string; fromName?: string }>(search, ['from', 'fromName']),
  component: AlbumPage,
})

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  component: ActivityPage,
})
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  artistsRoute,
  albumsRoute,
  songsRoute,
  artistRoute,
  albumRoute,
  activityRoute,
  settingsRoute,
])

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: false,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
