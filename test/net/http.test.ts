import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  createHttpClient,
  type FetchLike,
  HttpError,
} from '../../src/main/net/http'

function clocked(fetch: FetchLike) {
  let time = 0
  const waits: number[] = []
  const http = createHttpClient(
    fetch,
    () => time,
    async (ms) => {
      waits.push(ms)
      time += ms
    }
  )
  return { http, waits, time: () => time }
}

describe('metadata HTTP retries', () => {
  it('backs off after temporary failure and returns a successful retry', async () => {
    let calls = 0
    const { http, waits } = clocked(async () =>
      ++calls === 1
        ? new Response(null, { status: 503 })
        : Response.json({ found: true })
    )
    await expect(
      http.json('https://lrclib.net/api/get', { host: 'lrclib' })
    ).resolves.toEqual({ found: true })
    expect(calls).toBe(2)
    expect(waits).toEqual([1000])
  })

  it('stops after three attempts, including network failures', async () => {
    let calls = 0
    const { http, waits } = clocked(async () => {
      calls++
      throw new Error('network unavailable')
    })
    await expect(
      http.json('https://musicbrainz.org/ws/2/recording/', {
        host: 'musicbrainz',
      })
    ).rejects.toMatchObject({ kind: 'transient', status: null })
    expect(calls).toBe(3)
    expect(waits).toEqual([1000, 100, 3000])
  })

  it('honors Retry-After in addition to backoff', async () => {
    let calls = 0
    const { http, time } = clocked(async () =>
      ++calls === 1
        ? new Response(null, { status: 429, headers: { 'retry-after': '5' } })
        : Response.json({})
    )
    await http.json('https://lrclib.net/api/get', { host: 'lrclib' })
    expect(time()).toBe(5000)
    expect(calls).toBe(2)
  })

  it('returns promptly for a long Retry-After while preserving the host cooldown', async () => {
    let calls = 0
    const { http, waits } = clocked(async () => {
      calls++
      return new Response(null, {
        status: 429,
        headers: { 'retry-after': '86400' },
      })
    })
    await expect(
      http.json('https://lrclib.net/api/get', { host: 'lrclib' })
    ).rejects.toMatchObject({
      kind: 'transient',
      status: 429,
      retryAfterMs: 86_400_000,
    })
    await expect(
      http.json('https://lrclib.net/api/search', { host: 'lrclib' })
    ).rejects.toMatchObject({ kind: 'transient', retryAfterMs: 86_400_000 })
    expect(calls).toBe(1)
    expect(waits).toEqual([])
  })

  it.each([
    400, 401, 404,
  ])('does not retry a permanent %s response', async (status) => {
    let calls = 0
    const { http, waits } = clocked(async () => {
      calls++
      return new Response(null, { status })
    })
    await expect(
      http.json('https://lyrics.example/', { host: 'lyrics-server' })
    ).rejects.toMatchObject({ status, kind: 'permanent' })
    expect(calls).toBe(1)
    expect(waits).toEqual([])
  })

  it('does not replay POSTs that were not explicitly marked read-only', async () => {
    let calls = 0
    const { http, waits } = clocked(async () => {
      calls++
      return new Response(null, { status: 503 })
    })
    await expect(
      http.json('https://lrclib.net/api/publish', {
        host: 'lrclib',
        method: 'POST',
        body: '{}',
      })
    ).rejects.toBeInstanceOf(HttpError)
    await expect(
      http.json('https://music.youtube.com/youtubei/v1/browse', {
        host: 'youtube-music',
        method: 'POST',
        body: '{}',
      })
    ).rejects.toBeInstanceOf(HttpError)
    expect(calls).toBe(2)
    expect(waits).toEqual([])
  })

  it('retries read-only POSTs with their original request body', async () => {
    let calls = 0
    const { http } = clocked(async (_url, init) => {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe('{"browseId":"VLOLAK_test"}')
      expect(init).not.toHaveProperty('retryable')
      return ++calls < 3
        ? new Response(null, { status: 503 })
        : Response.json({ found: true })
    })
    await expect(
      http.json('https://www.youtube.com/youtubei/v1/browse', {
        host: 'youtube-music',
        method: 'POST',
        body: '{"browseId":"VLOLAK_test"}',
        retryable: true,
      })
    ).resolves.toEqual({ found: true })
    expect(calls).toBe(3)
  })

  it('cancels backoff before another request starts', async () => {
    const controller = new AbortController()
    let calls = 0
    const http = createHttpClient(
      async () => {
        calls++
        return new Response(null, { status: 503 })
      },
      Date.now,
      async (ms, signal) => {
        controller.abort(new Error('stopped'))
        await delay(ms, undefined, { signal })
      }
    )
    await expect(
      http.json('https://lrclib.net/api/get', {
        host: 'lrclib',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(1)
  })

  it('does not fetch when the caller has already aborted', async () => {
    let calls = 0
    const { http } = clocked(async () => {
      calls++
      return Response.json({})
    })
    await expect(
      http.json('https://lrclib.net/api/get', {
        host: 'lrclib',
        signal: AbortSignal.abort(new Error('stopped')),
      })
    ).rejects.toThrow('stopped')
    expect(calls).toBe(0)
  })
})
