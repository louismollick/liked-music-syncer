import type { LibraryTrackView, LikedArtistView } from '@shared/contracts'
import type { JSX } from 'react'
import type { AlbumGroup } from '../library/library-utils'

export type SearchResult =
  | { type: 'artist'; data: LikedArtistView }
  | { type: 'album'; data: AlbumGroup; artworkUrl: string | null }
  | { type: 'song'; data: LibraryTrackView; artworkUrl: string | null }

interface Props {
  result: SearchResult
  onClick: () => void
}

function PersonIcon(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className="w-5 h-5 text-text-muted"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z" />
    </svg>
  )
}

function MusicIcon(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className="w-5 h-5 text-text-muted"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M9 13c0 1.105-1.12 2-2.5 2S4 14.105 4 13s1.12-2 2.5-2 2.5.895 2.5 2z" />
      <path fillRule="evenodd" d="M9 3v10H8V3h1z" />
      <path d="M8 2.82a1 1 0 0 1 .804-.98l3-.6A1 1 0 0 1 13 2.22V4L8 5V2.82z" />
    </svg>
  )
}

export function SearchResultItem({ result, onClick }: Props): JSX.Element {
  let imageUrl: string | null = null
  let primary = ''
  let secondary = ''

  if (result.type === 'artist') {
    imageUrl = result.data.photoUrl
    primary = result.data.name
    secondary = `${result.data.likedTrackCount} tracks`
  } else if (result.type === 'album') {
    imageUrl = result.artworkUrl
    primary = result.data.album
    secondary = [result.data.albumArtist, result.data.year]
      .filter(Boolean)
      .join(' · ')
  } else {
    imageUrl = result.artworkUrl
    primary = result.data.title ?? 'Unknown Title'
    secondary = [result.data.artist, result.data.album]
      .filter(Boolean)
      .join(' · ')
  }

  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-tertiary/70 transition-colors text-left"
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          className="w-10 h-10 rounded-lg object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded-lg bg-surface-tertiary flex items-center justify-center flex-shrink-0">
          {result.type === 'artist' ? <PersonIcon /> : <MusicIcon />}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">
          {primary}
        </div>
        <div className="text-xs text-text-muted truncate">{secondary}</div>
      </div>
    </button>
  )
}
