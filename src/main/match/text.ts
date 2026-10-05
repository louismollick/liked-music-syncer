import type { CatalogTrack } from '../catalog/types'
import { casefold } from './casefold'
import { sequenceMatcherRatio } from './sequence-matcher'

export function normalizeText(value: string): string {
  return casefold(value.normalize('NFKC'))
    .trim()
    .replace(/[\s\-_]+/gu, ' ')
    .replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '')
    .replace(/\s+/gu, ' ')
}
export function normalizedPrimaryArtist(value: string): string {
  return value ? normalizeText(value.split(',')[0].trim()) : ''
}
const bracketAdornment =
  /[([{（【][^)\]}）】]*(?:official|music\s*video|official\s*mv|mv|pv|lyrics?|audio|visualizer|visualiser|hd|hq|4k|sub(?:bed|titles?)?)[^)\]}）】]*[)\]}）】]/giu
const bracketEnding =
  /\s*[([{（【][^)\]}）】]*(?:official|music video|official video|official mv|mv|audio|visualizer|lyrics?)[^)\]}）】]*[)\]}）】]\s*$/iu
const plainEnding =
  /\s*(?:-|:|\||\/)?\s*(?:official(?:\s+music)?\s+video|official\s+mv|music\s+video|mv|lyrics?|audio|visualizer)\s*$/iu
