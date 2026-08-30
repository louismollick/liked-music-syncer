import type {
  AuthSessionView,
  LibraryTrackView,
  LikedArtistView,
} from '@shared/contracts'
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
  authSession: AuthSessionView
  onSelectAccount: (key: string) => Promise<boolean>
  onLoadAccountCounts: () => Promise<void>
  switchingAccountKey: string | null
  accountSwitchError: string | null
  artists: LikedArtistView[]
  tracks: LibraryTrackView[]
  onSearchArtist: (artist: LikedArtistView) => void
  onSearchAlbum: (album: AlbumGroup) => void
  onSearchSong: (track: LibraryTrackView) => void
  children: ReactNode
}

export function MainLayout({
  counts,
  authSession,
  onSelectAccount,
  onLoadAccountCounts,
  switchingAccountKey,
  accountSwitchError,
  artists,
  tracks,
  onSearchArtist,
  onSearchAlbum,
  onSearchSong,
  children,
}: Props): JSX.Element {
  return (
    <div className="flex h-screen bg-surface-primary overflow-hidden">
      <Sidebar
        counts={counts}
        authSession={authSession}
        onSelectAccount={onSelectAccount}
        onLoadAccountCounts={onLoadAccountCounts}
        switchingAccountKey={switchingAccountKey}
        accountSwitchError={accountSwitchError}
      />
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
