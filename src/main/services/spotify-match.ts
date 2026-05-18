import { createHmac } from 'node:crypto'

const NORMALIZE_PATTERN = /[^\p{L}\p{N}]+/gu
const SPOTIFY_WEB_BASE_URL = 'https://open.spotify.com'
const SPOTIFY_SECRETS_URL =
  'https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json'
const SPOTIFY_PATHFINDER_URL =
  'https://api-partner.spotify.com/pathfinder/v2/query'
const SPOTIFY_SEARCH_QUERY_HASH =
  'd9f785900f0710b31c07818d617f4f7600c1e21217e80f5b043d1e78d74e6026'
const SPOTIFY_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const SECRET_CACHE_TTL_MS = 60 * 60 * 1000

interface SpotifySecretsResponse {
  [version: string]: number[]
}

interface SpotifyTokenResponse {
  accessToken?: string
  accessTokenExpirationTimestampMs?: number
}

interface SpotifyServerTimeResponse {
  serverTime?: number | string
}

interface SpotifyAppServerConfig {
  clientVersion?: string
}

interface SpotifyPathfinderTrackItem {
  item?: {
    data?: {
      uri?: string
      name?: string
      artists?: { items?: Array<{ profile?: { name?: string } }> }
      duration?: { totalMilliseconds?: number }
      albumOfTrack?: { name?: string }
    }
  }
}

interface SpotifyPathfinderSearchResponse {
  data?: {
    searchV2?: {
      tracksV2?: {
        items?: SpotifyPathfinderTrackItem[]
      }
    }
  }
  errors?: Array<{ message?: string }>
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(NORMALIZE_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(value: string) {
  return normalizeText(value)
    .split(' ')
    .map((item) => item.trim())
    .filter(Boolean)
}

function jaccardSimilarity(left: string, right: string) {
  const leftSet = new Set(tokenize(left))
  const rightSet = new Set(tokenize(right))
  if (leftSet.size === 0 || rightSet.size === 0) return 0

  let overlap = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) overlap += 1
  }

  return overlap / (leftSet.size + rightSet.size - overlap)
}

function durationScore(
  sourceDurationSec: number | null,
  trackDurationMs: number
) {
  if (!sourceDurationSec || trackDurationMs <= 0) return 0.5
  const diff = Math.abs(sourceDurationSec * 1000 - trackDurationMs)
  const maxDiff = 15000
  return Math.max(0, 1 - diff / maxDiff)
}

export function calculateSpotifyCandidateScore(
  source: { title: string; artist: string; durationSec: number | null },
  candidate: { name: string; artists: string[]; durationMs: number }
) {
  const title = jaccardSimilarity(source.title, candidate.name)
  const artist = jaccardSimilarity(source.artist, candidate.artists.join(' '))
  const duration = durationScore(
    source.durationSec ?? null,
    candidate.durationMs
  )
  return Number((title * 0.55 + artist * 0.35 + duration * 0.1).toFixed(4))
}

export class SpotifyMatcher {
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0
  private clientVersion: string | null = null
  private secretVersion: string | null = null
  private secretBytes: number[] | null = null
  private secretsFetchedAt = 0

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async matchTrack(
    source: { title: string; artist: string; durationSec: number | null },
    minimumScore: number
  ) {
    const query = [source.title, source.artist].filter(Boolean).join(' ').trim()
    if (!query) {
      return { spotifyTrackId: null, bestScore: 0, candidateCount: 0 }
    }

    const response = await this.fetchPathfinderSearch(query, 10)
    const candidates = (response.data?.searchV2?.tracksV2?.items ?? [])
      .map((item: SpotifyPathfinderTrackItem) => this.toCandidate(item))
      .filter(
        (
          candidate
        ): candidate is {
          trackId: string
          name: string
          artists: string[]
          durationMs: number
          album: string
        } => Boolean(candidate)
      )
      .map((candidate) => ({
        trackId: candidate.trackId,
        score: calculateSpotifyCandidateScore(source, candidate),
      }))
      .sort((left, right) => right.score - left.score)

    const best = candidates[0]

    return {
      spotifyTrackId: best && best.score >= minimumScore ? best.trackId : null,
      bestScore: best?.score ?? 0,
      candidateCount: candidates.length,
    }
  }

