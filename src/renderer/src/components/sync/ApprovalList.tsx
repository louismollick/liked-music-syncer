import type { SyncApprovalItemView } from '@shared/contracts'
import type { JSX } from 'react'
import { useState } from 'react'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'

interface Props {
  rows: SyncApprovalItemView[]
  onApprove: (ids: string[]) => void
  onDeny: (ids: string[]) => void
}

function actionVariant(
  action: SyncApprovalItemView['actionKind']
): 'warning' | 'error' | 'info' {
  switch (action) {
    case 'delete':
      return 'error'
    case 'replace':
      return 'warning'
    default:
      return 'info'
  }
}

export function ApprovalList({ rows, onApprove, onDeny }: Props): JSX.Element {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const allSelected = rows.length > 0 && selectedIds.length === rows.length

  const toggleAll = () =>
    setSelectedIds(allSelected ? [] : rows.map((r) => r.id))

  const toggle = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-text-muted">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="w-10 h-10 fill-current mb-3 opacity-40"
        >
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
        <p className="text-sm">No items waiting for approval</p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Checkbox
          checked={allSelected}
          onChange={toggleAll}
          label={`${selectedIds.length > 0 ? selectedIds.length : 'All'} selected`}
        />
        <div className="flex-1" />
        <Button
          size="sm"
          variant="primary"
          disabled={selectedIds.length === 0}
          onClick={() => onApprove(selectedIds)}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={selectedIds.length === 0}
          onClick={() => onDeny(selectedIds)}
        >
          Deny
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div
            key={row.id}
            className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
              selectedIds.includes(row.id)
                ? 'bg-surface-tertiary border-border'
                : 'bg-surface-secondary border-transparent hover:border-border'
            }`}
          >
            <Checkbox
              checked={selectedIds.includes(row.id)}
              onChange={() => toggle(row.id)}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text-primary truncate">
                {row.artist} — {row.title}
              </p>
              {row.album ? (
                <p className="text-xs text-text-muted truncate">{row.album}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Badge variant={actionVariant(row.actionKind)}>
                {row.actionKind}
              </Badge>
              <Badge>{row.status}</Badge>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
