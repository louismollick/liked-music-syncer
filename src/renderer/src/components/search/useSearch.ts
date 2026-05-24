import type { LibraryTrackView, LikedArtistView } from '@shared/contracts'
import { useMemo } from 'react'
import type { AlbumGroup } from '../library/library-utils'
import { groupAlbums } from '../library/library-utils'

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export interface SearchResults {
  artists: LikedArtistView[]
  albums: AlbumGroup[]
  songs: LibraryTrackView[]
}

export function useSearch(
  query: string,
  artists: LikedArtistView[],
  tracks: LibraryTrackView[]
): SearchResults {
  return useMemo(() => {
    const q = normalize(query)
    if (!q) return { artists: [], albums: [], songs: [] }

    const matchedArtists = artists
      .filter((a) => normalize(a.name).includes(q))
      .slice(0, 5)

    const matchedAlbums = groupAlbums(tracks)
      .filter(
        (a) =>
          normalize(a.album).includes(q) || normalize(a.albumArtist).includes(q)
      )
      .slice(0, 5)

    const matchedSongs = tracks
      .filter(
        (t) =>
          (t.title ? normalize(t.title).includes(q) : false) ||
          (t.artist ? normalize(t.artist).includes(q) : false) ||
          (t.album ? normalize(t.album).includes(q) : false)
      )
      .slice(0, 5)

    return {
      artists: matchedArtists,
      albums: matchedAlbums,
      songs: matchedSongs,
    }
  }, [query, artists, tracks])
}
