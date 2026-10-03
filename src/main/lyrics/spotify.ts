import { createHmac } from 'node:crypto'
import { type HttpClient, HttpError } from '../net/http'
import { formatLrcLine, isZeroTimestampOnlyLrc } from './lrc'
import type { LyricsQuery } from './types'

const WEB = 'https://open.spotify.com'
const SECRETS =
  'https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json'
const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query'
const SEARCH_HASH =
  'd9f785900f0710b31c07818d617f4f7600c1e21217e80f5b043d1e78d74e6026'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const SECRET_TTL_MS = 60 * 60 * 1000

export function generateTotp(
  timestampSeconds: number,
  secretBytes: number[]
): string {
  const secret = Buffer.from(
    secretBytes
      .map((value, index) => String(value ^ ((index % 33) + 9)))
      .join(''),
    'utf8'
  )
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(timestampSeconds / 30)))
  const digest = createHmac('sha1', secret).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(code).padStart(6, '0')
}

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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function createSpotifyClient(http: HttpClient) {
  let clientVersion: string | null = null
  let secret: { version: string; bytes: number[]; fetchedAt: number } | null =
    null
  let token: { value: string; expiresAt: number } | null = null

  async function version(signal?: AbortSignal): Promise<string> {
    if (clientVersion) return clientVersion
    const html = await http.text(WEB, {
      host: 'spotify',
      headers: { 'User-Agent': USER_AGENT },
      signal,
    })
    const encoded =
      /<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/.exec(
        html
      )?.[1]
    if (!encoded)
      throw new Error('Spotify web bootstrap is missing appServerConfig')
    const value = record(
      JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    ).clientVersion
    if (typeof value !== 'string' || !value)
      throw new Error('Spotify web bootstrap is missing clientVersion')
    clientVersion = value
    return value
  }

  async function latestSecret(signal?: AbortSignal) {
    if (secret && Date.now() - secret.fetchedAt < SECRET_TTL_MS) return secret
    const payload = record(
      await http.json(SECRETS, {
        host: 'spotify',
        headers: { 'User-Agent': USER_AGENT },
        signal,
      })
    )
    const version = Object.keys(payload)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(b) - Number(a))[0]
    const bytes = payload[version]
    if (
      !version ||
      !Array.isArray(bytes) ||
      !bytes.length ||
      !bytes.every((value) => Number.isInteger(value))
    ) {
      throw new Error(
        'Spotify secret response did not contain any valid versions'
      )
    }
    secret = { version, bytes: bytes as number[], fetchedAt: Date.now() }
    return secret
  }

  async function accessToken(signal?: AbortSignal): Promise<string> {
    if (token && token.expiresAt - Date.now() > 60_000) return token.value
    const currentSecret = await latestSecret(signal)
    const time = record(
      await http.json(`${WEB}/api/server-time`, {
        host: 'spotify',
        headers: { Origin: WEB, Referer: `${WEB}/`, 'User-Agent': USER_AGENT },
        signal,
      })
    ).serverTime
    if (
      !(typeof time === 'number' || typeof time === 'string') ||
      !/^\d+$/.test(String(time))
    )
      throw new Error(
        'Spotify server time response did not include a numeric serverTime'
      )
    const totp = generateTotp(Number(time), currentSecret.bytes)
    const url = new URL(`${WEB}/api/token`)
    for (const [key, value] of Object.entries({
      reason: 'init',
      productType: 'web-player',
      totp,
      totpServer: totp,
      totpVer: currentSecret.version,
    }))
      url.searchParams.set(key, value)
    const payload = record(
      await http.json(url.toString(), {
        host: 'spotify',
        headers: {
          Accept: 'application/json',
          Origin: WEB,
          Referer: `${WEB}/`,
          'User-Agent': USER_AGENT,
        },
        signal,
      })
    )
    if (
      typeof payload.accessToken !== 'string' ||
      typeof payload.accessTokenExpirationTimestampMs !== 'number'
    )
      throw new Error(
        'Spotify anonymous token response is missing access token fields'
      )
    token = {
      value: payload.accessToken,
      expiresAt: payload.accessTokenExpirationTimestampMs,
    }
    return token.value
  }

  async function search(
    query: LyricsQuery,
    signal?: AbortSignal
  ): Promise<string | null> {
    const clientVersion = await version(signal)
    const queryText = [
      query.title,
      query.artists.map((artist) => artist.name).join(', '),
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
    if (!queryText) return null
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
      extensions: { persistedQuery: { version: 1, sha256Hash: SEARCH_HASH } },
    })
    async function send(): Promise<Response> {
      const access = await accessToken(signal)
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
      token = null
      response = await send()
    }
    const payload = record(await response.json())
    const items = record(record(record(payload.data).searchV2).tracksV2).items
    if (!Array.isArray(items)) return null
    let bestId: string | null = null
    let bestScore = 0
    const source = {
      title: query.title,
      artist: query.artists.map((artist) => artist.name).join(', '),
      durationSeconds: query.durationSeconds,
    }
    for (const item of items) {
      const track = record(record(record(item).item).data)
      const uri = track.uri
      if (typeof uri !== 'string' || !uri.startsWith('spotify:track:')) continue
      const name = track.name
      const artists = record(track.artists).items
      if (typeof name !== 'string' || !name || !Array.isArray(artists)) continue
      const names = artists
        .map((artist) => record(record(artist).profile).name)
        .filter((value): value is string => typeof value === 'string')
      if (!names.length) continue
      const durationMs = Number(record(track.duration).totalMilliseconds) || 0
      const score = candidateScore(source, { name, artists: names, durationMs })
      if (score > bestScore) {
        bestScore = score
        bestId = uri.split(':').at(-1) ?? null
      }
    }
    return bestScore >= 0.6 ? bestId : null
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
    if (!Array.isArray(payload.lines)) return null
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
