import {
  buildAlbumKey,
  canonicalAlbumName,
  UNKNOWN_ALBUM_NAME,
} from '@shared/album-key'
import type { LibraryTrackView } from '@shared/contracts'

export interface AlbumGroup {
  key: string
  album: string
  albumArtist: string
  year: number | null
  trackCount: number
}

export function groupAlbums(tracks: LibraryTrackView[]): AlbumGroup[] {
  const grouped = new Map<
    string,
    {
      album: string
      albumArtists: Set<string>
      fallbackArtists: Set<string>
      year: number | null
      count: number
    }
  >()

  for (const track of tracks) {
    const key = buildAlbumKey(track.album, track.albumArtist)
    const album = canonicalAlbumName(track.album)
    const albumArtist = (track.albumArtist ?? '').trim()
    const fallbackArtist = (track.artist ?? 'Unknown Artist').trim()
    const existing = grouped.get(key)
    if (existing) {
      existing.count++
      if (albumArtist) existing.albumArtists.add(albumArtist)
      if (fallbackArtist) existing.fallbackArtists.add(fallbackArtist)
      if (existing.year == null && track.year != null) {
        existing.year = track.year
      }
      continue
    }

    grouped.set(key, {
      album,
      albumArtists: new Set(albumArtist ? [albumArtist] : []),
      fallbackArtists: new Set(fallbackArtist ? [fallbackArtist] : []),
      year: track.year,
      count: 1,
    })
  }

  return [...grouped.entries()]
    .map(([key, album]) => {
      const distinctArtists =
        album.albumArtists.size > 0
          ? [...album.albumArtists]
          : [...album.fallbackArtists]
      const albumArtist =
        album.album === UNKNOWN_ALBUM_NAME && distinctArtists.length > 1
          ? 'Various Artists'
          : (distinctArtists[0] ?? 'Unknown Artist')

      return {
        key,
        album: album.album,
        albumArtist,
        year: album.year,
        trackCount: album.count,
      }
    })
    .sort((left, right) => left.album.localeCompare(right.album))
}

function normalizeName(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? ''
}

export function matchesArtistFilter(
  track: LibraryTrackView,
  artistName: string
): boolean {
  const wanted = normalizeName(artistName)
  if (!wanted) return true

  return [track.artist, track.albumArtist].some(
    (value) => normalizeName(value) === wanted
  )
}

export function matchesAlbumFilter(
  track: LibraryTrackView,
  albumKey: string
): boolean {
  return buildAlbumKey(track.album, track.albumArtist) === albumKey
}

export function lyricTypeLabel(
  lyricsStatus: LibraryTrackView['lyricsStatus']
): 'Synced' | 'Unsynced' | 'None' {
  switch (lyricsStatus) {
    case 'synced':
      return 'Synced'
    case 'plain':
      return 'Unsynced'
    default:
      return 'None'
  }
}

export function remoteStatusLabel(
  track: Pick<LibraryTrackView, 'hasLocalFile' | 'hasRemoteFile'>
): 'In Sync' | 'Local Only' | 'Remote Only' | 'Missing' {
  if (track.hasLocalFile && track.hasRemoteFile) return 'In Sync'
  if (track.hasLocalFile) return 'Local Only'
  if (track.hasRemoteFile) return 'Remote Only'
  return 'Missing'
}

export type SongSortKey =
  | 'title'
  | 'artist'
  | 'album'
  | 'year'
  | 'lyricType'
  | 'language'
  | 'remoteStatus'

export function songSortValue(
  track: LibraryTrackView,
  key: SongSortKey
): number | string {
  switch (key) {
    case 'lyricType':
      return lyricTypeLabel(track.lyricsStatus)
    case 'language':
      return track.language ?? ''
    case 'remoteStatus':
      return remoteStatusLabel(track)
    default:
      return track[key] ?? ''
  }
}
