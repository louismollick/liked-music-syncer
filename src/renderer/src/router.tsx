import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router'
import { SearchBox } from './components/layout/SearchBox'
import { Sidebar } from './components/layout/Sidebar'
import { NeedsAttentionDrawer } from './components/NeedsAttention'
import { Palette } from './components/Palette'
import { SongPanel } from './components/SongPanel'
import { ActivityPage } from './pages/ActivityPage'
import { AlbumPage } from './pages/AlbumPage'
import { AlbumsPage, type AlbumsSearch } from './pages/AlbumsPage'
import { ArtistPage } from './pages/ArtistPage'
import { ArtistsPage, type ArtistsSearch } from './pages/ArtistsPage'
import { SettingsPage } from './pages/SettingsPage'
import { SongsPage, type SongsSearch } from './pages/SongsPage'

function RootLayout() {
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
