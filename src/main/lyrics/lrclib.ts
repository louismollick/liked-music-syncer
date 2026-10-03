import { type HttpClient, HttpError } from '../net/http'
import type { LyricsQuery } from './types'

const BASE = 'https://lrclib.net/api'
const HEADERS = {
  'User-Agent':
    'LikedMusicSyncer/2.0 (https://github.com/louismollick/liked-music-syncer)',
}

interface LrclibResult {
  duration?: number
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

function lyricsOf(item: LrclibResult | null): string | null {
  return item?.syncedLyrics?.trim() || item?.plainLyrics?.trim() || null
}

export async function lrclibLyrics(
  http: HttpClient,
  query: LyricsQuery,
  signal?: AbortSignal
): Promise<string | null> {
  const artist = query.artists.map((credit) => credit.name).join(', ')
  // LRCLIB's exact lookup accepts durations from 1 to 3600 seconds.
  // Longer concert/medley uploads can still use search with duration matching.
  const duration =
    query.durationSeconds === null ? null : Math.round(query.durationSeconds)
  const canGet =
    duration === null ||
    (Number.isFinite(duration) && duration >= 1 && duration <= 3600)
  const get = new URL(`${BASE}/get`)
  get.searchParams.set('track_name', query.title)
  get.searchParams.set('artist_name', artist)
  if (query.album) get.searchParams.set('album_name', query.album)
  if (duration !== null) get.searchParams.set('duration', String(duration))
  if (canGet)
    try {
      const item = await http.json<LrclibResult>(get.toString(), {
        host: 'lrclib',
        headers: HEADERS,
        signal,
      })
      const found = lyricsOf(item)
      if (found) return found
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error
    }
  const search = new URL(`${BASE}/search`)
  search.searchParams.set('track_name', query.title)
  search.searchParams.set('artist_name', artist)
  const items = await http.json<LrclibResult[]>(search.toString(), {
    host: 'lrclib',
    headers: HEADERS,
    signal,
  })
  if (!Array.isArray(items))
    throw new Error('LRCLIB search response is not a list')
  const selected =
    query.durationSeconds == null
      ? items[0]
      : items.find(
          (item) =>
            typeof item.duration === 'number' &&
            Math.abs(item.duration - query.durationSeconds!) <= 3
        )
  return lyricsOf(selected ?? null)
}
