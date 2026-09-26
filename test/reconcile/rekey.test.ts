import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  contributions,
  files,
  tombstones,
  trackHistory,
  uploads,
} from '../../src/main/library/schema'
import { processTombstones, runMatch } from '../../src/main/reconcile/steps'
import { readTags } from '../../src/main/tags/schema'
import { Harness, release, releaseMatch, song } from './harness'

const open: Harness[] = []
function harness() {
  const h = new Harness()
  open.push(h)
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

describe('Refresh and re-key', () => {
  it('re-keys a standalone track and replaces changed audio after placing the new file', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const liked = song('liked', 'Old Song')
    h.catalog.likes = [liked]
    await h.start()
    const old = h.row('video:liked')!
    const oldFile = h.file(old.id)!
    const oldPath = path.join(h.library, oldFile.relativePath)
    const album = release('release-1', song('catalog', 'New Song'))
    h.matcher.matches.set(liked.videoId, releaseMatch(liked, album, 'catalog'))
    h.reconciler.refresh({ kind: 'track', id: old.id })
    await h.idle()
    const current = h.row('release-1:catalog')!
    expect(current.id).toBe(old.id)
    expect(h.downloads).toEqual(['liked', 'catalog'])
    expect(h.file(old.id)).toMatchObject({
      audioVideoId: 'catalog',
      relativePath: 'Test Artist/Test Album/01 New Song.m4a',
    })
    expect(existsSync(oldPath)).toBe(false)
    expect(
      readTags(path.join(h.library, h.file(old.id)!.relativePath)).fields
    ).toMatchObject({ title: 'New Song', album: 'Test Album' })
    expect(
      h.db
        .select()
        .from(trackHistory)
        .where(eq(trackHistory.trackId, old.id))
        .all()
        .map((row) => row.event)
    ).toContain('re-keyed')
  })

  it('re-keys without another download when the release uses the same video', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const liked = song('same', 'Same')
    h.catalog.likes = [liked]
    await h.start()
    const album = release('release-2', song('same', 'Same'))
    h.matcher.matches.set('same', releaseMatch(liked, album))
    h.reconciler.refresh({ kind: 'track', id: h.rows()[0].id })
    await h.idle()
    const track = h.row('release-2:same')!
    expect(h.downloads).toEqual(['same'])
    expect(h.file(track.id)?.relativePath).toBe(
      'Test Artist/Test Album/01 Same.m4a'
    )
    expect(
      readTags(path.join(h.library, h.file(track.id)!.relativePath)).fields.lms
        .releaseBrowseId
    ).toBe('release-2')
  })

  it('keeps the old file while replacement audio is still downloading', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const liked = song('old-video', 'Old')
    h.catalog.likes = [liked]
    await h.start()
    const track = h.rows()[0]
    const oldPath = path.join(h.library, h.file(track.id)!.relativePath)
    const album = release('release-replacement', song('new-video', 'New'))
    h.matcher.matches.set('old-video', releaseMatch(liked, album, 'new-video'))
    let entered!: () => void
    let proceed!: () => void
    const downloading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      proceed = resolve
    })
    const originalDownload = h.deps.downloader.download
    h.deps.downloader.download = async (...args) => {
      entered()
      await blocked
      return originalDownload(...args)
    }
    h.reconciler.refresh({ kind: 'track', id: track.id })
    await downloading
    expect(h.row('release-replacement:new-video')?.id).toBe(track.id)
    expect(existsSync(oldPath)).toBe(true)
    expect(h.file(track.id)?.relativePath).toBe(
      path.relative(h.library, oldPath)
    )
    proceed()
    await h.idle()
    expect(existsSync(oldPath)).toBe(false)
    expect(h.file(track.id)?.audioVideoId).toBe('new-video')
  })

  it('merges into an existing filed track, deleting redundant local and remote copies through tombstones', async () => {
    const h = harness()
    h.lyricsText = '[00:01.00]Hello'
    const source = song('source', 'Source')
    const targetSong = song('target', 'Target')
    const album = release('release-3', targetSong)
    h.matcher.matches.set('target', releaseMatch(targetSong, album))
    h.catalog.likes = [source, targetSong]
    await h.start()
    const old = h.row('video:source')!
    const target = h.row('release-3:target')!
    const oldFile = h.file(old.id)!
    const oldUpload = h.upload(old.id)!
    const oldLocal = path.join(h.library, oldFile.relativePath)
    const targetLocal = path.join(h.library, h.file(target.id)!.relativePath)
    await h.stop()
    h.matcher.matches.set('source', releaseMatch(source, album, 'target'))
    await runMatch(h.deps, old, {
      signal: new AbortController().signal,
      progress: () => {},
    })
    expect(h.row('video:source')).toBeUndefined()
    expect(
      h.db
        .select()
        .from(contributions)
        .where(eq(contributions.sourceVideoId, 'source'))
        .get()?.trackId
    ).toBe(target.id)
    expect(
      h.db
        .select()
        .from(tombstones)
        .all()
        .map((row) => row.path)
    ).toContain(oldFile.relativePath)
    expect(existsSync(oldLocal)).toBe(true)
    expect(existsSync(path.join(h.remote, oldUpload.remotePath!))).toBe(true)
    await processTombstones(h.deps, new AbortController().signal)
    expect(existsSync(oldLocal)).toBe(false)
    expect(existsSync(path.join(h.remote, oldUpload.remotePath!))).toBe(false)
    expect(existsSync(targetLocal)).toBe(true)
    expect(h.upload(target.id)?.remotePath).toBe(
      h.file(target.id)?.relativePath
    )
  })

  it('transfers the file record when the existing target has no file', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const source = song('source', 'Source')
    h.catalog.likes = [source]
    await h.start()
    const old = h.row('video:source')!
    const oldFile = h.file(old.id)!
    const album = release('release-4', song('target', 'Target'))
    h.db
      .insert((await import('../../src/main/library/schema')).tracks)
      .values({
        id: 'empty-target',
        identityKey: 'release-4:target',
        title: 'Target',
        artist: 'Test Artist',
        artistCredits: '[]',
        album: 'Test Album',
        albumArtist: 'Test Artist',
        state: 'done',
        createdAt: h.time.toISOString(),
        updatedAt: h.time.toISOString(),
      })
      .run()
    await h.stop()
    h.matcher.matches.set('source', releaseMatch(source, album, 'target'))
    await runMatch(h.deps, old, {
      signal: new AbortController().signal,
      progress: () => {},
    })
    expect(
      h.db.select().from(files).where(eq(files.trackId, old.id)).get()
    ).toBeUndefined()
    expect(h.file('empty-target')?.relativePath).toBe(oldFile.relativePath)
    expect(h.db.select().from(tombstones).all()).toHaveLength(0)
  })

  it('refreshes a changed catalog video and removes the old file after replacement', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const source = song('liked', 'Song')
    const album = release(
      'release-5',
      song('first', 'Song'),
      song('second', 'Song')
    )
    h.matcher.matches.set('liked', releaseMatch(source, album, 'first'))
    h.catalog.likes = [source]
    await h.start()
    const oldPath = path.join(h.library, h.file(h.rows()[0].id)!.relativePath)
    const oldBytes = readFileSync(oldPath)
    h.matcher.matches.set('liked', releaseMatch(source, album, 'second'))
    h.reconciler.refresh({ kind: 'track', id: h.rows()[0].id })
    await h.idle()
    expect(h.downloads).toEqual(['first', 'second'])
    expect(h.file(h.rows()[0].id)?.audioVideoId).toBe('second')
    expect(existsSync(oldPath)).toBe(false)
    expect(
      readFileSync(
        path.join(h.library, h.file(h.rows()[0].id)!.relativePath)
      ).equals(oldBytes)
    ).toBe(false)
  })

  it('moves an uploaded audio file and sidecar remotely without re-uploading', async () => {
    const h = harness()
    h.lyricsText = '[00:01.00]Hello'
    h.catalog.likes = [song('moving', 'Old')]
    await h.start()
    const track = h.rows()[0]
    const desired = h.file(track.id)!.relativePath
    const oldPath = 'Test Artist/Old Location/Old.m4a'
    mkdirSync(path.dirname(path.join(h.library, oldPath)), { recursive: true })
    mkdirSync(path.dirname(path.join(h.remote, oldPath)), { recursive: true })
    renameSync(path.join(h.library, desired), path.join(h.library, oldPath))
    renameSync(
      path.join(h.library, desired.replace(/\.m4a$/, '.lrc')),
      path.join(h.library, oldPath.replace(/\.m4a$/, '.lrc'))
    )
    renameSync(path.join(h.remote, desired), path.join(h.remote, oldPath))
    renameSync(
      path.join(h.remote, desired.replace(/\.m4a$/, '.lrc')),
      path.join(h.remote, oldPath.replace(/\.m4a$/, '.lrc'))
    )
    h.db
      .update(files)
      .set({ relativePath: oldPath })
      .where(eq(files.trackId, track.id))
      .run()
    h.db
      .update(uploads)
      .set({
        remotePath: oldPath,
        lrcRemotePath: oldPath.replace(/\.m4a$/, '.lrc'),
      })
      .where(eq(uploads.trackId, track.id))
      .run()
    const move = vi.spyOn(h.deps.rclone, 'move')
    const upload = vi.spyOn(h.deps.rclone, 'upload')
    h.reconciler.markDirty()
    await h.idle()
    const newPath = h.file(track.id)!.relativePath
    expect(newPath).toBe(desired)
    expect(move.mock.calls.map((call) => [call[1], call[2]])).toEqual(
      expect.arrayContaining([
        [oldPath, newPath],
        [oldPath.replace(/\.m4a$/, '.lrc'), newPath.replace(/\.m4a$/, '.lrc')],
      ])
    )
    expect(upload).not.toHaveBeenCalled()
    expect(h.upload(track.id)?.remotePath).toBe(newPath)
    expect(h.upload(track.id)?.lrcRemotePath).toBe(
      newPath.replace(/\.m4a$/, '.lrc')
    )
  })
})
