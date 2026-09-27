import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Hover label for small icons. Native `title` tooltips don't show on rows that
 * re-render while the user hovers (lists refresh during syncing), so this
 * renders its own, in a portal so scroll containers don't clip it.
 */
export function Tooltip({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)

  const show = () => {
    timer.current = setTimeout(() => {
      const rect = ref.current?.getBoundingClientRect()
      if (rect) setAt({ x: rect.left + rect.width / 2, y: rect.top })
    }, 300)
  }
  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setAt(null)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return (
    <span
      ref={ref}
      role="img"
      aria-label={label}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {at &&
        createPortal(
          <span
            role="tooltip"
            style={{ left: at.x, top: at.y - 6 }}
            className="fixed z-[60] -translate-x-1/2 -translate-y-full pointer-events-none whitespace-nowrap rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-zinc-200 shadow-lg fade-in"
          >
            {label}
          </span>,
          document.body
        )}
    </span>
  )
}
