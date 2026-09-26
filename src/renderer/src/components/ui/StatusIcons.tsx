import {
  AlignLeft,
  CircleAlert,
  Cloud,
  CloudOff,
  Music2,
  TextSelect,
} from 'lucide-react'
import type { SongRowView } from '../../../../shared/ipc'
import { cx } from '../../lib/format'

const LYRICS_LABEL = {
  synced: 'Synced lyrics',
  plain: 'Plain lyrics',
  none: 'No lyrics',
} as const
const REMOTE_LABEL: Record<SongRowView['remoteState'], string> = {
  in_sync: 'Remote: in sync',
  stale: 'Remote: stale',
  missing: 'Remote: missing',
  uploading: 'Remote: uploading',
  failed: 'Remote: upload failed',
  off: 'Remote off',
}

/** One narrow status cell: lyrics, remote, and attention icons. Grey unless something is wrong. */
export function StatusIcons({
  song,
}: {
  song: Pick<SongRowView, 'lyricsStatus' | 'remoteState' | 'state'>
}) {
  const LyricsIcon =
    song.lyricsStatus === 'synced'
      ? Music2
      : song.lyricsStatus === 'plain'
        ? AlignLeft
        : TextSelect
  const remote = song.remoteState
  return (
    <span className="inline-flex items-center gap-2">
      <span title={LYRICS_LABEL[song.lyricsStatus]}>
        <LyricsIcon
          className={cx(
            'w-[15px] h-[15px]',
            song.lyricsStatus === 'synced'
              ? 'text-zinc-400'
              : song.lyricsStatus === 'plain'
                ? 'text-zinc-600'
                : 'text-zinc-700'
          )}
          strokeWidth={1.8}
        />
      </span>
      {remote !== 'off' && (
        <span title={REMOTE_LABEL[remote]}>
          {remote === 'failed' ? (
            <CloudOff
              className="w-[15px] h-[15px] text-orange-300"
              strokeWidth={1.8}
            />
          ) : (
            <Cloud
              className={cx(
                'w-[15px] h-[15px]',
                remote === 'in_sync' && 'text-zinc-700',
                remote === 'stale' && 'text-sky-300',
                remote === 'missing' && 'text-orange-300',
                remote === 'uploading' && 'text-zinc-300'
              )}
              strokeWidth={1.8}
            />
          )}
        </span>
      )}
      {song.state === 'needs_attention' && (
        <span title="Needs attention">
          <CircleAlert
            className="w-[15px] h-[15px] text-amber-300"
            strokeWidth={1.8}
          />
        </span>
      )}
    </span>
  )
}
