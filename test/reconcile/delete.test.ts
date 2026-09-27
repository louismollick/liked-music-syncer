import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  contributions,
  tombstones,
  tracks,
} from '../../src/main/library/schema'
import { deleteTracks, processTombstones } from '../../src/main/reconcile/steps'
import { Harness, song } from './harness'

const open: Harness[] = []
function harness() {
  const h = new Harness()
  open.push(h)
  return h
}
function unwanted(h: Harness, trackId: string) {
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
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

describe('explicit destination delete', () => {
  for (const where of ['local', 'remote', 'both'] as const) {
    it(`${where} writes tombstones before deleting and retains only remaining destinations`, async () => {
      const h = harness()
      h.lyricsText = '[00:01.00]Hello'
      h.catalog.likes = [song(`delete-${where}`, `Delete ${where}`)]
      await h.start()
      await h.stop()
      const track = h.rows()[0]
      const file = h.file(track.id)!
      const local = path.join(h.library, file.relativePath)
      const remote = path.join(h.remote, file.relativePath)
      unwanted(h, track.id)
      expect(deleteTracks(h.deps, [track.id], where)).toEqual([track.id])
      const pending = h.db.select().from(tombstones).all()
      expect(pending.map((row) => row.kind)).toEqual(
        where === 'both'
          ? ['local', 'local', 'remote', 'remote']
          : [where, where]
      )
      expect(pending.every((row) => row.doneAt === null)).toBe(true)
      expect(existsSync(local)).toBe(true)
      expect(existsSync(remote)).toBe(true)
      expect(h.row(track.identityKey!)).toMatchObject({
        state: 'no_longer_wanted',
      })
      await processTombstones(h.deps, new AbortController().signal)
      expect(existsSync(local)).toBe(where === 'remote')
      expect(existsSync(remote)).toBe(where === 'local')
      expect(existsSync(local.replace(/\.m4a$/, '.lrc'))).toBe(
        where === 'remote'
      )
      expect(existsSync(remote.replace(/\.m4a$/, '.lrc'))).toBe(
        where === 'local'
      )
      expect(
        h.db
          .select()
          .from(tombstones)
          .all()
          .every((row) => row.doneAt)
      ).toBe(true)
      if (where === 'both') expect(h.row(track.identityKey!)).toBeUndefined()
      else
        expect(h.row(track.identityKey!)).toMatchObject({
          state: 'no_longer_wanted',
        })
      expect(Boolean(h.file(track.id))).toBe(where === 'remote')
      expect(Boolean(h.upload(track.id))).toBe(where === 'local')
    })
  }

  it('never deletes a local or remote path now owned by another track', async () => {
    const h = harness()
    h.lyricsText = '[00:01.00]Hello'
    h.catalog.likes = [song('owner', 'Owner')]
    await h.start()
    await h.stop()
    const track = h.rows()[0]
    const file = h.file(track.id)!
    const local = path.join(h.library, file.relativePath)
    const remote = path.join(h.remote, file.relativePath)
    const localBytes = readFileSync(local)
    const remoteBytes = readFileSync(remote)
    for (const kind of ['local', 'remote'] as const) {
      for (const name of [
        file.relativePath,
        file.relativePath.replace(/\.m4a$/, '.lrc'),
      ]) {
        h.db
          .insert(tombstones)
          .values({
            id: `${kind}:${name}`,
            trackId: null,
            kind,
            path: name,
            reason: 'old owner',
            createdAt: h.time.toISOString(),
          })
          .run()
      }
    }
    await processTombstones(h.deps, new AbortController().signal)
    expect(readFileSync(local).equals(localBytes)).toBe(true)
    expect(readFileSync(remote).equals(remoteBytes)).toBe(true)
    expect(existsSync(local.replace(/\.m4a$/, '.lrc'))).toBe(true)
    expect(existsSync(remote.replace(/\.m4a$/, '.lrc'))).toBe(true)
    // Handled (left alone) and then pruned: none stay pending.
    expect(h.db.select().from(tombstones).all()).toHaveLength(0)
  })

  it('finishes a both-destination delete after reopening the database', async () => {
    const h = harness()
    h.catalog.likes = [song('restart-delete', 'Restart Delete')]
    await h.start()
    await h.stop()
    const track = h.rows()[0]
    const relative = h.file(track.id)!.relativePath
    unwanted(h, track.id)
    deleteTracks(h.deps, [track.id], 'both')
    expect(h.row(track.identityKey!)).toMatchObject({
      state: 'no_longer_wanted',
    })
    h.reopen()
    await processTombstones(h.deps, new AbortController().signal)
    expect(existsSync(path.join(h.library, relative))).toBe(false)
    expect(existsSync(path.join(h.remote, relative))).toBe(false)
    expect(h.row(track.identityKey!)).toBeUndefined()
  })

  it('skips tracks that regained an active contribution or are not No Longer Wanted', async () => {
    const h = harness()
    h.catalog.likes = [song('wanted')]
    await h.start()
    await h.stop()
    const track = h.rows()[0]
    expect(deleteTracks(h.deps, [track.id], 'both')).toEqual([])
    h.db
      .update(tracks)
      .set({ state: 'no_longer_wanted' })
      .where(eq(tracks.id, track.id))
      .run()
    expect(h.reconciler.delete([track.id], 'both')).toEqual([])
    expect(h.file(track.id)).toBeTruthy()
    expect(h.upload(track.id)).toBeTruthy()
    expect(h.db.select().from(tombstones).all()).toHaveLength(0)
  })

  it('deletes a remote tombstone from its recorded target after settings change', async () => {
    const h = harness()
    h.catalog.likes = [song('old-remote')]
    await h.start()
    await h.stop()
    const track = h.rows()[0]
    const relative = h.file(track.id)!.relativePath
    unwanted(h, track.id)
    deleteTracks(h.deps, [track.id], 'remote')
    const oldRemote = path.join(h.remote, relative)
    const nextRemote = path.join(h.root, 'next-remote')
    mkdirSync(path.dirname(path.join(nextRemote, relative)), {
      recursive: true,
    })
    const nextFile = path.join(nextRemote, relative)
    const bytes = readFileSync(oldRemote)
    ;(await import('node:fs')).writeFileSync(nextFile, bytes)
    h.settings.remoteFolder = nextRemote
    await processTombstones(h.deps, new AbortController().signal)
    expect(existsSync(oldRemote)).toBe(false)
    expect(readFileSync(nextFile).equals(bytes)).toBe(true)
  })
})
