import type { HttpClient } from '../net/http'
import { casefold } from './casefold'
import {
  canonicalizeTrackTitle,
  normalizeText,
  orderedTitleSearchQueries,
  titleVariants,
} from './text'
import type { Enrichment, Match } from './types'

const USER_AGENT =
  'LikedMusicSyncer/2.0 ( https://github.com/louismollick/liked-music-syncer )'
const GENRE_LIMIT = 3
interface Entity {
  [key: string]: unknown
}
function object(value: unknown): Entity | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Entity)
    : null
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}
function list(value: unknown): Entity[] {
  return Array.isArray(value)
    ? value.map(object).filter((entry): entry is Entity => entry !== null)
    : []
}
function artistNames(value: unknown): string[] {
  return list(value)
    .map((entry) => string(entry.name))
    .filter((entry): entry is string => entry !== null)
}
function releaseKey(
  match: Match,
  release: Entity
): [number, number, number, number, string] {
  const targetAlbum = normalizeText(match.album)
  const title = string(release.title)
  const date = string(release.date)
  const country = string(release.country)
  return [
    targetAlbum && title && normalizeText(title) === targetAlbum ? 0 : 1,
    date && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? 0 : 1,
    match.release?.year && date?.startsWith(String(match.release.year)) ? 0 : 1,
    country && country !== 'XW' ? 0 : country === 'XW' ? 1 : 2,
    string(release.id) ?? '',
  ]
}
function compareTuple(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] < b[i] ? -1 : a[i] > b[i] ? 1 : 0
    if (diff) return diff
  }
  return 0
}
function selectedRelease(match: Match, releases: unknown): Entity | null {
  const entries = list(releases)
  entries.sort((a, b) =>
    compareTuple(releaseKey(match, a), releaseKey(match, b))
  )
  return entries[0] ?? null
}
function selectedRecording(
  match: Match,
  recordings: unknown,
  primaryArtist: string
): Entity | null {
  const target = titleVariants(match.title, [primaryArtist])
  const canonical = normalizeText(
    canonicalizeTrackTitle(match.title, [primaryArtist])
  )
  const album = normalizeText(match.album)
  let best: Entity | null = null
  let bestKey: (number | string)[] | null = null
  for (const recording of list(recordings)) {
    const score = Number(recording.score ?? 0)
    if (!Number.isFinite(score) || score < 90) continue
    const title = string(recording.title)
    if (
      !title ||
      ![...titleVariants(title, [primaryArtist])].some((value) =>
        target.has(value)
      )
    )
      continue
    const names = artistNames(recording['artist-credit'])
    if (
      names.length &&
      !names.some(
        (name) => normalizeText(name) === normalizeText(primaryArtist)
      )
    )
      continue
    const release = selectedRelease(match, recording.releases)
    const releaseTitle = release ? string(release.title) : null
    const key: (number | string)[] = [
      album && releaseTitle && normalizeText(releaseTitle) === album ? 0 : 1,
      normalizeText(title) === canonical ? 0 : 1,
      -score,
      string(recording.id) ?? '',
    ]
    if (!bestKey || compareTuple(key, bestKey) < 0) {
      best = recording
      bestKey = key
    }
  }
  return best
}
export function musicBrainzGenres(payload: unknown): string[] {
  const genres = object(payload)?.genres
  if (!Array.isArray(genres)) return []
  const seen = new Set<string>()
  const ranked: [number, string][] = []
  for (const raw of genres) {
    const entry = object(raw)
    const name = string(entry?.name)?.trim()
    const rawCount = entry?.count
    if (
      !name ||
      typeof rawCount === 'boolean' ||
      (typeof rawCount !== 'number' && typeof rawCount !== 'string')
    )
      continue
    const count = Number(rawCount)
    const normalized = casefold(name.trim())
    if (!Number.isInteger(count) || count <= 0 || seen.has(normalized)) continue
    seen.add(normalized)
    ranked.push([count, name])
  }
  ranked.sort(
    (a, b) =>
      b[0] - a[0] ||
      (casefold(a[1]) < casefold(b[1])
        ? -1
        : casefold(a[1]) > casefold(b[1])
          ? 1
          : 0)
  )
  return ranked.slice(0, GENRE_LIMIT).map(([, name]) => name)
}
function recordingArtistId(
  recording: Entity,
  primaryArtist: string
): string | null {
  for (const credit of list(recording['artist-credit'])) {
    if (
      normalizeText(string(credit.name) ?? '') === normalizeText(primaryArtist)
    ) {
      const id = string(object(credit.artist)?.id)
      if (id) return id
    }
  }
  return null
}
export async function enrichMusicBrainz(
  http: HttpClient,
  match: Match,
  signal?: AbortSignal,
  genreCache: Map<string, string[]> = new Map()
): Promise<Enrichment> {
  const result: Enrichment = { mbRecordingId: null, genre: null, isrc: null }
  const primaryArtist =
    match.artists[0]?.name?.trim() ?? match.albumArtist.split(',')[0].trim()
  const queries = orderedTitleSearchQueries(match.title, [primaryArtist]).map(
    (title) => `recording:"${title}" AND artist:"${primaryArtist}"`
  )
  let recording: Entity | null = null
  for (const query of queries) {
    const url = new URL('https://musicbrainz.org/ws/2/recording/')
    url.searchParams.set('query', query)
    url.searchParams.set('fmt', 'json')
    url.searchParams.set('limit', '5')
    const payload = await http.json<unknown>(url.toString(), {
      host: 'musicbrainz',
      signal,
      headers: { 'User-Agent': USER_AGENT },
    })
    recording = selectedRecording(
      match,
      object(payload)?.recordings,
      primaryArtist
    )
    if (recording) break
  }
  if (!recording) return result
  result.mbRecordingId = string(recording.id)
  const isrcs = recording.isrcs
  if (Array.isArray(isrcs)) result.isrc = string(isrcs[0])
  const release = selectedRelease(match, recording.releases)
  const releaseGroupId = string(object(release?.['release-group'])?.id)
  const artistId = recordingArtistId(recording, primaryArtist)
  const sources: [string, string | null][] = [
    ['release-group', releaseGroupId],
    ['recording', result.mbRecordingId],
    ['artist', artistId],
  ]
  for (const [type, id] of sources) {
    if (!id) continue
    const cacheKey = `${type}:${id}`
    const cachedGenres = genreCache.get(cacheKey)
    if (cachedGenres) {
      if (cachedGenres.length) {
        result.genre = cachedGenres.join('; ')
        break
      }
      continue
    }
    const url = new URL(
      `https://musicbrainz.org/ws/2/${type}/${encodeURIComponent(id)}`
    )
    url.searchParams.set('inc', 'genres')
    url.searchParams.set('fmt', 'json')
    const payload = await http.json<unknown>(url.toString(), {
      host: 'musicbrainz',
      signal,
      headers: { 'User-Agent': USER_AGENT },
    })
    const genres = musicBrainzGenres(payload)
    genreCache.set(cacheKey, genres)
    if (genres.length) {
      result.genre = genres.join('; ')
      break
    }
  }
  return result
}
