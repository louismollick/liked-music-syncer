import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import type { CatalogRelease } from '../../src/main/catalog/types'
import { artists, contributions, tracks } from '../../src/main/library/schema'
import { releaseIdentityKey } from '../../src/main/match/types'
import {
  type CatalogRaw,
  checkLikedSongs,
  linkContributions,
} from '../../src/main/reconcile/sources'
import {
  deleteTracks,
  processTombstones,
  runMatch,
} from '../../src/main/reconcile/steps'
import { credit, Harness, release, releaseMatch, song } from './harness'

const open: Harness[] = []
function harness() {
  const h = new Harness()
  open.push(h)
  h.settings.remoteEnabled = false
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

const ARTIST = 'channel:artist-1'
const run = () => ({ signal: new AbortController().signal, progress: () => {} })

function catalogs(h: Harness) {
  const album = release('album', song('cv', 'Song'))
  const single = release('single', song('sv', 'Song'))
  h.catalog.releases.set(album.browseId, album)
  h.catalog.releases.set(single.browseId, single)
  return { album, single }
}

function fullDiscography(h: Harness, album: CatalogRelease, id = ARTIST) {
  h.catalog.refs = [
    {
      browseId: album.browseId,
      title: album.title,
      shelf: 'albums',
      year: 2024,
      thumbnailUrl: null,
    },
  ]
  h.db
    .insert(artists)
    .values({
      id,
      name: credit.name,
      channelId: id.replace('channel:', ''),
      fullDiscography: true,
    })
    .run()
}

/** Every active catalog contribution sits on the track with its own key. */
function expectCatalogInvariant(h: Harness) {
  for (const row of h.contributions()) {
    if (row.kind !== 'catalog' || !row.active) continue
    const track = h.rows().find((t) => t.id === row.trackId)
    expect(track?.identityKey).toBe(
      releaseIdentityKey(row.releaseId!, row.sourceVideoId)
    )
  }
}

/** A like checked and linked without matching, as the worker would find it. */
async function unmatchedLike(h: Harness, videoId: string) {
  h.catalog.likes = [song(videoId, 'Song')]
  await checkLikedSongs({
    db: h.db,
    catalog: h.catalog,
    accountId: h.account!,
    stillCurrent: () => true,
    now: () => h.time,
  })
  linkContributions(h.db, () => h.time)
  return h.rows().find((row) => row.identityKey === null)!
}

function catalogRow(h: Harness, trackId: string, album: CatalogRelease) {
  const raw: CatalogRaw = {
    kind: 'catalog',
    artistId: ARTIST,
    shelf: 'albums',
    release: {
      ...album,
      tracks: undefined,
    } as unknown as CatalogRaw['release'],
    track: album.tracks[0],
  }
  h.db
    .insert(contributions)
    .values({
      id: `catalog-${trackId}`,
      sourceKey: `catalog:${ARTIST}:${album.browseId}:${album.tracks[0].videoId}`,
      kind: 'catalog',
      artistId: ARTIST,
      trackId,
      sourceVideoId: album.tracks[0].videoId,
      releaseId: album.browseId,
      firstSeenAt: h.time.toISOString(),
      lastSeenAt: h.time.toISOString(),
      active: true,
      raw: JSON.stringify(raw),
    })
    .run()
}

describe('a catalog keeps its exact Release Track', () => {
  it('keeps a shared like and catalog track on the album through Refresh', async () => {
    const h = harness()
    const { album, single } = catalogs(h)
    fullDiscography(h, album)
    const like = song('lv', 'Song')
    h.matcher.matches.set('lv', releaseMatch(like, album, 'cv'))
    h.catalog.likes = [like]
    await h.start()
    const shared = h.row('album:cv')!
    expect(h.rows()).toHaveLength(1)
    expect(h.downloads).toEqual(['cv'])

    // The matcher would now file the like on the single.
    h.matcher.matches.set('lv', releaseMatch(like, single, 'sv'))
    h.reconciler.refresh({ kind: 'track', id: shared.id })
    await h.idle()
    expect(h.row('album:cv')?.id).toBe(shared.id)
    expect(h.file(shared.id)?.audioVideoId).toBe('cv')
    expect(h.downloads).toEqual(['cv'])
    expectCatalogInvariant(h)
  })

  it('re-keys a remaining like once the catalog no longer wants the track', async () => {
    const h = harness()
    const { album, single } = catalogs(h)
    fullDiscography(h, album)
    const like = song('lv', 'Song')
    h.matcher.matches.set('lv', releaseMatch(like, album, 'cv'))
    h.catalog.likes = [like]
    await h.start()
    const shared = h.row('album:cv')!
    h.reconciler.setFullDiscography(ARTIST, false)
    await h.idle()
    h.matcher.matches.set('lv', releaseMatch(like, single, 'sv'))
    h.reconciler.refresh({ kind: 'track', id: shared.id })
    await h.idle()
    expect(h.rows().find((row) => row.id === shared.id)?.identityKey).toBe(
      'single:sv'
    )
    expect(h.downloads).toEqual(['cv', 'sv'])
  })

  it('merges a new like into the catalog track it resolves to', async () => {
    const h = harness()
    const { album } = catalogs(h)
    fullDiscography(h, album)
    await h.start()
    const like = song('lv', 'Song')
    h.matcher.matches.set('lv', releaseMatch(like, album, 'cv'))
    h.catalog.likes = [like]
    await h.check()
    expect(h.rows()).toHaveLength(1)
    expect(
      h.contributions().every((row) => row.trackId === h.rows()[0].id)
    ).toBe(true)
    expect(h.downloads).toEqual(['cv'])
  })

  it('discards a match when a catalog contribution arrives mid-lookup', async () => {
    const h = harness()
    const { album, single } = catalogs(h)
    const track = await unmatchedLike(h, 'lv')
    h.matcher.matches.set('lv', releaseMatch(song('lv', 'Song'), single, 'sv'))
    let added = false
    h.matcher.during = () => {
      if (added) return
      added = true
      catalogRow(h, track.id, album)
    }
    await runMatch(h.deps, track, run())
    expect(h.matcher.calls).toBe(2)
    expect(h.rows().find((row) => row.id === track.id)?.identityKey).toBe(
      'album:cv'
    )
    expectCatalogInvariant(h)
  })

  it('discards a match when its catalog contribution goes away mid-lookup', async () => {
    const h = harness()
    const { album, single } = catalogs(h)
    const track = await unmatchedLike(h, 'lv')
    catalogRow(h, track.id, album)
    h.matcher.matches.set('lv', releaseMatch(song('lv', 'Song'), single, 'sv'))
    h.matcher.during = (input) => {
      if (input.kind !== 'catalog') return
      h.db
        .update(contributions)
        .set({ active: false })
        .where(eq(contributions.kind, 'catalog'))
        .run()
    }
    await runMatch(h.deps, track, run())
    expect(h.rows().find((row) => row.id === track.id)?.identityKey).toBe(
      'single:sv'
    )
  })

  it('drops a lookup for a track the user stopped managing meanwhile', async () => {
    const h = harness()
    catalogs(h)
    const track = await unmatchedLike(h, 'lv')
    h.matcher.during = () => h.reconciler.stopManaging(track.id)
    await runMatch(h.deps, track, run())
    const row = h.rows().find((t) => t.id === track.id)!
    expect(row.state).toBe('released')
    expect(row.match).toBeNull()
    expect(h.downloads).toEqual([])
  })

  it('records new sources of a stopped-managing Release Track without reviving it', async () => {
    const h = harness()
    const { album } = catalogs(h)
    fullDiscography(h, album)
    await h.start()
    const kept = h.row('album:cv')!
    h.reconciler.stopManaging(kept.id)
    await h.idle()

    // A new like resolving to it.
    const like = song('lv', 'Song')
    h.matcher.matches.set('lv', releaseMatch(like, album, 'cv'))
    h.catalog.likes = [like]
    // And a second Full Discography artist whose catalog lists it.
    fullDiscography(h, album, 'channel:artist-2')
    await h.reconciler.check({ catalogs: 'all' })
    await h.idle()

    expect(h.rows()).toHaveLength(1)
    const row = h.rows()[0]
    expect(row.id).toBe(kept.id)
    expect(row.state).toBe('released')
    expect(h.file(kept.id)).toBeUndefined()
    expect(h.downloads).toEqual(['cv'])
    expect(
      h.contributions().filter((c) => c.active && c.trackId === kept.id)
    ).toHaveLength(3)
  })

  it('waits for a pending delete before reusing a No Longer Wanted Release Track', async () => {
    const h = harness()
    const { album } = catalogs(h)
    const first = song('lv', 'Song')
    h.matcher.matches.set('lv', releaseMatch(first, album, 'cv'))
    h.catalog.likes = [first]
    await h.start()
    const old = h.row('album:cv')!
    h.catalog.likes = []
    h.catalog.declaredCount = 0
    await h.check()
    await h.stop()
    expect(h.rows()[0].state).toBe('no_longer_wanted')
    deleteTracks(h.deps, [old.id], 'local')

    const again = await unmatchedLike(h, 'lv2')
    h.matcher.matches.set('lv2', releaseMatch(song('lv2', 'Song'), album, 'cv'))
    await expect(runMatch(h.deps, again, run())).rejects.toMatchObject({
      kind: 'transient',
    })
    expect(h.rows().find((t) => t.id === old.id)?.state).toBe(
      'no_longer_wanted'
    )

    await processTombstones(h.deps, new AbortController().signal)
    expect(
      h.db.select().from(tracks).where(eq(tracks.id, old.id)).get()
    ).toBeUndefined()
    const reloaded = h.rows().find((t) => t.id === again.id)!
    await runMatch(h.deps, reloaded, run())
    expect(h.rows().find((t) => t.id === again.id)?.identityKey).toBe(
      'album:cv'
    )
  })
})
