import type { JSX } from 'react'

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: Props): JSX.Element {
  const base =
    'inline-flex items-center justify-center font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
  }
  const variants = {
    primary: 'bg-accent text-white hover:bg-accent-hover',
    secondary:
      'bg-surface-tertiary text-text-primary border border-border hover:bg-surface-hover',
    ghost:
      'text-text-secondary hover:text-text-primary hover:bg-surface-tertiary',
    danger: 'bg-error/10 text-error border border-error/30 hover:bg-error/20',
  }
  return (
    <button
      type="button"
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
