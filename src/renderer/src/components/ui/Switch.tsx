import { cx } from '../../lib/format'

export function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative w-9 h-5 rounded-md transition-colors disabled:opacity-40',
        checked ? 'bg-white' : 'bg-white/15'
      )}
    >
      <span
        className={cx(
          'absolute top-0.5 w-4 h-4 rounded-[4px] transition-all',
          checked ? 'left-[18px] bg-black' : 'left-0.5 bg-zinc-400'
        )}
      />
    </button>
  )
}
