import type { CommandResult, SyncSnapshot } from '@shared/contracts'
import type { JSX } from 'react'
import { useState } from 'react'
import { ApprovalList } from './ApprovalList'
import { JobCard } from './JobCard'
import { SyncTabs } from './SyncTabs'

type SyncView = 'queue' | 'needsApproval' | 'completed' | 'failures'

interface Props {
  snapshot: SyncSnapshot
  autoApprove: boolean
  onAction: (action: Promise<CommandResult>) => void
}

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

export function SyncView({
  snapshot,
  autoApprove,
  onAction,
}: Props): JSX.Element {
  const [activeView, setActiveView] = useState<SyncView>('queue')

  const showNeedsApproval = !autoApprove && snapshot.counts.needsApproval > 0

  return (
    <div className="p-6 h-full flex flex-col">
      <h2 className="text-xl font-semibold text-text-primary mb-5">Sync</h2>

      <SyncTabs
        activeView={activeView}
        onSelect={setActiveView}
        counts={snapshot.counts}
        showNeedsApproval={
          showNeedsApproval || snapshot.counts.needsApproval > 0
        }
      />

      <div className="flex-1 overflow-auto">
        {activeView === 'queue' ? (
          snapshot.queue.length > 0 ? (
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
          )
        ) : null}

        {activeView === 'needsApproval' ? (
          <ApprovalList
            rows={snapshot.needsApproval}
            onApprove={(ids) => onAction(window.api.sync.approveChanges(ids))}
            onDeny={(ids) => onAction(window.api.sync.denyChanges(ids))}
          />
        ) : null}

        {activeView === 'completed' ? (
          snapshot.completed.length > 0 ? (
            <div className="flex flex-col gap-2">
              {snapshot.completed.map((job) => (
                <JobCard key={job.id} job={job} />
              ))}
            </div>
          ) : (
            <EmptyState label="No completed jobs" />
          )
        ) : null}

        {activeView === 'failures' ? (
          snapshot.failures.length > 0 ? (
            <div className="flex flex-col gap-2">
              {snapshot.failures.map((job) => (
                <JobCard key={job.id} job={job} />
              ))}
            </div>
          ) : (
            <EmptyState label="No failures" />
          )
        ) : null}
      </div>
    </div>
  )
}
