import type { JSX } from 'react'

interface Props {
  children: React.ReactNode
  className?: string
  onClick?: () => void
}

export function Card({
  children,
  className = '',
  onClick,
}: Props): JSX.Element {
  if (onClick) {
    return (
      <button
        type="button"
        className={`w-full text-left bg-surface-secondary rounded-xl border border-border cursor-pointer hover:border-text-muted transition-colors ${className}`}
        onClick={onClick}
      >
        {children}
      </button>
    )
  }
  return (
    <div
      className={`bg-surface-secondary rounded-xl border border-border ${className}`}
    >
      {children}
    </div>
  )
}
