import type { CommandResult, LikedArtistView } from '@shared/contracts'
import {
  createRoute,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import type { JSX, MutableRefObject, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useAppState } from '../App'
import { AlbumsView } from '../components/library/AlbumsView'
import { ArtistsView } from '../components/library/ArtistsView'
import type { AlbumGroup } from '../components/library/library-utils'
import { SongsView } from '../components/library/SongsView'
import { useAlbumGroups } from '../hooks/useAlbumGroups'
import { rootRoute } from './root'

export const libraryTabSchema = z.enum(['artists', 'albums', 'songs'])
export type LibraryTab = z.infer<typeof libraryTabSchema>

const searchStringSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}, z.string().optional())

const rawLibrarySearchSchema = z.object({
  tab: libraryTabSchema.optional(),
  artist: searchStringSchema.optional(),
  artistId: searchStringSchema.optional(),
  albumKey: searchStringSchema.optional(),
  albumLabel: searchStringSchema.optional(),
})

export interface LibrarySearch {
  tab: LibraryTab
  artist?: string
  artistId?: string
  albumKey?: string
  albumLabel?: string
}

export function normalizeLibrarySearchInput(search: unknown): LibrarySearch {
  const parsed = rawLibrarySearchSchema.safeParse(search)
  const candidate = parsed.success ? parsed.data : {}
  const tab = candidate.tab ?? 'artists'

  if (tab === 'albums') {
    return candidate.artist
      ? { tab, artist: candidate.artist, artistId: candidate.artistId }
      : { tab }
  }

  if (tab === 'songs') {
    return {
      tab,
      ...(candidate.albumKey ? { albumKey: candidate.albumKey } : {}),
      ...(candidate.albumLabel ? { albumLabel: candidate.albumLabel } : {}),
    }
  }

  return { tab }
}

function serializeLibrarySearch(search: LibrarySearch): string {
  const params = new URLSearchParams()
  params.set('tab', search.tab)
  if (search.artist) params.set('artist', search.artist)
  if (search.artistId) params.set('artistId', search.artistId)
  if (search.albumKey) params.set('albumKey', search.albumKey)
  if (search.albumLabel) params.set('albumLabel', search.albumLabel)
  return params.toString()
}

function LibraryPane({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <section
      className={`absolute inset-0 overflow-hidden bg-surface-primary ${active ? 'visible pointer-events-auto z-10' : 'invisible pointer-events-none z-0'}`}
      aria-hidden={!active}
    >
      {children}
    </section>
  )
}

function completeLibraryPerf(
  pendingTabRef: MutableRefObject<LibraryTab | null>,
  tab: LibraryTab
) {
  if (!import.meta.env.DEV || pendingTabRef.current !== tab) return

  const measureName = `library-tab-switch-${tab}`
  const startMark = `${measureName}-start`
  const endMark = `${measureName}-end-${performance.now()}`
  performance.mark(endMark)
  performance.measure(measureName, startMark, endMark)
  const entry = performance.getEntriesByName(measureName).at(-1)

  console.info('[perf] library view committed', {
    view: measureName,
    durationMs: Math.round(entry?.duration ?? 0),
  })

  pendingTabRef.current = null
}

export const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'library',
  validateSearch: (search): LibrarySearch =>
    normalizeLibrarySearchInput(search),
  component: LibraryRouteComponent,
})

function LibraryRouteComponent(): JSX.Element {
  const search = libraryRoute.useSearch()
  return <LibraryViewContainer search={search} />
}

