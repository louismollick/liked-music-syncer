import { ExternalLink } from 'lucide-react'
import { invoke } from '../lib/api'
import { useAppState } from '../lib/app-state'
import { Artwork } from './ui/Artwork'
import { Button } from './ui/Button'
import { Drawer } from './ui/Drawer'

export function NeedsAttentionDrawer() {
  const { activity, attentionOpen, setAttentionOpen, openSong } = useAppState()
  const items = activity?.needsAttention ?? []
  return (
    <Drawer
      open={attentionOpen}
      onClose={() => setAttentionOpen(false)}
      title={
        <span>
          Needs attention{' '}
          <span className="ml-1 text-zinc-500 font-normal">{items.length}</span>
        </span>
      }
    >
      {items.length === 0 && (
        <div className="p-6 text-[13px] text-zinc-500">
          Nothing needs attention.
        </div>
      )}
      {items.map((item) => (
        <div
          key={`${item.kind}-${item.id}`}
          className="flex items-start gap-3 px-4 py-3 border-b border-line text-[13px]"
        >
          {item.kind === 'source' ? (
            <div className="w-8 h-8 shrink-0 rounded-md bg-amber-300/10" />
          ) : (
            <Artwork
              src={item.coverUrl}
              label={item.title}
              className="w-8 h-8 shrink-0"
            />
          )}
          <button
            type="button"
            className="flex-1 min-w-0 text-left"
            onClick={() => {
              if (item.kind !== 'source') {
                setAttentionOpen(false)
                openSong(item.id)
              }
            }}
          >
            <div className="truncate">
              {item.title}
              {item.subtitle && (
                <span className="text-zinc-500"> · {item.subtitle}</span>
              )}
            </div>
            <div className="text-[12px] text-zinc-400 mt-0.5">
              {item.reason}
            </div>
          </button>
          <div className="flex gap-1.5 shrink-0">
            {item.kind === 'track' && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  title="Open on YouTube Music"
                  onClick={() =>
                    window.open(
                      `https://music.youtube.com/search?q=${encodeURIComponent(`${item.title} ${item.subtitle ?? ''}`)}`
                    )
                  }
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="sm"
                  onClick={() => void invoke('activity:retry', item.id)}
                >
                  Retry
                </Button>
              </>
            )}
            {item.kind === 'outside_edit' && (
              <>
                <Button
                  size="sm"
                  onClick={() => void invoke('activity:rewrite', item.id)}
                >
                  Rewrite
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void invoke('activity:stopManaging', item.id)}
                >
                  Stop
                </Button>
              </>
            )}
            {item.kind === 'source' && (
              <Button size="sm" onClick={() => void invoke('activity:check')}>
                Retry
              </Button>
            )}
          </div>
        </div>
      ))}
    </Drawer>
  )
}
