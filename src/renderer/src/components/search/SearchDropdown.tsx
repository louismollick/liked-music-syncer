import { buildAlbumKey } from '@shared/album-key'
import type { LibraryTrackView, LikedArtistView } from '@shared/contracts'
import type { JSX } from 'react'
import { useAlbumArtwork } from '../../hooks/useAlbumArtwork'
import type { AlbumGroup } from '../library/library-utils'
import { SearchResultItem } from './SearchResultItem'

interface Props {
  artists: LikedArtistView[]
  albums: AlbumGroup[]
  songs: LibraryTrackView[]
  onSelectArtist: (artist: LikedArtistView) => void
  onSelectAlbum: (album: AlbumGroup) => void
  onSelectSong: (track: LibraryTrackView) => void
}

export function SearchDropdown({
  artists,
  albums,
  songs,
  onSelectArtist,
  onSelectAlbum,
  onSelectSong,
}: Props): JSX.Element {
  const albumKeys = [
    ...albums.map((a) => a.key),
    ...songs.map((t) => buildAlbumKey(t.album, t.albumArtist)),
  ]
  const { getArtworkUrl } = useAlbumArtwork(albumKeys)

  const hasResults = artists.length > 0 || albums.length > 0 || songs.length > 0

  return (
    <div className="absolute top-full left-4 right-4 mt-0 bg-surface-secondary border border-border rounded-b-xl shadow-xl z-50 overflow-hidden">
      {!hasResults ? (
        <p className="text-sm text-text-muted text-center py-4 px-3">
          No results
        </p>
      ) : (
        <>
          {artists.length > 0 && (
            <div className="p-2">
              <div className="px-3 py-1 text-xs font-semibold text-text-muted uppercase tracking-wider">
                Artists
              </div>
              {artists.map((a) => (
                <SearchResultItem
                  key={a.id}
                  result={{ type: 'artist', data: a }}
                  onClick={() => onSelectArtist(a)}
                />
              ))}
            </div>
          )}
          {albums.length > 0 && (
            <div
              className={`p-2 ${artists.length > 0 ? 'border-t border-border' : ''}`}
            >
              <div className="px-3 py-1 text-xs font-semibold text-text-muted uppercase tracking-wider">
                Albums
              </div>
              {albums.map((a) => (
                <SearchResultItem
                  key={a.key}
                  result={{
                    type: 'album',
                    data: a,
                    artworkUrl: getArtworkUrl(a.key),
                  }}
                  onClick={() => onSelectAlbum(a)}
                />
              ))}
            </div>
          )}
          {songs.length > 0 && (
            <div
              className={`p-2 ${artists.length > 0 || albums.length > 0 ? 'border-t border-border' : ''}`}
            >
              <div className="px-3 py-1 text-xs font-semibold text-text-muted uppercase tracking-wider">
                Songs
              </div>
              {songs.map((t) => (
                <SearchResultItem
                  key={t.id}
                  result={{
                    type: 'song',
                    data: t,
                    artworkUrl: getArtworkUrl(
                      buildAlbumKey(t.album, t.albumArtist)
                    ),
                  }}
                  onClick={() => onSelectSong(t)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
