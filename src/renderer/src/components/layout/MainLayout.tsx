import type { LibraryTrackView, LikedArtistView } from '@shared/contracts'
import type { JSX, ReactNode } from 'react'
import type { AlbumGroup } from '../library/library-utils'
import { SearchBar } from '../search/SearchBar'
import { Sidebar } from './Sidebar'

interface Props {
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
  children: ReactNode
}

export function MainLayout({
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
      <Sidebar counts={counts} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <SearchBar
          artists={artists}
          tracks={tracks}
          onSelectArtist={onSearchArtist}
          onSelectAlbum={onSearchAlbum}
          onSelectSong={onSearchSong}
        />
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
