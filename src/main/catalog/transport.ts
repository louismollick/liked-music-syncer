import type { HttpClient } from '../net/http'
import type {
  InnertubeClientName,
  InnertubeRequest,
  InnertubeTransport,
} from './types'

export const YTM_ORIGIN = 'https://music.youtube.com'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

function webRemixVersion(date = new Date()): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `1.${y}${m}${d}.01.00`
}

function clientContext(name: InnertubeClientName) {
  if (name === 'ANDROID_MUSIC') {
    return { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50' }
  }
  return {
    clientName: name,
    clientVersion:
      name === 'WEB'
        ? webRemixVersion().replace(/^1\./, '2.')
        : webRemixVersion(),
  }
}

export interface AuthHeaderSource {
  /** Cookie, Authorization (SAPISIDHASH), and X-Goog-AuthUser for the selected account. */
  headers(): Promise<Record<string, string>>
  /** Google refreshes session cookies in responses; keep them like a browser would. */
  storeCookies?(setCookie: string[]): Promise<void>
  /** A signed request came back signed out: the Google Session has expired. */
  signedOut?(): void
}

/** A signed request was answered as signed out (expired or revoked session). */
export class SignedOutError extends Error {
  readonly kind = 'permanent'
  constructor() {
    super('Your Google session has expired. Sign in again in Settings.')
  }
}

/** Innertube reports `logged_in: "0"` in its tracking params for signed-out answers. */
export function answeredSignedOut(response: unknown): boolean {
  const params = (
    response as {
      responseContext?: {
        serviceTrackingParams?: Array<{
          params?: Array<{ key?: string; value?: string }>
        }>
      }
    }
  )?.responseContext?.serviceTrackingParams
  if (!Array.isArray(params)) return false
  return params.some((service) =>
    service.params?.some(
      (param) => param.key === 'logged_in' && param.value === '0'
    )
  )
}

export interface TransportOptions {
  http: HttpClient
  auth: AuthHeaderSource | null
  language?: string
  region?: string
}

/**
 * Minimal Innertube transport. Personal reads are signed with the Google
 * Session's headers. WEB and ANDROID_MUSIC calls are public reads only.
 */
export function createInnertubeTransport(
  options: TransportOptions
): InnertubeTransport {
  const hl = options.language ?? 'en'
  const gl = options.region ?? 'US'
  return {
    async call(request: InnertubeRequest) {
      const client = request.client ?? 'WEB_REMIX'
      if (request.authenticated && client !== 'WEB_REMIX')
        throw new Error('Only WEB_REMIX supports signed catalog reads')
      const origin = client === 'WEB' ? 'https://www.youtube.com' : YTM_ORIGIN
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        origin,
        'x-origin': origin,
        'user-agent': USER_AGENT,
      }
      if (request.authenticated) {
        if (!options.auth) throw new Error('Not signed in to YouTube Music')
        Object.assign(headers, await options.auth.headers())
      }
      const body = {
        context: {
          client: { ...clientContext(client), hl: request.language ?? hl, gl },
          user: {},
        },
        ...request.body,
      }
      const url = `${origin}/youtubei/v1/${request.endpoint}?alt=json&prettyPrint=false`
      const init = {
        host: 'youtube-music' as const,
        method: 'POST',
        retryable: true,
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      }
      if (!request.authenticated || !options.auth)
        return options.http.json(url, init)
      const response = await options.http.request(url, init)
      const setCookie = response.headers.getSetCookie()
      if (setCookie.length) await options.auth.storeCookies?.(setCookie)
      const data: unknown = await response.json()
      if (answeredSignedOut(data)) {
        options.auth.signedOut?.()
        throw new SignedOutError()
      }
      return data
    },
  }
}
