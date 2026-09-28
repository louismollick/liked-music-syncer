import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createYouTubeMusicCatalog } from '../../src/main/catalog/catalog'
import type { CatalogReleaseRef } from '../../src/main/catalog/types'
import { artists } from '../../src/main/library/schema'
import {
  type CatalogRaw,
  checkArtistCatalog,
  SuspiciousSnapshotError,
} from '../../src/main/reconcile/sources'
import { credit, Harness, release, song } from './harness'

const TRICOT = 'UC5zlgZh4XYI0z2NAXAji-5A'
const open: Harness[] = []
function harness() {
  const h = new Harness()
  open.push(h)
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve('test/fixtures/catalog', `${name}.json`), 'utf8')
  )
}

function fullDiscography(h: Harness, id: string, channelId: string) {
  h.db
    .insert(artists)
    .values({ id, name: 'artist', channelId, fullDiscography: true })
    .run()
}

function ref(
  browseId: string,
  shelf: CatalogReleaseRef['shelf']
): CatalogReleaseRef {
  return { browseId, title: browseId, shelf, year: 2024, thumbnailUrl: null }
}

describe('Full Discography catalog discovery', () => {
  it('adds album tracks from the Albums shelf, including year-only cards', async () => {
    const h = harness()
    const artistId = `channel:${TRICOT}`
    fullDiscography(h, artistId, TRICOT)
    const catalog = createYouTubeMusicCatalog({
      async call(request) {
        const id = request.body.browseId
        if (id === TRICOT) return fixture('artist')
        if (request.body.params) return fixture('artist-singles-more')
        if (id === 'MPREb_I8W8NXwKIap') return fixture('release-fudeki')
        if (id === 'MPREb_c90oyiIKrXn') return fixture('release-jodeki')
        return fixture('album')
      },
    })
    await checkArtistCatalog({
      db: h.db,
      catalog,
      artistId,
      channelId: TRICOT,
      now: () => h.time,
    })
    const catalogRows = h.contributions().filter((row) => row.active)
    const byRelease = (id: string) =>
      catalogRows.filter((row) => row.releaseId === id)
    expect(byRelease('MPREb_I8W8NXwKIap')).toHaveLength(24)
    expect(byRelease('MPREb_c90oyiIKrXn')).toHaveLength(24)
    const shelves = new Set(
      catalogRows.map((row) => (JSON.parse(row.raw) as CatalogRaw).shelf)
    )
    expect(shelves).toEqual(new Set(['albums', 'singles']))
    const fudeki = byRelease('MPREb_I8W8NXwKIap').map(
      (row) => JSON.parse(row.raw) as CatalogRaw
    )
    expect(fudeki.map((raw) => raw.track.trackNumber)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1)
    )
    expect(fudeki.map((raw) => raw.release.kindLabel)).toContain('Album')
  })

  it('keeps the previous catalog when a populated shelf disappears', async () => {
    for (const lost of ['albums', 'singles'] as const) {
      const h = harness()
      const artistId = 'channel:artist-1'
      fullDiscography(h, artistId, credit.channelId)
      const kept = lost === 'albums' ? 'singles' : 'albums'
      // Enough tracks on the kept shelf that the 50% decline guard alone would pass.
      h.catalog.releases.set(
        'kept',
        release(
          'kept',
          ...Array.from({ length: 30 }, (_, i) => song(`kept-${i}`))
        )
      )
      h.catalog.releases.set('lost', release('lost', song('lost-0')))
      h.catalog.refs = [ref('kept', kept), ref('lost', lost)]
      const check = () =>
        checkArtistCatalog({
          db: h.db,
          catalog: h.catalog,
          artistId,
          channelId: credit.channelId,
          now: () => h.time,
        })
      await check()
      const before = h.contributions().map((row) => [row.sourceKey, row.active])
      h.catalog.refs = [ref('kept', kept)]
      await expect(check()).rejects.toBeInstanceOf(SuspiciousSnapshotError)
      expect(
        h.contributions().map((row) => [row.sourceKey, row.active])
      ).toEqual(before)
    }
  })

  it('accepts an artist that only ever had singles', async () => {
    const h = harness()
    const artistId = 'channel:artist-1'
    fullDiscography(h, artistId, credit.channelId)
    h.catalog.releases.set('single', release('single', song('only')))
    h.catalog.refs = [ref('single', 'singles')]
    const check = () =>
      checkArtistCatalog({
        db: h.db,
        catalog: h.catalog,
        artistId,
        channelId: credit.channelId,
        now: () => h.time,
      })
    await check()
    await check()
    expect(h.contributions().filter((row) => row.active)).toHaveLength(1)
  })
})
