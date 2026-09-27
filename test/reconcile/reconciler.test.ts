import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectOutsideEdits,
  recoverOperations,
} from '../../src/main/inventory/inventory'
import {
  artists,
  contributions,
  files,
  operations,
  tracks,
} from '../../src/main/library/schema'
import {
  checkArtistCatalog,
  SuspiciousSnapshotError,
  updateWantedStates,
} from '../../src/main/reconcile/sources'
import { readTags, writeTags } from '../../src/main/tags/schema'
import { credit, Harness, release, releaseMatch, song } from './harness'

const open: Harness[] = []
function harness() {
  const h = new Harness()
  open.push(h)
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

async function liked(h: Harness, ...songs: ReturnType<typeof song>[]) {
  h.catalog.likes = songs
  await h.start()
}

describe('reconciler', () => {
  it('takes a new like through matching, acquisition, tags, lyrics, upload and Activity', async () => {
    const h = harness()
    h.lyricsText = '[00:01.00]Hello'
    const item = {
      ...song('new-video', 'New Song'),
      thumbnailUrl: 'https://example.test/cover.jpg',
    }
    await liked(h, item)
    const track = h.row('video:new-video')!
    expect(track.state).toBe('done')
    const file = h.file(track.id)!
    expect(file.relativePath).toBe('Test Artist/New Song/New Song.m4a')
    const local = path.join(h.library, file.relativePath)
    expect(readTags(local).fields).toMatchObject({
      title: 'New Song',
      album: 'New Song',
      lyrics: h.lyricsText,
      language: 'en',
    })
    expect(readTags(local).cover).not.toBeNull()
    expect(readFileSync(local.replace(/\.m4a$/, '.lrc'), 'utf8')).toBe(
      `${h.lyricsText}\n`
    )
    expect(h.upload(track.id)?.verifiedAt).toBeTruthy()
    expect(existsSync(path.join(h.remote, file.relativePath))).toBe(true)
    expect(
      existsSync(
        path.join(h.remote, file.relativePath.replace(/\.m4a$/, '.lrc'))
      )
    ).toBe(true)
    expect(h.reconciler.activity().recent.map((row) => row.id)).toContain(
      track.id
    )
  })

  it('merges liked and catalog contributions for the same release track', async () => {
    const h = harness()
    const likedSong = song('liked-video', 'A Song')
    const album = release('release-1', song('catalog-video', 'A Song'))
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
    h.matcher.matches.set(
      likedSong.videoId,
      releaseMatch(likedSong, album, 'catalog-video')
    )
    h.db
      .insert(artists)
      .values({
        id: 'channel:artist-1',
        name: credit.name,
        channelId: credit.channelId,
        favorite: true,
      })
      .run()
    await liked(h, likedSong)
    expect(h.rows()).toHaveLength(1)
    expect(h.contributions()).toHaveLength(2)
    expect(new Set(h.contributions().map((row) => row.trackId)).size).toBe(1)
    expect(h.db.select().from(files).all()).toHaveLength(1)
    expect(h.downloads).toEqual(['catalog-video'])
  })

  it('keeps previous account likes until the new account completes, then scopes active likes', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    await liked(h, song('shared'), song('only-a'))
    h.setAccount('account-b')
    h.catalog.likedError = new Error('partial page')
    await h.check()
    expect(h.contributions().filter((row) => row.active)).toHaveLength(2)
    h.catalog.likedError = null
    h.catalog.likes = [song('shared'), song('only-b')]
    await h.check()
    expect(
      h
        .contributions()
        .filter((row) => row.active)
        .map((row) => row.sourceKey)
        .sort()
    ).toEqual(['ytm-liked:account-b:only-b', 'ytm-liked:account-b:shared'])
    expect(h.row('video:only-a')?.state).toBe('no_longer_wanted')
    expect(h.file(h.row('video:only-a')!.id)).toBeTruthy()
    h.setAccount('account-a')
    h.catalog.likes = [song('shared'), song('only-a')]
    await h.check()
    expect(
      h
        .contributions()
        .filter((row) => row.active)
        .map((row) => row.accountId)
    ).toEqual(['account-a', 'account-a'])
    expect(h.row('video:only-a')?.state).toBe('done')
  })

  it('rejects a suspicious or malformed liked snapshot without deactivating likes', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    await liked(h, ...Array.from({ length: 24 }, (_, i) => song(`video-${i}`)))
    h.catalog.likes = [song('video-0')]
    await h.check()
    expect(h.contributions().filter((row) => row.active)).toHaveLength(24)
    expect(
      h.reconciler
        .activity()
        .needsAttention.some((item) => item.kind === 'source')
    ).toBe(true)
    h.catalog.likedError = new Error('changed page shape')
    await h.check()
    expect(h.contributions().filter((row) => row.active)).toHaveLength(24)
  })

  it('keeps the previous Favorite Artist catalog after a suspicious partial response', async () => {
    const h = harness()
    const artistId = 'channel:artist-1'
    const full = release(
      'catalog-full',
      ...Array.from({ length: 24 }, (_, i) => song(`catalog-${i}`))
    )
    h.catalog.refs = [
      {
        browseId: full.browseId,
        title: full.title,
        kindLabel: 'Album',
        year: 2024,
        thumbnailUrl: null,
      },
    ]
    h.catalog.releases.set(full.browseId, full)
    h.db
      .insert(artists)
      .values({
        id: artistId,
        name: credit.name,
        channelId: credit.channelId,
        favorite: true,
      })
      .run()
    const check = () =>
      checkArtistCatalog({
        db: h.db,
        catalog: h.catalog,
        artistId,
        channelId: credit.channelId!,
        now: () => h.time,
      })
    await check()
    const checkedAt = h.db
      .select()
      .from(artists)
      .where(eq(artists.id, artistId))
      .get()?.catalogCheckedAt
    h.catalog.releases.set(
      full.browseId,
      release('catalog-full', song('catalog-0'), song('catalog-1'))
    )
    await expect(check()).rejects.toBeInstanceOf(SuspiciousSnapshotError)
    expect(
      h.contributions().filter((row) => row.active && row.kind === 'catalog')
    ).toHaveLength(24)
    expect(
      h.db.select().from(artists).where(eq(artists.id, artistId)).get()
        ?.catalogCheckedAt
    ).toBe(checkedAt)
  })

  it('retries transient match errors with a fake clock, stops after backoff, and resets on retry', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    h.matcher.error = new Error('temporary')
    await liked(h, song('retry-me'))
    let row = h.rows()[0]
    expect(row).toMatchObject({
      state: 'pending',
      attempts: 1,
      lastErrorKind: 'transient',
    })
    for (const [advance, expected] of [
      [60_000, 2],
      [300_000, 3],
      [1_800_000, 4],
    ] as const) {
      h.time = new Date(h.time.getTime() + advance)
      h.reconciler.markDirty()
      await h.idle()
      row = h.rows()[0]
      expect(row.attempts).toBe(expected)
    }
    expect(row.state).toBe('needs_attention')
    h.matcher.error = null
    h.reconciler.retry(row.id)
    await h.idle()
    expect(h.rows()[0]).toMatchObject({
      state: 'done',
      attempts: 0,
      lastError: null,
    })
  })

  it('sends permanent errors straight to Needs Attention', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    h.matcher.error = Object.assign(new Error('unavailable'), {
      kind: 'permanent',
    })
    await liked(h, song('unavailable'))
    expect(h.rows()[0]).toMatchObject({
      state: 'needs_attention',
      attempts: 1,
      nextAttemptAt: null,
    })
  })

  it('refreshes without another download if the catalog video is unchanged', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    await liked(h, song('same'))
    h.reconciler.refresh({ kind: 'track', id: h.rows()[0].id })
    await h.idle()
    expect(h.matcher.calls).toBe(2)
    expect(h.downloads).toEqual(['same'])
  })

  it('detects Outside Edits, pauses the worker, rewrites tags, then stops managing', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    await liked(h, song('outside'))
    const row = h.rows()[0]
    const file = h.file(row.id)!
    const absolute = path.join(h.library, file.relativePath)
    const changed = readTags(absolute)
    writeTags(
      absolute,
      { ...changed.fields, title: 'External title' },
      changed.cover
    )
    await detectOutsideEdits(
      {
        db: h.db,
        coversDir: path.join(h.userData, 'covers'),
        now: () => h.time,
      },
      h.library
    )
    expect(JSON.parse(h.file(row.id)!.outsideEdit!)).toContain('tags')
    h.reconciler.markDirty()
    await h.idle()
    expect(readTags(absolute).fields.title).toBe('External title')
    await h.reconciler.rewrite(row.id)
    await h.idle()
    expect(readTags(absolute).fields.title).toBe('outside')
    h.reconciler.stopManaging(row.id)
    expect(h.file(row.id)).toBeUndefined()
    expect(existsSync(absolute)).toBe(true)
  })

  it('keeps an unmanaged collision and uses a stable suffix', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const blocker = path.join(
      h.library,
      'Test Artist',
      'Collision',
      'Collision.m4a'
    )
    mkdirSync(path.dirname(blocker), { recursive: true })
    writeFileSync(blocker, 'unmanaged')
    await liked(h, song('collision', 'Collision'))
    const first = h.file(h.rows()[0].id)!
    expect(first.relativePath).toMatch(
      /^Test Artist\/Collision\/Collision \[[a-f0-9]{6}\]\.m4a$/
    )
    expect(readFileSync(blocker, 'utf8')).toBe('unmanaged')
    h.reconciler.refresh({ kind: 'track', id: h.rows()[0].id })
    await h.idle()
    expect(h.file(h.rows()[0].id)?.relativePath).toBe(first.relativePath)
  })

  it('keeps an unmanaged sidecar beside a free audio path', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    h.lyricsText = '[00:01.00]App lyrics'
    const blocker = path.join(h.library, 'Test Artist', 'Lyrics', 'Lyrics.lrc')
    mkdirSync(path.dirname(blocker), { recursive: true })
    writeFileSync(blocker, 'unmanaged lyrics')
    await liked(h, song('lyrics-collision', 'Lyrics'))
    const file = h.file(h.rows()[0].id)!
    expect(file.relativePath).toMatch(/Lyrics \[[a-f0-9]{6}\]\.m4a$/)
    expect(readFileSync(blocker, 'utf8')).toBe('unmanaged lyrics')
    expect(
      existsSync(
        path.join(h.library, file.relativePath.replace(/\.m4a$/, '.lrc'))
      )
    ).toBe(true)
  })

  it('moves a retag to a suffix when an unowned sidecar appeared', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    await liked(h, song('late-lyrics', 'Late Lyrics'))
    const track = h.rows()[0]
    const original = h.file(track.id)!.relativePath
    const blocker = path.join(h.library, original.replace(/\.m4a$/, '.lrc'))
    writeFileSync(blocker, 'unmanaged lyrics')
    h.lyricsText = '[00:01.00]App lyrics'
    h.reconciler.refresh({ kind: 'track', id: track.id })
    await h.idle()
    expect(h.file(track.id)!.relativePath).not.toBe(original)
    expect(readFileSync(blocker, 'utf8')).toBe('unmanaged lyrics')
  })

  it('reuploads a remote object deleted after its upload was recorded', async () => {
    const h = harness()
    await liked(h, song('remote-audit'))
    const track = h.rows()[0]
    const remote = path.join(h.remote, h.file(track.id)!.relativePath)
    rmSync(remote)
    await h.check()
    expect(existsSync(remote)).toBe(true)
    expect(h.upload(track.id)?.remoteSize).toBeGreaterThan(0)
  })

  it('leaves an in-flight track No Longer Wanted after a check removes its like', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    let entered!: () => void
    let release!: () => void
    const downloading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = h.deps.downloader.download
    h.deps.downloader.download = async (...args) => {
      entered()
      await blocked
      return original(...args)
    }
    h.catalog.likes = [song('unliked-during-download')]
    await h.reconciler.start()
    await downloading
    const id = h.rows()[0].id
    h.catalog.likes = []
    h.catalog.declaredCount = 0
    await h.reconciler.check()
    expect(h.rows()[0].state).toBe('no_longer_wanted')
    release()
    await h.idle()
    expect(
      h.db.select().from(tracks).where(eq(tracks.id, id)).get()?.state
    ).toBe('no_longer_wanted')
  })

  it('waits for an aborted step before preparing a changed library folder', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    let entered!: () => void
    let release!: () => void
    const downloading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = h.deps.downloader.download
    h.deps.downloader.download = async (...args) => {
      entered()
      await blocked
      return original(...args)
    }
    h.catalog.likes = [song('folder-switch')]
    await h.reconciler.start()
    await downloading
    const oldFolder = h.library
    h.settings.libraryFolder = path.join(h.root, 'new-library')
    mkdirSync(h.settings.libraryFolder)
    let changed = false
    const change = h.reconciler.libraryFolderChanged().then(() => {
      changed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(changed).toBe(false)
    release()
    await change
    await h.idle()
    expect(h.file(h.rows()[0].id)).toBeTruthy()
    expect(
      existsSync(path.join(oldFolder, h.file(h.rows()[0].id)!.relativePath))
    ).toBe(false)
    expect(
      existsSync(
        path.join(
          h.settings.libraryFolder,
          h.file(h.rows()[0].id)!.relativePath
        )
      )
    ).toBe(true)
  })

  it('gates No Longer Wanted until all configured sources have succeeded', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    h.db
      .insert(tracks)
      .values({
        id: 'adopted',
        identityKey: 'adopted:video:old',
        title: 'Old',
        artist: 'A',
        artistCredits: '[]',
        album: 'Old',
        albumArtist: 'A',
        state: 'done',
        adopted: true,
        createdAt: h.time.toISOString(),
        updatedAt: h.time.toISOString(),
      })
      .run()
    h.db
      .insert(artists)
      .values({
        id: 'channel:favorite',
        name: 'Favorite',
        channelId: 'favorite',
        favorite: true,
      })
      .run()
    // A failing Favorite Artist catalog must not freeze wanted states: once the
    // liked-songs source has completed a check, unclaimed tracks are unwanted.
    h.catalog.likes = []
    h.catalog.refs = []
    await h.reconciler.check()
    expect(
      h.db.select().from(tracks).where(eq(tracks.id, 'adopted')).get()?.state
    ).toBe('no_longer_wanted')
    // And a track that regains a source is wanted again even while the catalog still fails.
    h.db
      .insert(contributions)
      .values({
        id: 'relike',
        sourceKey: `ytm-liked:${h.account}:adopted-video`,
        kind: 'liked',
        accountId: h.account,
        trackId: 'adopted',
        sourceVideoId: 'adopted-video',
        firstSeenAt: h.time.toISOString(),
        lastSeenAt: h.time.toISOString(),
        active: true,
      })
      .run()
    updateWantedStates(h.db, {
      accountId: h.account,
      favoriteArtistIds: ['channel:favorite'],
    })
    expect(
      h.db.select().from(tracks).where(eq(tracks.id, 'adopted')).get()?.state
    ).toBe('pending')
  })

  it('recovers a placed file before an acquire commit and clears staging', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    await liked(h, song('crash'))
    await h.stop()
    const row = h.rows()[0]
    const file = h.file(row.id)!
    const staged = path.join(h.library, '.lms-staging', row.id, 'orphan.m4a')
    mkdirSync(path.dirname(staged), { recursive: true })
    writeFileSync(staged, 'stale')
    h.db.delete(files).where(eq(files.trackId, row.id)).run()
    h.db
      .insert(operations)
      .values({
        id: 'op',
        trackId: row.id,
        step: 'acquire',
        artifact: 'audio',
        kind: 'place',
        toPath: file.relativePath,
        expectedSha256: file.contentSha256,
        audioVideoId: file.audioVideoId,
        phase: 'started',
        startedAt: h.time.toISOString(),
      })
      .run()
    const count = await recoverOperations(
      { db: h.db, coversDir: h.userData, now: () => h.time },
      h.library
    )
    expect(count).toBe(1)
    expect(h.file(row.id)?.outsideEdit).toBeNull()
    expect(h.file(row.id)?.audioVideoId).toBe('crash')
    expect(existsSync(path.join(h.library, '.lms-staging'))).toBe(false)
    expect(h.db.select().from(operations).all()).toHaveLength(0)
  })
})
