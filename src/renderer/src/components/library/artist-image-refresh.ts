import { isLowResArtistPhotoUrl } from '@shared/artist-photo-url'

interface ArtistImageRefreshCandidate {
  id: string
  channelId: string | null
  photoUrl: string | null
}

interface ArtistImageRefreshState {
  candidateKey: string | null
  isAuthenticated: boolean
  lastRequestedKey: string | null
}

export function getArtistImageRefreshKey(
  artists: ArtistImageRefreshCandidate[]
): string | null {
  const candidates = artists
    .filter(
      (artist) =>
        Boolean(artist.channelId) && isLowResArtistPhotoUrl(artist.photoUrl)
    )
    .map((artist) => [artist.id, artist.photoUrl] as const)
    .sort(([left], [right]) => left.localeCompare(right))

  return candidates.length > 0 ? JSON.stringify(candidates) : null
}

export function shouldRequestArtistImageRefresh({
  candidateKey,
  isAuthenticated,
  lastRequestedKey,
}: ArtistImageRefreshState): boolean {
  return (
    isAuthenticated &&
    candidateKey !== null &&
    candidateKey !== lastRequestedKey
  )
}
