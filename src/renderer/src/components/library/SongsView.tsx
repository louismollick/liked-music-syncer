import type { LibraryTrackView } from '@shared/contracts'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Badge } from '../ui/Badge'
import { FilterPill } from './FilterPill'
import { LibraryActionButtons } from './LibraryActionButtons'
import {
  lyricTypeLabel,
  matchesAlbumFilter,
  remoteStatusLabel,
} from './library-utils'

type SortKey = 'title' | 'artist' | 'album' | 'year'
type SortDir = 'asc' | 'desc'

interface AlbumFilter {
  albumKey: string
  albumLabel: string
}

interface Props {
  tracks: LibraryTrackView[]
  tracksLoaded: boolean
  tracksRefreshing: boolean
  albumFilter: AlbumFilter | null
  onClearAlbumFilter: () => void
  onSyncLikedSongs: () => void
  onReprocessLibrary: () => void
  onReprocessFavoriteArtists: () => void
  onSyncToRemote: () => void
}

function sortTracks(
  tracks: LibraryTrackView[],
  key: SortKey,
  dir: SortDir
): LibraryTrackView[] {
  return [...tracks].sort((a, b) => {
    const av = a[key] ?? ''
    const bv = b[key] ?? ''
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
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
  sortKey: SortKey
  active: boolean
  dir: SortDir
  onClick: (key: SortKey) => void
}): JSX.Element {
  return (
    <th className="text-left px-3 py-2">
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
            className={`w-3 h-3 fill-current transition-transform ${dir === 'desc' ? 'rotate-180' : ''}`}
          >
            <path d="M6 2l4 6H2z" />
          </svg>
        ) : null}
      </button>
    </th>
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
  onClearAlbumFilter,
  onSyncLikedSongs,
  onReprocessLibrary,
  onReprocessFavoriteArtists,
  onSyncToRemote,
}: Props): JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('title')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const visibleTracks = useMemo(
    () =>
      albumFilter
        ? tracks.filter((track) => matchesAlbumFilter(track, albumFilter.albumKey))
        : tracks,
    [albumFilter, tracks]
  )

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((direction) => (direction === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sorted = useMemo(
    () => sortTracks(visibleTracks, sortKey, sortDir),
    [sortDir, sortKey, visibleTracks]
  )

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-4 mb-5">
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
          <p className="text-xs text-text-muted mt-0.5">
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

      <div className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-text-muted">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="w-12 h-12 fill-current mb-3 opacity-40"
            >
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
            <p className="text-sm">
              {tracksLoaded ? 'No tracks found' : 'Loading library…'}
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface-primary border-b border-border">
              <tr>
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
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                  Lyric Type
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                  Language
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                  Remote Status
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((track) => {
                const lyricType = lyricTypeLabel(track.lyricsStatus)
                const remoteStatus = remoteStatusLabel(track)

                return (
                  <tr
                    key={track.id}
                    className="border-b border-border/50 hover:bg-surface-secondary/50 transition-colors"
                  >
                    <td className="px-3 py-2.5 text-sm text-text-primary truncate max-w-[220px]">
                      {track.title ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-sm text-text-secondary truncate max-w-[180px]">
                      {track.artist ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-sm text-text-secondary truncate max-w-[180px]">
                      {track.album ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-sm text-text-muted tabular-nums">
                      {track.year ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-sm text-text-secondary">
                      <Badge variant={lyricTypeVariant(lyricType)}>
                        {lyricType}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-text-secondary">
                      {track.language ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-sm text-text-secondary">
                      <Badge variant={remoteStatusVariant(remoteStatus)}>
                        {remoteStatus}
                      </Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
