import type { SyncSnapshot } from '@shared/contracts'
import type { JSX } from 'react'
import { Button } from '../ui/Button'
import { JobCard } from './JobCard'

function EmptyState({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-text-muted">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="w-10 h-10 fill-current mb-3 opacity-40"
      >
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z" />
      </svg>
      <p className="text-sm">{label}</p>
    </div>
  )
}

interface Props {
  snapshot: SyncSnapshot
  onClear: () => void
}

export function SyncFailuresView({ snapshot, onClear }: Props): JSX.Element {
  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-4 mb-5">
        <h2 className="text-xl font-semibold text-text-primary">Failures</h2>
        <Button
          size="sm"
          variant="danger"
          onClick={onClear}
          disabled={snapshot.failures.length === 0}
        >
          Clear Failures
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {snapshot.failures.length > 0 ? (
          <div className="flex flex-col gap-2">
            {snapshot.failures.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        ) : (
          <EmptyState label="No failures" />
        )}
      </div>
    </div>
  )
}
