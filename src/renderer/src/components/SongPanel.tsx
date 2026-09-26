import { Link } from '@tanstack/react-router'
import { FolderOpen, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TrackDetailView } from '../../../shared/ipc'
import { invoke, useEvent } from '../lib/api'
import { useAppState } from '../lib/app-state'
import { cx, formatDate } from '../lib/format'
import { Artwork } from './ui/Artwork'
import { Button, IconButton } from './ui/Button'

const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })

function languageName(code: string | null): string {
  if (!code) return 'unknown language'
  try {
    return LANGUAGE_NAMES.of(code) ?? code
  } catch {
    return code
  }
}

const LYRICS_SOURCE: Record<string, string> = {
  spotify: 'Spotify',
  'youtube-music': 'YouTube Music',
  lrclib: 'LRCLIB',
}
const REMOTE_TEXT = {
  in_sync: 'in sync',
  stale: 'stale',
  missing: 'missing',
  uploading: 'uploading',
  failed: 'upload failed',
  off: 'off',
} as const

function Row({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="py-4 border-b border-line">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1.5">
        {title}
      </div>
      {children}
    </div>
  )
}

/** Slides in from the right with one song's Match, sources, files and remote state. */
export function SongPanel() {
  const { songId, closeSong } = useAppState()
  const [detail, setDetail] = useState<TrackDetailView | null>(null)
  const load = () => {
    if (songId) void invoke('library:track', songId).then(setDetail)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the song changes
  useEffect(() => {
    setDetail(null)
    load()
  }, [songId])
  useEvent('library:changed', (event) => {
    if (songId && (!event.trackIds || event.trackIds.includes(songId))) load()
  })
  useEffect(() => {
    if (!songId) return
    const onKey = (event: KeyboardEvent) =>
      event.key === 'Escape' && closeSong()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [songId, closeSong])

  const open = Boolean(songId)
  const song = detail?.song
  return (
    <aside
      className={cx(
        'absolute top-0 right-0 bottom-0 z-40 w-[380px] bg-panel border-l border-line shadow-2xl overflow-y-auto scroll-thin transition-transform duration-300',
        open ? 'translate-x-0' : 'translate-x-full'
      )}
    >
      <div className="px-5 pb-6 text-[13px]">
        <div className="flex justify-end h-12 items-center">
          <IconButton onClick={closeSong} title="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>
        {song && detail && (
          <div className="fade-in">
            <Artwork
              src={song.coverUrl}
              label={song.album || song.title}
              className="w-full aspect-square"
            />
            <div className="py-4 border-b border-line">
              <div className="text-xl font-semibold selectable">
                {song.title}
              </div>
              <div className="mt-0.5">
                {detail.artists.map((artist, index) => (
                  <span key={artist.id}>
                    {index > 0 && <span className="text-zinc-600">, </span>}
                    <Link
                      to="/artist/$artistId"
                      params={{ artistId: artist.id }}
                      className="text-zinc-300 hover:underline"
                    >
                      {artist.name}
                    </Link>
                  </span>
                ))}
                {song.albumKey && (
                  <>
                    <span className="text-zinc-600"> · </span>
                    <Link
                      to="/album/$albumKey"
                      params={{ albumKey: song.albumKey }}
                      search={{ from: 'songs' }}
                      className="text-zinc-400 hover:underline"
                    >
                      {song.album}
                    </Link>
                  </>
                )}
              </div>
            </div>
            {(detail.lastError || detail.outsideEdit) && (
              <div className="py-4 border-b border-line text-amber-200/90">
                {detail.outsideEdit ? (
                  <>
                    <div>
                      Changed outside the app: {detail.outsideEdit.join(', ')}.
                    </div>
                    <div className="flex gap-2 mt-3">
                      <Button
                        size="sm"
                        onClick={() => void invoke('activity:rewrite', song.id)}
                      >
                        Rewrite
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void invoke('activity:stopManaging', song.id)
                        }
                      >
                        Stop managing
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div>{detail.lastError}</div>
                    {song.state === 'needs_attention' && (
                      <Button
                        size="sm"
                        className="mt-3"
                        onClick={() => void invoke('activity:retry', song.id)}
                      >
                        Retry
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
            <Row title="Why it's here">
              {detail.contributions.length === 0 ? (
                <div className="text-zinc-400">
                  No longer in any Liked Music Library or Favorite Artist
                  catalog.
                </div>
              ) : (
                detail.contributions.map((c, index) => (
                  <div
                    key={`${c.kind}-${index}`}
                    className={index === 0 ? '' : 'text-zinc-400'}
                  >
                    {c.label}
                    {c.at ? ` · ${formatDate(c.at)}` : ''}
                  </div>
                ))
              )}
            </Row>
            <Row title="Match">
              {detail.match.catalogVideoId ? (
                <div className="text-zinc-300">
                  YouTube Music ·{' '}
                  <span className="font-mono text-[12px] text-zinc-400 selectable">
                    {detail.match.catalogVideoId}
                  </span>
                </div>
              ) : (
                <div className="text-zinc-400">Not matched yet</div>
              )}
              <div className="text-zinc-300">
                {detail.match.releaseTitle
                  ? `${detail.match.releaseTitle}${detail.match.releaseYear ? ` (${detail.match.releaseYear})` : ''}`
                  : 'Standalone track'}
              </div>
              {detail.match.genre && (
                <div className="text-zinc-400">
                  Genre: {detail.match.genre} ({detail.match.genreSource})
                </div>
              )}
              {Object.keys(detail.enrichmentErrors).length > 0 && (
                <div className="text-zinc-500 text-[12px] mt-1">
                  Some lookups failed:{' '}
                  {Object.keys(detail.enrichmentErrors).join(', ')}. Refresh to
                  try again.
                </div>
              )}
            </Row>
            <Row title="Lyrics">
              {detail.lyrics.status === 'none'
                ? 'No lyrics found'
                : `${detail.lyrics.status === 'synced' ? 'Synced' : 'Plain'} · ${detail.lyrics.source ? (LYRICS_SOURCE[detail.lyrics.source] ?? detail.lyrics.source) : 'unknown source'} · ${languageName(detail.lyrics.language)}`}
            </Row>
            <Row title="Files">
              <div className="font-mono text-[11px] text-zinc-400 break-all selectable">
                {detail.file.path ?? 'No local file'}
              </div>
              <div className="mt-1">
                Remote:{' '}
                <span
                  className={cx(
                    detail.remote.state === 'stale' && 'text-sky-300',
                    (detail.remote.state === 'missing' ||
                      detail.remote.state === 'failed') &&
                      'text-orange-300'
                  )}
                >
                  {REMOTE_TEXT[detail.remote.state]}
                  {detail.remote.state === 'stale' &&
                    detail.remote.differences.length > 0 &&
                    ` · ${detail.remote.differences.join(', ')} differ`}
                </span>
              </div>
            </Row>
            <div className="flex gap-2 pt-4">
              <Button
                variant="primary"
                onClick={() =>
                  void invoke('library:refresh', { kind: 'track', id: song.id })
                }
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </Button>
              {detail.file.absolutePath && (
                <Button
                  onClick={() =>
                    void invoke('app:showInFinder', detail.file.absolutePath!)
                  }
                >
                  <FolderOpen className="w-3.5 h-3.5" /> Show in Finder
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
