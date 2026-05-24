import type { JSX } from 'react'

type Variant = 'default' | 'success' | 'warning' | 'error' | 'info'

interface Props {
  children: React.ReactNode
  variant?: Variant
  className?: string
}

export function Badge({
  children,
  variant = 'default',
  className = '',
}: Props): JSX.Element {
  const variants: Record<Variant, string> = {
    default: 'bg-surface-tertiary text-text-secondary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    error: 'bg-error/10 text-error',
    info: 'bg-blue-500/10 text-blue-400',
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  )
}
