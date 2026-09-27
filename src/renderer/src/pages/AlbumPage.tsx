import { Link, useParams, useSearch } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { type Crumb, Crumbs } from '../components/layout/Page'
import { SongTable } from '../components/SongTable'
import { Artwork } from '../components/ui/Artwork'
import { Button } from '../components/ui/Button'
import { invoke, useLibraryData } from '../lib/api'
import { useDominantColor } from '../lib/dominant-color'
import { formatMinutes, plural } from '../lib/format'

export function AlbumPage() {
  const { albumKey } = useParams({ strict: false }) as { albumKey: string }
  const search = useSearch({ strict: false }) as {
    from?: string
    fromName?: string
  }
  const { data } = useLibraryData(
    () => invoke('library:album', albumKey),
    [albumKey]
  )
  const tint = useDominantColor(data?.album.coverUrl ?? null)
  if (data === undefined) return null
  if (data === null)
    return (
      <div className="p-6 text-zinc-500 text-[13px]">
        This album is no longer in your Library.
      </div>
    )
  const { album, tracks } = data
  const from = search.from ?? ''
  const crumbs: Crumb[] =
    from === 'albums'
      ? [{ label: 'Albums', to: '/albums' }]
      : from === 'songs'
        ? [{ label: 'Songs', to: '/songs' }]
        : [
            { label: 'Artists', to: '/artists' },
            ...(album.artistId
              ? [
                  {
                    label:
                      (from.startsWith('artist:') && search.fromName) ||
                      album.albumArtist,
                    to: '/artist/$artistId',
                    params: {
                      artistId: from.startsWith('artist:')
                        ? from.slice(7)
                        : album.artistId,
                    },
                  },
                ]
              : []),
          ]
  const artistTarget = from.startsWith('artist:')
    ? from.slice(7)
    : album.artistId
  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div
        style={{
          background: `linear-gradient(180deg, rgba(${tint ?? '82,82,91'}, .26), rgba(11,11,12,0))`,
        }}
      >
        <div className="p-6 pt-12 flex items-end gap-6">
          <Artwork
            src={album.coverUrl}
            label={album.title}
            className="w-48 h-48 shadow-2xl shrink-0"
            hover="self"
          />
          <div className="pb-1 min-w-0 pr-48">
            <Crumbs items={crumbs} />
            <div className="text-[12px] text-zinc-300">
              Album{album.year ? ` · ${album.year}` : ''}
            </div>
            <h1 className="text-5xl font-bold tracking-tight truncate selectable">
              {album.title}
            </h1>
            <div className="mt-4 flex items-center gap-2 text-[13px] text-zinc-300">
              {artistTarget ? (
                <Link
                  to="/artist/$artistId"
                  params={{ artistId: artistTarget }}
                  className="font-medium hover:underline"
                >
                  {album.albumArtist}
                </Link>
              ) : (
                <span className="font-medium">{album.albumArtist}</span>
              )}
              <span className="mr-2">
                · {plural(album.songCount, 'song')} ·{' '}
                {formatMinutes(album.durationSeconds)}
              </span>
              <Button
                onClick={() =>
                  void invoke('library:refresh', {
                    kind: 'album',
                    key: album.key,
                  })
                }
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </Button>
            </div>
          </div>
        </div>
      </div>
      <div className="px-6 pb-8">
        <SongTable
          rows={tracks}
          showAlbum={false}
          showCover={false}
          showNumber
        />
      </div>
    </div>
  )
}
