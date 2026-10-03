import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createYouTubeMusicCatalog } from '../../src/main/catalog/catalog'
import { restoreReleaseAudio } from '../../src/main/catalog/parsers/audio-playlist'
import type { CatalogReleaseRef } from '../../src/main/catalog/types'
import { artists, tracks } from '../../src/main/library/schema'
import {
  type CatalogRaw,
  checkArtistCatalog,
  linkContributions,
  SuspiciousSnapshotError,
  updateWantedStates,
} from '../../src/main/reconcile/sources'
import { deleteTracks, processTombstones } from '../../src/main/reconcile/steps'
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
  it('restores an OMV in place when its playlist later supplies separate audio', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    fullDiscography(h, 'channel:artist-1', credit.channelId)
    const album = {
      ...release('album', {
        ...song('video', 'Song'),
        videoType: 'OMV' as const,
      }),
      audioPlaylistId: 'audio-playlist',
    }
    const playlist = (videoId: string) => ({
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  sectionListRenderer: {
                    contents: [
                      {
                        itemSectionRenderer: {
                          contents: [
                            {
                              lockupViewModel: {
                                contentId: videoId,
                                metadata: {
                                  lockupMetadataViewModel: {
                                    title: { content: 'Song' },
                                  },
                                },
                                rendererContext: {
                                  commandContext: {
                                    onTap: {
                                      innertubeCommand: {
                                        watchEndpoint: {
                                          videoId,
                                          playlistId: 'audio-playlist',
                                          index: 0,
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    })
    h.catalog.releases.set(
      'album',
      await restoreReleaseAudio(playlist('video'), album)
    )
    h.catalog.refs = [ref('album', 'albums')]
    await h.start()
    const id = h.row('album:video')!.id
    const contributionId = h.contributions()[0].id
    h.catalog.releases.set(
      'album',
      await restoreReleaseAudio(playlist('audio'), album)
    )
    await h.reconciler.check({ catalogs: 'all' })
    await h.idle()
    expect(h.rows()).toHaveLength(1)
    expect(h.row('album:audio')).toMatchObject({ id, state: 'done' })
    expect(h.contributions()).toHaveLength(1)
    expect(h.contributions()[0]).toMatchObject({
      id: contributionId,
      trackId: id,
      sourceVideoId: 'audio',
    })
    expect(h.downloads).toEqual(['video', 'audio'])
  })
  it('finishes a pending deletion before restoring re-enabled catalog audio', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const artistId = 'channel:artist-1'
    fullDiscography(h, artistId, credit.channelId)
    h.catalog.releases.set(
      'album',
      release('album', { ...song('video', 'Song'), videoType: 'OMV' })
    )
    h.catalog.refs = [ref('album', 'albums')]
    await h.start()
    const id = h.rows()[0].id
    h.reconciler.setFullDiscography(artistId, false)
    await h.idle()
    await h.stop()
    deleteTracks(h.deps, [id], 'local')
    h.db
      .update(artists)
      .set({ fullDiscography: true })
      .where(eq(artists.id, artistId))
      .run()
    h.catalog.releases.set('album', release('album', song('audio', 'Song')))
    for (let check = 0; check < 2; check++) {
      await checkArtistCatalog({
        db: h.db,
        catalog: h.catalog,
        artistId,
        channelId: credit.channelId,
      })
      linkContributions(h.db)
      updateWantedStates(h.db, {
        accountId: null,
        fullDiscographyArtistIds: [artistId],
      })
      expect(h.rows()).toHaveLength(1)
      expect(h.rows()[0]).toMatchObject({
        id,
        state: 'no_longer_wanted',
        refreshRequested: true,
      })
      expect(h.contributions()[0].trackId).toBe(id)
      expect(h.downloads).toEqual(['video'])
    }
    await processTombstones(h.deps, new AbortController().signal)
    await h.start()
    expect(h.rows()).toHaveLength(1)
    expect(h.rows()[0]).toMatchObject({
      id,
      state: 'done',
      identityKey: 'album:audio',
    })
    expect(h.file(id)?.audioVideoId).toBe('audio')
    expect(h.downloads).toEqual(['video', 'audio'])
  })
  it('restores an inactive catalog contribution after Full Discography is re-enabled', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const artistId = 'channel:artist-1'
    fullDiscography(h, artistId, credit.channelId)
    h.catalog.releases.set(
      'album',
      release('album', { ...song('video', 'Song'), videoType: 'OMV' })
    )
    h.catalog.refs = [ref('album', 'albums')]
    await h.start()
    const id = h.rows()[0].id
    h.reconciler.setFullDiscography(artistId, false)
    await h.idle()
    expect(h.contributions()[0].active).toBe(false)
    expect(h.rows()[0].state).toBe('no_longer_wanted')
    h.catalog.releases.set('album', release('album', song('audio', 'Song')))
    h.reconciler.setFullDiscography(artistId, true)
    await h.idle()
    await h.reconciler.check({ catalogs: 'all' })
    await h.idle()
    expect(h.rows()).toHaveLength(1)
    expect(h.rows()[0]).toMatchObject({
      id,
      state: 'done',
      identityKey: 'album:audio',
    })
    expect(h.contributions()).toHaveLength(1)
    expect(h.contributions()[0]).toMatchObject({ active: true, trackId: id })
    expect(h.downloads).toEqual(['video', 'audio'])
  })
  it.each([
    'released',
    'no_longer_wanted',
  ] as const)('preserves track continuity over repeated audio changes checks for %s tracks', async (state) => {
    const h = harness()
    h.settings.remoteEnabled = false
    fullDiscography(h, 'channel:artist-1', credit.channelId)
    h.catalog.releases.set(
      'album',
      release('album', { ...song('video', 'Song'), videoType: 'OMV' })
    )
    h.catalog.refs = [ref('album', 'albums')]
    await h.start()
    const id = h.rows()[0].id
    if (state === 'released') h.reconciler.stopManaging(id)
    else h.db.update(tracks).set({ state }).where(eq(tracks.id, id)).run()
    h.catalog.releases.set('album', release('album', song('audio', 'Song')))
    for (let check = 0; check < 2; check++) {
      await h.reconciler.check({ catalogs: 'all' })
      await h.idle()
    }
    expect(h.rows()).toHaveLength(1)
    expect(h.rows()[0]).toMatchObject({
      id,
      state: state === 'released' ? 'released' : 'done',
    })
    expect(h.contributions()[0].trackId).toBe(id)
    expect(h.downloads).toEqual(
      state === 'released' ? ['video'] : ['video', 'audio']
    )
  })
  it('restores original audio on the existing catalog track without creating duplicates', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    fullDiscography(h, 'channel:artist-1', credit.channelId)
    const video = { ...song('music-video', 'Song'), videoType: 'OMV' as const }
    h.catalog.releases.set('album', release('album', video))
    h.catalog.refs = [ref('album', 'albums')]
    await h.start()
    const originalId = h.rows()[0].id
    const contributionId = h.contributions()[0].id
    expect(h.rows()[0].state).toBe('done')

    h.catalog.releases.set(
      'album',
      release('album', song('original-audio', 'Song'))
    )
    await h.reconciler.check({ catalogs: 'all' })
    await h.idle()
    expect(h.rows()).toHaveLength(1)
    expect(h.rows()[0]).toMatchObject({
      id: originalId,
      identityKey: 'album:original-audio',
      state: 'done',
    })
    expect(h.contributions()).toHaveLength(1)
    expect(h.contributions()[0]).toMatchObject({
      id: contributionId,
      trackId: originalId,
      sourceVideoId: 'original-audio',
      active: true,
    })
    expect(h.file(originalId)?.audioVideoId).toBe('original-audio')
    expect(h.downloads).toEqual(['music-video', 'original-audio'])
  })
  it('adds album tracks from the Albums shelf, including year-only cards', async () => {
    const h = harness()
    const artistId = `channel:${TRICOT}`
    fullDiscography(h, artistId, TRICOT)
    const catalog = createYouTubeMusicCatalog({
      async call(request) {
        const id = request.body.browseId
        if (id === TRICOT) return fixture('artist')
        if (request.body.params && request.client !== 'WEB')
          return fixture('artist-singles-more')
        if (id === 'MPREb_I8W8NXwKIap') return fixture('release-fudeki')
        if (id === 'MPREb_c90oyiIKrXn') return fixture('release-jodeki')
        if (id === 'VLOLAK5uy_mwHjByzWZRpiwWmmVI7O9lxeFIW6wNQ1M')
          return fixture('release-fudeki-audio')
        if (id === 'VLOLAK5uy_ndKXwdzJGooHSVq_hijdTx9UOl5qLVvPs')
          return fixture('release-jodeki-audio')
        if (request.client === 'WEB') return fixture('album-audio')
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
