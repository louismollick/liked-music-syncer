import { X } from 'lucide-react'
import { useEffect } from 'react'
import { cx } from '../../lib/format'
import { IconButton } from './Button'

/** Right-side drawer that slides over the current page. */
export function Drawer({
  open,
  onClose,
  title,
  width = 440,
  children,
}: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  width?: number
  children: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <>
      <div
        className={cx(
          'fixed inset-0 z-40 bg-black/40 transition-opacity',
          // Open, the backdrop takes clicks over the window drag areas too.
          open ? 'opacity-100 no-drag' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
      />
      <aside
        inert={!open}
        style={{ width }}
        className={cx(
          'fixed top-0 right-0 bottom-0 z-50 bg-panel border-l border-line shadow-2xl flex flex-col transition-transform duration-300',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <div className="h-14 shrink-0 flex items-center px-4 border-b border-line drag">
          <div className="text-[14px] font-semibold flex-1 min-w-0 truncate">
            {title}
          </div>
          <IconButton className="no-drag" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin">{children}</div>
      </aside>
    </>
  )
}
