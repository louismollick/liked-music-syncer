/**
 * Request scheduler: the single place for per-host pacing, timeouts,
 * Retry-After handling, and transient/permanent error classification.
 * Catalog, matcher, and lyrics code send every request through an HttpClient.
 */

import { setTimeout as delay } from 'node:timers/promises'

export type HostPolicyName =
  | 'youtube-music'
  | 'musicbrainz'
  | 'lrclib'
  | 'petitlyrics'
  | 'spotify'
  | 'lyrics-server'
  | 'youtube'
  | 'images'

interface HostPolicy {
  /** Minimum milliseconds between request starts for this host. */
  minIntervalMs: number
  timeoutMs: number
  /** Retries for read-only metadata requests, after the initial attempt. */
  retryDelaysMs?: readonly number[]
}

const METADATA_RETRIES = [1_000, 3_000] as const
const POLICIES: Record<HostPolicyName, HostPolicy> = {
  'youtube-music': {
    minIntervalMs: 250,
    timeoutMs: 20_000,
    retryDelaysMs: METADATA_RETRIES,
  },
  musicbrainz: {
    minIntervalMs: 1_100,
    timeoutMs: 15_000,
    retryDelaysMs: METADATA_RETRIES,
  },
  lrclib: {
    minIntervalMs: 200,
    timeoutMs: 15_000,
    retryDelaysMs: METADATA_RETRIES,
  },
  petitlyrics: {
    minIntervalMs: 750,
    timeoutMs: 15_000,
    retryDelaysMs: METADATA_RETRIES,
  },
  spotify: {
    minIntervalMs: 300,
    timeoutMs: 15_000,
    retryDelaysMs: METADATA_RETRIES,
  },
  'lyrics-server': {
    minIntervalMs: 200,
    timeoutMs: 15_000,
    retryDelaysMs: METADATA_RETRIES,
  },
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
  /** Explicitly allow replaying a read-only POST with a reusable body. */
  retryable?: boolean
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
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) =>
    delay(ms, undefined, { signal })
): HttpClient {
  const nextSlot = new Map<HostPolicyName, number>()
  const blockedUntil = new Map<HostPolicyName, number>()

  async function waitForSlot(
    host: HostPolicyName,
    deadline: number,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted()
    const policy = POLICIES[host]
    const current = now()
    const slot = Math.max(
      nextSlot.get(host) ?? 0,
      blockedUntil.get(host) ?? 0,
      current
    )
    if (slot >= deadline)
      throw new HttpError(
        `${host}: request pacing exceeds its time budget`,
        'transient',
        null,
        Math.max(0, slot - current)
      )
    nextSlot.set(host, slot + policy.minIntervalMs)
    if (slot > current) await sleep(slot - current, signal)
    signal?.throwIfAborted()
  }

  /**
   * Sends a request and reads its body with `read`. The timeout and the
   * caller's abort signal stay active until the body is read, so a quit or a
   * stalled server can always interrupt a large download.
   */
  async function attempt<T>(
    url: string,
    options: RequestOptions,
    read: (response: Response) => Promise<T>,
    deadline: number
  ): Promise<T> {
    const { host, signal, retryable: _retryable, ...init } = options
    await waitForSlot(host, deadline, signal)
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new Error('timeout')),
      Math.max(1, Math.min(POLICIES[host].timeoutMs, deadline - now()))
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
        void response.body?.cancel().catch(() => {})
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

  async function send<T>(
    url: string,
    options: RequestOptions,
    read: (response: Response) => Promise<T>
  ): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase()
    const retries =
      method === 'GET' || method === 'HEAD' || options.retryable === true
        ? (POLICIES[options.host].retryDelaysMs ?? [])
        : []
    // Bound all attempts, host pacing, and backoff together. A long server
    // cooldown stays recorded, but it must not occupy a reconciliation worker.
    const policy = POLICIES[options.host]
    const deadline =
      now() +
      policy.timeoutMs * (retries.length + 1) +
      retries.reduce((sum, delayMs) => sum + delayMs, 0)
    for (let count = 0; ; count++) {
      try {
        return await attempt(url, options, read, deadline)
      } catch (error) {
        options.signal?.throwIfAborted()
        if (
          !(error instanceof HttpError) ||
          error.kind !== 'transient' ||
          count >= retries.length ||
          Math.max(
            now() + retries[count],
            blockedUntil.get(options.host) ?? 0
          ) >= deadline
        )
          throw error
        await sleep(retries[count], options.signal)
      }
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
