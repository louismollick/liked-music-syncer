import type {
  SyncJobDisplayStatus,
  SyncJobView,
  SyncTrackWorkView,
} from '@shared/contracts'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { TrackRow } from './TrackRow'

function jobStatusVariant(
  status: SyncJobDisplayStatus
): 'success' | 'error' | 'warning' | 'default' | 'info' {
  return status === 'completed' ? 'success' : 'info'
}

function jobStatusLabel(status: SyncJobDisplayStatus) {
  return status === 'completed' ? 'Completed' : 'In Progress'
}

interface Props {
  job: SyncJobView
  tracks?: SyncTrackWorkView[]
  onCancel?: (jobId: string) => void
  defaultExpanded?: boolean
}

export function JobCard({
  job,
  tracks,
  onCancel,
  defaultExpanded = false,
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const canCancel =
    onCancel && (job.status === 'running' || job.status === 'queued')
  const visibleTracks = useMemo(
    () => tracks ?? job.tracks,
    [tracks, job.tracks]
  )

  return (
    <div className="bg-surface-secondary rounded-xl border border-border overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-3 p-4 hover:bg-surface-tertiary/30 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={`w-3 h-3 fill-current text-text-muted flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <path
            d="M4.5 1.5l4.5 4.5-4.5 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary truncate">
            {job.label}
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            {job.processedTracks}/{job.totalTracks} tracks
            {job.failedTracks > 0 ? ` - ${job.failedTracks} failed` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge variant={jobStatusVariant(job.displayStatus)}>
            {jobStatusLabel(job.displayStatus)}
          </Badge>
          {canCancel ? (
            <Button
              size="sm"
              variant="danger"
              onClick={(e) => {
                e.stopPropagation()
                onCancel?.(job.id)
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-border px-2 py-1 max-h-64 overflow-y-auto">
          {visibleTracks.length > 0 ? (
            visibleTracks.map((track) => (
              <TrackRow key={track.id} track={track} />
            ))
          ) : (
            <p className="text-xs text-text-muted px-3 py-2">
              No tracks in this filter.
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
