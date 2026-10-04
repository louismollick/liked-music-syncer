import { cpSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArtistPages, fetchArtistPage } from '../../src/main/artist-pages'
import {
  type CatalogArtist,
  CatalogShapeError,
} from '../../src/main/catalog/types'
import { adoptFiles, matchFromTags } from '../../src/main/inventory/inventory'
import {
  canonicalArtist,
  canonicalTrackNames,
  linkTrackArtists,
  recomputeArtistNames,
} from '../../src/main/library/artists'
import {
  artists,
  contributions,
  sourceSnapshots,
  trackArtists,
  tracks,
} from '../../src/main/library/schema'
import { HttpError } from '../../src/main/net/http'
import { desiredTagFields } from '../../src/main/reconcile/desired'
import {
  catalogSnapshotSource,
  catalogSourceKey,
  checkArtistCatalog,
} from '../../src/main/reconcile/sources'
import {
  nextStep,
  RetryLaterError,
  runMatch,
} from '../../src/main/reconcile/steps'
import { emptyLmsFields, readTags } from '../../src/main/tags/schema'
import { Harness, release, releaseMatch, song } from './harness'

const open: Harness[] = []
const harness = () => {
  const h = new Harness()
  open.push(h)
  h.settings.remoteEnabled = false
  return h
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of open.splice(0)) await h.close()
})

function page(
  channelId: string,
  name: string,
  primaryChannelId = channelId
): CatalogArtist {
  return {
    channelId,
    primaryChannelId,
    name,
    thumbnailUrl: null,
    albums: [],
    singles: [],
    albumsMore: null,
    singlesMore: null,
  }
}
const stepRun = () => ({
  signal: new AbortController().signal,
  progress: () => {},
})

function seedTrack(
  h: Harness,
  id: string,
  channelId: string,
  name = channelId
) {
  const source = { ...song(id), artists: [{ name, channelId }] }
  const album = release(`album-${id}`, source)
  album.artists = source.artists
  const match = releaseMatch(source, album)
  h.db
    .insert(tracks)
    .values({
      id,
      title: id,
      artist: name,
      albumArtist: name,
      artistCredits: JSON.stringify(source.artists),
      match: JSON.stringify(match),
      createdAt: h.time.toISOString(),
      updatedAt: h.time.toISOString(),
    })
    .run()
  linkTrackArtists(h.db, id, source.artists)
  return match
}

function seedContribution(
  h: Harness,
  id: string,
  artistId: string,
  trackId: string,
  videoId = trackId
) {
  h.db
    .insert(contributions)
    .values({
      id,
      sourceKey: catalogSourceKey(artistId, 'release', videoId),
      kind: 'catalog',
      artistId,
      trackId,
      releaseId: 'release',
      sourceVideoId: videoId,
      firstSeenAt: '2026-01-01',
      lastSeenAt: '2026-02-01',
      raw: JSON.stringify({ kind: 'catalog', artistId }),
    })
    .run()
}

