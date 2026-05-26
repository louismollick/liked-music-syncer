import type { LikedArtistView } from '@shared/contracts'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { JSX } from 'react'
import { useEffect, useMemo } from 'react'
import { ArtistCard } from './ArtistCard'
import {
  ARTIST_CARD_HEIGHT,
  chunkItems,
  GRID_GAP_PX,
  GRID_ROW_OVERSCAN,
  getGridColumnCount,
  getVirtualGridRowHeight,
} from './virtualization'

interface Props {
  artists: LikedArtistView[]
  selectedIds: string[]
  selectionEnabled: boolean
  isActive?: boolean
  onArtistClick: (artist: LikedArtistView) => void
  onToggleFavorite: (artist: LikedArtistView) => void
  scrollElement?: HTMLDivElement | null
  containerWidth?: number
  containerHeight?: number
  onInitialRender?: () => void
}

export function ArtistGrid({
  artists,
  selectedIds,
  selectionEnabled,
  isActive = true,
  onArtistClick,
  onToggleFavorite,
  scrollElement,
  containerWidth = 0,
  containerHeight = 0,
  onInitialRender,
}: Props): JSX.Element {
  const shouldVirtualize =
    Boolean(scrollElement) && containerWidth > 0 && containerHeight > 0
  const columnCount = getGridColumnCount(containerWidth)
  const rows = useMemo(
    () => chunkItems(artists, columnCount),
    [artists, columnCount]
  )
  const rowHeight = getVirtualGridRowHeight(
    containerWidth,
    columnCount,
    ARTIST_CARD_HEIGHT
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement ?? null,
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

  useEffect(() => {
    if (
      isActive &&
      artists.length > 0 &&
      (!shouldVirtualize || virtualRows.length > 0)
    ) {
      onInitialRender?.()
    }
  }, [
    artists.length,
    isActive,
    onInitialRender,
    shouldVirtualize,
    virtualRows.length,
  ])

  if (artists.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-text-muted">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="w-12 h-12 fill-current mb-3 opacity-40"
        >
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
        </svg>
        <p className="text-sm">No artists found</p>
      </div>
    )
  }

  if (!shouldVirtualize) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
        {artists.map((artist) => (
          <ArtistCard
            key={artist.id}
            artist={artist}
            selected={selectedIds.includes(artist.id)}
            selectionEnabled={selectionEnabled}
            onClick={() => onArtistClick(artist)}
            onToggleFavorite={() => onToggleFavorite(artist)}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      className="relative w-full"
      style={{
        height: virtualizer.getTotalSize(),
      }}
    >
      {virtualRows.map((virtualRow) => (
        <div
          key={virtualRow.key}
          className="absolute left-0 top-0 grid w-full"
          style={{
            boxSizing: 'border-box',
            gap: `${GRID_GAP_PX}px`,
            gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
            height: rowHeight,
            paddingBottom: `${GRID_GAP_PX}px`,
            transform: `translateY(${virtualRow.start}px)`,
          }}
        >
          {rows[virtualRow.index]?.map((artist) => (
            <ArtistCard
              key={artist.id}
              artist={artist}
              selected={selectedIds.includes(artist.id)}
              selectionEnabled={selectionEnabled}
              onClick={() => onArtistClick(artist)}
              onToggleFavorite={() => onToggleFavorite(artist)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
