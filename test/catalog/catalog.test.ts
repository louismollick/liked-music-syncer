import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createYouTubeMusicCatalog } from '../../src/main/catalog/catalog'
import { restoreReleaseAudio } from '../../src/main/catalog/parsers/audio-playlist'
import { nav } from '../../src/main/catalog/parsers/nav'
import { releaseTitlesMatch } from '../../src/main/catalog/release-match'
import {
  type CatalogRelease,
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
  it('checks the exact audio title when YouTube truncates the playlist title', async () => {
    const { release, audio, fullTitle } = fixture('gate-audio-title') as {
      release: CatalogRelease
      audio: unknown
      fullTitle: string
    }
    const lookedUp: string[] = []
    const restored = await restoreReleaseAudio(audio, release, async (id) => {
      lookedUp.push(id)
      return fullTitle
    })
    expect(lookedUp).toEqual(['JX5vgvcQLQk'])
    expect(restored.tracks[0]).toMatchObject({
      title: release.tracks[0].title,
      videoId: 'JX5vgvcQLQk',
      videoType: 'ATV',
    })
    for (const title of [null, 'GATE (Live)', 'Unrelated song']) {
      await expect(
        restoreReleaseAudio(audio, release, async () => title)
      ).rejects.toThrow('does not match the release track list')
    }
  })

  it('accepts localized titles but keeps recording versions distinct', () => {
    expect(releaseTitlesMatch('おやすみ - Oyasumi', 'おやすみ')).toBe(true)
    expect(
      releaseTitlesMatch('右脳左脳 - Right brain left brain', '右脳左脳')
    ).toBe(true)
    expect(releaseTitlesMatch('CROSS∞ROADS - CROSS ROADS', 'CROSS∞ROADS')).toBe(
      true
    )
    expect(
      releaseTitlesMatch(
        '光の言葉 (2023 Remaster) - Hikari no Kotoba (2023 remaster) (2023 Remaster)',
        'Hikari no Kotoba (2023 remaster)'
      )
    ).toBe(true)
    expect(releaseTitlesMatch('Song - Live', 'Song - Acoustic')).toBe(false)
    expect(releaseTitlesMatch('Song - Live', 'Song')).toBe(false)
    expect(releaseTitlesMatch('曲 (Live) - Song', 'Song')).toBe(false)
    for (const version of [
      'Alternate Version',
      '別録音',
      'Live',
      '2023 Remaster',
    ]) {
      expect(releaseTitlesMatch(`曲（${version}） - Song`, 'Song')).toBe(false)
    }
    expect(releaseTitlesMatch('曲 (feat. Guest) - Song', 'Song')).toBe(false)
    expect(releaseTitlesMatch('曲 feat. Guest - Song', 'Song')).toBe(false)
    expect(releaseTitlesMatch('曲 (Alternate Version) - Song', 'Song')).toBe(
      false
    )
    expect(
      releaseTitlesMatch(
        '曲 feat. Singer (Radio Version) - Song feat. Singer',
        'Song feat. Singer'
      )
    ).toBe(false)
    expect(
      releaseTitlesMatch(
        '曲 feat. Singer (別録音) - Song feat. Singer',
        'Song feat. Singer'
      )
    ).toBe(false)
    expect(releaseTitlesMatch('曲 Live - Song', 'Song')).toBe(false)
    expect(releaseTitlesMatch('曲 (2023 Remaster) - Song', 'Song')).toBe(false)
    expect(
      releaseTitlesMatch(
        'フロントメモリー feat. ACAね(ずっと真夜中でいいのに。) - Front Memory (feat. ACAne)',
        'Front Memory (feat. ACAne)'
      )
    ).toBe(true)
    expect(
      releaseTitlesMatch('Song (2023 Remaster)', 'Song (2024 Remaster)')
    ).toBe(false)
  })
  it('reads a release header and its ordered tracks', async () => {
    const { catalog, calls } = fake((request) =>
      fixture(request.client === 'WEB' ? 'album-audio' : 'album')
    )
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
      ['おやすみ - Oyasumi', 'BOiVcOaci2o', 212, 1],
      ['Orange Juice', 'ExmdsUPrCjQ', 169, 2],
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
    const { catalog } = fake((request) =>
      fixture(request.client === 'WEB' ? 'album-2-audio' : 'album-2')
    )
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
    const { catalog } = fake((request) =>
      request.client === 'WEB' ? fixture('album-2-audio') : page
    )
    const release = await catalog.release('MPREb_discs')
    expect(release.tracks.map((track) => track.discNumber)).toEqual([
      1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
    ])
    expect(release.tracks.at(-1)?.trackNumber).toBe(11)
  })

  it.each([
    ['yoasobi', 'MPREb_LfJd6hctedK', 'by4SYYWlhEs', 262, 0],
    ['ruru', 'MPREb_LP6iWdMoAwK', 'mU3SFom01jE', 239, 0],
    ['decade', 'MPREb_KHCfoiUp1Nq', 'pKEXcRbvw9A', 242, 0],
    ['kokyuu', 'MPREb_o4pnYRcwoHM', 'AWjoPl09BnU', 263, 7],
  ])('uses the original audio of %s while preserving release metadata', async (name, browseId, videoId, durationSeconds, index) => {
    const { catalog, calls } = fake((request) =>
      fixture(request.client === 'WEB' ? `${name}-audio` : name)
    )
    const release = await catalog.release(browseId)
    expect(release.tracks[index]).toMatchObject({
      videoId,
      durationSeconds,
      videoType: 'ATV',
      trackNumber: index + 1,
      album: { browseId, name: release.title },
    })
    expect(calls[1]).toMatchObject({
      client: 'WEB',
      authenticated: false,
      body: {
        browseId: `VL${release.audioPlaylistId}`,
        params: 'wgYCCAA%3D',
      },
    })
  })

  it.each([
    'truncated',
    'reordered',
    'other playlist',
    'conflicting ID',
    'different order with valid indices',
  ])('rejects an %s audio playlist instead of attaching wrong audio', async (problem) => {
    const audio = fixture('decade-audio')
    const items = nav(audio, [
      'contents',
      'twoColumnBrowseResultsRenderer',
      'tabs',
      0,
      'tabRenderer',
      'content',
      'sectionListRenderer',
      'contents',
      0,
      'itemSectionRenderer',
      'contents',
    ]) as unknown[]
    const endpoint = nav(items[0], [
      'lockupViewModel',
      'rendererContext',
      'commandContext',
      'onTap',
      'innertubeCommand',
      'watchEndpoint',
    ]) as Record<string, unknown>
    if (problem === 'truncated') items.pop()
    if (problem === 'reordered') items.reverse()
    if (problem === 'other playlist')
      endpoint.playlistId = 'OLAK_another_release'
    if (problem === 'conflicting ID') endpoint.videoId = 'another_video'
    if (problem === 'different order with valid indices') {
      items.reverse()
      for (const [index, item] of items.entries()) {
        const watch = nav(item, [
          'lockupViewModel',
          'rendererContext',
          'commandContext',
          'onTap',
          'innertubeCommand',
          'watchEndpoint',
        ]) as Record<string, unknown>
        watch.index = index
      }
    }
    const { catalog } = fake((request) =>
      request.client === 'WEB' ? audio : fixture('decade')
    )
    await expect(catalog.release('MPREb_KHCfoiUp1Nq')).rejects.toBeInstanceOf(
      CatalogShapeError
    )
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

  it('returns no candidates for an explicit no-results search response', async () => {
    const { catalog, calls } = fake(() => fixture('search-no-results'))
    await expect(
      catalog.searchSongs('Kyoumei -Kuukyo na Ishi- Lily Chou-Chou')
    ).resolves.toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('rejects missing shelves and unrelated messages instead of treating them as no results', async () => {
    const page = fixture('search-no-results')
    const message = nav(page, [
      'contents',
      'tabbedSearchResultsRenderer',
      'tabs',
      0,
      'tabRenderer',
      'content',
      'sectionListRenderer',
      'contents',
      0,
      'itemSectionRenderer',
      'contents',
      0,
      'messageRenderer',
    ]) as { text: { runs: { text: string }[] } }
    message.text.runs = [{ text: 'Sign in to search' }]
    const { catalog } = fake(() => page)
    await expect(catalog.searchSongs('anything')).rejects.toThrow(
      'Missing songs shelf'
    )
    const missing = fake(() => fixture('search-artists')).catalog
    await expect(missing.searchSongs('anything')).rejects.toThrow(
      'Missing songs shelf'
    )
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
