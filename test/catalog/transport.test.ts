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
