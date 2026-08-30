import { buildAlbumKey } from '@shared/album-key'
import { artistCreditId } from '@shared/artist-credit'
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
      const artistIds = new Set(
        track.artistCredits.map((credit) => artistCreditId(credit))
      )
      if (artistIds.size === 0) {
        for (const value of [track.artist, track.albumArtist]) {
          const normalized = normalizeName(value)
          if (normalized)
            artistIds.add(artistCreditId({ name: normalized, channelId: null }))
        }
      }

      for (const artistId of artistIds) {
        const keys = artistAlbumKeys.get(artistId) ?? new Set<string>()
        keys.add(album?.key ?? albumKey)
        artistAlbumKeys.set(artistId, keys)
      }
    }

    const filterByArtist = (
      artistId: string | null,
      artistName?: string | null
    ): AlbumGroup[] => {
      const lookupId =
        artistId ??
        (artistName
          ? artistCreditId({ name: artistName, channelId: null })
          : null)
      if (!lookupId) return groups
      const allowedKeys = artistAlbumKeys.get(lookupId)
      if (!allowedKeys) return []

      return groups.filter((group) => allowedKeys.has(group.key))
    }

    return {
      groups,
      filterByArtist,
    }
  }, [tracks])
}
