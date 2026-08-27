import type {
  CommandResult,
  SyncFilter,
  SyncJobView,
  SyncSnapshot,
  SyncTrackWorkView,
} from '@shared/contracts'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { JobCard } from './JobCard'

interface Props {
  snapshot: SyncSnapshot
  onAction: (action: Promise<CommandResult>) => Promise<void>
}

function EmptyState({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-text-muted">
      <p className="text-sm">{label}</p>
    </div>
  )
}

function filterTracks(
  job: SyncJobView,
  filter: SyncFilter
): SyncTrackWorkView[] {
  if (filter === 'in_progress') {
    return job.tracks.filter(
      (track) =>
        track.displayStatus === 'queued' ||
        track.displayStatus === 'in_progress'
    )
  }
  if (filter === 'failed') {
    return job.tracks.filter((track) => track.displayStatus === 'failed')
  }
  return job.tracks
}

function filterJobs(jobs: SyncJobView[], filter: SyncFilter) {
  if (filter === 'in_progress') {
    return jobs
      .filter((job) => job.displayStatus === 'in_progress')
      .map((job) => ({ job, tracks: filterTracks(job, filter) }))
      .filter(({ tracks }) => tracks.length > 0)
  }
  if (filter === 'completed') {
    return jobs
      .filter((job) => job.displayStatus === 'completed')
      .map((job) => ({ job, tracks: filterTracks(job, filter) }))
  }
  if (filter === 'failed') {
    return jobs
      .map((job) => ({ job, tracks: filterTracks(job, filter) }))
      .filter(({ tracks }) => tracks.length > 0)
  }
  return jobs.map((job) => ({ job, tracks: job.tracks }))
}

export function SyncView({ snapshot, onAction }: Props): JSX.Element {
  const [filter, setFilter] = useState<SyncFilter>('all')
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null)
  const filtered = useMemo(
    () => filterJobs(snapshot.jobs, filter),
    [snapshot.jobs, filter]
  )

  const retryFailedTracks = async (jobId: string) => {
    if (retryingJobId) return
    setRetryingJobId(jobId)
    try {
      await onAction(window.api.sync.retryFailedTracks(jobId))
    } finally {
      setRetryingJobId(null)
    }
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-4 mb-5">
        <h2 className="text-xl font-semibold text-text-primary">Sync</h2>
        <Button
          size="sm"
          variant="danger"
          onClick={() => onAction(window.api.sync.clearFailures())}
          disabled={snapshot.counts.failed === 0}
        >
          Clear Failed
        </Button>
      </div>

      <div className="flex gap-2 mb-4">
        {(['all', 'in_progress', 'completed', 'failed'] as SyncFilter[]).map(
          (value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                filter === value
                  ? 'bg-surface-tertiary border-border text-text-primary'
                  : 'border-border/50 text-text-secondary hover:text-text-primary'
              }`}
            >
              {value === 'all'
                ? 'All'
                : value === 'in_progress'
                  ? 'In Progress'
                  : value === 'completed'
                    ? 'Completed'
                    : 'Failed'}
            </button>
          )
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {filtered.length > 0 ? (
          <div className="flex flex-col gap-2">
            {filtered.map(({ job, tracks }) => (
              <JobCard
                key={job.id}
                job={job}
                tracks={tracks}
                onCancel={(id) => onAction(window.api.sync.cancel(id))}
                onRetry={(id) => void retryFailedTracks(id)}
                retrying={retryingJobId === job.id}
                defaultExpanded={
                  filter === 'failed' || snapshot.jobs.length === 1
                }
              />
            ))}
          </div>
        ) : (
          <EmptyState label="No sync work in this filter." />
        )}
      </div>
    </div>
  )
}
