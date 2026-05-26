import type { LibraryTrackView } from '@shared/contracts'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { useAlbumArtwork } from '../../hooks/useAlbumArtwork'
import { useElementSize } from '../../hooks/useElementSize'
import { FilterPill } from './FilterPill'
import { LibraryActionButtons } from './LibraryActionButtons'
import type { AlbumGroup } from './library-utils'
import {
  ALBUM_CARD_HEIGHT,
  chunkItems,
  GRID_GAP_PX,
  GRID_ROW_OVERSCAN,
  getGridColumnCount,
  getVirtualGridRowHeight,
} from './virtualization'

interface ArtistFilter {
  artistName: string
}

interface Props {
  tracks: LibraryTrackView[]
  albums: AlbumGroup[]
  tracksLoaded: boolean
  tracksRefreshing: boolean
  artistFilter: ArtistFilter | null
  isActive: boolean
  onOpenAlbum: (album: AlbumGroup) => void
  onClearArtistFilter: () => void
  onSyncLikedSongs: () => void
  onReprocessLibrary: () => void
  onReprocessFavoriteArtists: () => void
  onSyncToRemote: () => void
  onInitialRender?: () => void
}

function AlbumPlaceholderIcon(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="w-10 h-10 fill-current text-text-muted opacity-40"
    >
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  )
}

function AlbumCard({
  group,
  artworkUrl,
  onClick,
}: {
  group: AlbumGroup
  artworkUrl: string | null
  onClick: () => void
}): JSX.Element {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-surface-secondary transition-all hover:border-surface-hover">
      <button
        type="button"
        onClick={onClick}
        className="w-full cursor-pointer text-left"
        aria-label={`Open ${group.album}`}
      >
        <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-surface-tertiary">
          {artworkUrl ? (
            <img
              src={artworkUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <AlbumPlaceholderIcon />
          )}
        </div>
        <div className="p-2.5">
          <p className="truncate text-sm font-medium text-text-primary">
            {group.album}
          </p>
          <p className="truncate text-xs text-text-muted">
            {group.albumArtist}
          </p>
          <p className="text-xs text-text-muted">
            {group.trackCount} {group.trackCount === 1 ? 'track' : 'tracks'}
            {group.year ? ` · ${group.year}` : ''}
          </p>
        </div>
      </button>
    </div>
  )
}

export function AlbumsView({
  tracks,
  albums,
  tracksLoaded,
  tracksRefreshing,
  artistFilter,
  isActive,
  onOpenAlbum,
  onClearArtistFilter,
  onSyncLikedSongs,
  onReprocessLibrary,
  onReprocessFavoriteArtists,
  onSyncToRemote,
  onInitialRender,
}: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(scrollRef)
  const shouldVirtualize = width > 0 && height > 0
  const columnCount = getGridColumnCount(width)
  const rows = useMemo(
    () => chunkItems(albums, columnCount),
    [albums, columnCount]
  )
  const rowHeight = getVirtualGridRowHeight(
    width,
    columnCount,
    ALBUM_CARD_HEIGHT
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: GRID_ROW_OVERSCAN,
  })

  useEffect(() => {
    if (isActive && shouldVirtualize) {
      void rowHeight
      virtualizer.measure()
    }
  }, [isActive, rowHeight, shouldVirtualize, virtualizer])

  const virtualRows = virtualizer.getVirtualItems()
  const visibleAlbumKeys = useMemo(
    () =>
      shouldVirtualize
        ? [
            ...new Set(
              virtualRows.flatMap(
                (virtualRow) =>
                  rows[virtualRow.index]?.map((album) => album.key) ?? []
              )
            ),
          ]
        : albums.map((album) => album.key),
    [albums, rows, shouldVirtualize, virtualRows]
  )
  const {
    getArtworkUrl,
    loading: artworkLoading,
    error: artworkError,
  } = useAlbumArtwork(visibleAlbumKeys)

  useEffect(() => {
    if (
      isActive &&
      albums.length > 0 &&
      (!shouldVirtualize || virtualRows.length > 0)
    ) {
      onInitialRender?.()
    }
  }, [
    albums.length,
    isActive,
    onInitialRender,
    shouldVirtualize,
    virtualRows.length,
  ])

  const renderedRows = shouldVirtualize
    ? virtualRows
    : rows.map((_, index) => ({
        index,
        key: index,
        start: index * rowHeight,
      }))

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-text-primary">Albums</h2>
            {artistFilter ? (
              <FilterPill
                label={artistFilter.artistName}
                onClear={onClearArtistFilter}
              />
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            {albums.length} albums
            {!tracksLoaded ? ' · loading library…' : ''}
            {tracksRefreshing ? ' · refreshing library…' : ''}
            {artworkLoading ? ' · loading artwork…' : ''}
            {artworkError ? ' · artwork unavailable' : ''}
            {tracks.length === 0 && tracksLoaded ? ' · empty library' : ''}
          </p>
        </div>
        <LibraryActionButtons
          onSyncLikedSongs={onSyncLikedSongs}
          onReprocessLibrary={onReprocessLibrary}
          onReprocessFavoriteArtists={onReprocessFavoriteArtists}
          onSyncToRemote={onSyncToRemote}
        />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto">
        {albums.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-text-muted">
            <AlbumPlaceholderIcon />
            <p className="mt-3 text-sm">
              {tracksLoaded ? 'No albums found' : 'Loading library…'}
            </p>
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{
              height: shouldVirtualize ? virtualizer.getTotalSize() : 'auto',
            }}
          >
            {renderedRows.map((virtualRow) => (
              <div
                key={virtualRow.key}
                className="grid w-full"
                style={{
                  boxSizing: 'border-box',
                  gap: `${GRID_GAP_PX}px`,
                  gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                  height: shouldVirtualize ? rowHeight : undefined,
                  paddingBottom: `${GRID_GAP_PX}px`,
                  position: shouldVirtualize ? 'absolute' : 'relative',
                  top: 0,
                  left: 0,
                  transform: shouldVirtualize
                    ? `translateY(${virtualRow.start}px)`
                    : undefined,
                }}
              >
                {rows[virtualRow.index]?.map((group) => (
                  <AlbumCard
                    key={group.key}
                    group={group}
                    artworkUrl={getArtworkUrl(group.key)}
                    onClick={() => onOpenAlbum(group)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
