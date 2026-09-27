import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createYouTubeMusicCatalog } from '../../src/main/catalog/catalog'
import { nav } from '../../src/main/catalog/parsers/nav'
import {
  CatalogShapeError,
  type InnertubeRequest,
  type InnertubeTransport,
} from '../../src/main/catalog/types'

const fixtures = resolve('test/fixtures/catalog')
const privateFixtures = resolve('test/fixtures/private')

function fixture(name: string, privateFile = false): unknown {
  return JSON.parse(
    readFileSync(
      resolve(privateFile ? privateFixtures : fixtures, `${name}.json`),
      'utf8'
    )
  )
}

function fake(respond: (request: InnertubeRequest) => unknown): {
  catalog: ReturnType<typeof createYouTubeMusicCatalog>
  calls: InnertubeRequest[]
} {
  const calls: InnertubeRequest[] = []
  const transport: InnertubeTransport = {
    async call(request) {
      calls.push(request)
      return respond(request)
    },
  }
  return { catalog: createYouTubeMusicCatalog(transport), calls }
}

function findArray(value: unknown, key: string): unknown[] | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArray(item, key)
      if (found) return found
    }
    return null
  }
  for (const [name, child] of Object.entries(value)) {
    if (name === key && Array.isArray(child)) return child
    const found = findArray(child, key)
    if (found) return found
  }
  return null
}