export function LibraryViewContainer({
  search,
}: {
  search: LibrarySearch
}): JSX.Element {
  const navigate = useNavigate()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const {
    artists,
    tracks,
    tracksLoaded,
    tracksRefreshing,
    authStatus,
    runAction,
  } = useAppState()
  const [selectionEnabled, setSelectionEnabled] = useState(false)
  const [selectedArtistIds, setSelectedArtistIds] = useState<string[]>([])
  const { groups: allAlbums, filterByArtist } = useAlbumGroups(tracks)
  const activeTab = search.tab
  const activeArtistFilter =
    activeTab === 'albums' && search.artist
      ? { id: search.artistId ?? null, name: search.artist }
      : null
  const activeAlbumFilter =
    activeTab === 'songs' && search.albumKey
      ? {
          albumKey: search.albumKey,
          albumLabel: search.albumLabel ?? 'Filtered Album',
        }
      : null
  const pendingPerfTabRef = useRef<LibraryTab | null>(null)

  useEffect(() => {
    if (pathname !== '/library') return

    const currentHash = window.location.hash
    const currentSearch = currentHash.includes('?')
      ? currentHash.slice(currentHash.indexOf('?') + 1)
      : ''
    const normalizedSearch = serializeLibrarySearch(search)

    if (currentSearch === normalizedSearch) return

    void navigate({
      to: '/library',
      search,
      replace: true,
    })
  }, [navigate, pathname, search])

  const startLibraryPerf = (tab: LibraryTab) => {
    if (!import.meta.env.DEV) return

    pendingPerfTabRef.current = tab
    const startMark = `library-tab-switch-${tab}-start`
    performance.clearMarks(startMark)
    performance.mark(startMark)
  }

  const navigateToLibrary = (nextSearch: LibrarySearch) => {
    if (nextSearch.tab !== activeTab) {
      startLibraryPerf(nextSearch.tab)
    }

    void navigate({
      to: '/library',
      search: nextSearch,
    })
  }

  const toggleArtistSelect = (artistId: string) => {
    setSelectedArtistIds((current) =>
      current.includes(artistId)
        ? current.filter((id) => id !== artistId)
        : [...current, artistId]
    )
  }

  const openArtistAlbums = (artist: LikedArtistView) =>
    navigateToLibrary({
      tab: 'albums',
      artist: artist.name,
      artistId: artist.id,
    })

  const openAlbumSongs = (album: AlbumGroup) =>
    navigateToLibrary({
      tab: 'songs',
      albumKey: album.key,
      albumLabel: album.album,
    })

  const onAction = (action: Promise<CommandResult>) => runAction(action)
  const albums = useMemo(
    () =>
      activeArtistFilter
        ? filterByArtist(activeArtistFilter.id, activeArtistFilter.name)
        : allAlbums,
    [activeArtistFilter, allAlbums, filterByArtist]
  )

  return (
    <div className="relative h-full overflow-hidden isolate bg-surface-primary">
      <LibraryPane active={activeTab === 'artists'}>
        <ArtistsView
          artists={artists}
          selectedIds={selectedArtistIds}
          selectionEnabled={selectionEnabled}
          authStatus={authStatus}
          isActive={activeTab === 'artists'}
          onToggleSelectionMode={() =>
            setSelectionEnabled((current) => !current)
          }
          onToggleSelect={toggleArtistSelect}
          onOpenArtist={openArtistAlbums}
          onAction={onAction}
          onClearSelected={() => setSelectedArtistIds([])}
          onInitialRender={() =>
            completeLibraryPerf(pendingPerfTabRef, 'artists')
          }
        />
      </LibraryPane>

      <LibraryPane active={activeTab === 'albums'}>
        <AlbumsView
          tracks={tracks}
          albums={albums}
          tracksLoaded={tracksLoaded}
          tracksRefreshing={tracksRefreshing}
          artistFilter={
            activeArtistFilter ? { artistName: activeArtistFilter.name } : null
          }
          isActive={activeTab === 'albums'}
          onOpenAlbum={openAlbumSongs}
          onClearArtistFilter={() => navigateToLibrary({ tab: 'albums' })}
          onSyncLikedSongs={() =>
            onAction(window.api.sync.startLikedSongsSync())
          }
          onReprocessLibrary={() =>
            onAction(window.api.sync.startLibraryReprocess())
          }
          onReprocessFavoriteArtists={() =>
            onAction(window.api.sync.refreshFavoriteArtists())
          }
          onSyncToRemote={() => onAction(window.api.sync.syncMissingToRemote())}
          onInitialRender={() =>
            completeLibraryPerf(pendingPerfTabRef, 'albums')
          }
        />
      </LibraryPane>

      <LibraryPane active={activeTab === 'songs'}>
        <SongsView
          tracks={tracks}
          tracksLoaded={tracksLoaded}
          tracksRefreshing={tracksRefreshing}
          albumFilter={activeAlbumFilter}
          isActive={activeTab === 'songs'}
          onClearAlbumFilter={() => navigateToLibrary({ tab: 'songs' })}
          onSyncLikedSongs={() =>
            onAction(window.api.sync.startLikedSongsSync())
          }
          onReprocessLibrary={() =>
            onAction(window.api.sync.startLibraryReprocess())
          }
          onReprocessFavoriteArtists={() =>
            onAction(window.api.sync.refreshFavoriteArtists())
          }
          onSyncToRemote={() => onAction(window.api.sync.syncMissingToRemote())}
          onInitialRender={() =>
            completeLibraryPerf(pendingPerfTabRef, 'songs')
          }
        />
      </LibraryPane>
    </div>
  )
}
