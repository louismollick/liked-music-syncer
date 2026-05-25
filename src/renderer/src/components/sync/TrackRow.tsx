import type { SyncTrackWorkView } from '@shared/contracts'
import type { JSX } from 'react'
import { Badge } from '../ui/Badge'

function statusVariant(
  status: SyncTrackWorkView['displayStatus']
): 'success' | 'error' | 'warning' | 'default' | 'info' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'failed':
      return 'error'
    case 'in_progress':
      return 'info'
    default:
      return 'default'
  }
}

function statusLabel(status: SyncTrackWorkView['displayStatus']) {
  if (status === 'in_progress') return 'In Progress'
  return status[0].toUpperCase() + status.slice(1)
}

interface Props {
  track: SyncTrackWorkView
}

export function TrackRow({ track }: Props): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-2 px-3 hover:bg-surface-tertiary/30 rounded-lg transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary truncate">
          {track.artist} - {track.title}
        </p>
        {track.reasonDetail || track.reasonCode ? (
          <p className="text-xs text-text-muted truncate mt-0.5">
            {track.reasonDetail || track.reasonCode}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-xs text-text-muted">{track.stage}</span>
        <Badge variant={statusVariant(track.displayStatus)}>
          {statusLabel(track.displayStatus)}
        </Badge>
      </div>
    </div>
  )
}
