import type { JSX } from 'react'

interface Props {
  label: string
  onClear: () => void
}

export function FilterPill({ label, onClear }: Props): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-secondary px-3 py-1 text-xs font-medium text-text-primary">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label} filter`}
        className="rounded-full p-0.5 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="h-3 w-3 fill-none stroke-current"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M2 2l8 8M10 2L2 10" />
        </svg>
      </button>
    </span>
  )
}
