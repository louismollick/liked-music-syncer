import type { LyricsQuery } from './types'

const VERSION_PATTERNS = {
  instrumental:
    /\binstrumental\b|\binst\.(?=\W|$)|\binst\b|off[\s-]*vocal|\bkaraoke\b|カラオケ|インスト(?:ゥルメンタル)?/i,
  live: /\blive\b|ライブ/i,
  'tv-size': /\btv[\s.-]*(?:size|ver(?:sion)?\.?)\b|テレビサイズ/i,
  remix: /\bremix\b|リミックス/i,
  acoustic: /\bacoustic\b|アコースティック/i,
  cover: /\bcover\b|カバー|歌ってみた/i,
  demo: /\bdemo\b|デモ/i,
  'new-recording': /\bnew[\s-]*recording\b|\bre[\s-]*record(?:ed|ing)\b|再録/i,
}

export function versionQualifiers(title: string): string[] {
  const normalized = title.normalize('NFKC')
  return Object.entries(VERSION_PATTERNS)
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([kind]) => kind)
}

export function isInstrumentalTitle(title: string): boolean {
  return VERSION_PATTERNS.instrumental.test(title.normalize('NFKC'))
}

export function normalizeLyricsName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** Only drop the untranslated half of a bilingual title, never its version. */
export function prepareLyricsQuery(query: LyricsQuery) {
  const qualifiers = versionQualifiers(query.title)
  const titles = [query.title]
  const halves = query.title.split(/\s+-\s+/)
  if (halves.length === 2) {
    const native = halves.findIndex((half) =>
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(half)
    )
    if (native >= 0 && versionQualifiers(halves[1 - native]).length === 0)
      titles.push(halves[native])
  }
  return {
    ...query,
    qualifiers,
    titles: [...new Set(titles)],
    artistNames: [
      ...new Set(
        [
          query.artists.map((credit) => credit.name).join(', '),
          ...(query.artistVariants ?? []),
        ].filter(Boolean)
      ),
    ],
  }
}

export type LyricsLookup = ReturnType<typeof prepareLyricsQuery>

export function sameVersion(query: LyricsLookup, title: string): boolean {
  const qualifiers = versionQualifiers(title)
  return (
    qualifiers.length === query.qualifiers.length &&
    qualifiers.every((kind) => query.qualifiers.includes(kind))
  )
}

export function durationMatches(
  query: LyricsLookup,
  duration: number
): boolean {
  return (
    query.durationSeconds === null ||
    (Number.isFinite(duration) &&
      duration > 0 &&
      Math.abs(duration - query.durationSeconds) <= 3)
  )
}

export function titleMatches(query: LyricsLookup, title: string): boolean {
  return query.titles.some(
    (variant) => normalizeLyricsName(variant) === normalizeLyricsName(title)
  )
}

/** Exact normalized names keep broad provider searches on the same song. */
export function candidateMatches(
  query: LyricsLookup,
  title: string,
  artist: string,
  duration: number
): boolean {
  return (
    typeof title === 'string' &&
    typeof artist === 'string' &&
    sameVersion(query, title) &&
    durationMatches(query, duration) &&
    titleMatches(query, title) &&
    query.artistNames.some(
      (variant) => normalizeLyricsName(variant) === normalizeLyricsName(artist)
    )
  )
}
