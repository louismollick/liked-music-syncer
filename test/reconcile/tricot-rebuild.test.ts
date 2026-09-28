import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createYouTubeMusicCatalog } from '../../src/main/catalog/catalog'
import { nav } from '../../src/main/catalog/parsers/nav'
import type {
  CatalogRelease,
  YouTubeMusicCatalog,
} from '../../src/main/catalog/types'
import { LibraryQueries } from '../../src/main/library/queries'
import { artists, files } from '../../src/main/library/schema'
import { catalogContribution } from '../../src/main/match/resolve'
import { albumKey } from '../../src/main/reconcile/reconciler'
import { Harness, song } from './harness'

const TRICOT = 'UC5zlgZh4XYI0z2NAXAji-5A'
const FUDEKI = 'MPREb_I8W8NXwKIap'
const JODEKI = 'MPREb_c90oyiIKrXn'

const open: Harness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve('test/fixtures/catalog', `${name}.json`), 'utf8')
  )
}

/** tricot's artist page, cut down to the Fudeki and Jodeki album cards. */
function tricotPage(): unknown {
  const page = structuredClone(fixture('artist'))
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
  const title = (section: unknown) =>
    nav(section, [
      'musicCarouselShelfRenderer',
      'header',
      'musicCarouselShelfBasicHeaderRenderer',
      'title',
      'runs',
      0,
      'text',
    ])
  const albums = sections.find((section) => title(section) === 'Albums')!
  const shelf = albums.musicCarouselShelfRenderer as { contents: unknown[] }
  shelf.contents = shelf.contents.filter((card) =>
    [FUDEKI, JODEKI].includes(
      nav(card, [
        'musicTwoRowItemRenderer',
        'navigationEndpoint',
        'browseEndpoint',
        'browseId',
      ]) as string
    )
  )
  sections.splice(0, sections.length, albums)
  return page
}

describe('a fresh Library for tricot', () => {
  it('downloads Fudeki and Jodeki complete, in order, with channel credits', async () => {
    const h = new Harness()
    open.push(h)
    h.settings.remoteEnabled = false
    const real = createYouTubeMusicCatalog({
      async call(request) {
        const id = request.body.browseId
        if (id === TRICOT) return tricotPage()
        if (id === FUDEKI) return fixture('release-fudeki')
        if (id === JODEKI) return fixture('release-jodeki')
        throw new Error(`unexpected request ${JSON.stringify(request.body)}`)
      },
    })
    // Likes stay fake; everything else reads the saved YouTube Music responses.
    const catalog: YouTubeMusicCatalog = {
      ...real,
      likedSongs: () => h.catalog.likedSongs(),
    }
    h.deps.catalog = catalog
    const fudeki: CatalogRelease = await real.release(FUDEKI)
    // Representative likes: an album track, and the instrumental on track 18.
    for (const index of [0, 17]) {
      const track = fudeki.tracks[index]
      h.matcher.matches.set(track.videoId, {
        ...catalogContribution(fudeki, track, null),
        resolutionMethod: 'liked_album_exact',
      })
    }
    h.catalog.likes = [
      song(fudeki.tracks[0].videoId, fudeki.tracks[0].title),
      song(fudeki.tracks[17].videoId, fudeki.tracks[17].title),
    ]
    h.db
      .insert(artists)
      .values({
        id: `channel:${TRICOT}`,
        name: 'tricot',
        channelId: TRICOT,
        fullDiscography: true,
      })
      .run()
    await h.start()

    const queries = new LibraryQueries(
      h.db,
      () => null,
      () => null,
      () => h.settings
    )
    for (const album of ['Fudeki', 'Jodeki']) {
      const view = queries.album(albumKey(album, 'tricot'))!
      expect(view.tracks.map((track) => track.trackNumber)).toEqual(
        Array.from({ length: 24 }, (_, i) => i + 1)
      )
    }
    const fudekiIds = new Set(
      h
        .rows()
        .filter((row) => row.releaseId === FUDEKI)
        .map((row) => row.id)
    )
    const links = h.db
      .all<{ track_id: string; artist_id: string }>(
        sql`SELECT track_id, artist_id FROM track_artists`
      )
      .filter((row) => fudekiIds.has(row.track_id))
    expect(
      links.filter((row) => row.artist_id === `channel:${TRICOT}`)
    ).toHaveLength(22)
    expect(
      links.filter((row) => row.artist_id === 'name:tricot / in the blue shirt')
    ).toHaveLength(2)
    expect(
      h.db.all<{ id: string }>(sql`SELECT id FROM artists`).map((row) => row.id)
    ).not.toContain('name:tricot')
    expect(h.rows()).toHaveLength(48)
    expect(h.db.select().from(files).all()).toHaveLength(48)
    expect(h.downloads).toHaveLength(48)

    // Checking the sources again and restarting changes nothing.
    const calls = h.matcher.calls
    await h.reconciler.check({ catalogs: 'all' })
    await h.idle()
    await h.stop()
    await h.start()
    expect(h.rows()).toHaveLength(48)
    expect(h.db.select().from(files).all()).toHaveLength(48)
    expect(h.downloads).toHaveLength(48)
    expect(h.matcher.calls).toBe(calls)
  }, 60_000)
})
