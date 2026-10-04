import { randomUUID } from 'node:crypto'
import { type HttpClient, HttpError } from '../net/http'
import { type createSpotifyToken, record, USER_AGENT, WEB } from './token'

const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query'
const LIBRARY_HASH =
  '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240'

export interface SpotifyLikedTrack {
  trackId: string
  title: string
  artists: { id: string; name: string }[]
  album: { id: string; name: string }
  trackNumber: number | null
  durationMs: number
  addedAt: string
  position: number
}
export interface SpotifyLibrary {
  likedSongs(
    signal?: AbortSignal
  ): Promise<{ tracks: SpotifyLikedTrack[]; declaredCount: number }>
}
export class SpotifyShapeError extends Error {
  readonly kind = 'permanent' as const
  constructor(detail: string) {
    super(`Spotify changed its API: ${detail}`)
  }
}
function id(value: unknown, kind: string): string {
  return typeof value === 'string' && value.startsWith(`spotify:${kind}:`)
    ? value.slice(`spotify:${kind}:`.length)
    : ''
}

/** Accept the two library paths and track wrappers used by the web player clients. */
export function parseLibraryPage(payload: unknown, offset: number) {
  const me = record(record(record(payload).data).me)
  const page = record(record(me.library).tracks ?? me.libraryTracks)
  if (
    !Array.isArray(page.items) ||
    !Number.isInteger(page.totalCount) ||
    Number(page.totalCount) < 0
  )
    throw new SpotifyShapeError('missing library tracks or totalCount')
  const tracks: SpotifyLikedTrack[] = []
  for (const [index, value] of page.items.entries()) {
    const row = record(value)
    const wrapper = record(row.track ?? row.item ?? row.itemV2)
    const track = record(wrapper.data)
    const uri = track.uri ?? wrapper._uri
    // Known non-track entries advance pagination but never become contributions.
    if (typeof uri === 'string' && /^spotify:(local|episode):/.test(uri))
      continue
    const trackId = id(uri, 'track')
    const album = record(track.albumOfTrack)
    const artistItems = record(track.artists).items
    const artists = Array.isArray(artistItems)
      ? artistItems.map((value) => {
          const artist = record(value)
          return {
            id: id(artist.uri, 'artist'),
            name: record(artist.profile).name,
          }
        })
      : []
    const addedAt = record(row.addedAt).isoString ?? row.addedAt ?? row.added_at
    const durationMs = record(
      track.trackDuration ?? track.duration
    ).totalMilliseconds
    if (
      !trackId ||
      typeof track.name !== 'string' ||
      !track.name ||
      !artists.length ||
      !artists.every(
        (artist) => typeof artist.name === 'string' && artist.name
      ) ||
      !id(album.uri, 'album') ||
      typeof album.name !== 'string' ||
      typeof durationMs !== 'number' ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      typeof addedAt !== 'string' ||
      !Number.isFinite(Date.parse(addedAt))
    )
      throw new SpotifyShapeError(
        `malformed library track at position ${offset + index}`
      )
    tracks.push({
      trackId,
      title: track.name,
      artists: artists.map((artist) => ({
        id: artist.id,
        name: String(artist.name),
      })),
      album: { id: id(album.uri, 'album'), name: album.name },
      trackNumber:
        Number.isInteger(track.trackNumber) && Number(track.trackNumber) > 0
          ? Number(track.trackNumber)
          : null,
      durationMs,
      addedAt: new Date(addedAt).toISOString(),
      position: offset + index,
    })
  }
  return {
    tracks,
    rawCount: page.items.length,
    totalCount: Number(page.totalCount),
  }
}

