import type {
  AuthStatus,
  CommandResult,
  LibraryIndexStatus,
  LikedArtistView,
} from '@shared/contracts'
import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '../ui/Button'
import { ArtistGrid } from './ArtistGrid'

interface Props {
  artists: LikedArtistView[]
  libraryIndexStatus: LibraryIndexStatus
  authStatus: AuthStatus
  onAction: (action: Promise<CommandResult>) => void
}

export function LibraryView({
  artists,
  libraryIndexStatus,
  authStatus,
  onAction,
}: Props): JSX.Element {
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const toggleFavorite = (artist: LikedArtistView) => {
    onAction(
      window.api.library.setArtistFavorite(artist.id, !artist.isFavorite)
    )
  }

  const statusText = libraryIndexStatus.ready
    ? 'ready'
    : libraryIndexStatus.reason
  const authText = authStatus.isAuthenticated
    ? 'authenticated'
    : 'not authenticated'

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Library</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Index: {statusText} · Auth: {authText}
            {selectedIds.length > 0 ? ` · ${selectedIds.length} selected` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {selectedIds.length > 0 ? (
            <>
              <Button
                size="sm"
                onClick={() =>
                  onAction(window.api.sync.reprocessArtists(selectedIds))
                }
              >
                Reprocess Selected
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  onAction(window.api.sync.refreshFavoriteArtists(selectedIds))
                }
              >
                Refresh Catalog
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIds([])}
              >
                Clear
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="primary"
                onClick={() => onAction(window.api.sync.startLikedSongsSync())}
              >
                Sync Liked Songs
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  onAction(window.api.sync.startLibraryReprocess())
                }
              >
                Reprocess Library
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  onAction(window.api.sync.refreshFavoriteArtists())
                }
              >
                Refresh All Favorites
              </Button>
              <Button
                size="sm"
                onClick={() => onAction(window.api.sync.syncMissingToRemote())}
              >
                Sync to Remote
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <ArtistGrid
          artists={artists}
          selectedIds={selectedIds}
          selectionEnabled
          onArtistClick={(artist) => toggleSelect(artist.id)}
          onToggleFavorite={toggleFavorite}
        />
      </div>
    </div>
  )
}
