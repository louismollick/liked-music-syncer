const ALBUM_KEY_SEPARATOR = '|||'
export const UNKNOWN_ALBUM_NAME = 'Unknown Album'
const LEGACY_UNKNOWN_ALBUM_NAME = '_Singles'

export function isUnknownAlbumValue(value: string | null | undefined): boolean {
  if (value == null) return true
  const trimmed = value.trim()
  return (
    trimmed === '' ||
    trimmed === LEGACY_UNKNOWN_ALBUM_NAME ||
    trimmed === UNKNOWN_ALBUM_NAME
  )
}

export function canonicalAlbumName(value: string | null | undefined): string {
  if (isUnknownAlbumValue(value)) return UNKNOWN_ALBUM_NAME
  return value!.trim()
}

export function buildAlbumKey(
  album: string | null | undefined,
  albumArtist: string | null | undefined
): string {
  const canonicalAlbum = canonicalAlbumName(album)
  if (canonicalAlbum === UNKNOWN_ALBUM_NAME) return canonicalAlbum
  return `${canonicalAlbum}${ALBUM_KEY_SEPARATOR}${albumArtist?.trim() ?? ''}`
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
