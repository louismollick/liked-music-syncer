import type { JSX } from 'react'
import { Spinner } from '../ui/spinner'

export function AccountDiscoveryStatus(): JSX.Element {
  return (
    <div
      role="status"
      className="flex min-h-14 items-center gap-2 px-3 text-xs text-text-muted"
    >
      <Spinner />
      <span>Finding other accounts...</span>
    </div>
  )
}
