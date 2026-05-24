import type { LikedArtistView } from '@shared/contracts'
import type { JSX } from 'react'
import { ArtistCard } from './ArtistCard'

interface Props {
  artists: LikedArtistView[]
  selectedIds: string[]
  selectionEnabled: boolean
  onArtistClick: (artist: LikedArtistView) => void
  onToggleFavorite: (artist: LikedArtistView) => void
}

export function ArtistGrid({
  artists,
  selectedIds,
  selectionEnabled,
  onArtistClick,
  onToggleFavorite,
}: Props): JSX.Element {
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
