import { ChevronDown, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cx } from '../../lib/format'

export function Chip({
  label,
  onRemove,
}: {
  label: string
  onRemove: () => void
}) {
  return (
    <span className="inline-flex items-center gap-1.5 h-7 rounded-md border border-line bg-white/[.04] pl-2.5 pr-1.5 text-[12px] text-zinc-200">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="text-zinc-500 hover:text-white"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </span>
  )
}

export interface MenuOption {
  label: string
  hint?: string
  onSelect: () => void
  active?: boolean
}

export interface MenuSection {
  title: string
  options: MenuOption[]
}

/** A small popover menu anchored to its trigger. */
export function Menu({
  trigger,
  sections,
  align = 'left',
}: {
  trigger: (open: boolean) => React.ReactNode
  sections: MenuSection[]
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) =>
      event.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((v) => !v)}>{trigger(open)}</div>
      {open && (
        <div
          className={cx(
            'absolute z-50 mt-1 min-w-[220px] max-h-[360px] overflow-y-auto scroll-thin rounded-md border border-line bg-raised shadow-2xl py-1 fade-in',
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          {sections.map((section, index) => (
            <div
              key={section.title}
              className={cx(index > 0 && 'border-t border-line mt-1 pt-1')}
            >
              <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {section.title}
              </div>
              {section.options.map((option) => (
                <button
                  type="button"
                  key={option.label}
                  onClick={() => {
                    option.onSelect()
                    setOpen(false)
                  }}
                  className={cx(
                    'w-full text-left px-3 py-1.5 text-[13px] flex items-center justify-between gap-4 hover:bg-white/[.06]',
                    option.active ? 'text-white' : 'text-zinc-300'
                  )}
                >
                  <span>{option.label}</span>
                  {option.hint && (
                    <span className="text-[11px] text-zinc-500">
                      {option.hint}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AddFilterButton({ sections }: { sections: MenuSection[] }) {
  return (
    <Menu
      sections={sections}
      trigger={() => (
        <button
          type="button"
          className="inline-flex items-center gap-1 h-7 rounded-md border border-dashed border-white/15 px-2.5 text-[12px] text-zinc-400 hover:text-white hover:border-white/30"
        >
          <Plus className="w-3.5 h-3.5" /> Filter
        </button>
      )}
    />
  )
}

export function SortMenu({
  label,
  sections,
}: {
  label: string
  sections: MenuSection[]
}) {
  return (
    <Menu
      align="right"
      sections={sections}
      trigger={() => (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[12px] text-zinc-500 hover:text-zinc-200"
        >
          {label} <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}
    />
  )
}
