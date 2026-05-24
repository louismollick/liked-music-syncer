import type { CommandResult, SyncSnapshot } from '@shared/contracts'
import type { JSX } from 'react'
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
  onAction: (action: Promise<CommandResult>) => void
}

export function SyncQueueView({ snapshot, onAction }: Props): JSX.Element {
  return (
    <div className="p-6 h-full flex flex-col">
      <h2 className="text-xl font-semibold text-text-primary mb-5">Queue</h2>
      <div className="flex-1 overflow-auto">
        {snapshot.queue.length > 0 ? (
          <div className="flex flex-col gap-2">
            {snapshot.queue.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onCancel={(id) => onAction(window.api.sync.cancel(id))}
                defaultExpanded={snapshot.queue.length === 1}
              />
            ))}
          </div>
        ) : (
          <EmptyState label="Queue is empty" />
        )}
      </div>
    </div>
  )
}
