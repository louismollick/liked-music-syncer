import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryQueries } from '../../src/main/library/queries'
import {
  contributions,
  files,
  trackArtists,
  tracks,
  uploads,
} from '../../src/main/library/schema'
import { albumKey } from '../../src/main/reconcile/reconciler'
import { Harness, release, releaseMatch, song } from '../reconcile/harness'

const open: Harness[] = []
function harness() {
  const h = new Harness()
  open.push(h)
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

async function seeded() {
  const h = harness()
  const first = song('album-first', 'First', 0)
  const second = song('album-second', 'Second', 1)
  const album = release('release-1', first, second)
  h.matcher.matches.set(first.videoId, releaseMatch(first, album))
  h.matcher.matches.set(second.videoId, releaseMatch(second, album))
  h.catalog.likes = [
    first,
    second,
    song('plain', 'Plain', 2),
    song('attention', 'Attention', 3),
  ]
  await h.start()
  await h.stop()
  const byKey = (key: string) => h.row(key)!
  const firstRow = byKey('release-1:album-first')
  const secondRow = byKey('release-1:album-second')
  const plain = byKey('video:plain')
  const attention = byKey('video:attention')
  h.db
    .update(tracks)
    .set({ lyricsStatus: 'synced' })
    .where(eq(tracks.id, firstRow.id))
    .run()
  h.db
    .update(tracks)
    .set({ lyricsStatus: 'plain', state: 'no_longer_wanted' })
    .where(eq(tracks.id, plain.id))
    .run()
  h.db
    .update(tracks)
    .set({ state: 'needs_attention' })
    .where(eq(tracks.id, attention.id))
    .run()
  h.db
    .update(uploads)
    .set({ localSha256: 'stale' })
    .where(eq(uploads.trackId, secondRow.id))
    .run()
  h.db.delete(uploads).where(eq(uploads.trackId, plain.id)).run()
  h.db
    .update(contributions)
    .set({ firstSeenAt: '2026-09-24T00:00:00.000Z' })
    .where(eq(contributions.trackId, firstRow.id))
    .run()
  h.db
    .update(contributions)
    .set({ firstSeenAt: '2026-09-25T00:00:00.000Z' })
    .where(eq(contributions.trackId, secondRow.id))
    .run()
  h.db
    .update(contributions)
    .set({ firstSeenAt: '2026-09-23T00:00:00.000Z' })
    .where(eq(contributions.trackId, plain.id))
    .run()
  h.db
    .update(contributions)
    .set({ firstSeenAt: '2026-09-22T00:00:00.000Z' })
    .where(eq(contributions.trackId, attention.id))
    .run()
  const catalog = {
    ...plain,
    id: 'catalog-only',
    identityKey: 'video:catalog-only',
    title: 'Catalog Only',
    state: 'done',
    lyricsStatus: 'none',
  }
  h.db.insert(tracks).values(catalog).run()
  h.db
    .insert(files)
    .values({
      ...h.file(plain.id)!,
      trackId: catalog.id,
      relativePath: 'Test Artist/Catalog Only/Catalog Only.m4a',
    })
    .run()
  h.db
    .insert(trackArtists)
    .values({ trackId: catalog.id, artistId: 'channel:artist-1', position: 0 })
    .run()
  const q = new LibraryQueries(
    h.db,
    () => null,
    () => null,
    () => h.settings
  )
  return { h, q, firstRow, secondRow, plain, attention, catalog }
}

describe('LibraryQueries', () => {
  it('filters lyrics, remote state, and track state', async () => {
    const { q, firstRow, secondRow, plain, attention } = await seeded()
    const ids = (filters: Parameters<typeof q.songs>[0]['filters']) =>
      q.songs({ filters }).rows.map((row) => row.id)
    expect(ids({ lyrics: 'synced' })).toEqual([firstRow.id])
    expect(ids({ lyrics: 'plain' })).toEqual([plain.id])
    expect(ids({ remote: 'stale' })).toEqual([secondRow.id])
    expect(ids({ remote: 'missing' })).toEqual([plain.id, 'catalog-only'])
    expect(ids({ remote: 'in_sync' })).toHaveLength(2)
    expect(ids({ state: 'needs_attention' })).toEqual([attention.id])
    expect(ids({ state: 'no_longer_wanted' })).toEqual([plain.id])
  })

  it('sorts by liked date with catalog-only songs last', async () => {
    const { q, firstRow, secondRow, plain, attention, catalog } = await seeded()
    expect(q.songs({ sort: 'liked' }).rows.map((row) => row.id)).toEqual([
      secondRow.id,
      firstRow.id,
      plain.id,
      attention.id,
      catalog.id,
    ])
    expect(q.songs({ sort: 'liked', limit: 2, offset: 1 })).toMatchObject({
      total: 5,
      rows: [{ id: firstRow.id }, { id: plain.id }],
    })
  })

  it('orders album tracks and shows an artist’s albums and standalone songs', async () => {
    const { q, firstRow, secondRow, plain, attention, catalog } = await seeded()
    const detail = q.album(albumKey('Test Album', 'Test Artist'))!
    expect(detail.tracks.map((row) => row.id)).toEqual([
      firstRow.id,
      secondRow.id,
    ])
    const artist = q.artist('channel:artist-1')!
    expect(artist.albums.map((row) => row.key)).toEqual([detail.album.key])
    expect(artist.standalone.map((row) => row.id)).toEqual(
      expect.arrayContaining([plain.id, attention.id, catalog.id])
    )
    expect(artist.artist.songCount).toBe(5)
  })

  it('searches across songs, albums, and artists and reports counts', async () => {
    const { q } = await seeded()
    expect(q.search('First').songs.map((row) => row.title)).toEqual(['First'])
    expect(q.search('Test Album').albums.map((row) => row.title)).toEqual([
      'Test Album',
    ])
    expect(q.search('Test Artist').artists.map((row) => row.name)).toEqual([
      'Test Artist',
    ])
    expect(q.counts()).toMatchObject({
      songs: 5,
      artists: 1,
      albums: 1,
      needsAttention: 1,
      noLongerWanted: 1,
    })
  })
})