describe('canonical artist pages', () => {
  it.each([
    new CatalogShapeError('unreadable page'),
    new HttpError('missing channel', 'permanent', 404),
    new HttpError('terminated channel', 'permanent', 410),
  ])('checkpoints a permanent page failure: %s', async (error) => {
    const h = harness()
    const match = seedTrack(h, 'fallback', 'missing', 'Credit name')
    h.catalog.artistError = error
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pages = createArtistPages({
      db: h.db,
      catalog: h.catalog,
      onUpdated: () => {},
    })
    expect(await pages.run()).toBe(false)
    expect(canonicalArtist(h.db, 'channel:missing')).toMatchObject({
      name: 'Credit name',
      nativeName: null,
      primaryChannelId: 'missing',
      pageCheckedAt: expect.any(String),
    })
    expect(canonicalTrackNames(h.db, h.rows()[0], match)).toEqual({
      artist: 'Credit name',
      albumArtist: 'Credit name',
    })
    expect(nextStep(h.db, h.rows()[0], undefined, undefined, h.settings)).toBe(
      'acquire'
    )
    expect(log).toHaveBeenCalledOnce()
    h.catalog.artistCalls = []
    expect(await pages.run()).toBe(false)
    expect(h.catalog.artistCalls).toEqual([])
    await pages.stop()
  })

  it.each([
    'en',
    'ja',
  ])('matches using the credit name after a permanent %s failure', async (language) => {
    const h = harness()
    h.catalog.likes = [song('fallback-match')]
    const real = h.catalog.artist.bind(h.catalog)
    vi.spyOn(h.catalog, 'artist').mockImplementation(async (id, signal, hl) => {
      if (hl === language) throw new CatalogShapeError('unreadable page')
      return real(id, signal, hl)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await h.start()
    expect(h.rows()[0]).toMatchObject({
      artist: 'Test Artist',
      albumArtist: 'Test Artist',
      attempts: 0,
      state: 'done',
    })
    expect(h.downloads).toEqual(['fallback-match'])
  })

  it.each([
    new Error('network error'),
    new HttpError('server error', 'transient', 503),
    new HttpError('rate limited', 'transient', 429),
    new DOMException('aborted', 'AbortError'),
  ])('leaves transient page failures eligible to retry: %s', async (error) => {
    const h = harness()
    const match = seedTrack(h, 'retry', 'retry', 'Credit name')
    h.catalog.artistError = error
    await expect(
      fetchArtistPage(h.db, h.catalog, {
        name: 'Credit name',
        channelId: 'retry',
      })
    ).rejects.toBe(error)
    expect(canonicalArtist(h.db, 'channel:retry')?.pageCheckedAt).toBeNull()
    expect(canonicalTrackNames(h.db, h.rows()[0], match)).toBeNull()
    expect(
      nextStep(h.db, h.rows()[0], undefined, undefined, h.settings)
    ).toBeNull()
    h.catalog.artistError = null
    await fetchArtistPage(h.db, h.catalog, {
      name: 'Credit name',
      channelId: 'retry',
    })
    expect(canonicalArtist(h.db, 'channel:retry')?.pageCheckedAt).not.toBeNull()
  })

  it('does not checkpoint a permanent error if the page request was aborted', async () => {
    const h = harness()
    const controller = new AbortController()
    vi.spyOn(h.catalog, 'artist').mockImplementation(async () => {
      controller.abort()
      throw new CatalogShapeError('unreadable page')
    })
    await expect(
      fetchArtistPage(
        h.db,
        h.catalog,
        { name: 'Credit', channelId: 'aborted' },
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(canonicalArtist(h.db, 'channel:aborted')?.pageCheckedAt).toBeNull()
  })

  it('uses normalized track credits for matching, recomputation, and scheduling', async () => {
    const h = harness()
    const liked = song('normalized')
    liked.artists.push(
      { name: ' Guest ', channelId: null },
      { name: 'Guest', channelId: null }
    )
    const album = release('normalized-album', liked)
    h.catalog.likes = [liked]
    h.matcher.matches.set(liked.videoId, releaseMatch(liked, album))
    await h.start()
    const row = h.rows()[0]
    expect(row.artist).toBe('Test Artist, Guest')
    expect(JSON.parse(row.artistCredits)).toEqual(liked.artists)
    expect(recomputeArtistNames(h.db)).toBe(0)
    expect(nextStep(h.db, row, undefined, undefined, h.settings)).toBe(
      'acquire'
    )
    h.db
      .update(tracks)
      .set({ artist: 'stale' })
      .where(eq(tracks.id, row.id))
      .run()
    expect(recomputeArtistNames(h.db)).toBe(1)
    expect(nextStep(h.db, h.rows()[0], undefined, undefined, h.settings)).toBe(
      'acquire'
    )
  })

  it('preserves a checked survivor page when a differently named alias loads later', async () => {
    const h = harness()
    seedTrack(h, 'own', 'own')
    seedTrack(h, 'topic', 'topic')
    h.db
      .update(artists)
      .set({ fullDiscography: true })
      .where(eq(artists.id, 'channel:own'))
      .run()
    h.catalog.pages.set('own', page('own', 'Survivor name'))
    h.catalog.pages.set('own:ja', page('own', 'Survivor native'))
    h.catalog.pages.set('topic', page('topic', 'Alias name', 'own'))
    h.catalog.pages.set('topic:ja', page('topic', 'Alias native', 'own'))
    await fetchArtistPage(h.db, h.catalog, { name: 'own', channelId: 'own' })
    const survivor = canonicalArtist(h.db, 'channel:own')!
    await fetchArtistPage(h.db, h.catalog, {
      name: 'topic',
      channelId: 'topic',
    })
    expect(canonicalArtist(h.db, 'channel:topic')).toMatchObject({
      id: survivor.id,
      name: 'Survivor name',
      nativeName: 'Survivor native',
      pageCheckedAt: survivor.pageCheckedAt,
    })
    expect(
      h.db.select().from(artists).where(eq(artists.id, 'channel:topic')).get()
    ).toMatchObject({
      name: 'Alias name',
      nativeName: 'Alias native',
      aliasOf: survivor.id,
    })
  })

  it('uses one cached channel name for several credit spellings and keeps raw credits', async () => {
    const h = harness()
    h.catalog.pages.set(
      'artist-1',
      page('artist-1', 'Canonical band', 'official')
    )
    h.catalog.pages.set('artist-1:ja', page('artist-1', 'バンド', 'official'))
    h.catalog.likes = ['BAND', 'Band', 'band'].map((name, index) => ({
      ...song(`v${index}`),
      artists: [{ name, channelId: 'artist-1' }],
    }))
    h.catalog.likes[0].artists.push({
      name: 'Another spelling',
      channelId: 'artist-1',
    })
    await h.start()
    expect(h.rows().map((row) => [row.artist, row.albumArtist])).toEqual(
      Array(3).fill(['Canonical band', 'Canonical band'])
    )
    expect(h.db.select().from(artists).all()).toMatchObject([
      {
        id: 'channel:artist-1',
        name: 'Canonical band',
        nativeName: 'バンド',
        primaryChannelId: 'official',
      },
    ])
    expect(h.catalog.artistCalls).toEqual([
      { channelId: 'artist-1', language: 'en' },
      { channelId: 'artist-1', language: 'ja' },
    ])
    for (const row of h.rows()) {
      const fields = readTags(
        path.join(h.library, h.file(row.id)!.relativePath)
      ).fields
      expect([fields.artist, fields.albumArtist]).toEqual([
        'Canonical band',
        'Canonical band',
      ])
      expect(JSON.parse(row.artistCredits)).toEqual(fields.lms.artistCredits)
      expect(fields.lms.artistCredits[0].name).not.toBe('Canonical band')
    }
  })

  it('merges channels transactionally into the Full Discography row and flattens older aliases', async () => {
    const h = harness()
    seedTrack(h, 'topic-track', 'topic')
    seedTrack(h, 'own-1', 'own')
    seedTrack(h, 'own-2', 'own')
    h.db
      .update(artists)
      .set({ fullDiscography: true, fullDiscographyAt: '2026-01-01' })
      .where(eq(artists.id, 'channel:topic'))
      .run()
    h.db
      .insert(artists)
      .values({
        id: 'channel:old',
        channelId: 'old',
        name: 'old',
        aliasOf: 'channel:own',
      })
      .run()
    // Both rows link the same track; merging keeps the earliest position.
    h.db
      .insert(trackArtists)
      .values({ artistId: 'channel:topic', trackId: 'own-1', position: 2 })
      .run()
    seedContribution(h, 'topic-c', 'channel:topic', 'topic-track')
    seedContribution(h, 'own-c', 'channel:own', 'own-1')
    seedContribution(
      h,
      'duplicate',
      'channel:own',
      'topic-track',
      'topic-track'
    )
    h.db
      .insert(sourceSnapshots)
      .values({
        source: catalogSnapshotSource('channel:own'),
        status: 'ok',
        startedAt: '2026-01-01',
        lastSuccessAt: '2026-01-01',
        itemCount: 2,
      })
      .run()
    h.catalog.pages.set('topic', page('topic', 'Sokoninaru', 'own'))
    await fetchArtistPage(h.db, h.catalog, {
      name: 'topic',
      channelId: 'topic',
    })
    expect(canonicalArtist(h.db, 'channel:own')).toMatchObject({
      id: 'channel:topic',
      fullDiscography: true,
      fullDiscographyAt: '2026-01-01',
      nativeName: null,
    })
    expect(
      h.db.select().from(artists).where(eq(artists.id, 'channel:old')).get()
        ?.aliasOf
    ).toBe('channel:topic')
    expect(h.db.select().from(trackArtists).all()).toHaveLength(3)
    expect(
      h.db
        .select()
        .from(trackArtists)
        .all()
        .every((row) => row.artistId === 'channel:topic')
    ).toBe(true)
    expect(h.contributions()).toHaveLength(2)
    for (const contribution of h.contributions()) {
      expect(contribution.artistId).toBe('channel:topic')
      expect(contribution.sourceKey).toContain('catalog:channel:topic:')
      expect(JSON.parse(contribution.raw).artistId).toBe('channel:topic')
    }
    expect(h.db.select().from(sourceSnapshots).all()).toMatchObject([
      { source: 'catalog:channel:topic', lastSuccessAt: '2026-01-01' },
    ])
    expect(
      h
        .rows()
        .map((row) => row.id)
        .sort()
    ).toEqual(['own-1', 'own-2', 'topic-track'])
    expect(recomputeArtistNames(h.db)).toBe(3)
  })

  it('rolls back page metadata, links, and source desire together if a merge fails', async () => {
    const h = harness()
    seedTrack(h, 'a', 'topic')
    seedTrack(h, 'b', 'own')
    h.db
      .update(artists)
      .set({ fullDiscography: true })
      .where(eq(artists.id, 'channel:topic'))
      .run()
    seedContribution(h, 'own-c', 'channel:own', 'b')
    h.catalog.pages.set('topic', page('topic', 'Band', 'own'))
    h.db.$client.exec(
      "CREATE TRIGGER reject_merge BEFORE UPDATE OF artist_id ON contributions BEGIN SELECT RAISE(ABORT, 'test merge failure'); END"
    )
    await expect(
      fetchArtistPage(h.db, h.catalog, { name: 'topic', channelId: 'topic' })
    ).rejects.toThrow('test merge failure')
    expect(
      h.db
        .select()
        .from(artists)
        .all()
        .every((row) => row.pageCheckedAt === null && row.aliasOf === null)
    ).toBe(true)
    expect(
      h.db
        .select()
        .from(trackArtists)
        .all()
        .map((row) => row.artistId)
        .sort()
    ).toEqual(['channel:own', 'channel:topic'])
    expect(h.contributions()[0].artistId).toBe('channel:own')
    h.db.$client.exec('DROP TRIGGER reject_merge')
    await fetchArtistPage(h.db, h.catalog, {
      name: 'topic',
      channelId: 'topic',
    })
    expect(h.contributions()[0].artistId).toBe('channel:topic')
  })

  it('retries only unchecked artists after a partial backfill failure', async () => {
    const h = harness()
    seedTrack(h, 'a', 'a', 'Credit A')
    seedTrack(h, 'b', 'b', 'Credit B')
    h.catalog.pages.set('a', page('a', 'Canonical A'))
    h.catalog.pages.set('b', page('b', 'Canonical B'))
    const real = h.catalog.artist.bind(h.catalog)
    const fetch = vi
      .spyOn(h.catalog, 'artist')
      .mockImplementation(async (id, signal, language) => {
        if (id === 'b') throw new Error('temporary outage')
        return real(id, signal, language)
      })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onUpdated = vi.fn()
    const backfill = createArtistPages({
      db: h.db,
      catalog: h.catalog,
      onUpdated,
    })
    expect(await backfill.run()).toBe(true)
    expect(h.rows().map((row) => row.artist)).toEqual([
      'Canonical A',
      'Credit B',
    ])
    fetch.mockRestore()
    log.mockRestore()
    h.catalog.artistCalls = []
    expect(await backfill.run()).toBe(false)
    expect(h.catalog.artistCalls).toEqual([
      { channelId: 'b', language: 'en' },
      { channelId: 'b', language: 'ja' },
    ])
    expect(h.rows().map((row) => row.artist)).toEqual([
      'Canonical A',
      'Canonical B',
    ])
    expect(onUpdated).toHaveBeenCalledTimes(2)
    await backfill.stop()
  })

  it('otherwise keeps the row with most tracks, even when it is not the primary channel', async () => {
    const h = harness()
    seedTrack(h, 'a1', 'a')
    seedTrack(h, 'a2', 'a')
    seedTrack(h, 'b1', 'b')
    h.catalog.pages.set('a', page('a', 'Artist', 'b'))
    await fetchArtistPage(h.db, h.catalog, { name: 'a', channelId: 'a' })
    expect(canonicalArtist(h.db, 'channel:b')?.id).toBe('channel:a')
    // A later Full Discography row becomes the survivor; existing aliases stay direct.
    seedTrack(h, 'c1', 'c')
    h.db
      .update(artists)
      .set({ fullDiscography: true })
      .where(eq(artists.id, 'channel:c'))
      .run()
    h.catalog.pages.set('c', page('c', 'Artist', 'b'))
    await fetchArtistPage(h.db, h.catalog, { name: 'c', channelId: 'c' })
    expect(
      h.db.select().from(artists).where(eq(artists.id, 'channel:b')).get()
        ?.aliasOf
    ).toBe('channel:c')
    expect(canonicalArtist(h.db, 'channel:a')?.id).toBe('channel:c')
  })

  it('keeps track and release roles in tags and adoption links channel aliases to the survivor', async () => {
    const h = harness()
    const liked = song('collaboration', 'Collaboration')
    liked.artists = [{ name: 'MYGO credit', channelId: 'mygo' }]
    const album = release('collab-release', liked)
    album.artists = [
      { name: 'MYGO release credit', channelId: 'mygo' },
      { name: 'Ave credit', channelId: 'ave' },
      { name: 'Unidentified guest', channelId: null },
    ]
    h.catalog.likes = [liked]
    h.matcher.matches.set(liked.videoId, releaseMatch(liked, album))
    h.catalog.pages.set('mygo', page('mygo', 'MyGO!!!!!'))
    h.catalog.pages.set('ave', page('ave', 'Ave Mujica'))
    await h.start()
    const row = h.rows()[0]
    expect(row.artist).toBe('MyGO!!!!!')
    expect(row.albumArtist).toBe('MyGO!!!!!, Ave Mujica, Unidentified guest')
    const fields = readTags(
      path.join(h.library, h.file(row.id)!.relativePath)
    ).fields
    expect(fields.lms.releaseArtistCredits).toEqual(album.artists)
    expect(matchFromTags(fields)?.release?.artists).toEqual(album.artists)
    const rebuilt = harness()
    cpSync(h.library, rebuilt.library, { recursive: true })
    rebuilt.db
      .insert(artists)
      .values([
        {
          id: 'channel:mygo-survivor',
          name: 'MyGO!!!!!',
          channelId: 'mygo-survivor',
          primaryChannelId: 'mygo-survivor',
          pageCheckedAt: 'now',
        },
        {
          id: 'channel:mygo',
          name: 'old',
          channelId: 'mygo',
          aliasOf: 'channel:mygo-survivor',
        },
      ])
      .run()
    await adoptFiles(
      {
        db: rebuilt.db,
        coversDir: path.join(rebuilt.userData, 'covers'),
        now: () => rebuilt.time,
      },
      rebuilt.library
    )
    expect(rebuilt.db.select().from(trackArtists).all()).toMatchObject([
      { artistId: 'channel:mygo-survivor' },
    ])
    expect(JSON.parse(rebuilt.rows()[0].match!).release.artists).toEqual(
      album.artists
    )
    expect(rebuilt.rows()[0].albumArtist).toBe(row.albumArtist)
    expect(
      rebuilt.db
        .select()
        .from(artists)
        .where(eq(artists.id, 'channel:mygo'))
        .get()?.name
    ).toBe('old')
  })

  it('still adopts older tags without release credits and preserves distinct album-artist text', () => {
    const h = harness()
    const match = seedTrack(h, 'legacy', 'mygo')
    const fields = desiredTagFields(h.rows()[0], null, null)
    fields.lms = {
      ...emptyLmsFields(),
      ...fields.lms,
      schemaVersion: 6,
      releaseArtistCredits: [],
    }
    fields.lms.matchConfirmed = true
    fields.albumArtist = 'MyGO!!!!!, Ave Mujica'
    expect(matchFromTags(fields)?.artists).toEqual(match.artists)
    expect(matchFromTags(fields)?.release?.artists).toEqual([
      { name: 'MyGO!!!!!, Ave Mujica', channelId: null },
    ])
  })

  it.each([
    'en',
    'ja',
  ])('retries a failed %s artist fetch before saving the Match or tagging', async (language) => {
    const h = harness()
    h.catalog.likes = [song('waiting')]
    const real = h.catalog.artist.bind(h.catalog)
    vi.spyOn(h.catalog, 'artist').mockImplementation(async (id, signal, hl) => {
      if (hl === language) throw new Error('page unavailable')
      return real(id, signal, hl)
    })
    await h.start()
    const row = h.rows()[0]
    expect(row.match).toBeNull()
    expect(row.state).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.nextAttemptAt).not.toBeNull()
    expect(h.downloads).toEqual([])
    expect(h.db.select().from(artists).all()[0].pageCheckedAt).toBeNull()
    await expect(
      runMatch({ ...h.deps, now: () => h.time }, row, stepRun())
    ).rejects.toBeInstanceOf(RetryLaterError)
    vi.mocked(h.catalog.artist).mockRestore()
    await h.reconciler.retry(row.id)
    await h.idle()
    expect(h.row('video:waiting')?.artist).toBe('Test Artist')
    expect(h.downloads).toEqual(['waiting'])
  })

  it('resumes backfill from cached pages after interruption and wakes retag/move/upload work', async () => {
    const h = harness()
    h.settings.remoteEnabled = true
    h.catalog.likes = [song('backfill')]
    await h.start()
    await h.stop()
    const row = h.rows()[0]
    const originalId = row.id
    const oldPath = h.file(row.id)!.relativePath
    h.db.update(artists).set({ name: 'Canonical', pageCheckedAt: null }).run()
    h.catalog.pages.set('artist-1', page('artist-1', 'Canonical'))
    await fetchArtistPage(h.db, h.catalog, {
      name: 'credit',
      channelId: 'artist-1',
    })
    // Simulate exiting after the page transaction, before tracks were recomputed.
    h.reopen()
    const onUpdated = vi.fn(() => h.reconciler.markDirty())
    const pages = createArtistPages({ db: h.db, catalog: h.catalog, onUpdated })
    h.catalog.artistCalls = []
    expect(await pages.run()).toBe(false)
    expect(h.catalog.artistCalls).toEqual([])
    expect(onUpdated).toHaveBeenCalledOnce()
    expect(h.rows()[0]).toMatchObject({
      id: originalId,
      artist: 'Canonical',
      albumArtist: 'Canonical',
    })
    await h.start()
    expect(h.file(originalId)!.relativePath).not.toBe(oldPath)
    expect(
      readTags(path.join(h.library, h.file(originalId)!.relativePath)).fields
        .artist
    ).toBe('Canonical')
    expect(h.upload(originalId)!.remotePath).toBe(
      h.file(originalId)!.relativePath
    )
    expect(h.upload(originalId)!.localSha256).toBe(
      h.file(originalId)!.contentSha256
    )
    expect(
      readTags(path.join(h.remote, h.upload(originalId)!.remotePath!)).fields
        .artist
    ).toBe('Canonical')
    expect(h.downloads).toEqual(['backfill'])
    await pages.stop()
  })

  it.each([
    'success',
    'failure',
  ])('discards an older alias catalog %s after a newer survivor check finishes', async (outcome) => {
    const h = harness()
    seedTrack(h, 'topic-track', 'topic')
    seedTrack(h, 'own-1', 'own')
    seedTrack(h, 'own-2', 'own')
    h.db.update(artists).set({ fullDiscography: true }).run()
    h.catalog.pages.set('topic', page('topic', 'Band', 'own'))
    const old = release('old', song('old-video'))
    const added = release('added', song('new-video'))
    const ref = (album: ReturnType<typeof release>) => ({
      browseId: album.browseId,
      title: album.title,
      shelf: 'albums' as const,
      year: 2024,
      thumbnailUrl: null,
    })
    vi.spyOn(h.catalog, 'artistReleases').mockImplementation(async (id) =>
      id === 'topic' ? [ref(old)] : [ref(old), ref(added)]
    )
    let resume!: () => void
    let loaded!: () => void
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    const entered = new Promise<void>((resolve) => {
      loaded = resolve
    })
    let first = true
    vi.spyOn(h.catalog, 'release').mockImplementation(async (id) => {
      if (first) {
        first = false
        loaded()
        await paused
        if (outcome === 'failure') throw new Error('older request failed')
      }
      return id === 'old' ? old : added
    })
    const earlier = checkArtistCatalog({
      db: h.db,
      catalog: h.catalog,
      artistId: 'channel:topic',
      channelId: 'topic',
      now: () => h.time,
    })
    await entered
    await fetchArtistPage(h.db, h.catalog, {
      name: 'topic',
      channelId: 'topic',
    })
    await checkArtistCatalog({
      db: h.db,
      catalog: h.catalog,
      artistId: 'channel:own',
      channelId: 'own',
      now: () => h.time,
    })
    resume()
    expect(await earlier).toEqual({ total: 0 })
    expect(h.contributions()).toHaveLength(2)
    expect(
      h
        .contributions()
        .every((row) => row.active && row.artistId === 'channel:own')
    ).toBe(true)
    expect(h.db.select().from(sourceSnapshots).all()).toMatchObject([
      { source: 'catalog:channel:own', status: 'ok', itemCount: 2 },
    ])
  })

  it('abandons an alias check before validating the survivor shelves', async () => {
    const h = harness()
    seedTrack(h, 'topic-track', 'topic')
    seedTrack(h, 'own-1', 'own')
    seedTrack(h, 'own-2', 'own')
    h.db.update(artists).set({ fullDiscography: true }).run()
    seedContribution(h, 'topic-c', 'channel:topic', 'topic-track')
    seedContribution(h, 'own-c', 'channel:own', 'own-1')
    h.db
      .update(contributions)
      .set({
        raw: JSON.stringify({
          kind: 'catalog',
          artistId: 'channel:topic',
          shelf: 'albums',
        }),
      })
      .where(eq(contributions.id, 'topic-c'))
      .run()
    h.db
      .update(contributions)
      .set({
        raw: JSON.stringify({
          kind: 'catalog',
          artistId: 'channel:own',
          shelf: 'singles',
        }),
      })
      .where(eq(contributions.id, 'own-c'))
      .run()
    h.catalog.pages.set('topic', page('topic', 'Band', 'own'))
    const album = release('old-album', song('old'))
    h.catalog.refs = [
      {
        browseId: album.browseId,
        title: album.title,
        shelf: 'albums',
        year: 2024,
        thumbnailUrl: null,
      },
    ]
    vi.spyOn(h.catalog, 'release').mockImplementation(async () => {
      await fetchArtistPage(h.db, h.catalog, {
        name: 'topic',
        channelId: 'topic',
      })
      return album
    })
    await expect(
      checkArtistCatalog({
        db: h.db,
        catalog: h.catalog,
        artistId: 'channel:topic',
        channelId: 'topic',
      })
    ).resolves.toEqual({ total: 0 })
    expect(h.contributions()).toHaveLength(2)
    expect(
      h
        .contributions()
        .every((row) => row.active && row.artistId === 'channel:own')
    ).toBe(true)
  })

  it.each([
    'success',
    'failure',
  ])('abandons a newer alias catalog %s and keeps survivor contributions active', async (outcome) => {
    const h = harness()
    seedTrack(h, 'topic-track', 'topic')
    seedTrack(h, 'own-track', 'own')
    h.db
      .update(artists)
      .set({ fullDiscography: true })
      .where(eq(artists.id, 'channel:own'))
      .run()
    h.catalog.pages.set('topic', page('topic', 'Band', 'own'))
    const survivorAlbum = release('survivor-album', song('survivor-video'))
    const album = release('new-album', song('new'))
    const ref = (item: ReturnType<typeof release>) => ({
      browseId: item.browseId,
      title: item.title,
      shelf: 'albums' as const,
      year: 2024,
      thumbnailUrl: null,
    })
    h.catalog.refs = [ref(survivorAlbum)]
    h.catalog.releases.set(survivorAlbum.browseId, survivorAlbum)
    await checkArtistCatalog({
      db: h.db,
      catalog: h.catalog,
      artistId: 'channel:own',
      channelId: 'own',
      now: () => h.time,
    })
    const before = h.contributions()
    const checkedAt = canonicalArtist(h.db, 'channel:own')!.catalogCheckedAt
    h.catalog.refs = [
      {
        browseId: album.browseId,
        title: album.title,
        shelf: 'albums',
        year: 2024,
        thumbnailUrl: null,
      },
    ]
    vi.spyOn(h.catalog, 'release').mockImplementation(async () => {
      await fetchArtistPage(h.db, h.catalog, {
        name: 'topic',
        channelId: 'topic',
      })
      if (outcome === 'failure') throw new Error('alias request failed')
      return album
    })
    expect(
      await checkArtistCatalog({
        db: h.db,
        catalog: h.catalog,
        artistId: 'channel:topic',
        channelId: 'topic',
        now: () => h.time,
      })
    ).toEqual({ total: 0 })
    const survivor = canonicalArtist(h.db, 'channel:topic')!
    expect(h.contributions()).toEqual(before)
    expect(survivor.catalogCheckedAt).toBe(checkedAt)
    expect(h.contributions()[0]).toMatchObject({
      artistId: survivor.id,
      active: true,
    })
    expect(JSON.parse(h.contributions()[0].raw).artistId).toBe(survivor.id)
    expect(h.db.select().from(sourceSnapshots).all()).toMatchObject([
      {
        source: catalogSnapshotSource(survivor.id),
        status: 'running',
        error: null,
      },
    ])
  })
})
