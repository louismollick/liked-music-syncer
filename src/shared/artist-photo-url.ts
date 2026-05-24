const ARTIST_PHOTO_MIN_EDGE = 300

export function isLowResArtistPhotoUrl(photoUrl: string | null): boolean {
  if (!photoUrl) return true
  const sizeMatch = photoUrl.match(/[=/]s(\d+)(?:[-/]|$)/i)
  if (sizeMatch) {
    return Number.parseInt(sizeMatch[1], 10) < ARTIST_PHOTO_MIN_EDGE
  }
  const dimensionMatch = photoUrl.match(/=w(\d+)-h(\d+)/i)
  if (dimensionMatch) {
    const edge = Math.min(
      Number.parseInt(dimensionMatch[1], 10),
      Number.parseInt(dimensionMatch[2], 10)
    )
    return edge < ARTIST_PHOTO_MIN_EDGE
  }
  return false
}
