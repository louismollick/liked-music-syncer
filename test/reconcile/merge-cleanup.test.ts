import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256File } from '../../src/main/inventory/files'
import {
  files,
  tombstones,
  unmanagedFiles,
} from '../../src/main/library/schema'
import { processTombstones, runMatch } from '../../src/main/reconcile/steps'
import { Harness, release, releaseMatch, song } from './harness'

const open: Harness[] = []
function harness(remote = false) {
  const h = new Harness()
  open.push(h)
  h.settings.remoteEnabled = remote
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

const run = () => ({ signal: new AbortController().signal, progress: () => {} })
const source = song('src', 'Source')
const targetSong = song('tgt', 'Target')
const album = release('rel', targetSong)

/**
 * Two filed tracks, then the source's Refresh resolves to the target's Release
 * Track `rel:tgt`. `audio` sets which video each file is recorded to hold.
 */
async function merged(
  h: Harness,
  audio: { source?: string; target?: string } = {}
) {
  h.lyricsText = '[00:01.00]Hello'
  h.matcher.matches.set('tgt', releaseMatch(targetSong, album))
  h.catalog.likes = [source, targetSong]
  await h.start()
  await h.stop()
  const old = h.row('video:src')!
  const target = h.row('rel:tgt')!
  const sourceFile = h.file(old.id)!
  const targetFile = h.file(target.id)!
  const sourceUpload = h.upload(old.id)
  const targetUpload = h.upload(target.id)
  if (audio.source)
    h.db
      .update(files)
      .set({ audioVideoId: audio.source })
      .where(eq(files.trackId, old.id))
      .run()
  if (audio.target)
    h.db
      .update(files)
      .set({ audioVideoId: audio.target })
      .where(eq(files.trackId, target.id))
      .run()
  h.matcher.matches.set('src', releaseMatch(source, album, 'tgt'))
  const local = (relative: string) => path.join(h.library, relative)
  return {
    old,
    target,
    sourceFile,
    targetFile,
    sourceUpload,
    targetUpload,
    local,
    remote: (relative: string) => path.join(h.remote, relative),
    merge: () =>
      runMatch(h.deps, h.rows().find((r) => r.id === old.id)!, run()),
  }
}

const tidy = (h: Harness) =>
  processTombstones(h.deps, new AbortController().signal)

function released(h: Harness, relative: string) {
  return h.db
    .select()
    .from(unmanagedFiles)
    .where(eq(unmanagedFiles.relativePath, relative))
    .get()?.released
}

describe('merge file lifecycle', () => {
  it('keeps the source file when it holds the matched video and the target does not', async () => {
    const h = harness()
    const m = await merged(h, { source: 'tgt', target: 'other' })
    await m.merge()
    expect(h.file(m.target.id)?.relativePath).toBe(m.sourceFile.relativePath)
    await h.start()
    expect(h.downloads).toEqual(['src', 'tgt'])
    expect(existsSync(m.local(m.targetFile.relativePath))).toBe(false)
  })

  it('keeps a wrong-audio target until its download replaces it, and a failed download deletes nothing', async () => {
    const h = harness()
    const m = await merged(h, { target: 'other' })
    await m.merge()
    expect(h.file(m.target.id)?.relativePath).toBe(m.targetFile.relativePath)
    await tidy(h)
    expect(existsSync(m.local(m.sourceFile.relativePath))).toBe(true)

    const download = h.deps.downloader.download
    h.deps.downloader.download = async () => {
      throw Object.assign(new Error('offline'), { kind: 'permanent' })
    }
    await h.start()
    await h.stop()
    await tidy(h)
    expect(existsSync(m.local(m.sourceFile.relativePath))).toBe(true)

    h.deps.downloader.download = download
    h.reconciler.retry(m.target.id)
    await h.start()
    expect(h.file(m.target.id)?.audioVideoId).toBe('tgt')
    expect(existsSync(m.local(m.sourceFile.relativePath))).toBe(false)
    expect(existsSync(m.local(m.targetFile.relativePath))).toBe(true)
  })

  it('keeps a damaged target on disk as a released Unmanaged File', async () => {
    const h = harness()
    const m = await merged(h)
    writeFileSync(
      m.local(m.targetFile.relativePath),
      Buffer.alloc(m.targetFile.size)
    )
    await m.merge()
    expect(h.file(m.target.id)?.relativePath).toBe(m.sourceFile.relativePath)
    expect(released(h, m.targetFile.relativePath)).toBe(true)
    await h.start()
    await tidy(h)
    expect(existsSync(m.local(m.targetFile.relativePath))).toBe(true)
  })

  it('drops the record of a target file that is gone', async () => {
    const h = harness()
    const m = await merged(h)
    rmSync(m.local(m.targetFile.relativePath))
    await m.merge()
    expect(h.file(m.target.id)?.relativePath).toBe(m.sourceFile.relativePath)
    expect(released(h, m.targetFile.relativePath)).toBeUndefined()
  })

  it('deletes remote copies only once the replacement is uploaded to that same remote', async () => {
    const h = harness(true)
    const m = await merged(h, { target: 'other' })
    await m.merge()
    const oldRemote = m.remote(m.sourceUpload!.remotePath!)
    const upload = vi
      .spyOn(h.deps.rclone, 'upload')
      .mockRejectedValue(
        Object.assign(new Error('remote down'), { kind: 'permanent' })
      )
    await h.start()
    await h.stop()
    await tidy(h)
    // Replaced locally, so the local copy went; the remote one waits.
    expect(existsSync(m.local(m.sourceFile.relativePath))).toBe(false)
    expect(existsSync(oldRemote)).toBe(true)

    upload.mockRestore()
    h.settings.remoteEnabled = false
    await tidy(h)
    expect(existsSync(oldRemote)).toBe(true)

    h.settings.remoteEnabled = true
    h.reconciler.retry(m.target.id)
    await h.start()
    await h.stop()
    await tidy(h)
    expect(existsSync(oldRemote)).toBe(false)
  })

  it('makes cleanup wait for the new survivor after a second merge', async () => {
    const h = harness()
    const m = await merged(h, { target: 'other' })
    await m.merge()
    const third = song('third', 'Third')
    h.catalog.likes = [third, source, targetSong]
    const final = release('final', song('fin', 'Final'))
    h.matcher.matches.set('third', releaseMatch(third, final, 'fin'))
    // Stop the target from finishing its download before the second merge.
    const download = h.deps.downloader.download
    h.deps.downloader.download = async () => {
      throw Object.assign(new Error('offline'), { kind: 'permanent' })
    }
    await h.start()
    await h.stop()
    const survivor = h.row('final:fin')!
    h.matcher.matches.set('tgt', releaseMatch(targetSong, final, 'fin'))
    h.matcher.matches.set('src', releaseMatch(source, final, 'fin'))
    await runMatch(h.deps, h.rows().find((r) => r.id === m.target.id)!, run())
    const waiting = h.db
      .select()
      .from(tombstones)
      .all()
      .filter((row) => row.replacementTrackId)
    expect(waiting.length).toBeGreaterThan(0)
    expect(waiting.every((row) => row.replacementTrackId === survivor.id)).toBe(
      true
    )
    h.deps.downloader.download = download
  })

  it('keeps displaced copies when the user stops managing the survivor', async () => {
    const h = harness(true)
    const m = await merged(h, { target: 'other' })
    await m.merge()
    h.reconciler.stopManaging(m.target.id)
    await tidy(h)
    expect(released(h, m.sourceFile.relativePath)).toBe(true)
    expect(existsSync(m.local(m.sourceFile.relativePath))).toBe(true)
    expect(existsSync(m.remote(m.sourceUpload!.remotePath!))).toBe(true)
    expect(
      h.db
        .select()
        .from(tombstones)
        .all()
        .filter((row) => !row.doneAt && row.replacementTrackId)
    ).toHaveLength(0)
  })

  it('applies a delete of the survivor only to the side the user chose', async () => {
    for (const where of ['local', 'remote'] as const) {
      const h = harness(true)
      const m = await merged(h, { target: 'other' })
      await m.merge()
      // Unlike everything, so the survivor is No Longer Wanted, then delete one side.
      h.catalog.likes = []
      h.catalog.declaredCount = 0
      await h.check()
      await h.stop()
      expect(h.reconciler.delete([m.target.id], where)).toEqual([m.target.id])
      await tidy(h)
      const oldLocal = m.local(m.sourceFile.relativePath)
      const oldRemote = m.remote(m.sourceUpload!.remotePath!)
      if (where === 'local') {
        expect(existsSync(oldLocal)).toBe(false)
        expect(existsSync(oldRemote)).toBe(true)
      } else {
        expect(existsSync(oldRemote)).toBe(false)
        expect(existsSync(oldLocal)).toBe(true)
        expect(released(h, m.sourceFile.relativePath)).toBe(true)
      }
      expect(
        h.db
          .select()
          .from(tombstones)
          .all()
          .filter((row) => row.replacementTrackId)
      ).toHaveLength(0)
    }
  })

  it('keeps displaced audio and sidecars that changed while waiting', async () => {
    const h = harness()
    const m = await merged(h, { target: 'other' })
    await m.merge()
    const oldAudio = m.local(m.sourceFile.relativePath)
    const oldSidecar = oldAudio.replace(/\.m4a$/, '.lrc')
    writeFileSync(oldAudio, Buffer.from('edited audio'))
    writeFileSync(oldSidecar, 'edited lyrics\n')
    await h.start()
    expect(h.file(m.target.id)?.audioVideoId).toBe('tgt')
    expect(existsSync(oldAudio)).toBe(true)
    expect(existsSync(oldSidecar)).toBe(true)
    expect(released(h, m.sourceFile.relativePath)).toBe(true)
    expect(
      released(h, m.sourceFile.relativePath.replace(/\.m4a$/, '.lrc'))
    ).toBe(true)
  })

  it('never deletes a replacement that now sits at a displaced path', async () => {
    const h = harness()
    const m = await merged(h)
    await m.merge()
    await h.start()
    const survivor = h.file(m.target.id)!
    const oldHash = 'not-the-current-bytes'
    h.db
      .insert(tombstones)
      .values({
        id: 'reused-path',
        trackId: null,
        kind: 'local',
        path: survivor.relativePath,
        reason: 'merged',
        createdAt: h.time.toISOString(),
        replacementTrackId: m.target.id,
        expectedSha256: oldHash,
      })
      .run()
    await tidy(h)
    const absolute = m.local(survivor.relativePath)
    expect(existsSync(absolute)).toBe(true)
    expect(await sha256File(absolute)).toBe(survivor.contentSha256)
  })
})
