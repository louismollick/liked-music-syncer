import type { ButtonHTMLAttributes } from 'react'
import { cx } from '../../lib/format'

type Variant = 'default' | 'primary' | 'attention' | 'ghost'

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: 'sm' | 'md'
}) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
        variant === 'primary' &&
          'bg-white text-black border-white font-medium hover:bg-white/90',
        variant === 'default' &&
          'border-line-strong text-zinc-200 hover:border-white/30 hover:text-white',
        variant === 'attention' &&
          'border-amber-300/30 text-amber-200 hover:border-amber-300/60',
        variant === 'ghost' &&
          'border-transparent text-zinc-400 hover:text-white hover:bg-white/[.06]',
        className
      )}
    />
  )
}

export function IconButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30',
        className
      )}
    />
  )
}
