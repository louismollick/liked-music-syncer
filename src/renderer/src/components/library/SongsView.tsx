import type { LibraryTrackView } from '@shared/contracts'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useElementSize } from '../../hooks/useElementSize'
import { Badge } from '../ui/Badge'
import { FilterPill } from './FilterPill'
import { LibraryActionButtons } from './LibraryActionButtons'
import {
  lyricTypeLabel,
  matchesAlbumFilter,
  remoteStatusLabel,
  type SongSortKey,
  songSortValue,
} from './library-utils'
import { SONG_ROW_HEIGHT, SONG_ROW_OVERSCAN } from './virtualization'

type SortDir = 'asc' | 'desc'

const SONG_GRID_TEMPLATE =
  'minmax(220px, 2fr) minmax(180px, 1.5fr) minmax(180px, 1.5fr) minmax(72px, 0.7fr) minmax(128px, 1fr) minmax(120px, 0.9fr) minmax(132px, 1fr)'

interface AlbumFilter {
  albumKey: string
  albumLabel: string
}

interface Props {
  tracks: LibraryTrackView[]
  tracksLoaded: boolean
  tracksRefreshing: boolean
  albumFilter: AlbumFilter | null
  isActive: boolean
  onClearAlbumFilter: () => void
  onSyncLikedSongs: () => void
  onReprocessLibrary: () => void
  onReprocessFavoriteArtists: () => void
  onSyncToRemote: () => void
  onInitialRender?: () => void
}

function sortTracks(
  tracks: LibraryTrackView[],
  key: SongSortKey,
  dir: SortDir
): LibraryTrackView[] {
  return [...tracks].sort((a, b) => {
    const av = songSortValue(a, key)
    const bv = songSortValue(b, key)
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, {
            sensitivity: 'base',
          })
    return dir === 'asc' ? cmp : -cmp
  })
}

function ColHeader({
  label,
  sortKey,
  active,
  dir,
  onClick,
}: {
  label: string
  sortKey: SongSortKey
  active: boolean
  dir: SortDir
  onClick: (key: SongSortKey) => void
}): JSX.Element {
  return (
    <div className="px-3 py-2">
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={`flex items-center gap-1 text-xs font-medium uppercase tracking-wide transition-colors ${
          active
            ? 'text-text-primary'
            : 'text-text-muted hover:text-text-primary'
        }`}
      >
        {label}
        {active ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            className={`h-3 w-3 fill-current transition-transform ${dir === 'desc' ? 'rotate-180' : ''}`}
          >
            <path d="M6 2l4 6H2z" />
          </svg>
        ) : null}
      </button>
    </div>
  )
}

function lyricTypeVariant(
  label: ReturnType<typeof lyricTypeLabel>
): 'success' | 'warning' | 'default' {
  switch (label) {
    case 'Synced':
      return 'success'
    case 'Unsynced':
      return 'warning'
    default:
      return 'default'
  }
}

function remoteStatusVariant(
  label: ReturnType<typeof remoteStatusLabel>
): 'success' | 'warning' | 'info' | 'error' {
  switch (label) {
    case 'In Sync':
      return 'success'
    case 'Local Only':
      return 'warning'
    case 'Remote Only':
      return 'info'
    default:
      return 'error'
  }
}

