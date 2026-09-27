/**
 * Request scheduler: the single place for per-host pacing, timeouts,
 * Retry-After handling, and transient/permanent error classification.
 * Catalog, matcher, and lyrics code send every request through an HttpClient.
 */

export type HostPolicyName =
  | 'youtube-music'
  | 'musicbrainz'
  | 'lrclib'
  | 'spotify'
  | 'lyrics-server'
  | 'youtube'
  | 'images'

interface HostPolicy {
  /** Minimum milliseconds between request starts for this host. */
  minIntervalMs: number
  timeoutMs: number
}

const POLICIES: Record<HostPolicyName, HostPolicy> = {
  'youtube-music': { minIntervalMs: 250, timeoutMs: 20_000 },
  musicbrainz: { minIntervalMs: 1_100, timeoutMs: 15_000 },
  lrclib: { minIntervalMs: 200, timeoutMs: 15_000 },
  spotify: { minIntervalMs: 300, timeoutMs: 15_000 },
  'lyrics-server': { minIntervalMs: 200, timeoutMs: 15_000 },
  youtube: { minIntervalMs: 200, timeoutMs: 15_000 },
  images: { minIntervalMs: 0, timeoutMs: 30_000 },
}

export type ErrorKind = 'transient' | 'permanent'

export class HttpError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface RequestOptions extends Omit<RequestInit, 'signal'> {
  host: HostPolicyName
  signal?: AbortSignal
}

export interface HttpClient {
  request(url: string, options: RequestOptions): Promise<Response>
  json<T = unknown>(url: string, options: RequestOptions): Promise<T>
  text(url: string, options: RequestOptions): Promise<string>
  bytes(url: string, options: RequestOptions): Promise<Uint8Array>
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function classifyStatus(status: number): ErrorKind {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return 'transient'
  }
  return 'permanent'
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now())
}

export function createHttpClient(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): HttpClient {
  const nextSlot = new Map<HostPolicyName, number>()
  const blockedUntil = new Map<HostPolicyName, number>()

  async function waitForSlot(host: HostPolicyName) {
    const policy = POLICIES[host]
    const current = now()
    const slot = Math.max(
      nextSlot.get(host) ?? 0,
      blockedUntil.get(host) ?? 0,
      current
    )
    nextSlot.set(host, slot + policy.minIntervalMs)
    if (slot > current) await sleep(slot - current)
  }

  /**
   * Sends a request and reads its body with `read`. The timeout and the
   * caller's abort signal stay active until the body is read, so a quit or a
   * stalled server can always interrupt a large download.
   */
  async function send<T>(
    url: string,
    options: RequestOptions,
    read: (response: Response) => Promise<T>
  ): Promise<T> {
    const { host, signal, ...init } = options
    await waitForSlot(host)
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new Error('timeout')),
      POLICIES[host].timeoutMs
    )
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let response: Response
      try {
        response = await fetchImpl(url, { ...init, signal: controller.signal })
      } catch (error) {
        if (signal?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw new HttpError(`${host}: ${message}`, 'transient', null)
      }
      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(
          response.headers.get('retry-after')
        )
        if (retryAfterMs !== null) blockedUntil.set(host, now() + retryAfterMs)
        throw new HttpError(
          `${host}: HTTP ${response.status} for ${new URL(url).pathname}`,
          classifyStatus(response.status),
          response.status,
          retryAfterMs
        )
      }
      try {
        return await read(response)
      } catch (error) {
        if (signal?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw new HttpError(`${host}: ${message}`, 'transient', null)
      }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    // The caller reads the body itself; buffer it here so the timeout still covers it.
    request: (url, options) =>
      send(url, options, async (response) => {
        const body = await response.arrayBuffer()
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        })
      }),
    json: <T>(url: string, options: RequestOptions) =>
      send(url, options, async (response) => (await response.json()) as T),
    text: (url, options) => send(url, options, (response) => response.text()),
    bytes: (url, options) =>
      send(
        url,
        options,
        async (response) => new Uint8Array(await response.arrayBuffer())
      ),
  }
}

export function errorKindOf(error: unknown): ErrorKind {
  if (error instanceof HttpError) return error.kind
  if (error && typeof error === 'object' && 'kind' in error) {
    const kind = (error as { kind: unknown }).kind
    if (kind === 'transient' || kind === 'permanent') return kind
  }
  return 'transient'
}
