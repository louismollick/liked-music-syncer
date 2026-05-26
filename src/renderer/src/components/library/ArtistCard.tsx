import type { LikedArtistView } from '@shared/contracts'
import type { JSX } from 'react'

interface Props {
  artist: LikedArtistView
  selected: boolean
  selectionEnabled: boolean
  onClick: () => void
  onToggleFavorite: () => void
}

function StarIcon({ filled }: { filled: boolean }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`w-3.5 h-3.5 ${filled ? 'fill-warning text-warning' : 'fill-none text-text-muted stroke-current'}`}
      strokeWidth={filled ? 0 : 1.5}
    >
      <path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z" />
    </svg>
  )
}

export function ArtistCard({
  artist,
  selected,
  selectionEnabled,
  onClick,
  onToggleFavorite,
}: Props): JSX.Element {
  return (
    <div
      className={`group relative bg-surface-secondary rounded-xl border transition-all overflow-hidden ${
        selected ? 'border-accent' : 'border-border hover:border-surface-hover'
      }`}
    >
      <button
        type="button"
        className="w-full text-left cursor-pointer"
        onClick={onClick}
        aria-label={
          selectionEnabled
            ? `${selected ? 'Deselect' : 'Select'} ${artist.name}`
            : `Open ${artist.name}`
        }
      >
        <div className="aspect-square bg-surface-tertiary relative overflow-hidden">
          {artist.photoUrl ? (
            <img
              src={artist.photoUrl}
              alt={artist.name}
              className="w-full h-full object-cover"
              onError={(e) => {
                console.warn('[artist-image] img onError — remote URL failed', {
                  artistId: artist.id,
                  artistName: artist.name,
                  photoUrl: artist.photoUrl,
                })
                e.currentTarget.style.display = 'none'
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="w-10 h-10 text-text-muted fill-current"
              >
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
              </svg>
            </div>
          )}
          {selected ? (
            <div className="absolute inset-0 bg-accent/20 flex items-center justify-center">
              <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 12 12"
                  className="w-3.5 h-3.5 fill-white"
                >
                  <path d="M10.28 2.28L4.5 8.06 1.72 5.28a1 1 0 0 0-1.42 1.42l3.5 3.5a1 1 0 0 0 1.42 0l6.5-6.5a1 1 0 0 0-1.42-1.42z" />
                </svg>
              </div>
            </div>
          ) : null}
        </div>
      </button>
      <div className="px-2.5 pt-2.5 pb-3">
        <div className="flex items-start justify-between gap-1">
          <button
            type="button"
            onClick={onClick}
            className="min-w-0 flex-1 cursor-pointer text-left"
            aria-label={
              selectionEnabled
                ? `${selected ? 'Deselect' : 'Select'} ${artist.name}`
                : `Open ${artist.name}`
            }
          >
            <p className="truncate text-sm font-medium leading-tight text-text-primary">
              {artist.name}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {artist.likedTrackCount} track
              {artist.likedTrackCount !== 1 ? 's' : ''}
            </p>
          </button>
          <button
            type="button"
            onClick={onToggleFavorite}
            className="flex-shrink-0 p-0.5 hover:scale-110 transition-transform"
            aria-label={artist.isFavorite ? 'Unfavorite' : 'Favorite'}
          >
            <StarIcon filled={artist.isFavorite} />
          </button>
        </div>
      </div>
    </div>
  )
}
