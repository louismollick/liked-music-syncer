import type { JSX } from 'react'

interface Props {
  title: string
  children: React.ReactNode
}

export function SettingsSection({ title, children }: Props): JSX.Element {
  return (
    <div className="mb-6">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
        {title}
      </h3>
      <div className="bg-surface-secondary rounded-xl border border-border p-4 flex flex-col gap-4">
        {children}
      </div>
    </div>
  )
}
