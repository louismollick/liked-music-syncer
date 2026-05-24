const ALBUM_KEY_SEPARATOR = '|||'

export function buildAlbumKey(
  album: string | null | undefined,
  albumArtist: string | null | undefined
): string {
  return `${album ?? ''}${ALBUM_KEY_SEPARATOR}${albumArtist ?? ''}`
}

export function parseAlbumKey(albumKey: string): {
  album: string
  albumArtist: string
} {
  const separatorIndex = albumKey.indexOf(ALBUM_KEY_SEPARATOR)
  if (separatorIndex === -1) {
    return { album: albumKey, albumArtist: '' }
  }
  return {
    album: albumKey.slice(0, separatorIndex),
    albumArtist: albumKey.slice(separatorIndex + ALBUM_KEY_SEPARATOR.length),
  }
}
