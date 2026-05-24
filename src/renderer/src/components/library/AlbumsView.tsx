import type { LibraryTrackView } from '@shared/contracts'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { useAlbumArtwork } from '../../hooks/useAlbumArtwork'
import { FilterPill } from './FilterPill'
import { LibraryActionButtons } from './LibraryActionButtons'
import { groupAlbums, matchesArtistFilter, type AlbumGroup } from './library-utils'

interface ArtistFilter {
  artistName: string
}

interface Props {
  tracks: LibraryTrackView[]
  tracksLoaded: boolean
  tracksRefreshing: boolean
  artistFilter: ArtistFilter | null
  onOpenAlbum: (album: AlbumGroup) => void
  onClearArtistFilter: () => void
  onSyncLikedSongs: () => void
  onReprocessLibrary: () => void
  onReprocessFavoriteArtists: () => void
  onSyncToRemote: () => void
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
    <button
      type="button"
      onClick={onClick}
      className="bg-surface-secondary rounded-xl border border-border p-4 flex flex-col gap-1.5 text-left hover:border-border/80 transition-colors"
    >
      <div className="w-full aspect-square bg-surface-tertiary rounded-lg mb-2 overflow-hidden flex items-center justify-center">
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <AlbumPlaceholderIcon />
        )}
      </div>
      <p className="text-sm font-medium text-text-primary truncate">
        {group.album}
      </p>
      <p className="text-xs text-text-muted truncate">{group.albumArtist}</p>
      <p className="text-xs text-text-muted">
        {group.trackCount} {group.trackCount === 1 ? 'track' : 'tracks'}
        {group.year ? ` · ${group.year}` : ''}
      </p>
    </button>
  )
}

export function AlbumsView({
  tracks,
  tracksLoaded,
  tracksRefreshing,
  artistFilter,
  onOpenAlbum,
  onClearArtistFilter,
  onSyncLikedSongs,
  onReprocessLibrary,
  onReprocessFavoriteArtists,
  onSyncToRemote,
}: Props): JSX.Element {
  const visibleTracks = useMemo(
    () =>
      artistFilter
        ? tracks.filter((track) => matchesArtistFilter(track, artistFilter.artistName))
        : tracks,
    [artistFilter, tracks]
  )
  const albums = useMemo(() => groupAlbums(visibleTracks), [visibleTracks])
  const albumKeys = useMemo(() => albums.map((album) => album.key), [albums])
  const { getArtworkUrl, loading: artworkLoading, error: artworkError } =
    useAlbumArtwork(albumKeys)

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-4 mb-5">
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
          <p className="text-xs text-text-muted mt-0.5">
            {albums.length} albums
            {!tracksLoaded ? ' · loading library…' : ''}
            {tracksRefreshing ? ' · refreshing library…' : ''}
            {artworkLoading ? ' · loading artwork…' : ''}
            {artworkError ? ' · artwork unavailable' : ''}
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
        {albums.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-text-muted">
            <AlbumPlaceholderIcon />
            <p className="text-sm mt-3">
              {tracksLoaded ? 'No albums found' : 'Loading library…'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {albums.map((group) => (
              <AlbumCard
                key={group.key}
                group={group}
                artworkUrl={getArtworkUrl(group.key)}
                onClick={() => onOpenAlbum(group)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