describe('YouTube Music catalog', () => {
  it('reads a release header and its ordered tracks', async () => {
    const { catalog, calls } = fake(() => fixture('album'))
    const release = await catalog.release('MPREb_test')
    expect(release.title).toBe('Oyasumi')
    expect(release.kindLabel).toBe('Single')
    expect(release.year).toBe(2013)
    expect(release.artists).toEqual([
      { name: 'tricot', channelId: 'UC5zlgZh4XYI0z2NAXAji-5A' },
    ])
    expect(release.audioPlaylistId).toBe(
      'OLAK5uy_kcQNhq9ftYX10HKXuvVcxxsBiArdnmUnI'
    )
    expect(
      release.tracks.map((track) => [
        track.title,
        track.videoId,
        track.durationSeconds,
        track.trackNumber,
      ])
    ).toEqual([
      ['おやすみ - Oyasumi', 'h2ydFHebKgQ', 212, 1],
      ['Orange Juice', 'd6rxGmvQPLU', 169, 2],
    ])
    expect(release.tracks.every((track) => track.discNumber === null)).toBe(
      true
    )
    expect(calls[0]).toMatchObject({
      endpoint: 'browse',
      authenticated: false,
      body: { browseId: 'MPREb_test' },
    })
  })

  it('keeps the full track list of another release', async () => {
    const { catalog } = fake(() => fixture('album-2'))
    const release = await catalog.release('MPREb_deluxe')
    expect(release.title).toBe('As Daylight Dies')
    expect(release.tracks).toHaveLength(11)
    expect(release.tracks.map((track) => track.trackNumber)).toEqual(
      Array.from({ length: 11 }, (_, i) => i + 1)
    )
  })

  it('assigns disc numbers when tracks are split across shelves', async () => {
    const page = structuredClone(fixture('album-2'))
    const sections = nav(page, [
      'contents',
      'twoColumnBrowseResultsRenderer',
      'secondaryContents',
      'sectionListRenderer',
      'contents',
    ]) as Record<string, unknown>[]
    const first = sections[0] as { musicShelfRenderer: { contents: unknown[] } }
    const second = structuredClone(first)
    second.musicShelfRenderer.contents =
      first.musicShelfRenderer.contents.splice(5)
    sections.splice(1, 0, second)
    const { catalog } = fake(() => page)
    const release = await catalog.release('MPREb_discs')
    expect(release.tracks.map((track) => track.discNumber)).toEqual([
      1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
    ])
    expect(release.tracks.at(-1)?.trackNumber).toBe(11)
  })

  it('reads artist shelves and expands the linked lists with deduplication', async () => {
    const { catalog, calls } = fake((request) => {
      if (request.body.browseId === 'UC5zlgZh4XYI0z2NAXAji-5A')
        return fixture('artist')
      if (request.body.params === 'ggMIegYIAhoCAQI%3D')
        return fixture('artist-singles-more')
      return fixture('artist-albums-more')
    })
    const artist = await catalog.artist('UC5zlgZh4XYI0z2NAXAji-5A')
    expect(artist.name).toBe('tricot')
    expect(artist.albums.length).toBeGreaterThan(0)
    expect(artist.singles.length).toBeGreaterThan(0)
    expect(artist.singlesMore?.browseId).toMatch(/^MPAD/)
    const releases = await catalog.artistReleases('UC5zlgZh4XYI0z2NAXAji-5A')
    expect(releases.length).toBeGreaterThan(
      artist.albums.length + artist.singles.length
    )
    expect(new Set(releases.map((release) => release.browseId)).size).toBe(
      releases.length
    )
    expect(
      calls.some((call) => call.body.params === 'ggMIegYIAhoCAQI%3D')
    ).toBe(true)
  })

  it('uses the songs filter, spelling setting, and limit', async () => {
    const { catalog, calls } = fake((request) =>
      fixture(
        request.body.params === 'EgWKAQIIAUICCAFqChAJEAUQChADEAQ%3D'
          ? 'search-songs-ignore-spelling'
          : 'search-songs'
      )
    )
    const tracks = await catalog.searchSongs('tricot', { limit: 2 })
    expect(tracks).toHaveLength(2)
    expect(tracks[0]).toMatchObject({
      videoId: 'AGs1kb9Douc',
      title: '餌にもなれない - WALKING',
      durationSeconds: 247,
    })
    await catalog.searchSongs('tricot', { ignoreSpelling: true, limit: 1 })
    expect(calls.map((call) => call.body.params)).toEqual([
      'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
      'EgWKAQIIAUICCAFqChAJEAUQChADEAQ%3D',
    ])
    expect(calls.every((call) => !call.authenticated)).toBe(true)
  })

  it('follows search continuations to reach the requested limit', async () => {
    const initial = fixture('search-songs')
    const contents = nav(initial, [
      'contents',
      'tabbedSearchResultsRenderer',
      'tabs',
      0,
      'tabRenderer',
      'content',
      'sectionListRenderer',
      'contents',
      0,
      'musicShelfRenderer',
      'contents',
    ]) as unknown[]
    const { catalog, calls } = fake((request) =>
      request.body.continuation
        ? {
            continuationContents: {
              musicShelfContinuation: { contents: contents.slice(0, 2) },
            },
          }
        : initial
    )
    const tracks = await catalog.searchSongs('tricot', { limit: 28 })
    expect(tracks).toHaveLength(28)
    expect(calls[1].body).toHaveProperty('continuation')
  })

  it.each([
    ['next', 'h2ydFHebKgQ', 'MPLYt_pSI7Skgpq05'],
    ['next-2', 'Rbgw_rduQpM', 'MPLYt_XFB3PAEm0ew-5'],
  ])('reads %s despite tabs without endpoints', async (name, videoId, lyricsBrowseId) => {
    const { catalog } = fake(() => fixture(name))
    const watch = await catalog.watch(videoId)
    expect(watch.lyricsBrowseId).toBe(lyricsBrowseId)
    expect(watch.track?.videoId).toBe(videoId)
    expect(watch.track?.title).toBeTruthy()
  })

  it('prefers timed lyrics and skips lines without cue ranges', async () => {
    const response = fixture('lyrics-timed') as Record<string, unknown>
    const copy = structuredClone(response)
    findArray(copy, 'timedLyricsData')?.push({ lyricLine: 'missing time' })
    const { catalog, calls } = fake(() => copy)
    const lyrics = await catalog.lyrics('MPLY_test')
    expect(lyrics?.timed?.length).toBeGreaterThan(10)
    expect(lyrics?.timed?.some((line) => line.text === 'missing time')).toBe(
      false
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      client: 'ANDROID_MUSIC',
      authenticated: false,
    })
  })

  it('falls back to plain lyrics', async () => {
    const { catalog, calls } = fake(() => fixture('lyrics-plain'))
    const lyrics = await catalog.lyrics('MPLY_test')
    expect(lyrics?.timed).toBeNull()
    expect(lyrics?.plain).toContain('\n')
    expect(lyrics?.source).toContain('Source:')
    expect(calls).toHaveLength(2)
  })

  it('returns null when neither lyrics response contains text', async () => {
    const { catalog, calls } = fake(() => ({ contents: {} }))
    expect(await catalog.lyrics('MPLY_missing')).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('throws a shape error when a page loses its expected container', async () => {
    const { catalog } = fake(() => ({ contents: {} }))
    await expect(catalog.release('MPREb_broken')).rejects.toBeInstanceOf(
      CatalogShapeError
    )
    await expect(catalog.likedSongs()).rejects.toBeInstanceOf(CatalogShapeError)
    await expect(catalog.searchSongs('broken')).rejects.toBeInstanceOf(
      CatalogShapeError
    )
  })

  it('reads the public playlist through the liked songs parser', async () => {
    const { catalog } = fake(() => fixture('playlist'))
    const result = await catalog.likedSongs()
    expect(result.declaredCount).toBe(100)
    expect(result.pageCount).toBe(1)
    expect(result.tracks).toHaveLength(100)
    expect(result.tracks[0]).toMatchObject({
      position: 0,
      videoId: '3DcoC8p9az8',
      videoType: 'OMV',
    })
    expect(result.tracks[99].position).toBe(99)
  })

  it('skips an item without a video ID but keeps its source position', async () => {
    const page = structuredClone(fixture('playlist'))
    const rows = nav(page, [
      'contents',
      'twoColumnBrowseResultsRenderer',
      'secondaryContents',
      'sectionListRenderer',
      'contents',
      0,
      'musicPlaylistShelfRenderer',
      'contents',
    ]) as unknown[]
    rows.splice(1, 0, { musicResponsiveListItemRenderer: { flexColumns: [] } })
    const { catalog } = fake(() => page)
    const result = await catalog.likedSongs()
    expect(result.tracks).toHaveLength(100)
    expect(result.tracks[1].position).toBe(2)
  })

  it.skipIf(
    !existsSync(resolve(privateFixtures, 'liked-page-1.json')) ||
      !existsSync(resolve(privateFixtures, 'liked-page-2.json'))
  )('follows personal liked songs continuation', async () => {
    const { catalog, calls } = fake((request) => {
      if (!request.body.continuation) return fixture('liked-page-1', true)
      const lastPage = structuredClone(fixture('liked-page-2', true)) as {
        onResponseReceivedActions: {
          appendContinuationItemsAction: { continuationItems: unknown[] }
        }[]
      }
      lastPage.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems.pop()
      return lastPage
    })
    const result = await catalog.likedSongs()
    expect(result.pageCount).toBe(2)
    expect(result.tracks.length).toBeGreaterThan(100)
    expect(result.tracks[0].position).toBe(0)
    expect(result.tracks.at(-1)?.position).toBeGreaterThan(100)
    expect(calls[1].body).toHaveProperty('continuation')
    expect(calls.every((call) => call.authenticated)).toBe(true)
  })

  it.skipIf(!existsSync(resolve(privateFixtures, 'account-menu.json')))(
    'reads the selected account',
    async () => {
      const { catalog, calls } = fake(() => fixture('account-menu', true))
      const account = await catalog.account()
      expect(account?.name).toBeTruthy()
      expect(account?.handle).toMatch(/^@/)
      expect(account?.channelId).toMatch(/^UC/)
      expect(account?.photoUrl).toMatch(/^https:/)
      expect(calls[0]).toMatchObject({
        endpoint: 'account/account_menu',
        authenticated: true,
      })
    }
  )
})
