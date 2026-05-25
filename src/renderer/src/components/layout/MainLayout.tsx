import type { LibraryTrackView, LikedArtistView } from '@shared/contracts'
import type { JSX } from 'react'
import type { AlbumGroup } from '../library/library-utils'
import { SearchBar } from '../search/SearchBar'
import type { Screen } from './Sidebar'
import { Sidebar } from './Sidebar'

interface Props {
  screen: Screen
  onNavigate: (screen: Screen) => void
  counts: {
    all: number
    inProgress: number
    completed: number
    failed: number
  }
  artists: LikedArtistView[]
  tracks: LibraryTrackView[]
  onSearchArtist: (artist: LikedArtistView) => void
  onSearchAlbum: (album: AlbumGroup) => void
  onSearchSong: (track: LibraryTrackView) => void
  children: React.ReactNode
}

export function MainLayout({
  screen,
  onNavigate,
  counts,
  artists,
  tracks,
  onSearchArtist,
  onSearchAlbum,
  onSearchSong,
  children,
}: Props): JSX.Element {
  return (
    <div className="flex h-screen bg-surface-primary overflow-hidden">
      <Sidebar screen={screen} onNavigate={onNavigate} counts={counts} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <SearchBar
          artists={artists}
          tracks={tracks}
          onSelectArtist={onSearchArtist}
          onSelectAlbum={onSearchAlbum}
          onSelectSong={onSearchSong}
        />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
