import { isLowResArtistPhotoUrl } from '@shared/artist-photo-url'
import type {
  AuthStatus,
  CommandResult,
  LibraryIndexStatus,
  LikedArtistView,
} from '@shared/contracts'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { ArtistGrid } from './ArtistGrid'
import { LibraryActionButtons } from './LibraryActionButtons'

interface Props {
  artists: LikedArtistView[]
  selectedIds: string[]
  selectionEnabled: boolean
  libraryIndexStatus: LibraryIndexStatus
  authStatus: AuthStatus
  onToggleSelectionMode: () => void
  onToggleSelect: (id: string) => void
  onOpenArtist: (artist: LikedArtistView) => void
  onAction: (action: Promise<CommandResult>) => void
  onClearSelected: () => void
}

export function ArtistsView({
  artists,
  selectedIds,
  selectionEnabled,
  libraryIndexStatus,
  authStatus,
  onToggleSelectionMode,
  onToggleSelect,
  onOpenArtist,
  onAction,
  onClearSelected,
}: Props): JSX.Element {
  const imageRefreshStarted = useRef(false)

  useEffect(() => {
    const withPhoto = artists.filter((artist) =>
      Boolean(artist.photoUrl)
    ).length
    const needsRefresh = artists.filter((artist) =>
      isLowResArtistPhotoUrl(artist.photoUrl)
    ).length

    console.info('[artist-image] Artists tab active', {
      totalArtists: artists.length,
      withPhotoUrl: withPhoto,
      needsImageRefresh: needsRefresh,
      indexReady: libraryIndexStatus.ready,
      authenticated: authStatus.isAuthenticated,
    })

    if (needsRefresh === 0) {
      console.info(
        '[artist-image] skip refresh — all artist photos meet quality threshold'
      )
      return
    }

    if (imageRefreshStarted.current) {
      return
    }
    imageRefreshStarted.current = true

    console.info('[artist-image] requesting main-process refresh', {
      needsImageRefresh: needsRefresh,
    })

    void window.api.library
      .refreshArtistImages()
      .then((result) => {
        console.info('[artist-image] refresh settled', {
          ok: result.ok,
          message: result.message,
          details: result.details ?? null,
        })
      })
      .catch((error: unknown) => {
        console.error('[artist-image] refresh failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        imageRefreshStarted.current = false
      })
  }, [artists, authStatus.isAuthenticated, libraryIndexStatus.ready])

  const toggleFavorite = (artist: LikedArtistView) => {
    onAction(
      window.api.library.setArtistFavorite(artist.id, !artist.isFavorite)
    )
  }

  const handleArtistClick = (artist: LikedArtistView) => {
    if (selectionEnabled) {
      onToggleSelect(artist.id)
      return
    }
    onOpenArtist(artist)
  }

  const statusText = libraryIndexStatus.ready
    ? 'ready'
    : libraryIndexStatus.reason
  const authText = authStatus.isAuthenticated
    ? 'authenticated'
    : 'not authenticated'

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Artists</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Index: {statusText} · Auth: {authText}
            {selectionEnabled ? ' · select on' : ''}
            {selectedIds.length > 0 ? ` · ${selectedIds.length} selected` : ''}
          </p>
        </div>
        <LibraryActionButtons
          showSelectionControls
          selectionEnabled={selectionEnabled}
          selectedCount={selectedIds.length}
          onToggleSelectionMode={onToggleSelectionMode}
          onReprocessSelected={() =>
            onAction(window.api.sync.reprocessArtists(selectedIds))
          }
          onRefreshSelectedFavorites={() =>
            onAction(window.api.sync.refreshFavoriteArtists(selectedIds))
          }
          onClearSelected={onClearSelected}
          onSyncLikedSongs={() =>
            onAction(window.api.sync.startLikedSongsSync())
          }
          onReprocessLibrary={() =>
            onAction(window.api.sync.startLibraryReprocess())
          }
          onReprocessFavoriteArtists={() =>
            onAction(window.api.sync.refreshFavoriteArtists())
          }
          onSyncToRemote={() => onAction(window.api.sync.syncMissingToRemote())}
        />
      </div>

      <div className="flex-1 overflow-auto">
        <ArtistGrid
          artists={artists}
          selectedIds={selectedIds}
          selectionEnabled={selectionEnabled}
          onArtistClick={handleArtistClick}
          onToggleFavorite={toggleFavorite}
        />
      </div>
    </div>
  )
}
