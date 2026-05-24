import type { CommandResult, SyncSnapshot } from '@shared/contracts'
import type { JSX } from 'react'
import { ApprovalList } from './ApprovalList'

interface Props {
  snapshot: SyncSnapshot
  onAction: (action: Promise<CommandResult>) => void
}

export function SyncApprovalView({ snapshot, onAction }: Props): JSX.Element {
  return (
    <div className="p-6 h-full flex flex-col">
      <h2 className="text-xl font-semibold text-text-primary mb-5">
        Needs Approval
      </h2>
      <div className="flex-1 overflow-auto">
        <ApprovalList
          rows={snapshot.needsApproval}
          onApprove={(ids) => onAction(window.api.sync.approveChanges(ids))}
          onDeny={(ids) => onAction(window.api.sync.denyChanges(ids))}
        />
      </div>
    </div>
  )
}
