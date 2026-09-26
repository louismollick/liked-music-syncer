import { useEffect, useState } from 'react'
import { cx } from '../../lib/format'

/** Text input that saves on blur or Enter (not on every keystroke). */
export function TextInput({
  value,
  onCommit,
  placeholder,
  className,
  mono,
}: {
  value: string
  onCommit: (value: string) => void
  placeholder?: string
  className?: string
  mono?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft !== value) onCommit(draft.trim())
  }
  return (
    <input
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        if (event.key === 'Escape') setDraft(value)
      }}
      className={cx(
        'flex-1 min-w-0 h-8 rounded-md border border-line bg-white/[.04] px-3 text-[13px] text-zinc-100 outline-none focus:border-white/30 placeholder:text-zinc-600',
        mono && 'font-mono text-[12px]',
        className
      )}
    />
  )
}
