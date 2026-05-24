import type { SyncJobView } from '@shared/contracts'
import type { JSX } from 'react'
import { useState } from 'react'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { TrackRow } from './TrackRow'

function jobStatusVariant(
  status: SyncJobView['status']
): 'success' | 'error' | 'warning' | 'default' | 'info' {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'running':
      return 'info'
    case 'waiting_approval':
      return 'warning'
    case 'cancelled':
      return 'default'
    default:
      return 'default'
  }
}

interface Props {
  job: SyncJobView
  onCancel?: (jobId: string) => void
  defaultExpanded?: boolean
}

export function JobCard({
  job,
  onCancel,
  defaultExpanded = false,
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const canCancel =
    onCancel && (job.status === 'running' || job.status === 'queued')

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
            {job.failedTracks > 0 ? ` · ${job.failedTracks} failed` : ''}
            {job.pendingApprovalTracks > 0
              ? ` · ${job.pendingApprovalTracks} pending approval`
              : ''}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge variant={jobStatusVariant(job.status)}>
            {job.status.replace(/_/g, ' ')}
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

      {expanded && job.tracks.length > 0 ? (
        <div className="border-t border-border px-2 py-1 max-h-64 overflow-y-auto">
          {job.tracks.map((track) => (
            <TrackRow key={track.id} track={track} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
