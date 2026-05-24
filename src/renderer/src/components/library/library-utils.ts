import type { LibraryTrackView } from '@shared/contracts'
import { buildAlbumKey } from '@shared/album-key'

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
    { album: string; albumArtist: string; year: number | null; count: number }
  >()

  for (const track of tracks) {
    const key = buildAlbumKey(track.album, track.albumArtist)
    const existing = grouped.get(key)
    if (existing) {
      existing.count++
      continue
    }

    grouped.set(key, {
      album: track.album ?? 'Unknown Album',
      albumArtist: track.albumArtist ?? track.artist ?? 'Unknown Artist',
      year: track.year,
      count: 1,
    })
  }

  return [...grouped.entries()]
    .map(([key, album]) => ({
      key,
      album: album.album,
      albumArtist: album.albumArtist,
      year: album.year,
      trackCount: album.count,
    }))
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
