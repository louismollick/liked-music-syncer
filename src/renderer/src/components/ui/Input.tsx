import type { JSX } from 'react'
import { useId } from 'react'

interface Props extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export function Input({
  label,
  className = '',
  id,
  ...rest
}: Props): JSX.Element {
  const generatedId = useId()
  const inputId = id ?? generatedId

  const inputEl = (
    <input
      id={inputId}
      className={`w-full bg-surface-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-muted transition-colors ${className}`}
      {...rest}
    />
  )

  if (!label) return inputEl

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm text-text-secondary">
        {label}
      </label>
      {inputEl}
    </div>
  )
}
