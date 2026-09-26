import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useRef } from 'react'
import type { SongRowView, SongSort } from '../../../shared/ipc'
import { useAppState } from '../lib/app-state'
import { cx, formatDate, formatDuration } from '../lib/format'
import { Artwork } from './ui/Artwork'
import { StatusIcons } from './ui/StatusIcons'

export interface SongTableProps {
  rows: SongRowView[]
  showAlbum?: boolean
  showCover?: boolean
  showNumber?: boolean
  sort?: SongSort
  descending?: boolean
  onSort?: (sort: SongSort) => void
  /** Scroll container for virtualization; omit for short lists. */
  scrollRef?: React.RefObject<HTMLDivElement | null>
  scrollMargin?: number
}

const ROW_HEIGHT = 52

function Header({
  label,
  sort,
  active,
  descending,
  onSort,
  className,
}: {
  label: string
  sort?: SongSort
  active: boolean
  descending?: boolean
  onSort?: (sort: SongSort) => void
  className?: string
}) {
  const Arrow = descending ? ArrowDown : ArrowUp
  return (
    <div className={cx('flex items-center gap-1', className)}>
      {sort && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sort)}
          className={cx(
            'inline-flex items-center gap-1 uppercase hover:text-zinc-300',
            active && 'text-zinc-300'
          )}
        >
          {label}
          {active && <Arrow className="w-3 h-3" />}
        </button>
      ) : (
        <span>{label}</span>
      )}
    </div>
  )
}

export function SongTable({
  rows,
  showAlbum = true,
  showCover = true,
  showNumber = false,
  sort,
  descending,
  onSort,
  scrollRef,
  scrollMargin = 0,
}: SongTableProps) {
  const { openSong } = useAppState()
  const listRef = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin,
    enabled: Boolean(scrollRef),
  })
  const grid = showAlbum
    ? 'grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_56px_44px_56px_76px_112px]'
    : showNumber
      ? 'grid-cols-[40px_minmax(0,3fr)_44px_56px_76px_112px]'
      : 'grid-cols-[minmax(0,3fr)_56px_44px_56px_76px_112px]'

  const renderRow = (song: SongRowView, index: number) => (
    <div
      key={song.id}
      onClick={() => openSong(song.id)}
      className={cx(
        'grid items-center gap-3 px-2 border-b border-line hover:bg-white/[.03] cursor-pointer text-[13px]',
        grid
      )}
      style={{ height: ROW_HEIGHT }}
    >
      {showNumber && (
        <div className="text-zinc-500 tabular-nums pl-1">
          {song.trackNumber ?? index + 1}
        </div>
      )}
      <div className="flex items-center gap-3 min-w-0">
        {showCover && (
          <Artwork
            src={song.coverUrl}
            label={song.album || song.title}
            className="w-9 h-9 shrink-0"
          />
        )}
        <div className="min-w-0">
          <div className="truncate">{song.title}</div>
          {showCover &&
            (song.artistId ? (
              <Link
                to="/artist/$artistId"
                params={{ artistId: song.artistId }}
                onClick={(event) => event.stopPropagation()}
                className="block truncate text-[12px] text-zinc-500 hover:text-white hover:underline"
              >
                {song.artist}
              </Link>
            ) : (
              <div className="truncate text-[12px] text-zinc-500">
                {song.artist}
              </div>
            ))}
        </div>
      </div>
      {showAlbum && (
        <div className="min-w-0 truncate">
          {song.albumKey ? (
            <Link
              to="/album/$albumKey"
              params={{ albumKey: song.albumKey }}
              search={{ from: 'songs' }}
              onClick={(event) => event.stopPropagation()}
              className="text-zinc-400 hover:text-white hover:underline"
            >
              {song.album}
            </Link>
          ) : (
            <span className="text-zinc-500">
              {song.standalone ? 'Standalone' : song.album}
            </span>
          )}
        </div>
      )}
      {!showNumber && (
        <div className="text-zinc-500 tabular-nums">{song.year ?? ''}</div>
      )}
      <div className="text-zinc-500 uppercase text-[11px]">
        {song.language ?? ''}
      </div>
      <div className="text-right text-zinc-500 tabular-nums">
        {formatDuration(song.durationSeconds)}
      </div>
      <div className="flex justify-center">
        <StatusIcons song={song} />
      </div>
      <div className="text-right pr-2 text-zinc-500 tabular-nums">
        {song.likedAt ? formatDate(song.likedAt) : 'Catalog'}
      </div>
    </div>
  )

  const active = (s: SongSort) => sort === s
  return (
    <div ref={listRef}>
      <div
        className={cx(
          'grid gap-3 px-2 h-9 items-center border-b border-line text-[11px] uppercase tracking-wider text-zinc-500',
          grid
        )}
      >
        {showNumber && <div className="pl-1">#</div>}
        <Header
          label="Title"
          sort="title"
          active={active('title')}
          descending={descending}
          onSort={onSort}
        />
        {showAlbum && (
          <Header
            label="Album"
            sort="album"
            active={active('album')}
            descending={descending}
            onSort={onSort}
          />
        )}
        {!showNumber && (
          <Header
            label="Year"
            sort="year"
            active={active('year')}
            descending={descending}
            onSort={onSort}
          />
        )}
        <div>Lang</div>
        <Header
          label="Time"
          sort="time"
          active={active('time')}
          descending={descending}
          onSort={onSort}
          className="justify-end"
        />
        <div className="text-center">Status</div>
        <Header
          label="Liked"
          sort="liked"
          active={active('liked')}
          descending={descending}
          onSort={onSort}
          className="justify-end pr-2"
        />
      </div>
      {scrollRef ? (
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => (
            <div
              key={item.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${item.start - virtual.options.scrollMargin}px)`,
              }}
            >
              {renderRow(rows[item.index], item.index)}
            </div>
          ))}
        </div>
      ) : (
        rows.map(renderRow)
      )}
    </div>
  )
}
