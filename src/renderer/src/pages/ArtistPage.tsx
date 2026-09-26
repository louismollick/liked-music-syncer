import { useParams } from '@tanstack/react-router'
import { RefreshCw, Star } from 'lucide-react'
import { AlbumTile } from '../components/Grids'
import { Crumbs, Section } from '../components/layout/Page'
import { SongTable } from '../components/SongTable'
import { Artwork } from '../components/ui/Artwork'
import { Button } from '../components/ui/Button'
import { invoke, useLibraryData } from '../lib/api'
import { useDominantColor } from '../lib/dominant-color'
import { plural } from '../lib/format'

export function ArtistPage() {
  const { artistId } = useParams({ strict: false }) as { artistId: string }
  const { data, reload } = useLibraryData(
    () => invoke('library:artist', artistId),
    [artistId]
  )
  const tint = useDominantColor(data?.artist.imageUrl ?? null)
  if (data === undefined) return null
  if (data === null)
    return (
      <div className="p-6 text-zinc-500 text-[13px]">
        This artist is no longer in your Library.
      </div>
    )
  const { artist, albums, standalone } = data
  const songs = artist.songCount
  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div
        style={{
          background: `linear-gradient(180deg, rgba(${tint ?? '82,82,91'}, .32), rgba(11,11,12,0))`,
        }}
      >
        <div className="p-6 pt-12 flex items-end gap-6">
          <Artwork
            src={artist.imageUrl}
            label={artist.name}
            kind="artist"
            className="w-40 h-40 shadow-2xl shrink-0"
          />
          <div className="pb-1 min-w-0 pr-48">
            <Crumbs items={[{ label: 'Artists', to: '/artists' }]} />
            <div className="text-[12px] text-zinc-300">Artist</div>
            <h1 className="text-5xl font-bold tracking-tight truncate selectable">
              {artist.name}
            </h1>
            <div className="mt-4 flex items-center gap-2 text-[13px]">
              <span className="text-zinc-300 mr-2">
                {plural(songs, 'song')} · {plural(albums.length, 'album')}
                {standalone.length ? ` · ${standalone.length} standalone` : ''}
              </span>
              {artist.identified && (
                <Button
                  variant={artist.favorite ? 'primary' : 'default'}
                  title={
                    artist.favorite
                      ? 'Syncing the Official Main Catalog (albums, singles, EPs). Click to stop.'
                      : 'Download the Official Main Catalog: every album, single and EP.'
                  }
                  onClick={() =>
                    void invoke('library:setFavorite', {
                      artistId: artist.id,
                      favorite: !artist.favorite,
                    }).then(reload)
                  }
                >
                  <Star
                    className="w-3.5 h-3.5"
                    fill={artist.favorite ? 'currentColor' : 'none'}
                  />{' '}
                  Favorite
                </Button>
              )}
              <Button
                onClick={() =>
                  void invoke('library:refresh', {
                    kind: 'artist',
                    id: artist.id,
                  })
                }
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </Button>
            </div>
          </div>
        </div>
      </div>
      <div className="p-6 space-y-8">
        {albums.length > 0 && (
          <Section title="Albums">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-5">
              {albums.map((album) => (
                <AlbumTile
                  key={album.key}
                  album={album}
                  from={`artist:${artist.id}`}
                />
              ))}
            </div>
          </Section>
        )}
        {standalone.length > 0 && (
          <Section title="Standalone tracks">
            <SongTable rows={standalone} showAlbum={false} />
          </Section>
        )}
      </div>
    </div>
  )
}