export function stripTitleAdornments(value: string): string {
  let cleaned = value.trim()
  for (;;) {
    const updated = cleaned
      .replace(bracketAdornment, ' ')
      .trim()
      .replace(bracketEnding, '')
      .trim()
      .replace(plainEnding, '')
      .trim()
      .replace(/\s+/gu, ' ')
      .trim()
    if (updated === cleaned) return updated
    cleaned = updated
  }
}
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
export function canonicalizeTrackTitle(
  value: string,
  artistNames: string[]
): string {
  let cleaned = stripTitleAdornments(value)
  for (const name of artistNames) {
    const artist = name.trim()
    if (!artist) continue
    let updated = cleaned
      .replace(
        new RegExp(`^\\s*${escapeRegex(artist)}\\s*(?:-|:|\\||/)\\s*`, 'iu'),
        ''
      )
      .trim()
    if (updated === cleaned)
      updated = cleaned
        .replace(
          new RegExp(
            `^\\s*${escapeRegex(artist)}(?=\\s|["'“”‘’「『〈《])\\s*`,
            'iu'
          ),
          ''
        )
        .trim()
    if (updated !== cleaned) {
      cleaned = updated
      break
    }
  }
  const quoted = cleaned.match(/^["'“”‘’「『〈《](.+?)["'“”‘’」』〉》]\s*$/u)
  if (quoted?.[1].trim()) cleaned = quoted[1].trim()
  return cleaned || value.trim()
}
export function titleVariants(
  value: string,
  artistNames: string[]
): Set<string> {
  const cleaned = canonicalizeTrackTitle(value, artistNames)
  return new Set(
    [cleaned, ...cleaned.split(/\s*(?:-|:|\||\/)\s*/u)]
      .map(normalizeText)
      .filter(Boolean)
  )
}
export function cleanChannelArtist(value: string): string {
  return (
    value
      .trim()
      .replace(
        /\s*(?:official(?:\s+youtube)?(?:\s+channel)?|topic|vevo)\s*$/iu,
        ''
      )
      .trim() || value.trim()
  )
}
export interface TitleIdentity {
  title: string
  artist: string
  method: string
}
export function artistTitleIdentities(
  title: string,
  artist: string,
  watchArtists: string[]
): TitleIdentity[] {
  const known = [...watchArtists, artist]
  const identities: TitleIdentity[] = []
  const seen = new Set<string>()
  function add(rawTitle: string, rawArtist: string, method: string) {
    const candidateTitle = rawTitle.replace(
      /^[ \t\-_—–:|/『』「」"'“”]+|[ \t\-_—–:|/『』「」"'“”]+$/gu,
      ''
    )
    const candidateArtist = cleanChannelArtist(rawArtist)
    const key = `${normalizeText(candidateTitle)}\0${normalizeText(candidateArtist)}`
    if (
      !normalizeText(candidateTitle) ||
      !normalizeText(candidateArtist) ||
      seen.has(key)
    )
      return
    seen.add(key)
    identities.push({ title: candidateTitle, artist: candidateArtist, method })
  }
  for (const name of known)
    if (name) add(canonicalizeTrackTitle(title, [name]), name, 'source')
  const separator =
    /\s+(?:[-–—|／/]|_{1,2})\s+|\s*[-–—|／/]\s*(?=[『「【])/u.exec(title)
  const split = separator
    ? [
        title.slice(0, separator.index),
        title.slice(separator.index + separator[0].length),
      ]
    : []
  if (split.length === 2)
    add(
      canonicalizeTrackTitle(split[1], [split[0].trim()]),
      split[0].trim(),
      'parsed_separator'
    )
  const quote = title.match(/^(.+?)[『「](.+?)[』」]/u)
  if (quote) add(quote[2], quote[1], 'parsed_quote')
  for (const found of title.matchAll(/["“”『「](.+?)["“”』」]/gu))
    for (const name of known) if (name) add(found[1], name, 'quoted_title')
  return identities
}
export function textSimilarity(
  left: string | null | undefined,
  right: string | null | undefined
): number {
  const a = normalizeText(left ?? '')
  const b = normalizeText(right ?? '')
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a))
    return (
      0.9 +
      (0.1 * Math.min(Array.from(a).length, Array.from(b).length)) /
        Math.max(Array.from(a).length, Array.from(b).length)
    )
  return sequenceMatcherRatio(a, b)
}
export function identityScoresMatch(title: number, artist: number): boolean {
  return (title >= 0.96 && artist >= 0.88) || (title >= 0.88 && artist >= 0.82)
}
const versionPatterns: Record<string, RegExp> = {
  cover:
    /(?<![\p{L}\p{N}_])cover(?![\p{L}\p{N}_])|カバー|弾いてみた|歌ってみた/iu,
  live: /(?<![\p{L}\p{N}_])live(?![\p{L}\p{N}_])|ライブ/iu,
  remix: /(?<![\p{L}\p{N}_])remix(?![\p{L}\p{N}_])|リミックス/iu,
  edit: /(?<![\p{L}\p{N}_])edit(?![\p{L}\p{N}_])/iu,
  acoustic: /(?<![\p{L}\p{N}_])acoustic(?![\p{L}\p{N}_])|アコースティック/iu,
  instrumental:
    /(?<![\p{L}\p{N}_])instrumental(?![\p{L}\p{N}_])|インスト(?:ゥルメンタル)?/iu,
  demo: /(?<![\p{L}\p{N}_])demo(?![\p{L}\p{N}_])|デモ/iu,
  karaoke: /(?<![\p{L}\p{N}_])karaoke(?![\p{L}\p{N}_])|カラオケ/iu,
  short:
    /(?<![\p{L}\p{N}_])short\s*(?:ver(?:sion)?\.?)?(?![\p{L}\p{N}_])|ショート/iu,
  sped_up: /(?<![\p{L}\p{N}_])sped\s*up(?![\p{L}\p{N}_])/iu,
  slowed: /(?<![\p{L}\p{N}_])slowed(?![\p{L}\p{N}_])/iu,
}
export function versionMarkers(value: string | null | undefined): Set<string> {
  return new Set(
    Object.entries(versionPatterns)
      .filter(([, pattern]) => pattern.test(value ?? ''))
      .map(([name]) => name)
  )
}
function albumVersionMarkers(value: string): Set<string> {
  const versions = [
    ...value.matchAll(/[([{（【]([^)\]}）】]*)[)\]}）】]/gu),
  ].map((match) => match[1])
  const suffix = /\s+-\s+(.+)$/u.exec(value)
  if (suffix) versions.push(suffix[1])
  const markers = versionMarkers(
    versions
      .join(' ')
      .replace(/\b(remixes|covers|edits|demos)\b/giu, (word) =>
        word.toLowerCase() === 'remixes' ? 'remix' : word.slice(0, -1)
      )
  )
  if (/^\s*live\s+(?:at|in|from|on)\b/iu.test(value)) markers.add('live')
  return markers
}
export function versionCompatible(
  source: Pick<CatalogTrack, 'title' | 'album'>,
  candidate: Pick<CatalogTrack, 'title' | 'album'>
): boolean {
  const markersFor = (track: Pick<CatalogTrack, 'title' | 'album'>) =>
    new Set([
      ...versionMarkers(track.title),
      ...albumVersionMarkers(track.album?.name ?? ''),
    ])
  const markers = markersFor(source)
  const found = markersFor(candidate)
  return (
    markers.size === found.size &&
    [...markers].every((marker) => found.has(marker))
  )
}
export function orderedTitleSearchQueries(
  value: string,
  artistNames: string[]
): string[] {
  const canonical = canonicalizeTrackTitle(value, artistNames)
  return [
    ...new Set(
      [value.trim(), canonical, ...canonical.split(/\s*(?:-|:|\||\/)\s*/u)]
        .map((part) => part.trim())
        .filter(Boolean)
    ),
  ]
}
