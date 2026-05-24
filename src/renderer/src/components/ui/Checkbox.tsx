import type { JSX } from 'react'
import { useId } from 'react'

interface Props extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export function Checkbox({
  label,
  className = '',
  ...rest
}: Props): JSX.Element {
  const generatedId = useId()
  const inputId = rest.id ?? generatedId

  const input = (
    <input
      type="checkbox"
      id={inputId}
      className={`w-4 h-4 rounded bg-surface-tertiary border border-border accent-accent cursor-pointer ${className}`}
      {...rest}
    />
  )

  if (!label) return input

  return (
    <div className="flex items-center gap-2.5">
      {input}
      <label
        htmlFor={inputId}
        className="text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
      >
        {label}
      </label>
    </div>
  )
}
