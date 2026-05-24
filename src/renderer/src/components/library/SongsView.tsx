import type { LibraryTrackView } from '@shared/contracts'
import type { JSX } from 'react'
import { useState } from 'react'
import { useTracks } from '../../hooks/useTracks'

type SortKey = 'title' | 'artist' | 'album' | 'year'
type SortDir = 'asc' | 'desc'

function sortTracks(
  tracks: LibraryTrackView[],
  key: SortKey,
  dir: SortDir
): LibraryTrackView[] {
  return [...tracks].sort((a, b) => {
    const av = a[key] ?? ''
    const bv = b[key] ?? ''
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
    return dir === 'asc' ? cmp : -cmp
  })
}

function ColHeader({
  label,
  sortKey,
  active,
  dir,
  onClick,
}: {
  label: string
  sortKey: SortKey
  active: boolean
  dir: SortDir
  onClick: (key: SortKey) => void
}): JSX.Element {
  return (
    <th className="text-left px-3 py-2">
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={`flex items-center gap-1 text-xs font-medium uppercase tracking-wide transition-colors ${
          active
            ? 'text-text-primary'
            : 'text-text-muted hover:text-text-primary'
        }`}
      >
        {label}
        {active ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            className={`w-3 h-3 fill-current transition-transform ${dir === 'desc' ? 'rotate-180' : ''}`}
          >
            <path d="M6 2l4 6H2z" />
          </svg>
        ) : null}
      </button>
    </th>
  )
}

export function SongsView(): JSX.Element {
  const { tracks, loading } = useTracks()
  const [sortKey, setSortKey] = useState<SortKey>('title')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sorted = sortTracks(tracks, sortKey, sortDir)

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full text-text-muted">
        <p className="text-sm">Loading...</p>
      </div>
    )
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-text-primary">Songs</h2>
        <p className="text-xs text-text-muted mt-0.5">{tracks.length} tracks</p>
      </div>

      <div className="flex-1 overflow-auto">
        {tracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-text-muted">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="w-12 h-12 fill-current mb-3 opacity-40"
            >
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
            <p className="text-sm">No tracks found</p>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface-primary border-b border-border">
              <tr>
                <ColHeader
                  label="Title"
                  sortKey="title"
                  active={sortKey === 'title'}
                  dir={sortDir}
                  onClick={handleSort}
                />
                <ColHeader
                  label="Artist"
                  sortKey="artist"
                  active={sortKey === 'artist'}
                  dir={sortDir}
                  onClick={handleSort}
                />
                <ColHeader
                  label="Album"
                  sortKey="album"
                  active={sortKey === 'album'}
                  dir={sortDir}
                  onClick={handleSort}
                />
                <ColHeader
                  label="Year"
                  sortKey="year"
                  active={sortKey === 'year'}
                  dir={sortDir}
                  onClick={handleSort}
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map((track) => (
                <tr
                  key={track.id}
                  className="border-b border-border/50 hover:bg-surface-secondary/50 transition-colors"
                >
                  <td className="px-3 py-2.5 text-sm text-text-primary truncate max-w-[200px]">
                    {track.title ?? '—'}
                  </td>
                  <td className="px-3 py-2.5 text-sm text-text-secondary truncate max-w-[160px]">
                    {track.artist ?? '—'}
                  </td>
                  <td className="px-3 py-2.5 text-sm text-text-secondary truncate max-w-[160px]">
                    {track.album ?? '—'}
                  </td>
                  <td className="px-3 py-2.5 text-sm text-text-muted tabular-nums">
                    {track.year ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
