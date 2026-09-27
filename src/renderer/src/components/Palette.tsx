import { useNavigate } from '@tanstack/react-router'
import { CornerDownLeft, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchResultsView } from '../../../shared/ipc'
import { invoke } from '../lib/api'
import { useAppState } from '../lib/app-state'
import { cx, plural } from '../lib/format'
import { Artwork } from './ui/Artwork'

interface Entry {
  key: string
  group: string
  label: string
  hint?: string
  image?: { src: string | null; kind: 'album' | 'artist' }
  run: () => void
}

export function Palette() {
  const { paletteOpen, setPaletteOpen, openSong } = useAppState()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [results, setResults] = useState<SearchResultsView | null>(null)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPaletteOpen])

  useEffect(() => {
    if (paletteOpen) {
      setText('')
      setResults(null)
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [paletteOpen])

  useEffect(() => {
    if (!text.trim()) {
      setResults(null)
      return
    }
    let current = true
    const timer = setTimeout(
      () =>
        void invoke('library:search', text).then((next) => {
          // Ignore responses for text the user has already changed.
          if (current) setResults(next)
        }),
      120
    )
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [text])

  const close = () => setPaletteOpen(false)
  const entries = useMemo<Entry[]>(() => {
    const commands: Entry[] = [
      {
        key: 'cmd-check',
        group: 'Commands',
        label: 'Check liked songs now',
        run: () => void invoke('activity:check'),
      },
      {
        key: 'cmd-catalogs',
        group: 'Commands',
        label: 'Refresh Full Discography catalogs',
        run: () => void invoke('activity:refreshCatalogs'),
      },
      {
        key: 'cmd-activity',
        group: 'Commands',
        label: 'Open Activity',
        run: () => void navigate({ to: '/activity' }),
      },
      {
        key: 'cmd-settings',
        group: 'Commands',
        label: 'Open Settings',
        run: () => void navigate({ to: '/settings' }),
      },
    ]
    const query = text.trim().toLowerCase()
    const filtered = query
      ? commands.filter((c) => c.label.toLowerCase().includes(query))
      : commands
    const out = [...filtered]
    for (const artist of results?.artists ?? []) {
      out.push({
        key: `artist-${artist.id}`,
        group: 'Artists',
        label: artist.name,
        hint: `${plural(artist.songCount, 'song')}${artist.fullDiscography ? ' · Full Discography' : ''}`,
        image: { src: artist.imageUrl, kind: 'artist' },
        run: () =>
          void navigate({
            to: '/artist/$artistId',
            params: { artistId: artist.id },
          }),
      })
    }
    for (const album of results?.albums ?? []) {
      out.push({
        key: `album-${album.key}`,
        group: 'Albums',
        label: album.title,
        hint: `${album.albumArtist}${album.year ? ` · ${album.year}` : ''}`,
        image: { src: album.coverUrl, kind: 'album' },
        run: () =>
          void navigate({
            to: '/album/$albumKey',
            params: { albumKey: album.key },
            search: { from: 'albums' },
          }),
      })
    }
    for (const song of results?.songs ?? []) {
      out.push({
        key: `song-${song.id}`,
        group: 'Songs',
        label: song.title,
        hint: `${song.artist}${song.album ? ` · ${song.album}` : ''}`,
        image: { src: song.coverUrl, kind: 'album' },
        run: () => {
          void navigate({ to: '/songs', search: { song: song.id } })
          openSong(song.id)
        },
      })
    }
    return out
  }, [results, text, navigate, openSong])

  useEffect(() => {
    void entries.length
    setCursor(0)
  }, [entries.length])

  if (!paletteOpen) return null
  let lastGroup = ''
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-start justify-center pt-24 no-drag"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="w-[620px] rounded-md bg-raised border border-line shadow-2xl overflow-hidden fade-in">
        <div className="flex items-center gap-3 px-4 h-12 border-b border-line">
          <Search className="w-4 h-4 text-zinc-500" />
          <input
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close()
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((c) => Math.min(entries.length - 1, c + 1))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((c) => Math.max(0, c - 1))
              }
              if (event.key === 'Enter' && entries[cursor]) {
                entries[cursor].run()
                close()
              }
            }}
            placeholder="Search or run a command"
            className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-zinc-500"
          />
          <span className="text-[11px] text-zinc-500">esc</span>
        </div>
        <div className="max-h-[440px] overflow-y-auto scroll-thin py-1 text-[13px]">
          {entries.map((entry, index) => {
            const header = entry.group !== lastGroup
            lastGroup = entry.group
            return (
              <div key={entry.key}>
                {header && (
                  <div
                    className={cx(
                      'px-4 pt-3 pb-1 text-[11px] uppercase tracking-wider text-zinc-500',
                      index > 0 && 'border-t border-line mt-1'
                    )}
                  >
                    {entry.group}
                  </div>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => {
                    entry.run()
                    close()
                  }}
                  className={cx(
                    'w-full px-4 py-2 flex items-center gap-3 text-left',
                    cursor === index ? 'bg-white/[.06]' : ''
                  )}
                >
                  {entry.image && (
                    <Artwork
                      src={entry.image.src}
                      label={entry.label}
                      kind={entry.image.kind}
                      className="w-7 h-7 shrink-0"
                    />
                  )}
                  <span className="truncate">{entry.label}</span>
                  {entry.hint && (
                    <span className="text-zinc-500 truncate">{entry.hint}</span>
                  )}
                  {cursor === index && (
                    <CornerDownLeft className="ml-auto w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  )}
                </button>
              </div>
            )
          })}
          {text.trim() && results && entries.length === 0 && (
            <div className="px-4 py-6 text-zinc-500">No matches</div>
          )}
        </div>
      </div>
    </div>
  )
}
