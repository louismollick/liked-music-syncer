import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { onDiskRelative } from '../../src/main/inventory/files'
import { adoptFiles } from '../../src/main/inventory/inventory'
import { LibraryQueries } from '../../src/main/library/queries'
import {
  artists,
  contributions,
  files,
  tombstones,
  tracks,
  uploads,
} from '../../src/main/library/schema'
import { checkArtistCatalog } from '../../src/main/reconcile/sources'
import {
  deleteTracks,
  processTombstones,
  targetKey,
} from '../../src/main/reconcile/steps'
import { credit, Harness, release, song } from './harness'

const open: Harness[] = []
function harness() {
  const h = new Harness()
  h.settings.remoteEnabled = false
  open.push(h)
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

function inventoryDeps(h: Harness) {
  return {
    db: h.db,
    coversDir: path.join(h.userData, 'covers'),
    now: () => h.time,
  }
}

function unwant(h: Harness, trackId: string) {
  h.db
    .update(contributions)
    .set({ active: false })
    .where(eq(contributions.trackId, trackId))
    .run()
  h.db
    .update(tracks)
    .set({ state: 'no_longer_wanted' })
    .where(eq(tracks.id, trackId))
    .run()
}

describe('third review fixes', () => {
  it('records the on-disk spelling when a folder differs only in case', async () => {
    const h = harness()
    mkdirSync(path.join(h.library, 'Ne-Yo', 'Album2'), { recursive: true })
    writeFileSync(path.join(h.library, 'Ne-Yo', 'Album2', '01 x.m4a'), 'a')
    const caseInsensitive = existsSync(path.join(h.library, 'NE-YO'))
    const recorded = await onDiskRelative(h.library, 'NE-YO/Album2/01 x.m4a')
    expect(recorded).toBe(
      caseInsensitive ? 'Ne-Yo/Album2/01 x.m4a' : 'NE-YO/Album2/01 x.m4a'
    )
    expect(await onDiskRelative(h.library, 'missing/file.m4a')).toBe(
      'missing/file.m4a'
    )
  })

  it('does not re-adopt a managed file whose record differs only in case', async () => {
    const h = harness()
    h.catalog.likes = [song('cased', 'Cased')]
    await h.start()
    await h.stop()
    const track = h.rows()[0]
    const onDisk = h.file(track.id)!.relativePath
    h.db
      .update(files)
      .set({ relativePath: onDisk.toUpperCase() })
      .where(eq(files.trackId, track.id))
      .run()
    await adoptFiles(inventoryDeps(h), h.library)
    expect(h.db.select().from(tracks).all()).toHaveLength(1)
    expect(h.db.select().from(files).all()).toHaveLength(1)
  })

  it('never deletes a local file owned under a different spelling', async () => {
    const h = harness()
    h.catalog.likes = [song('owned', 'Owned')]
    await h.start()
    await h.stop()
    const file = h.file(h.rows()[0].id)!
    h.db
      .insert(tombstones)
      .values({
        id: randomUUID(),
        kind: 'local',
        path: file.relativePath.toUpperCase(),
        reason: 'old owner',
        createdAt: h.time.toISOString(),
      })
      .run()
    await processTombstones(h.deps, new AbortController().signal)
    expect(existsSync(path.join(h.library, file.relativePath))).toBe(true)
  })

  it('keeps a stopped-managing track out of Refresh', async () => {
    const h = harness()
    h.catalog.likes = [song('kept', 'Kept')]
    await h.start()
    const track = h.rows()[0]
    h.reconciler.stopManaging(track.id)
    h.reconciler.refresh({ kind: 'all' })
    await h.idle()
    expect(h.downloads).toHaveLength(1)
    expect(
      h.db.select().from(tracks).where(eq(tracks.id, track.id)).get()?.state
    ).toBe('released')
  })

  it('does not bring a No Longer Wanted track back through Retry', async () => {
    const h = harness()
    h.catalog.likes = [song('gone', 'Gone')]
    await h.start()
    const track = h.rows()[0]
    unwant(h, track.id)
    h.reconciler.retry(track.id)
    await h.idle()
    expect(h.downloads).toHaveLength(1)
    expect(
      h.db.select().from(tracks).where(eq(tracks.id, track.id)).get()?.state
    ).toBe('no_longer_wanted')
  })

  it('discards a catalog that finishes after the artist was un-favorited', async () => {
    const h = harness()
    const album = release('release-x', song('cat-1'), song('cat-2'))
    h.catalog.releases.set(album.browseId, album)
    h.catalog.refs = [
      {
        browseId: album.browseId,
        title: album.title,
        kindLabel: 'Album',
        year: 2024,
        thumbnailUrl: null,
      },
    ]
    h.db
      .insert(artists)
      .values({
        id: 'channel:artist-1',
        name: credit.name,
        channelId: credit.channelId,
        favorite: true,
      })
      .run()
    const releaseOf = h.catalog.release.bind(h.catalog)
    h.catalog.release = async (id: string) => {
      // The user un-favorites while the releases are still loading.
      h.db
        .update(artists)
        .set({ favorite: false })
        .where(eq(artists.id, 'channel:artist-1'))
        .run()
      return releaseOf(id)
    }
    await checkArtistCatalog({
      db: h.db,
      catalog: h.catalog,
      artistId: 'channel:artist-1',
      channelId: credit.channelId,
      now: () => h.time,
    })
    expect(h.contributions().filter((row) => row.active)).toHaveLength(0)
  })

  it('keeps a track that was liked again before its tombstones finished', async () => {
    const h = harness()
    h.catalog.likes = [song('again', 'Again')]
    await h.start()
    await h.stop()
    const track = h.rows()[0]
    unwant(h, track.id)
    deleteTracks(h.deps, [track.id], 'local')
    // Liked again before the delete ran; the new download hasn't happened yet.
    h.db
      .update(contributions)
      .set({ active: true })
      .where(eq(contributions.trackId, track.id))
      .run()
    h.db
      .update(tracks)
      .set({ state: 'pending' })
      .where(eq(tracks.id, track.id))
      .run()
    await processTombstones(h.deps, new AbortController().signal)
    expect(
      h.db.select().from(tracks).where(eq(tracks.id, track.id)).get()
    ).toBeDefined()
  })

  it('never moves or deletes a remote object another track owns under a different spelling', async () => {
    const h = harness()
    h.settings.remoteEnabled = true
    h.catalog.likes = [song('mover', 'Mover')]
    await h.start()
    await h.stop()
    const track = h.rows()[0]
    // Our record points at an old path that another track now owns
    // (spelled differently, which is the same object on case-insensitive remotes).
    const oldPath = 'Old Artist/Old.m4a'
    mkdirSync(path.join(h.remote, 'Old Artist'), { recursive: true })
    writeFileSync(path.join(h.remote, oldPath), 'someone else')
    h.db
      .update(uploads)
      .set({ remotePath: oldPath })
      .where(eq(uploads.trackId, track.id))
      .run()
    h.db
      .insert(uploads)
      .values({
        trackId: 'other-track',
        remoteTarget: targetKey({ remote: ':local', folder: h.remote }),
        remotePath: oldPath.toUpperCase(),
        uploadedAt: h.time.toISOString(),
      })
      .run()
    await h.start()
    await h.idle()
    expect(existsSync(path.join(h.remote, oldPath))).toBe(true)
    expect(
      h.db.select().from(uploads).where(eq(uploads.trackId, track.id)).get()
        ?.remotePath
    ).toBe(h.file(track.id)!.relativePath)
  })

  it('counts and filters Needs Attention the same way', async () => {
    const h = harness()
    h.catalog.likes = [song('edited', 'Edited')]
    await h.start()
    const track = h.rows()[0]
    h.db
      .update(files)
      .set({ outsideEdit: JSON.stringify(['tags']) })
      .where(eq(files.trackId, track.id))
      .run()
    const q = new LibraryQueries(
      h.db,
      () => null,
      () => null,
      () => h.settings
    )
    expect(q.counts().needsAttention).toBe(1)
    expect(
      q.songs({ filters: { state: 'needs_attention' } }).rows.map((r) => r.id)
    ).toEqual([track.id])
  })
})
