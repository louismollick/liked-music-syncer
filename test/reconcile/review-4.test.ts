import { cpSync, existsSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptFiles } from '../../src/main/inventory/inventory'
import { artists, tracks, unmanagedFiles } from '../../src/main/library/schema'
import {
  checkLikedSongs,
  claimAdoptedFiles,
  linkContributions,
} from '../../src/main/reconcile/sources'
import { deleteTracks, runMatch } from '../../src/main/reconcile/steps'
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

const run = () => ({ signal: new AbortController().signal, progress: () => {} })
const album = release('album', song('cv', 'Song'))

async function likeChecked(h: Harness, videoId: string) {
  await checkLikedSongs({
    db: h.db,
    catalog: h.catalog,
    accountId: h.account!,
    stillCurrent: () => true,
    now: () => h.time,
  })
  linkContributions(h.db, () => h.time)
  return h
    .rows()
    .find((row) =>
      h
        .contributions()
        .some((c) => c.trackId === row.id && c.sourceVideoId === videoId)
    )!
}

function released(h: Harness, relative: string) {
  return h.db
    .select()
    .from(unmanagedFiles)
    .where(eq(unmanagedFiles.relativePath, relative))
    .get()?.released
}

describe('fourth review fixes', () => {
  it('waits for a pending delete without using up the track’s retries', async () => {
    const h = harness()
    const first = song('lv', 'Song')
    h.matcher.matches.set('lv', releaseMatch(first, album, 'cv'))
    h.catalog.likes = [first]
    await h.start()
    const old = h.row('album:cv')!
    h.catalog.likes = []
    h.catalog.declaredCount = 0
    await h.check()
    await h.stop()
    deleteTracks(h.deps, [old.id], 'local')
    const again = song('lv2', 'Song')
    h.matcher.matches.set('lv2', releaseMatch(again, album, 'cv'))
    h.catalog.likes = [again]
    h.catalog.declaredCount = null
    await h.start()
    const waiting = h.rows().find((row) => row.id !== old.id)!
    expect(waiting.state).toBe('pending')
    expect(waiting.attempts).toBe(0)
    expect(waiting.nextAttemptAt).not.toBeNull()
  })

  it('keeps a file downloaded after Stop managing as Unmanaged, not tracked', async () => {
    const h = harness()
    const download = h.deps.downloader.download
    h.deps.downloader.download = async (id, dir, progress, signal) => {
      const file = await download(id, dir, progress, signal)
      const track = h.rows()[0]
      h.reconciler.stopManaging(track.id)
      return file
    }
    h.catalog.likes = [song('loose', 'Loose')]
    await h.start()
    const track = h.rows()[0]
    expect(track.state).toBe('released')
    expect(h.file(track.id)).toBeUndefined()
    const leftovers = h.db.select().from(unmanagedFiles).all()
    for (const row of leftovers) {
      expect(row.released).toBe(true)
      expect(existsSync(path.join(h.library, row.relativePath))).toBe(true)
    }
  })

  it('does not merge a track that became No Longer Wanted during its lookup', async () => {
    const h = harness()
    h.matcher.matches.set('cv', releaseMatch(song('cv', 'Song'), album, 'cv'))
    h.catalog.likes = [song('cv', 'Song'), song('lv', 'Song')]
    await h.start()
    await h.stop()
    const target = h.row('album:cv')!
    const current = h.row('video:lv')!
    h.matcher.matches.set('lv', releaseMatch(song('lv', 'Song'), album, 'cv'))
    h.matcher.during = () => {
      h.db
        .update(tracks)
        .set({ state: 'no_longer_wanted' })
        .where(eq(tracks.id, current.id))
        .run()
    }
    await runMatch(h.deps, current, run())
    expect(h.rows().find((row) => row.id === current.id)?.identityKey).toBe(
      'video:lv'
    )
    expect(h.file(current.id)).toBeDefined()
    expect(h.file(target.id)).toBeDefined()
  })

  it('keeps a restored copy Unmanaged instead of attaching it to a No Longer Wanted track', async () => {
    const source = harness()
    source.catalog.likes = [song('loose', 'Loose')]
    await source.start()
    await source.stop()
    const h = harness()
    cpSync(source.library, h.library, { recursive: true })
    h.db
      .insert(tracks)
      .values({
        id: 'unwanted',
        identityKey: 'video:loose',
        title: 'Loose',
        state: 'no_longer_wanted',
        createdAt: h.time.toISOString(),
        updatedAt: h.time.toISOString(),
      })
      .run()
    const relative = source.db.select().from(tracks).all()[0]
    const file = source.file(relative.id)!
    await adoptFiles(
      {
        db: h.db,
        coversDir: path.join(h.userData, 'covers'),
        now: () => h.time,
      },
      h.library
    )
    expect(h.file('unwanted')).toBeUndefined()
    expect(released(h, file.relativePath)).toBe(true)
  })

  it('does not let a like claim a file a Full Discography catalog wrote', async () => {
    const source = harness()
    source.catalog.releases.set(album.browseId, album)
    source.catalog.refs = [
      {
        browseId: album.browseId,
        title: album.title,
        shelf: 'albums',
        year: 2024,
        thumbnailUrl: null,
      },
    ]
    source.db
      .insert(artists)
      .values({
        id: 'channel:artist-1',
        name: credit.name,
        channelId: credit.channelId,
        fullDiscography: true,
      })
      .run()
    await source.start()
    await source.stop()
    const h = harness()
    cpSync(source.library, h.library, { recursive: true })
    h.catalog.likes = [song('cv', 'Song')]
    await likeChecked(h, 'cv')
    await adoptFiles(
      {
        db: h.db,
        coversDir: path.join(h.userData, 'covers'),
        now: () => h.time,
      },
      h.library
    )
    expect(claimAdoptedFiles(h.db, () => h.time)).toBe(0)
  })
})
