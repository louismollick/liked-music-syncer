import { versionMarkers } from '../match/text'
import type { CatalogTrack } from './types'

/** Album titles can contain both localized and romanized text separated by " - ". */
export function releaseTitlesMatch(left: string, right: string): boolean {
  left = left.normalize('NFKC')
  right = right.normalize('NFKC')
  const normalize = (value: string) =>
    value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/(\([^()]+\))(?:\s+\1)+$/gu, '$1')
      .replace(/[^\p{L}\p{N}]/gu, '')
  const cjk =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
  const localizedParts = (value: string) => {
    const parts = value.split(/\s+-\s+/u)
    return parts.length === 2 &&
      (cjk.test(parts[0]) !== cjk.test(parts[1]) ||
        normalize(parts[0]) === normalize(parts[1]))
      ? parts.map(normalize)
      : []
  }
  const a = normalize(left),
    b = normalize(right)
  if (a === b) return Boolean(a)
  const featured = /(?<![\p{L}\p{N}_])(?:feat(?:uring)?\.?|ft\.?)\s+/iu
  if (featured.test(left) !== featured.test(right)) return false
  // Translation matching must not discard a version attached only to one half.
  const qualifiers = (value: string) =>
    [
      ...new Set([
        ...versionMarkers(value),
        ...[...value.matchAll(/\([^()]+\)/gu)]
          .filter((match) => {
            // A band's name after a featured artist is an artist credit,
            // e.g. ACAね(ずっと真夜中でいいのに。), not a recording qualifier.
            const prefix =
              value
                .slice(0, match.index)
                .split(/\s+-\s+/u)
                .at(-1) ?? ''
            const bandCredit =
              cjk.test(match[0]) &&
              !/版|録音|バージョン/u.test(match[0]) &&
              /(?:feat\.?|ft\.?)\s+[^()]+$/iu.test(prefix)
            return (
              !bandCredit ||
              versionMarkers(match[0]).size > 0 ||
              /remaster/iu.test(match[0])
            )
          })
          .map((match) => normalize(match[0])),
        ...(
          value.match(/(?:\d{4}\s*)?remaster(?:ed)?(?:\s*\d{4})?/giu) ?? []
        ).map(normalize),
      ]),
    ]
      .sort()
      .join('|')
  if (qualifiers(left) !== qualifiers(right)) return false
  return Boolean(
    a &&
      b &&
      (localizedParts(left).includes(b) || localizedParts(right).includes(a))
  )
}

/** A saved release position disambiguates repeated titles when a video was replaced by audio. */
export function sameReleasePosition(
  left: CatalogTrack,
  right: CatalogTrack
): boolean {
  return (
    left.trackNumber !== null &&
    left.trackNumber === right.trackNumber &&
    left.discNumber === right.discNumber &&
    releaseTitlesMatch(left.title, right.title) &&
    left.artists.some((artist) =>
      right.artists.some(
        (other) =>
          (artist.channelId !== null && artist.channelId === other.channelId) ||
          artist.name.normalize('NFKC').toLowerCase() ===
            other.name.normalize('NFKC').toLowerCase()
      )
    )
  )
}
