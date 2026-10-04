import { type HttpClient, HttpError } from '../net/http'
import { createSpotifyToken, record, USER_AGENT, WEB } from '../spotify/token'

export { generateTotp } from '../spotify/token'

const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query'
const SEARCH_HASH =
  'd9f785900f0710b31c07818d617f4f7600c1e21217e80f5b043d1e78d74e6026'

import { formatLrcLine, isZeroTimestampOnlyLrc } from './lrc'
import {
  durationMatches,
  type LyricsLookup,
  sameVersion,
  titleMatches,
} from './query'

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  )
}

function jaccard(left: string, right: string): number {
  const a = tokenize(left)
  const b = tokenize(right)
  if (!a.size || !b.size) return 0
  let overlap = 0
  for (const token of a) if (b.has(token)) overlap++
  return overlap / (a.size + b.size - overlap)
}

export function candidateScore(
  source: { title: string; artist: string; durationSeconds: number | null },
  candidate: { name: string; artists: string[]; durationMs: number }
): number {
  const duration =
    !source.durationSeconds || candidate.durationMs <= 0
      ? 0.5
      : Math.max(
          0,
          1 -
            Math.abs(source.durationSeconds * 1000 - candidate.durationMs) /
              15000
        )
  return (
    Math.round(
      (jaccard(source.title, candidate.name) * 0.55 +
        jaccard(source.artist, candidate.artists.join(' ')) * 0.35 +
        duration * 0.1) *
        10000
    ) / 10000
  )
}

export function createSpotifyClient(http: HttpClient) {
  const token = createSpotifyToken(http)
  async function search(
    query: LyricsLookup,
    signal?: AbortSignal,
    excludeId: string | null = null
  ): Promise<string | null> {
    const clientVersion = await token.version(signal)
    for (const title of query.titles) {
      for (const artist of query.artistNames) {
        const queryText = `${title} ${artist}`.trim()
        if (!queryText) continue
        const body = JSON.stringify({
          operationName: 'searchDesktop',
          variables: {
            searchTerm: queryText,
            offset: 0,
            limit: 10,
            numberOfTopResults: 5,
            includeAudiobooks: false,
            includeArtistHasConcertsField: true,
            includePreReleases: true,
            includeLocalConcertsField: false,
            includeAuthors: true,
          },
          extensions: {
            persistedQuery: { version: 1, sha256Hash: SEARCH_HASH },
          },
        })
        async function send(): Promise<Response> {
          const access = (await token.accessToken(signal)).value
          return http.request(PATHFINDER, {
            host: 'spotify',
            method: 'POST',
            retryable: true,
            body,
            signal,
            headers: {
              Accept: 'application/json',
              'Accept-Language': 'en',
              'App-Platform': 'WebPlayer',
              Authorization: `Bearer ${access}`,
              'Content-Type': 'application/json;charset=UTF-8',
              Origin: WEB,
              Referer: `${WEB}/`,
              'Spotify-App-Version': clientVersion,
              'User-Agent': USER_AGENT,
            },
          })
        }
        let response: Response
        try {
          response = await send()
        } catch (error) {
          if (
            !(
              error &&
              typeof error === 'object' &&
              'status' in error &&
              error.status === 401
            )
          )
            throw error
          token.invalidate()
          response = await send()
        }
        const payload = record(await response.json())
        if (Array.isArray(payload.errors) && payload.errors.length)
          throw new Error(
            `Spotify search errors: ${JSON.stringify(payload.errors)}`
          )
        const items = record(
          record(record(payload.data).searchV2).tracksV2
        ).items
        if (!Array.isArray(items))
          throw new Error('Spotify search response is missing tracks')
        let bestId: string | null = null
        let bestScore = 0
        const source = {
          title,
          artist,
          durationSeconds: query.durationSeconds,
        }
        for (const item of items) {
          const track = record(record(record(item).item).data)
          const uri = track.uri
          if (typeof uri !== 'string' || !uri.startsWith('spotify:track:'))
            continue
          const name = track.name
          const artists = record(track.artists).items
          if (typeof name !== 'string' || !name || !Array.isArray(artists))
            continue
          const names = artists
            .map((artist) => record(record(artist).profile).name)
            .filter((value): value is string => typeof value === 'string')
          if (!names.length) continue
          const durationMs =
            Number(record(track.duration).totalMilliseconds) || 0
          if (
            uri.split(':').at(-1) === excludeId ||
            (excludeId !== null && !titleMatches(query, name)) ||
            !sameVersion(query, name) ||
            !durationMatches(query, durationMs / 1000)
          )
            continue
          const score = candidateScore(source, {
            name,
            artists: names,
            durationMs,
          })
          if (score > bestScore) {
            bestScore = score
            bestId = uri.split(':').at(-1) ?? null
          }
        }
        if (bestScore >= 0.6 && bestId) return bestId
      }
    }
    return null
  }

  async function lyrics(
    trackId: string,
    serverUrl: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const url = new URL(serverUrl)
    url.searchParams.set('trackid', trackId)
    url.searchParams.set('format', 'lrc')
    let payload: Record<string, unknown>
    try {
      payload = record(
        await http.json(url.toString(), { host: 'lyrics-server', signal })
      )
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null
      throw error
    }
    if (payload.error || payload.errors || payload.success === false)
      throw new Error(`Spotify lyrics error: ${JSON.stringify(payload)}`)
    if (!Array.isArray(payload.lines))
      throw new Error('Spotify lyrics response is missing lines')
    const synced: string[] = []
    const plain: string[] = []
    for (const raw of payload.lines) {
      const line = record(raw)
      if (typeof line.words !== 'string' || !line.words.trim()) continue
      const words = line.words.trim()
      plain.push(words)
      if (typeof line.timeTag === 'string' && line.timeTag.trim())
        synced.push(`[${line.timeTag.trim().replace(/^\[|\]$/g, '')}]${words}`)
      else if (
        typeof line.startTimeMs === 'string' &&
        /^\d+$/.test(line.startTimeMs.trim())
      )
        synced.push(formatLrcLine(Number(line.startTimeMs.trim()), words))
    }
    const syncedText = synced.join('\n')
    if (syncedText && !isZeroTimestampOnlyLrc(syncedText)) return syncedText
    return plain.length ? plain.join('\n') : null
  }

  return { search, lyrics }
}
