import { buildAlbumKey } from '@shared/album-key'
import type { LibraryTrackView } from '@shared/contracts'
import { useMemo } from 'react'
import {
  type AlbumGroup,
  groupAlbums,
} from '../components/library/library-utils'

function normalizeName(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? ''
}

export function useAlbumGroups(tracks: LibraryTrackView[]) {
  return useMemo(() => {
    const groups = groupAlbums(tracks)
    const groupsByKey = new Map(groups.map((group) => [group.key, group]))
    const artistAlbumKeys = new Map<string, Set<string>>()

    for (const track of tracks) {
      const albumKey = buildAlbumKey(track.album, track.albumArtist)
      const album = groupsByKey.get(albumKey)
      const normalizedArtists = new Set(
        [track.artist, track.albumArtist]
          .map((value) => normalizeName(value))
          .filter(Boolean)
      )

      for (const artistName of normalizedArtists) {
        const keys = artistAlbumKeys.get(artistName) ?? new Set<string>()
        keys.add(album?.key ?? albumKey)
        artistAlbumKeys.set(artistName, keys)
      }
    }

    const filterByArtist = (artistName: string | null): AlbumGroup[] => {
      if (!artistName) return groups

      const normalizedArtist = normalizeName(artistName)
      if (!normalizedArtist) return groups

      const allowedKeys = artistAlbumKeys.get(normalizedArtist)
      if (!allowedKeys) return []

      return groups.filter((group) => allowedKeys.has(group.key))
    }

    return {
      groups,
      filterByArtist,
    }
  }, [tracks])
}
