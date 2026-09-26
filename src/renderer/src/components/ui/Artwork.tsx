import { Disc3, User } from 'lucide-react'
import { useState } from 'react'
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
}: {
  src: string | null
  label: string
  className?: string
  kind?: 'album' | 'artist'
}) {
  const [failed, setFailed] = useState(false)
  const hue = hueFor(label || '?')
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        // Google image hosts reject requests with a localhost/file referrer.
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cx('rounded-md object-cover bg-white/[.04]', className)}
      />
    )
  }
  const Icon = kind === 'artist' ? User : Disc3
  return (
    <div
      className={cx(
        'rounded-md flex items-center justify-center text-white/25',
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
