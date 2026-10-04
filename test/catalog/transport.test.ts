import { describe, expect, it } from 'vitest'
import {
  answeredSignedOut,
  createInnertubeTransport,
  SignedOutError,
} from '../../src/main/catalog/transport'
import { createHttpClient } from '../../src/main/net/http'
import { parseSetCookie } from '../../src/main/session/headers'

function tracking(loggedIn: '0' | '1') {
  return {
    responseContext: {
      serviceTrackingParams: [
        {
          service: 'GFEEDBACK',
          params: [{ key: 'logged_in', value: loggedIn }],
        },
      ],
    },
  }
}

function transportAnswering(
  body: unknown,
  setCookie: string[] = []
): {
  transport: ReturnType<typeof createInnertubeTransport>
  stored: string[][]
  signedOut: number[]
} {
  const stored: string[][] = []
  const signedOut: number[] = []
  const http = createHttpClient(async () => {
    const headers = new Headers({ 'content-type': 'application/json' })
    for (const value of setCookie) headers.append('set-cookie', value)
    return new Response(JSON.stringify(body), { status: 200, headers })
  })
  const transport = createInnertubeTransport({
    http,
    auth: {
      headers: async () => ({ cookie: 'SAPISID=x' }),
      storeCookies: async (values) => {
        stored.push(values)
      },
      signedOut: () => signedOut.push(1),
    },
  })
  return { transport, stored, signedOut }
}

describe('Innertube transport sessions', () => {
  it('overrides the language for one page without changing later calls', async () => {
    const languages: string[] = []
    const http = createHttpClient(async (_url, init) => {
      languages.push(JSON.parse(String(init?.body)).context.client.hl)
      return Response.json({})
    })
    const transport = createInnertubeTransport({ http, auth: null })
    for (const language of [undefined, 'ja', undefined])
      await transport.call({
        endpoint: 'browse',
        body: {},
        authenticated: false,
        language,
      })
    expect(languages).toEqual(['en', 'ja', 'en'])
  })

  it('reads official audio playlists from regular YouTube without session headers', async () => {
    let calls = 0
    const http = createHttpClient(async (url, init) => {
      calls++
      expect(new URL(url).origin).toBe('https://www.youtube.com')
      expect(new Headers(init?.headers).get('cookie')).toBeNull()
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      const body = JSON.parse(String(init?.body))
      expect(body.context.client.clientName).toBe('WEB')
      expect(body.context.client.clientVersion).toMatch(/^2\./)
      return Response.json({})
    })
    const transport = createInnertubeTransport({
      http,
      auth: {
        headers: async () => {
          throw new Error('Should not request session headers')
        },
      },
    })
    await transport.call({
      endpoint: 'browse',
      body: { browseId: 'VLOLAK_test' },
      authenticated: false,
      client: 'WEB',
    })
    await expect(
      transport.call({
        endpoint: 'browse',
        body: {},
        authenticated: true,
        client: 'WEB',
      })
    ).rejects.toThrow('Only WEB_REMIX')
    expect(calls).toBe(1)
  })

  it('retries a temporary failure from a read-only Innertube POST', async () => {
    let calls = 0
    let time = 0
    const http = createHttpClient(
      async () =>
        ++calls === 1
          ? new Response(null, { status: 503 })
          : Response.json({ catalog: 'available' }),
      () => time,
      async (ms) => {
        time += ms
      }
    )
    const transport = createInnertubeTransport({ http, auth: null })
    await expect(
      transport.call({
        endpoint: 'browse',
        body: { browseId: 'MPRE_album' },
        authenticated: false,
      })
    ).resolves.toEqual({ catalog: 'available' })
    expect(calls).toBe(2)
  })
  it('recognizes a signed-out answer', () => {
    expect(answeredSignedOut(tracking('0'))).toBe(true)
    expect(answeredSignedOut(tracking('1'))).toBe(false)
    expect(answeredSignedOut({})).toBe(false)
  })

  it('reports an expired session instead of a shape error', async () => {
    const { transport, signedOut } = transportAnswering(tracking('0'))
    await expect(
      transport.call({ endpoint: 'browse', body: {}, authenticated: true })
    ).rejects.toBeInstanceOf(SignedOutError)
    expect(signedOut).toHaveLength(1)
  })

  it('does not treat a public read as an expired session', async () => {
    const { transport, signedOut } = transportAnswering(tracking('0'))
    await expect(
      transport.call({ endpoint: 'browse', body: {}, authenticated: false })
    ).resolves.toEqual(tracking('0'))
    expect(signedOut).toHaveLength(0)
  })

  it('hands refreshed cookies from signed answers to the session', async () => {
    const { transport, stored } = transportAnswering(tracking('1'), [
      '__Secure-1PSIDTS=new; Domain=.youtube.com; Path=/; Secure; HttpOnly',
      'SIDCC=abc; Domain=.youtube.com; Path=/',
    ])
    await transport.call({ endpoint: 'browse', body: {}, authenticated: true })
    expect(stored).toEqual([
      [
        '__Secure-1PSIDTS=new; Domain=.youtube.com; Path=/; Secure; HttpOnly',
        'SIDCC=abc; Domain=.youtube.com; Path=/',
      ],
    ])
  })

  it('parses Set-Cookie attributes', () => {
    const now = Date.parse('2026-09-26T00:00:00Z')
    expect(
      parseSetCookie(
        '__Secure-3PSIDCC=a=b; expires=Sun, 26-Sep-2027 00:00:00 GMT; path=/; domain=.youtube.com; Secure; HttpOnly; priority=high; SameSite=none',
        now
      )
    ).toEqual({
      name: '__Secure-3PSIDCC',
      value: 'a=b',
      domain: '.youtube.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: Date.parse('2027-09-26T00:00:00Z') / 1000,
      sameSite: 'no_restriction',
    })
    expect(parseSetCookie('YSC=x; Max-Age=60', now)?.expirationDate).toBe(
      now / 1000 + 60
    )
    expect(parseSetCookie('no-equals-sign', now)).toBeNull()
  })
})
