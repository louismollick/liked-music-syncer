import { createHmac } from 'node:crypto'
import type { HttpClient } from '../net/http'

export const WEB = 'https://open.spotify.com'
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const SECRETS =
  'https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json'
const SECRET_TTL_MS = 60 * 60 * 1000

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export class SpotifyAuthError extends Error {
  readonly kind = 'permanent' as const
}
interface SpotifyToken {
  value: string
  expiresAt: number
  clientId: string | null
}

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

/** Each client owns its token cache; signed-in cookies never reach the lyrics client. */
export function createSpotifyToken(
  http: HttpClient,
  options: {
    cookies?: () => Promise<string>
    userAgent?: string
    onExpired?: () => void
  } = {}
) {
  let clientVersion: string | null = null
  let secret: { version: string; bytes: number[]; fetchedAt: number } | null =
    null
  let token: SpotifyToken | null = null
  async function version(signal?: AbortSignal): Promise<string> {
    if (clientVersion) return clientVersion
    const html = await http.text(WEB, {
      host: 'spotify',
      headers: { 'User-Agent': options.userAgent ?? USER_AGENT },
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
        headers: { 'User-Agent': options.userAgent ?? USER_AGENT },
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

  async function accessToken(signal?: AbortSignal): Promise<SpotifyToken> {
    if (token && token.expiresAt - Date.now() > 60_000) return token
    const currentSecret = await latestSecret(signal)
    const time = record(
      await http.json(`${WEB}/api/server-time`, {
        host: 'spotify',
        headers: {
          Origin: WEB,
          Referer: `${WEB}/`,
          'User-Agent': options.userAgent ?? USER_AGENT,
        },
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
      reason: options.cookies ? 'transport' : 'init',
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
          'User-Agent': options.userAgent ?? USER_AGENT,
          ...(options.cookies ? { Cookie: await options.cookies() } : {}),
        },
        signal,
      })
    )
    if (options.cookies && payload.isAnonymous !== false) {
      options.onExpired?.()
      throw new SpotifyAuthError(
        'Your Spotify session has expired. Sign in again.'
      )
    }
    if (
      typeof payload.accessToken !== 'string' ||
      typeof payload.accessTokenExpirationTimestampMs !== 'number'
    )
      throw new Error('Spotify token response is missing access token fields')
    token = {
      value: payload.accessToken,
      expiresAt: payload.accessTokenExpirationTimestampMs,
      clientId: typeof payload.clientId === 'string' ? payload.clientId : null,
    }
    return token
  }

  return {
    accessToken,
    version,
    invalidate: () => {
      token = null
    },
  }
}
