import type { AlbumArtworkEntry } from '@shared/contracts'

const albumArtworkCache = new Map<string, string | null>()
const ALBUM_KEY_SEPARATOR = '\u0001'

export function normalizeAlbumArtworkKeys(albumKeys: string[]): string[] {
  return [...new Set(albumKeys.filter(Boolean))].sort()
}

export function stabilizeAlbumArtworkKeys(
  previousKeys: string[],
  albumKeys: string[]
): string[] {
  const nextKeys = normalizeAlbumArtworkKeys(albumKeys)
  if (
    previousKeys.length === nextKeys.length &&
    previousKeys.every((key, index) => key === nextKeys[index])
  ) {
    return previousKeys
  }
  return nextKeys
}

export function buildAlbumArtworkSignature(albumKeys: string[]): string {
  return albumKeys.join(ALBUM_KEY_SEPARATOR)
}

export function readAlbumArtworkCache(
  albumKeys: string[]
): Record<string, string | null> {
  const next: Record<string, string | null> = {}
  for (const albumKey of albumKeys) {
    if (albumArtworkCache.has(albumKey)) {
      next[albumKey] = albumArtworkCache.get(albumKey) ?? null
    }
  }
  return next
}

export function writeAlbumArtworkCache(entries: AlbumArtworkEntry[]): void {
  for (const entry of entries) {
    albumArtworkCache.set(entry.albumKey, entry.artworkUrl)
  }
}

export function filterArtworkState(
  artworkByKey: Record<string, string | null>,
  albumKeys: string[]
): Record<string, string | null> {
  const allowed = new Set(albumKeys)
  return Object.fromEntries(
    Object.entries(artworkByKey).filter(([albumKey]) => allowed.has(albumKey))
  )
}
