import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createYouTubeMusicCatalog } from '../../src/main/catalog/catalog'
import { nav } from '../../src/main/catalog/parsers/nav'
import {
  CatalogShapeError,
  type InnertubeRequest,
} from '../../src/main/catalog/types'

const TRICOT = 'UC5zlgZh4XYI0z2NAXAji-5A'
const SINGLES_PARAMS = 'ggMIegYIAhoCAQI%3D'

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve('test/fixtures/catalog', `${name}.json`), 'utf8')
  )
}

function catalogFor(respond: (request: InnertubeRequest) => unknown) {
  const calls: InnertubeRequest[] = []
  const catalog = createYouTubeMusicCatalog({
    async call(request) {
      calls.push(request)
      return respond(request)
    },
  })
  return { catalog, calls }
}

/** The tricot artist page, whose album cards show only a year. */
function tricot(request: InnertubeRequest): unknown {
  if (request.body.browseId === TRICOT) return fixture('artist')
  if (request.body.params === SINGLES_PARAMS)
    return fixture('artist-singles-more')
  throw new Error(`unexpected request ${JSON.stringify(request.body)}`)
}

function artistShelf(page: unknown, title: string): Record<string, unknown> {
  const sections = nav(page, [
    'contents',
    'singleColumnBrowseResultsRenderer',
    'tabs',
    0,
    'tabRenderer',
    'content',
    'sectionListRenderer',
    'contents',
  ]) as Record<string, unknown>[]
  const section = sections.find(
    (entry) =>
      nav(entry, [
        'musicCarouselShelfRenderer',
        'header',
        'musicCarouselShelfBasicHeaderRenderer',
        'title',
        'runs',
        0,
        'text',
      ]) === title
  )
  return section?.musicCarouselShelfRenderer as Record<string, unknown>
}

describe('artist release discovery', () => {
  it('keeps album cards whose subtitle is only a year', async () => {
    const { catalog } = catalogFor(tricot)
    const artist = await catalog.artist(TRICOT)
    expect(
      artist.albums.map((ref) => [ref.browseId, ref.title, ref.year, ref.shelf])
    ).toEqual([
      ['MPREb_I8W8NXwKIap', 'Fudeki', 2022, 'albums'],
      ['MPREb_c90oyiIKrXn', 'Jodeki', 2021, 'albums'],
      ['MPREb_mtEel9pD4r9', '10', 2020, 'albums'],
      ['MPREb_ZsuBCCFasTP', 'Black', 2020, 'albums'],
      ['MPREb_JIySGPaawIc', '3', 2017, 'albums'],
      ['MPREb_16TXbnrGm7o', 'A N D', 2015, 'albums'],
      ['MPREb_Npjg6HxNrZ3', 'T H E', 2013, 'albums'],
    ])
    expect(artist.singles.every((ref) => ref.shelf === 'singles')).toBe(true)
  })

  it('lists every album and single, tagged with the shelf it came from', async () => {
    const { catalog } = catalogFor(tricot)
    const releases = await catalog.artistReleases(TRICOT)
    const albums = releases.filter((ref) => ref.shelf === 'albums')
    const singles = releases.filter((ref) => ref.shelf === 'singles')
    expect(albums).toHaveLength(7)
    expect(singles).toHaveLength(22)
    expect(singles.map((ref) => ref.title)).toContain('Kabuku EP')
    expect(new Set(releases.map((ref) => ref.browseId)).size).toBe(
      releases.length
    )
  })

  it('keeps inline releases that a truncated "more" list leaves out', async () => {
    const more = structuredClone(fixture('artist-singles-more')) as unknown
    const items = nav(more, [
      'contents',
      'singleColumnBrowseResultsRenderer',
      'tabs',
      0,
      'tabRenderer',
      'content',
      'sectionListRenderer',
      'contents',
      0,
      'gridRenderer',
      'items',
    ]) as unknown[]
    const firstInline = nav(items[0], [
      'musicTwoRowItemRenderer',
      'title',
      'runs',
      0,
      'text',
    ])
    items.splice(0, 1)
    const { catalog } = catalogFor((request) =>
      request.body.params === SINGLES_PARAMS ? more : tricot(request)
    )
    const releases = await catalog.artistReleases(TRICOT)
    expect(releases.map((ref) => ref.title)).toContain(firstInline)
  })

  it('ignores continuation controls but rejects unreadable release cards', async () => {
    const page = structuredClone(fixture('artist')) as unknown
    const albums = artistShelf(page, 'Albums')
    const contents = albums.contents as unknown[]
    contents.push({ continuationItemRenderer: {} })
    const { catalog } = catalogFor((request) =>
      request.body.browseId === TRICOT ? page : tricot(request)
    )
    expect((await catalog.artist(TRICOT)).albums).toHaveLength(7)

    const card = contents[1] as {
      musicTwoRowItemRenderer: Record<string, unknown>
    }
    delete card.musicTwoRowItemRenderer.navigationEndpoint
    delete card.musicTwoRowItemRenderer.title
    await expect(catalog.artist(TRICOT)).rejects.toBeInstanceOf(
      CatalogShapeError
    )
  })

  it('rejects an unknown item inside a release list', async () => {
    const page = structuredClone(fixture('artist')) as unknown
    ;(artistShelf(page, 'Albums').contents as unknown[]).push({
      somethingNewRenderer: {},
    })
    const { catalog } = catalogFor(() => page)
    await expect(catalog.artist(TRICOT)).rejects.toBeInstanceOf(
      CatalogShapeError
    )
  })

  it('stops on a repeated continuation token', async () => {
    const more = structuredClone(fixture('artist-singles-more')) as Record<
      string,
      unknown
    >
    const grid = nav(more, [
      'contents',
      'singleColumnBrowseResultsRenderer',
      'tabs',
      0,
      'tabRenderer',
      'content',
      'sectionListRenderer',
      'contents',
      0,
      'gridRenderer',
    ]) as Record<string, unknown>
    grid.continuations = [{ nextContinuationData: { continuation: 'again' } }]
    const next = {
      continuationContents: {
        gridContinuation: {
          items: grid.items,
          continuations: [{ nextContinuationData: { continuation: 'again' } }],
        },
      },
    }
    const { catalog } = catalogFor((request) => {
      if (request.body.continuation) return next
      if (request.body.params === SINGLES_PARAMS) return more
      return tricot(request)
    })
    await expect(catalog.artistReleases(TRICOT)).rejects.toBeInstanceOf(
      CatalogShapeError
    )
  })
})
