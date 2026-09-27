import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AlbumView, ArtistView } from '../../../shared/ipc'
import { invoke } from '../lib/api'
import { cx, plural } from '../lib/format'
import { Artwork } from './ui/Artwork'
import { Tooltip } from './ui/Tooltip'

const GAP = 20

function useColumns(
  ref: React.RefObject<HTMLDivElement | null>,
  minWidth: number
) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width)
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  const columns = Math.max(1, Math.floor((width + GAP) / (minWidth + GAP)))
  const tile = width ? (width - GAP * (columns - 1)) / columns : minWidth
  return { columns, tile }
}

function VirtualGrid<T>({
  items,
  minWidth,
  textHeight,
  scrollRef,
  gridRef,
  scrollMargin,
  render,
}: {
  items: T[]
  minWidth: number
  textHeight: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  gridRef: React.RefObject<HTMLDivElement | null>
  scrollMargin: number
  render: (item: T, tile: number) => React.ReactNode
}) {
  const { columns, tile } = useColumns(gridRef, minWidth)
  const rows = Math.ceil(items.length / columns)
  const rowHeight = tile + textHeight + GAP
  const virtual = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
    scrollMargin,
  })
  useEffect(() => {
    void rowHeight
    virtual.measure()
  }, [rowHeight, virtual])
  return (
    <div
      ref={gridRef}
      style={{ height: virtual.getTotalSize(), position: 'relative' }}
    >
      {virtual.getVirtualItems().map((row) => (
        <div
          key={row.key}
          className="absolute left-0 right-0 grid"
          style={{
            top: 0,
            transform: `translateY(${row.start - scrollMargin}px)`,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: GAP,
          }}
        >
          {items
            .slice(row.index * columns, row.index * columns + columns)
            .map((item) => render(item, tile))}
        </div>
      ))}
    </div>
  )
}

export function ArtistGrid(props: {
  artists: ArtistView[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  gridRef: React.RefObject<HTMLDivElement | null>
  scrollMargin: number
  onChanged: () => void
}) {
  return (
    <VirtualGrid
      items={props.artists}
      minWidth={150}
      textHeight={44}
      scrollRef={props.scrollRef}
      gridRef={props.gridRef}
      scrollMargin={props.scrollMargin}
      render={(artist) => (
        <Link
          key={artist.id}
          to="/artist/$artistId"
          params={{ artistId: artist.id }}
          className="group relative block"
        >
          <Artwork
            src={artist.imageUrl}
            label={artist.name}
            kind="artist"
            className="w-full aspect-square"
            hover="group"
          />
          {artist.identified && (
            <div
              className={cx(
                'absolute top-2 right-2 transition-opacity',
                artist.fullDiscography
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
              )}
            >
              <Tooltip
                interactive
                label={
                  artist.fullDiscography
                    ? 'Full Discography: downloading every album, single and EP'
                    : 'Full Discography: download every album, single and EP'
                }
              >
                <button
                  type="button"
                  aria-label="Full Discography"
                  aria-pressed={artist.fullDiscography}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void invoke('library:setFullDiscography', {
                      artistId: artist.id,
                      fullDiscography: !artist.fullDiscography,
                    }).then(props.onChanged)
                  }}
                  className={cx(
                    'w-8 h-8 rounded-md backdrop-blur flex items-center justify-center transition-colors',
                    artist.fullDiscography
                      ? 'bg-white text-black'
                      : 'bg-black/55 text-zinc-300 hover:text-white'
                  )}
                >
                  <Download className="w-4 h-4" strokeWidth={2} />
                </button>
              </Tooltip>
            </div>
          )}
          <div className="mt-2 text-[13px] truncate">{artist.name}</div>
          <div className="text-[11px] text-zinc-500 truncate">
            {plural(artist.songCount, 'song')}
            {artist.fullDiscography
              ? ' · Full Discography'
              : artist.suggested
                ? ' · Suggested'
                : ''}
          </div>
        </Link>
      )}
    />
  )
}

export function AlbumTile({
  album,
  from,
  fromName,
}: {
  album: AlbumView
  from: string
  fromName?: string
}) {
  return (
    <Link
      key={album.key}
      to="/album/$albumKey"
      params={{ albumKey: album.key }}
      search={{ from, fromName }}
      className="block group"
    >
      <Artwork
        src={album.coverUrl}
        label={album.title}
        className="w-full aspect-square"
        hover="group"
      />
      <div className="mt-2 text-[13px] truncate group-hover:text-white">
        {album.title}
      </div>
      <div className="text-[11px] text-zinc-500 truncate">
        {from.startsWith('artist:') ? (album.year ?? '') : album.albumArtist}
      </div>
    </Link>
  )
}

export function AlbumGrid(props: {
  albums: AlbumView[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  gridRef: React.RefObject<HTMLDivElement | null>
  scrollMargin: number
}) {
  return (
    <VirtualGrid
      items={props.albums}
      minWidth={170}
      textHeight={44}
      scrollRef={props.scrollRef}
      gridRef={props.gridRef}
      scrollMargin={props.scrollMargin}
      render={(album) => (
        <AlbumTile key={album.key} album={album} from="albums" />
      )}
    />
  )
}
