import type { JSX } from 'react'

type SyncView = 'queue' | 'needsApproval' | 'completed' | 'failures'

interface Tab {
  id: SyncView
  label: string
  count: number
  show?: boolean
}

interface Props {
  activeView: SyncView
  onSelect: (view: SyncView) => void
  counts: {
    queue: number
    needsApproval: number
    completed: number
    failures: number
  }
  showNeedsApproval: boolean
}

export function SyncTabs({
  activeView,
  onSelect,
  counts,
  showNeedsApproval,
}: Props): JSX.Element {
  const tabs: Tab[] = [
    { id: 'queue', label: 'Queue', count: counts.queue },
    {
      id: 'needsApproval',
      label: 'Needs Approval',
      count: counts.needsApproval,
      show: showNeedsApproval,
    },
    { id: 'completed', label: 'Completed', count: counts.completed },
    { id: 'failures', label: 'Failures', count: counts.failures },
  ]

  return (
    <div className="flex gap-1 border-b border-border mb-4">
      {tabs
        .filter((t) => t.show !== false)
        .map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeView === tab.id
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary hover:border-border'
            }`}
          >
            {tab.label}
            {tab.count > 0 ? (
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                  activeView === tab.id
                    ? tab.id === 'needsApproval'
                      ? 'bg-warning/20 text-warning'
                      : tab.id === 'failures'
                        ? 'bg-error/20 text-error'
                        : 'bg-surface-tertiary text-text-primary'
                    : 'bg-surface-tertiary text-text-muted'
                }`}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        ))}
    </div>
  )
}