  private async fetchPathfinderSearch(
    query: string,
    limit: number,
    allowRetry = true
  ): Promise<SpotifyPathfinderSearchResponse> {
    await this.ensureClientVersion()
    await this.ensureAccessToken()

    const response = await this.fetchImpl(SPOTIFY_PATHFINDER_URL, {
      method: 'POST',
      headers: this.buildSearchHeaders(),
      body: JSON.stringify({
        operationName: 'searchDesktop',
        variables: {
          searchTerm: query,
          offset: 0,
          limit,
          numberOfTopResults: Math.min(limit, 5),
          includeAudiobooks: false,
          includeArtistHasConcertsField: true,
          includePreReleases: true,
          includeLocalConcertsField: false,
          includeAuthors: true,
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: SPOTIFY_SEARCH_QUERY_HASH,
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (response.status === 401 && allowRetry) {
      this.accessToken = null
      this.accessTokenExpiresAt = 0
      return this.fetchPathfinderSearch(query, limit, false)
    }

    if (!response.ok) {
      throw new Error(
        await this.formatFetchError('Spotify search failed', response)
      )
    }

    const payload = (await response.json()) as SpotifyPathfinderSearchResponse
    if (payload.errors?.length) {
      throw new Error(
        payload.errors
          .map((error) => error.message)
          .filter(Boolean)
          .join('; ')
      )
    }

    return payload
  }

  private buildSearchHeaders() {
    if (!this.accessToken) {
      throw new Error('Spotify anonymous access token not initialized')
    }

    return {
      Accept: 'application/json',
      'Accept-Language': 'en',
      'App-Platform': 'WebPlayer',
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json;charset=UTF-8',
      Origin: SPOTIFY_WEB_BASE_URL,
      Referer: `${SPOTIFY_WEB_BASE_URL}/`,
      ...(this.clientVersion
        ? { 'Spotify-App-Version': this.clientVersion }
        : {}),
      'User-Agent': SPOTIFY_USER_AGENT,
    }
  }

  private async ensureClientVersion() {
    if (this.clientVersion) return

    const response = await this.fetchImpl(SPOTIFY_WEB_BASE_URL, {
      headers: { 'User-Agent': SPOTIFY_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(
        await this.formatFetchError('Spotify web bootstrap failed', response)
      )
    }

    const html = await response.text()
    const match = html.match(
      /<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/
    )
    if (!match?.[1]) {
      throw new Error('Spotify web bootstrap is missing appServerConfig')
    }

    const config = JSON.parse(
      Buffer.from(match[1], 'base64').toString('utf8')
    ) as SpotifyAppServerConfig
    if (!config.clientVersion) {
      throw new Error('Spotify web bootstrap is missing clientVersion')
    }

    this.clientVersion = config.clientVersion
  }

  private async ensureAccessToken() {
    if (this.accessToken && this.accessTokenExpiresAt - Date.now() > 60_000) {
      return
    }

    const { version, secretBytes } = await this.getLatestSecrets()
    const serverTime = await this.getServerTime()
    const totp = this.generateTotp(serverTime, secretBytes)
    const target = new URL(`${SPOTIFY_WEB_BASE_URL}/api/token`)
    target.searchParams.set('reason', 'init')
    target.searchParams.set('productType', 'web-player')
    target.searchParams.set('totp', totp)
    target.searchParams.set('totpServer', totp)
    target.searchParams.set('totpVer', version)

    const response = await this.fetchImpl(target, {
      headers: {
        Accept: 'application/json',
        Origin: SPOTIFY_WEB_BASE_URL,
        Referer: `${SPOTIFY_WEB_BASE_URL}/`,
        'User-Agent': SPOTIFY_USER_AGENT,
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(
        await this.formatFetchError(
          'Spotify anonymous token request failed',
          response
        )
      )
    }

    const payload = (await response.json()) as SpotifyTokenResponse
    if (!payload.accessToken || !payload.accessTokenExpirationTimestampMs) {
      throw new Error(
        'Spotify anonymous token response is missing access token fields'
      )
    }

    this.accessToken = payload.accessToken
    this.accessTokenExpiresAt = payload.accessTokenExpirationTimestampMs
  }

  private async getLatestSecrets() {
    if (
      this.secretVersion &&
      this.secretBytes &&
      Date.now() - this.secretsFetchedAt < SECRET_CACHE_TTL_MS
    ) {
      return { version: this.secretVersion, secretBytes: this.secretBytes }
    }

    const response = await this.fetchImpl(SPOTIFY_SECRETS_URL, {
      headers: { 'User-Agent': SPOTIFY_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(
        await this.formatFetchError('Spotify secret fetch failed', response)
      )
    }

    const payload = (await response.json()) as SpotifySecretsResponse
    const version = Object.keys(payload)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)[0]

    if (version === undefined) {
      throw new Error('Spotify secret response did not contain any versions')
    }

    const secretBytes = payload[String(version)]
    if (!Array.isArray(secretBytes) || secretBytes.length === 0) {
      throw new Error(
        `Spotify secret version ${version} did not contain any bytes`
      )
    }

    this.secretVersion = String(version)
    this.secretBytes = secretBytes
    this.secretsFetchedAt = Date.now()

    return { version: this.secretVersion, secretBytes: this.secretBytes }
  }

  private async getServerTime() {
    const response = await this.fetchImpl(
      `${SPOTIFY_WEB_BASE_URL}/api/server-time`,
      {
        headers: {
          Origin: SPOTIFY_WEB_BASE_URL,
          Referer: `${SPOTIFY_WEB_BASE_URL}/`,
          'User-Agent': SPOTIFY_USER_AGENT,
        },
        signal: AbortSignal.timeout(10000),
      }
    )

    if (!response.ok) {
      throw new Error(
        await this.formatFetchError(
          'Spotify server time request failed',
          response
        )
      )
    }

    const payload = (await response.json()) as SpotifyServerTimeResponse
    const serverTime = Number(payload.serverTime)
    if (!Number.isFinite(serverTime)) {
      throw new Error(
        'Spotify server time response did not include a numeric serverTime'
      )
    }

    return serverTime
  }

  private generateTotp(timestampSeconds: number, secretBytes: number[]) {
    const transformed = secretBytes.map(
      (value, index) => value ^ ((index % 33) + 9)
    )
    const joined = transformed.join('')
    const secret = Buffer.from(
      Buffer.from(joined, 'utf8').toString('hex'),
      'hex'
    )
    const counter = Math.floor(timestampSeconds / 30)
    const counterBuffer = Buffer.alloc(8)
    counterBuffer.writeBigUInt64BE(BigInt(counter))

    const hmac = createHmac('sha1', secret).update(counterBuffer).digest()
    const lastByte = hmac.at(-1)
    if (lastByte === undefined) {
      throw new Error('Spotify TOTP calculation produced an empty HMAC digest')
    }

    const offset = lastByte & 0x0f
    if (offset > hmac.length - 4) {
      throw new Error(
        'Spotify TOTP calculation produced an invalid HMAC offset'
      )
    }

    const code = hmac.readUInt32BE(offset) & 0x7fffffff
    return String(code % 1_000_000).padStart(6, '0')
  }

  private toCandidate(item: SpotifyPathfinderTrackItem) {
    const track = item.item?.data
    const trackId = track?.uri ? this.extractTrackId(track.uri) : null
    const name = track?.name?.trim()
    const artists = track?.artists?.items
      ?.map((artist) => artist.profile?.name?.trim())
      .filter((artist): artist is string => Boolean(artist))
    const durationMs = track?.duration?.totalMilliseconds

    if (
      !trackId ||
      !name ||
      !artists?.length ||
      typeof durationMs !== 'number'
    ) {
      return null
    }

    return {
      trackId,
      name,
      artists,
      durationMs,
      album: track?.albumOfTrack?.name?.trim() || '',
    }
  }

  private extractTrackId(uri: string) {
    const parts = uri.split(':')
    return parts.length === 3 && parts[1] === 'track' ? parts[2] || null : null
  }

  private async formatFetchError(prefix: string, response: Response) {
    const body = (await response.text()).trim()
    return body
      ? `${prefix}: ${response.status} ${body}`
      : `${prefix}: ${response.status}`
  }
}
