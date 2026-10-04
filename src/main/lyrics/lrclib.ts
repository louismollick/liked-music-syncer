import { type HttpClient, HttpError } from '../net/http'
import { classifyLyricsText } from './classify'
import { candidateMatches, type LyricsLookup } from './query'

const BASE = 'https://lrclib.net/api'
const HEADERS = {
  'User-Agent':
    'LikedMusicSyncer/2.0 (https://github.com/louismollick/liked-music-syncer)',
}

interface LrclibResult {
  trackName: string
  artistName: string
  duration: number
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

export async function lrclibLyrics(
  http: HttpClient,
  query: LyricsLookup,
  signal?: AbortSignal,
  reportError?: (error: unknown) => void
): Promise<string | null> {
  let plain: string | null = null
  const duration =
    query.durationSeconds === null ? null : Math.round(query.durationSeconds)
  const canGet =
    duration === null ||
    (Number.isFinite(duration) && duration >= 1 && duration <= 3600)
  function consider(item: LrclibResult) {
    if (
      !candidateMatches(query, item.trackName, item.artistName, item.duration)
    )
      return null
    const lyrics =
      classifyLyricsText(item.syncedLyrics) ??
      classifyLyricsText(item.plainLyrics)
    if (lyrics?.synced) return lyrics.text
    plain ??= lyrics?.text ?? null
    return null
  }
  try {
    for (const title of query.titles) {
      for (const artist of query.artistNames) {
        const get = new URL(`${BASE}/get`)
        get.searchParams.set('track_name', title)
        get.searchParams.set('artist_name', artist)
        if (query.album) get.searchParams.set('album_name', query.album)
        if (duration !== null)
          get.searchParams.set('duration', String(duration))
        if (canGet) {
          try {
            const item = await http.json<LrclibResult>(get.toString(), {
              host: 'lrclib',
              headers: HEADERS,
              signal,
            })
            if (item) {
              const synced = consider(item)
              if (synced) return synced
            }
          } catch (error) {
            if (!(error instanceof HttpError && error.status === 404))
              throw error
          }
        }
        const search = new URL(`${BASE}/search`)
        search.searchParams.set('track_name', title)
        search.searchParams.set('artist_name', artist)
        const items = await http.json<LrclibResult[]>(search.toString(), {
          host: 'lrclib',
          headers: HEADERS,
          signal,
        })
        if (!Array.isArray(items))
          throw new Error('LRCLIB search response is not a list')
        for (const item of items) {
          const synced = consider(item)
          if (synced) return synced
        }
        if (plain) return plain
      }
    }
  } catch (error) {
    if (
      !plain ||
      !reportError ||
      signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw error
    reportError(error)
  }
  return plain
}
