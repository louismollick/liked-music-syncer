import { Download, X } from 'lucide-react'
import { useState } from 'react'
import type { ArtistView } from '../../../shared/ipc'
import { invoke } from '../lib/api'
import { cx } from '../lib/format'
import { Tooltip } from './ui/Tooltip'

const LOOK = {
  overlay: {
    base: 'w-8 h-8 backdrop-blur',
    off: 'bg-black/55 border-white/10 text-zinc-300 hover:bg-black/80 hover:border-white/35 hover:text-white',
    on: 'bg-emerald-950/70 border-emerald-400/40 text-emerald-300',
    stop: 'hover:bg-red-950/70 hover:border-red-400/60 hover:text-red-300',
    icon: 'w-4 h-4',
  },
  button: {
    base: 'h-8 px-3 gap-1.5 text-[13px] whitespace-nowrap',
    off: 'border-line-strong text-zinc-200 hover:bg-white/[.08] hover:border-white/30 hover:text-white',
    on: 'bg-emerald-400/10 border-emerald-400/40 text-emerald-300',
    stop: 'hover:bg-red-400/10 hover:border-red-400/60 hover:text-red-300',
    icon: 'w-3.5 h-3.5',
  },
} as const

/**
 * Turns an artist's Full Discography on or off. While on, hovering previews
 * turning it off: a red X. Not right after turning it on, though, while the
 * pointer is still on the button, or the click would look like it failed.
 */
export function FullDiscographyToggle({
  artist,
  shape,
  onChanged,
}: {
  artist: ArtistView
  shape: 'overlay' | 'button'
  onChanged: () => void
}) {
  const [armed, setArmed] = useState(true)
  const on = artist.fullDiscography
  const stop = on && armed
  const look = LOOK[shape]
  const iconClass = cx(look.icon, 'shrink-0')
  return (
    <Tooltip
      interactive
      label={
        on ? 'Stop downloading full discography' : 'Download full discography'
      }
    >
      <button
        type="button"
        aria-label={shape === 'overlay' ? 'Full Discography' : undefined}
        aria-pressed={on}
        onMouseLeave={() => setArmed(true)}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setArmed(false)
          void invoke('library:setFullDiscography', {
            artistId: artist.id,
            fullDiscography: !on,
          }).then(onChanged)
        }}
        className={cx(
          'group/toggle inline-flex items-center justify-center rounded-md border transition-colors',
          look.base,
          on ? look.on : look.off,
          stop && look.stop
        )}
      >
        <Download
          className={cx(iconClass, stop && 'group-hover/toggle:hidden')}
          strokeWidth={2}
        />
        {stop && (
          <X
            className={cx(iconClass, 'hidden group-hover/toggle:block')}
            strokeWidth={2}
          />
        )}
        {shape === 'button' && 'Full Discography'}
      </button>
    </Tooltip>
  )
}
