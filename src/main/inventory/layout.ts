import { createHash } from 'node:crypto'

/**
 * Fixed folder layout (no templates):
 *   Release Tracks:    {albumArtist}/{album}/{track:02d} {title}.m4a
 *   Standalone Tracks: {albumArtist}/{title}/{title}.m4a
 * Segments are sanitized exactly like the old Python templating so adopted
 * release files keep their paths.
 */

const INVALID_PATH_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
const MAX_SEGMENT_BYTES = 200

export function sanitizeSegment(value: string, fallback = '_'): string {
  const compact = value.normalize('NFC').trim().split(/\s+/).filter(Boolean).join(' ')
  let cleaned = compact.replace(INVALID_PATH_CHARS, '_')
  // Leading dots would hide files on macOS/Linux.
  cleaned = cleaned.replace(/^\.+/, (dots) => '_'.repeat(dots.length))
  while (Buffer.byteLength(cleaned, 'utf8') > MAX_SEGMENT_BYTES) {
    cleaned = cleaned.slice(0, -1)
  }
  return cleaned || fallback
}

export interface LayoutInput {
  title: string
  album: string
  albumArtist: string
  trackNumber: number | null
  /** True for Release Tracks, false for Standalone Tracks. */
  hasRelease: boolean
}

export function layoutPath(input: LayoutInput): string {
  const artist = sanitizeSegment(input.albumArtist || 'Unknown Artist')
  const title = sanitizeSegment(input.title || 'Untitled')
  if (!input.hasRelease) return `${artist}/${title}/${title}.m4a`
  const album = sanitizeSegment(input.album || input.title || 'Untitled')
  const number = String(input.trackNumber ?? 0).padStart(2, '0')
  return `${artist}/${album}/${sanitizeSegment(`${number} ${input.title || 'Untitled'}`)}.m4a`
}

/** Case- and normalization-insensitive key for collision checks. */
export function pathKey(relativePath: string): string {
  return relativePath.normalize('NFC').toLowerCase()
}

export function withSuffix(relativePath: string, identityKey: string, length: number): string {
  const digest = createHash('sha256').update(identityKey).digest('hex').slice(0, length)
  return relativePath.replace(/\.m4a$/i, ` [${digest}].m4a`)
}

export function sidecarPath(audioRelativePath: string): string {
  return audioRelativePath.replace(/\.m4a$/i, '.lrc')
}

/**
 * Picks the layout path for a track, adding a stable identity-derived suffix
 * when the path is taken by another entry. `isTaken` must answer for the real
 * filesystem and for paths reserved by other tracks.
 */
export async function resolveCollision(
  preferred: string,
  identityKey: string,
  isTaken: (relativePath: string) => boolean | Promise<boolean>
): Promise<string> {
  if (!(await isTaken(preferred))) return preferred
  for (let length = 6; length <= 64; length += 2) {
    const candidate = withSuffix(preferred, identityKey, length)
    if (!(await isTaken(candidate))) return candidate
  }
  throw new Error(`No free path for ${preferred}`)
}
