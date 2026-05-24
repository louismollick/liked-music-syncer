import type { JSX } from 'react'
import type { Screen } from './Sidebar'
import { Sidebar } from './Sidebar'

interface Props {
  screen: Screen
  onNavigate: (screen: Screen) => void
  counts: {
    queue: number
    needsApproval: number
    completed: number
    failures: number
  }
  showNeedsApproval: boolean
  children: React.ReactNode
}

export function MainLayout({
  screen,
  onNavigate,
  counts,
  showNeedsApproval,
  children,
}: Props): JSX.Element {
  return (
    <div className="flex h-screen bg-surface-primary overflow-hidden">
      <Sidebar
        screen={screen}
        onNavigate={onNavigate}
        counts={counts}
        showNeedsApproval={showNeedsApproval}
      />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  )
}