export function createSpotifyLibrary(
  http: HttpClient,
  token: ReturnType<typeof createSpotifyToken>,
  options: {
    userAgent?: string
    deviceId?: () => Promise<string | null>
  } = {}
) {
  let hash = LIBRARY_HASH
  let clientToken: { value: string; expiresAt: number } | null = null
  const userAgent = options.userAgent ?? USER_AGENT
  const headers = { Origin: WEB, Referer: `${WEB}/`, 'User-Agent': userAgent }

  async function refreshHash(signal?: AbortSignal): Promise<void> {
    const html = await http.text(WEB, { host: 'spotify', headers, signal })
    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(
      (match) => new URL(match[1], WEB).href
    )
    for (const url of scripts) {
      const js = await http.text(url, { host: 'spotify', headers, signal })
      const found =
        /(?:["']?name["']?\s*:\s*["']fetchLibraryTracks["'][\s\S]{0,500}?["']?sha256Hash["']?\s*:\s*["']([a-f0-9]{64})["'])|(?:["']?sha256Hash["']?\s*:\s*["']([a-f0-9]{64})["'][\s\S]{0,500}?["']?name["']?\s*:\s*["']fetchLibraryTracks["'])/.exec(
          js
        )
      if (found) {
        hash = found[1] ?? found[2]
        return
      }
    }
    throw new SpotifyShapeError(
      'could not refresh fetchLibraryTracks query hash'
    )
  }
  async function getClientToken(signal?: AbortSignal) {
    if (clientToken && clientToken.expiresAt > Date.now() + 60_000)
      return clientToken.value
    const access = await token.accessToken(signal)
    if (!access.clientId)
      throw new SpotifyShapeError('token is missing clientId')
    const payload = record(
      await http.json('https://clienttoken.spotify.com/v1/clienttoken', {
        host: 'spotify',
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal,
        body: JSON.stringify({
          client_data: {
            client_version: await token.version(signal),
            client_id: access.clientId,
            js_sdk_data: {
              device_brand: 'unknown',
              device_model: 'unknown',
              os: 'mac',
              os_version: '10.15.7',
              device_type: 'computer',
              device_id: (await options.deviceId?.()) ?? randomUUID(),
            },
          },
        }),
      })
    )
    const granted = record(payload.granted_token)
    if (
      typeof granted.token !== 'string' ||
      typeof granted.expires_after_seconds !== 'number'
    )
      throw new SpotifyShapeError('client token was not granted')
    clientToken = {
      value: granted.token,
      expiresAt: Date.now() + granted.expires_after_seconds * 1000,
    }
    return clientToken.value
  }
  return {
    async account(signal?: AbortSignal) {
      const access = await token.accessToken(signal)
      const payload = record(
        await http.json(PATHFINDER, {
          host: 'spotify',
          method: 'POST',
          signal,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${access.value}`,
            'App-Platform': 'WebPlayer',
          },
          body: JSON.stringify({
            operationName: 'profileAttributes',
            variables: {},
            extensions: {
              persistedQuery: {
                version: 1,
                sha256Hash:
                  'b197b5adb4b761690f76ad9d9fb278c14c14e7331f357c04a56e7001af7106e0',
              },
            },
          }),
        })
      )
      const profile = record(record(record(payload.data).me).profile)
      const accountId =
        typeof profile.username === 'string'
          ? profile.username
          : access.accountId
      if (!accountId) throw new SpotifyShapeError('missing Spotify Account ID')
      return {
        id: accountId,
        name:
          typeof profile.name === 'string'
            ? profile.name
            : typeof profile.displayName === 'string'
              ? profile.displayName
              : accountId,
      }
    },
    async likedSongs(signal?: AbortSignal) {
      const tracks: SpotifyLikedTrack[] = []
      let offset = 0
      let total: number | null = null
      let refreshedHash = false
      let refreshedToken = false
      let requestedClientToken = false
      for (;;) {
        let payload: unknown
        try {
          payload = await http.json(PATHFINDER, {
            host: 'spotify',
            method: 'POST',
            signal,
            headers: {
              ...headers,
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'App-Platform': 'WebPlayer',
              'Spotify-App-Version': await token.version(signal),
              Authorization: `Bearer ${(await token.accessToken(signal)).value}`,
              ...(clientToken
                ? { 'Client-Token': await getClientToken(signal) }
                : {}),
            },
            body: JSON.stringify({
              operationName: 'fetchLibraryTracks',
              variables: { offset, limit: 50 },
              extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
            }),
          })
        } catch (error) {
          if (
            error instanceof HttpError &&
            error.status === 401 &&
            !refreshedToken
          ) {
            refreshedToken = true
            token.invalidate()
            continue
          }
          if (
            error instanceof HttpError &&
            error.status === 403 &&
            !requestedClientToken
          ) {
            requestedClientToken = true
            await getClientToken(signal)
            continue
          }
          throw error
        }
        const errors = record(payload).errors
        if (Array.isArray(errors) && errors.length) {
          if (
            errors.some((error) =>
              JSON.stringify(error).includes('PersistedQueryNotFound')
            ) &&
            !refreshedHash
          ) {
            refreshedHash = true
            await refreshHash(signal)
            continue
          }
          throw new SpotifyShapeError(
            `fetchLibraryTracks errors: ${JSON.stringify(errors)}`
          )
        }
        const page = parseLibraryPage(payload, offset)
        if (total !== null && total !== page.totalCount)
          throw new SpotifyShapeError(
            'library count changed while paging; try again'
          )
        total = page.totalCount
        if (offset < total && page.rawCount === 0)
          throw new SpotifyShapeError('empty page before totalCount')
        if (offset + page.rawCount > total)
          throw new SpotifyShapeError('page exceeds totalCount')
        tracks.push(...page.tracks)
        offset += page.rawCount
        if (offset >= total) return { tracks, declaredCount: total }
      }
    },
  }
}
