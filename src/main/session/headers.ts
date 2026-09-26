import { createHash } from 'node:crypto'

export const YTM_ORIGIN = 'https://music.youtube.com'

export interface SimpleCookie {
  name: string
  value: string
  domain?: string
}

/** Builds a Cookie header, preferring the most specific domain for duplicate names. */
export function cookieHeader(cookies: SimpleCookie[]): string {
  const byName = new Map<string, SimpleCookie>()
  for (const cookie of cookies) {
    const existing = byName.get(cookie.name)
    const specificity = (c: SimpleCookie) =>
      (c.domain ?? '').replace(/^\./, '').length
    if (!existing || specificity(cookie) > specificity(existing))
      byName.set(cookie.name, cookie)
  }
  return [...byName.values()].map((c) => `${c.name}=${c.value}`).join('; ')
}

export interface ParsedSetCookie {
  name: string
  value: string
  domain: string | null
  path: string
  secure: boolean
  httpOnly: boolean
  /** Seconds since the epoch; null for a session cookie. */
  expirationDate: number | null
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified'
}

/** Parses one Set-Cookie header value (RFC 6265 attributes Google uses). */
export function parseSetCookie(
  header: string,
  nowMs = Date.now()
): ParsedSetCookie | null {
  const [pair, ...attributes] = header.split(';')
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const cookie: ParsedSetCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: null,
    path: '/',
    secure: false,
    httpOnly: false,
    expirationDate: null,
    sameSite: 'unspecified',
  }
  let maxAge: number | null = null
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=')
    const key = rawKey.trim().toLowerCase()
    const value = rest.join('=').trim()
    if (key === 'domain' && value) cookie.domain = value
    else if (key === 'path' && value) cookie.path = value
    else if (key === 'secure') cookie.secure = true
    else if (key === 'httponly') cookie.httpOnly = true
    else if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value)
    else if (key === 'expires') {
      const at = Date.parse(value)
      if (!Number.isNaN(at)) cookie.expirationDate = Math.floor(at / 1000)
    } else if (key === 'samesite') {
      const mode = value.toLowerCase()
      cookie.sameSite =
        mode === 'none'
          ? 'no_restriction'
          : mode === 'lax'
            ? 'lax'
            : mode === 'strict'
              ? 'strict'
              : 'unspecified'
    }
  }
  // Max-Age wins over Expires.
  if (maxAge !== null) cookie.expirationDate = Math.floor(nowMs / 1000) + maxAge
  return cookie
}

export function sapisidFrom(cookies: SimpleCookie[]): string | null {
  const find = (name: string) =>
    cookies.find((cookie) => cookie.name === name)?.value
  return find('__Secure-3PAPISID') ?? find('SAPISID') ?? null
}

export function sapisidHash(
  sapisid: string,
  nowSeconds: number,
  origin = YTM_ORIGIN
): string {
  const digest = createHash('sha1')
    .update(`${nowSeconds} ${sapisid} ${origin}`)
    .digest('hex')
  return `SAPISIDHASH ${nowSeconds}_${digest}`
}

export interface ParsedAccount {
  name: string
  handle: string | null
  channelId: string | null
  photoUrl: string | null
}

/** Reads the account shown by `account/account_menu` for one X-Goog-AuthUser slot. */
export function parseAccountMenu(response: unknown): ParsedAccount | null {
  const text = JSON.stringify(response ?? {})
  const name = text.match(
    /"accountName":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/
  )?.[1]
  if (!name) return null
  const handle =
    text.match(
      /"channelHandle":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/
    )?.[1] ?? null
  const channelId = text.match(/"browseId":"(UC[\w-]{22})"/)?.[1] ?? null
  const photos = [
    ...text.matchAll(/"url":"(https:\/\/yt\d\.ggpht\.com\/[^"]+)"/g),
  ].map((m) => m[1])
  return {
    name: JSON.parse(`"${name}"`) as string,
    handle: handle ? (JSON.parse(`"${handle}"`) as string) : null,
    channelId,
    photoUrl: photos.at(-1) ?? null,
  }
}
