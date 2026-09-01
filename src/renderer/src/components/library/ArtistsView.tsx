import type {
  AuthStatus,
  CommandResult,
  LikedArtistView,
} from '@shared/contracts'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { useElementSize } from '../../hooks/useElementSize'
import { ArtistGrid } from './ArtistGrid'
import {
  getArtistImageRefreshKey,
  shouldRequestArtistImageRefresh,
} from './artist-image-refresh'
import { LibraryActionButtons } from './LibraryActionButtons'

interface Props {
  artists: LikedArtistView[]
  selectedIds: string[]
  selectionEnabled: boolean
  authStatus: AuthStatus
  isActive: boolean
  onToggleSelectionMode: () => void
  onToggleSelect: (id: string) => void
  onOpenArtist: (artist: LikedArtistView) => void
  onAction: (action: Promise<CommandResult>) => void
  onClearSelected: () => void
  onInitialRender?: () => void
}

export function ArtistsView({
  artists,
  selectedIds,
  selectionEnabled,
  authStatus,
  isActive,
  onToggleSelectionMode,
  onToggleSelect,
  onOpenArtist,
  onAction,
  onClearSelected,
  onInitialRender,
}: Props): JSX.Element {
  const lastImageRefreshKey = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(scrollRef)

  useEffect(() => {
    if (!isActive) return

    const candidateKey = getArtistImageRefreshKey(artists)

    if (
      !shouldRequestArtistImageRefresh({
        candidateKey,
        isAuthenticated: authStatus.isAuthenticated,
        lastRequestedKey: lastImageRefreshKey.current,
      })
    ) {
      return
    }
    lastImageRefreshKey.current = candidateKey

    void window.api.library
      .refreshArtistImages()
      .then((result) => {
        if (!result.ok && lastImageRefreshKey.current === candidateKey) {
          lastImageRefreshKey.current = null
        }
      })
      .catch((error: unknown) => {
        if (lastImageRefreshKey.current === candidateKey) {
          lastImageRefreshKey.current = null
        }
        console.error('[artist-image] refresh failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }, [artists, authStatus.isAuthenticated, isActive])

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

  const authText = authStatus.isAuthenticated
    ? 'authenticated'
    : 'not authenticated'

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Artists</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Auth: {authText}
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

      <div ref={scrollRef} className="flex-1 overflow-auto">
        <ArtistGrid
          artists={artists}
          selectedIds={selectedIds}
          selectionEnabled={selectionEnabled}
          isActive={isActive}
          onArtistClick={handleArtistClick}
          onToggleFavorite={toggleFavorite}
          scrollElement={scrollRef.current}
          containerWidth={width}
          containerHeight={height}
          onInitialRender={onInitialRender}
        />
      </div>
    </div>
  )
}
