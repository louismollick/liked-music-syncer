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