export function SongsView({
  tracks,
  tracksLoaded,
  tracksRefreshing,
  albumFilter,
  isActive,
  onClearAlbumFilter,
  onSyncLikedSongs,
  onReprocessLibrary,
  onReprocessFavoriteArtists,
  onSyncToRemote,
  onInitialRender,
}: Props): JSX.Element {
  const [sortKey, setSortKey] = useState<SongSortKey>('title')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const scrollRef = useRef<HTMLDivElement>(null)
  const { height } = useElementSize(scrollRef)

  const visibleTracks = useMemo(
    () =>
      albumFilter
        ? tracks.filter((track) =>
            matchesAlbumFilter(track, albumFilter.albumKey)
          )
        : tracks,
    [albumFilter, tracks]
  )

  const handleSort = (key: SongSortKey) => {
    if (key === sortKey) {
      setSortDir((direction) => (direction === 'asc' ? 'desc' : 'asc'))
      return
    }

    setSortKey(key)
    setSortDir('asc')
  }

  const sorted = useMemo(
    () => sortTracks(visibleTracks, sortKey, sortDir),
    [sortDir, sortKey, visibleTracks]
  )
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SONG_ROW_HEIGHT,
    overscan: SONG_ROW_OVERSCAN,
  })

  useEffect(() => {
    if (!isActive) return

    void height
    virtualizer.measure()
  }, [height, isActive, virtualizer])

  const virtualRows = virtualizer.getVirtualItems()

  useEffect(() => {
    if (isActive && sorted.length > 0 && virtualRows.length > 0) {
      onInitialRender?.()
    }
  }, [isActive, onInitialRender, sorted.length, virtualRows.length])

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-text-primary">Songs</h2>
            {albumFilter ? (
              <FilterPill
                label={albumFilter.albumLabel}
                onClear={onClearAlbumFilter}
              />
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            {visibleTracks.length} tracks
            {!tracksLoaded ? ' · loading library…' : ''}
            {tracksRefreshing ? ' · refreshing library…' : ''}
          </p>
        </div>
        <LibraryActionButtons
          onSyncLikedSongs={onSyncLikedSongs}
          onReprocessLibrary={onReprocessLibrary}
          onReprocessFavoriteArtists={onReprocessFavoriteArtists}
          onSyncToRemote={onSyncToRemote}
        />
      </div>

      <div className="flex-1 min-h-0">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-text-muted">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="mb-3 h-12 w-12 fill-current opacity-40"
            >
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
            <p className="text-sm">
              {tracksLoaded ? 'No tracks found' : 'Loading library…'}
            </p>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div
              className="grid shrink-0 border-b border-border bg-surface-primary"
              style={{ gridTemplateColumns: SONG_GRID_TEMPLATE }}
            >
              <ColHeader
                label="Title"
                sortKey="title"
                active={sortKey === 'title'}
                dir={sortDir}
                onClick={handleSort}
              />
              <ColHeader
                label="Artist"
                sortKey="artist"
                active={sortKey === 'artist'}
                dir={sortDir}
                onClick={handleSort}
              />
              <ColHeader
                label="Album"
                sortKey="album"
                active={sortKey === 'album'}
                dir={sortDir}
                onClick={handleSort}
              />
              <ColHeader
                label="Year"
                sortKey="year"
                active={sortKey === 'year'}
                dir={sortDir}
                onClick={handleSort}
              />
              <ColHeader
                label="Lyric Type"
                sortKey="lyricType"
                active={sortKey === 'lyricType'}
                dir={sortDir}
                onClick={handleSort}
              />
              <ColHeader
                label="Language"
                sortKey="language"
                active={sortKey === 'language'}
                dir={sortDir}
                onClick={handleSort}
              />
              <ColHeader
                label="Remote Status"
                sortKey="remoteStatus"
                active={sortKey === 'remoteStatus'}
                dir={sortDir}
                onClick={handleSort}
              />
            </div>

            <div ref={scrollRef} className="flex-1 overflow-auto">
              <div
                className="relative min-w-[1120px]"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualRows.map((virtualRow) => {
                  const track = sorted[virtualRow.index]
                  if (!track) return null

                  const lyricType = lyricTypeLabel(track.lyricsStatus)
                  const remoteStatus = remoteStatusLabel(track)

                  return (
                    <div
                      key={track.id}
                      className="absolute left-0 top-0 grid w-full border-b border-border/50 transition-colors hover:bg-surface-secondary/50"
                      style={{
                        gridTemplateColumns: SONG_GRID_TEMPLATE,
                        height: SONG_ROW_HEIGHT,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <div className="truncate px-3 py-2.5 text-sm text-text-primary">
                        {track.title ?? '—'}
                      </div>
                      <div className="truncate px-3 py-2.5 text-sm text-text-secondary">
                        {track.artist ?? '—'}
                      </div>
                      <div className="truncate px-3 py-2.5 text-sm text-text-secondary">
                        {track.album ?? '—'}
                      </div>
                      <div className="px-3 py-2.5 text-sm tabular-nums text-text-muted">
                        {track.year ?? '—'}
                      </div>
                      <div className="px-3 py-2.5 text-sm text-text-secondary">
                        <Badge variant={lyricTypeVariant(lyricType)}>
                          {lyricType}
                        </Badge>
                      </div>
                      <div className="px-3 py-2.5 text-sm text-text-secondary">
                        {track.language ?? '—'}
                      </div>
                      <div className="px-3 py-2.5 text-sm text-text-secondary">
                        <Badge variant={remoteStatusVariant(remoteStatus)}>
                          {remoteStatus}
                        </Badge>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
