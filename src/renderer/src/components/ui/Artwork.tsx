import { Disc3, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cx } from '../../lib/format'

function hueFor(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i += 1)
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return hash % 360
}

/** Square artwork with the app-wide 6px radius and a tinted fallback. */
export function Artwork({
  src,
  label,
  className,
  kind = 'album',
  hover,
}: {
  src: string | null
  label: string
  className?: string
  kind?: 'album' | 'artist'
  /** Outline on hover: of itself, or of the enclosing `group`. */
  hover?: 'self' | 'group'
}) {
  const [failed, setFailed] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the image changes
  useEffect(() => setFailed(false), [src])
  const hue = hueFor(label || '?')
  const hoverClass =
    hover &&
    cx(
      'outline-2 outline-offset-2 outline-transparent transition-[outline-color] duration-200',
      hover === 'self'
        ? 'hover:outline-white/20'
        : 'group-hover:outline-white/20'
    )
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        // Google image hosts reject requests with a localhost/file referrer.
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cx(
          'rounded-md object-cover bg-white/[.04]',
          hoverClass,
          className
        )}
      />
    )
  }
  const Icon = kind === 'artist' ? User : Disc3
  return (
    <div
      className={cx(
        'rounded-md flex items-center justify-center text-white/25',
        hoverClass,
        className
      )}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 30% 22%), hsl(${(hue + 40) % 360} 25% 12%))`,
      }}
    >
      <Icon className="w-1/3 h-1/3 max-w-10 max-h-10" strokeWidth={1.5} />
    </div>
  )
}
