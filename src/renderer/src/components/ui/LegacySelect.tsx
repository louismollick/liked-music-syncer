import type { JSX } from 'react'
import { useId } from 'react'

interface Props extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
}

export function Select({
  label,
  className = '',
  id,
  children,
  ...rest
}: Props): JSX.Element {
  const generatedId = useId()
  const selectId = id ?? generatedId

  const selectEl = (
    <select
      id={selectId}
      className={`w-full bg-surface-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-text-muted transition-colors appearance-none cursor-pointer ${className}`}
      {...rest}
    >
      {children}
    </select>
  )

  if (!label) return selectEl

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={selectId} className="text-sm text-text-secondary">
        {label}
      </label>
      {selectEl}
    </div>
  )
}
