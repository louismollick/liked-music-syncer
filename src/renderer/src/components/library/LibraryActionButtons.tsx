import type { JSX } from 'react'
import { Button } from '../ui/Button'

interface Props {
  showSelectionControls?: boolean
  selectionEnabled?: boolean
  selectedCount?: number
  onToggleSelectionMode?: () => void
  onReprocessSelected?: () => void
  onRefreshSelectedFavorites?: () => void
  onClearSelected?: () => void
  onSyncLikedSongs: () => void
  onReprocessLibrary: () => void
  onReprocessFavoriteArtists: () => void
  onSyncToRemote: () => void
}

export function LibraryActionButtons({
  showSelectionControls = false,
  selectionEnabled = false,
  selectedCount = 0,
  onToggleSelectionMode,
  onReprocessSelected,
  onRefreshSelectedFavorites,
  onClearSelected,
  onSyncLikedSongs,
  onReprocessLibrary,
  onReprocessFavoriteArtists,
  onSyncToRemote,
}: Props): JSX.Element {
  const hasSelection = selectedCount > 0

  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      {showSelectionControls ? (
        <Button
          size="sm"
          variant={selectionEnabled ? 'primary' : 'secondary'}
          onClick={onToggleSelectionMode}
        >
          Select
        </Button>
      ) : null}

      {hasSelection ? (
        <>
          <Button size="sm" onClick={onReprocessSelected}>
            Reprocess Selected
          </Button>
          <Button size="sm" onClick={onRefreshSelectedFavorites}>
            Refresh Catalog
          </Button>
          <Button size="sm" variant="ghost" onClick={onClearSelected}>
            Clear
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="primary" onClick={onSyncLikedSongs}>
            Sync Liked Songs
          </Button>
          <Button size="sm" onClick={onReprocessLibrary}>
            Reprocess Library
          </Button>
          <Button size="sm" onClick={onReprocessFavoriteArtists}>
            Reprocess Favorite Artists
          </Button>
          <Button size="sm" onClick={onSyncToRemote}>
            Sync to Remote
          </Button>
        </>
      )}
    </div>
  )
}
