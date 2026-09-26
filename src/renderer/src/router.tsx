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
import { NeedsAttentionDrawer } from './components/NeedsAttention'
import { Palette } from './components/Palette'
import { SongPanel } from './components/SongPanel'
import { useAppState } from './lib/app-state'
import { ActivityPage } from './pages/ActivityPage'
import { AlbumPage } from './pages/AlbumPage'
import { AlbumsPage, type AlbumsSearch } from './pages/AlbumsPage'
import { ArtistPage } from './pages/ArtistPage'
import { ArtistsPage, type ArtistsSearch } from './pages/ArtistsPage'
import { SettingsPage } from './pages/SettingsPage'
import { SongsPage, type SongsSearch } from './pages/SongsPage'

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
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 min-w-0 relative">
        <div className="absolute inset-x-0 top-0 h-12 drag z-10 pointer-events-none" />
        <SearchBox />
        <div className="h-full">
          <Outlet />
        </div>
        <SongPanel />
      </main>
      <NeedsAttentionDrawer />
      <Palette />
    </div>
  )
}

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
  component: ArtistsPage,
})

const albumsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/albums',
  validateSearch: (search: Record<string, unknown>): AlbumsSearch =>
    pick<AlbumsSearch>(search, ['sort']),
  component: AlbumsPage,
})

const songsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/songs',
  validateSearch: (search: Record<string, unknown>): SongsSearch =>
    pick<SongsSearch>(search, [
      'lyrics',
      'remote',
      'state',
      'lang',
      'favorite',
      'sort',
      'desc',
      'song',
    ]),
  component: SongsPage,
})

const artistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/artist/$artistId',
  component: ArtistPage,
})

const albumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/album/$albumKey',
  validateSearch: (search: Record<string, unknown>): { from?: string } =>
    pick<{ from?: string }>(search, ['from']),
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
