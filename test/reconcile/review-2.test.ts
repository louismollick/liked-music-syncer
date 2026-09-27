import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectOutsideEdits } from '../../src/main/inventory/inventory'
import { files, tombstones, tracks } from '../../src/main/library/schema'
import { validateLikedSnapshot } from '../../src/main/reconcile/sources'
import { processTombstones } from '../../src/main/reconcile/steps'
import { readTags, writeTags } from '../../src/main/tags/schema'
import { makeM4a } from '../helpers/audio'
import { Harness, song } from './harness'

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

function absoluteFile(h: Harness, trackId: string): string {
  return path.join(h.library, h.file(trackId)!.relativePath)
}

describe('second review fixes', () => {
  it('keeps genre and lyrics when providers fail during a Refresh', async () => {
    const h = harness()
    h.lyricsText = '[00:01.00]Hello'
    vi.spyOn(h.deps.matcher, 'enrich').mockResolvedValue({
      mbRecordingId: 'mb-1',
      genre: 'Rock',
      isrc: 'ISRC1',
    })
    h.catalog.likes = [song('keep', 'Keep')]
    await h.start()
    const track = h.rows()[0]
    const before = readFileSync(absoluteFile(h, track.id))
    vi.spyOn(h.deps.matcher, 'enrich').mockRejectedValue(
      new Error('MusicBrainz 503')
    )
    vi.spyOn(h.deps.lyrics, 'find').mockResolvedValue({
      lyrics: null,
      spotifyTrackId: null,
      errors: { lrclib: 'down' },
    })
    h.reconciler.refresh({ kind: 'track', id: track.id })
    await h.idle()
    const after = h.rows()[0]
    expect(after.genre).toBe('Rock')
    expect(after.isrc).toBe('ISRC1')
    expect(after.lyricsText).toBe('[00:01.00]Hello')
    expect(readFileSync(absoluteFile(h, track.id)).equals(before)).toBe(true)
  })

  it('retags in place when only the capitalisation of the path changes', async () => {
    const h = harness()
    h.catalog.likes = [song('case', 'Case Song')]
    await h.start()
    const track = h.rows()[0]
    const original = h.file(track.id)!.relativePath
    h.matcher.matches.set('case', {
      ...(await h.deps.matcher.match({
        kind: 'liked',
        song: song('case', 'case song'),
      })),
    })
    h.reconciler.refresh({ kind: 'track', id: track.id })
    await h.idle()
    const after = h.rows()[0]
    expect(after.state).toBe('done')
    expect(after.title).toBe('case song')
    expect(h.file(track.id)!.relativePath.toLowerCase()).toBe(
      original.toLowerCase()
    )
    expect(readTags(absoluteFile(h, track.id)).fields.title).toBe('case song')
  })

  it('makes Stop managing stick across checks and restarts', async () => {
    const h = harness()
    h.catalog.likes = [song('released', 'Released')]
    await h.start()
    const track = h.rows()[0]
    const absolute = absoluteFile(h, track.id)
    h.reconciler.stopManaging(track.id)
    await h.check()
    expect(h.downloads).toHaveLength(1)
    await h.stop()
    h.reopen()
    await h.start()
    expect(h.downloads).toHaveLength(1)
    expect(existsSync(absolute)).toBe(true)
    expect(h.db.select().from(files).all()).toHaveLength(0)
    expect(
      h.db.select().from(tracks).where(eq(tracks.id, track.id)).get()?.state
    ).toBe('released')
  })

  it('rewrites an audio edit in place instead of leaving a duplicate', async () => {
    const h = harness()
    h.catalog.likes = [song('audio', 'Audio')]
    await h.start()
    const track = h.rows()[0]
    const absolute = absoluteFile(h, track.id)
    const tags = readTags(absolute)
    makeM4a(absolute, 0.7, 880)
    writeTags(absolute, tags.fields, tags.cover)
    await detectOutsideEdits(inventoryDeps(h), h.library)
    expect(JSON.parse(h.file(track.id)!.outsideEdit!)).toEqual(['audio'])
    await h.reconciler.rewrite(track.id)
    await h.idle()
    expect(h.downloads).toHaveLength(2)
    expect(path.join(h.library, h.file(track.id)!.relativePath)).toBe(absolute)
    expect(h.file(track.id)!.outsideEdit).toBeNull()
  })

  it('does not overwrite a file edited while the app is running', async () => {
    const h = harness()
    h.catalog.likes = [song('live', 'Live')]
    await h.start()
    const track = h.rows()[0]
    const absolute = absoluteFile(h, track.id)
    const tags = readTags(absolute)
    writeTags(absolute, { ...tags.fields, title: 'Edited by hand' }, tags.cover)
    h.lyricsText = '[00:02.00]New lyrics'
    h.reconciler.refresh({ kind: 'track', id: track.id })
    await h.idle()
    expect(readTags(absolute).fields.title).toBe('Edited by hand')
    expect(JSON.parse(h.file(track.id)!.outsideEdit!)).toContain('tags')
  })

  it('ignores an unmounted library folder and clears flags when files come back', async () => {
    const h = harness()
    h.catalog.likes = [song('mount', 'Mount')]
    await h.start()
    const track = h.rows()[0]
    const report = await detectOutsideEdits(
      inventoryDeps(h),
      path.join(h.root, 'not-mounted')
    )
    expect(report.checked).toBe(0)
    expect(h.file(track.id)!.outsideEdit).toBeNull()
    h.db
      .update(files)
      .set({ outsideEdit: JSON.stringify(['deleted']) })
      .where(eq(files.trackId, track.id))
      .run()
    await detectOutsideEdits(inventoryDeps(h), h.library)
    expect(h.file(track.id)!.outsideEdit).toBeNull()
  })

  it('rejects a liked list that stops well short of its declared count', () => {
    const songs = Array.from({ length: 100 }, (_, i) => ({
      ...song(`v${i}`),
      position: i,
    }))
    expect(() => validateLikedSnapshot(songs.slice(0, 70), 100, 100)).toThrow(
      /Only 70 of 100/
    )
    // Unavailable songs make the header ~10% higher than what parses; that is fine.
    expect(() =>
      validateLikedSnapshot(songs.slice(0, 90), 100, 100)
    ).not.toThrow()
  })

  it('keeps processing tombstones when one remote delete fails', async () => {
    const h = harness()
    const local = path.join(h.library, 'stray.m4a')
    makeM4a(local)
    const at = h.time.toISOString()
    h.db
      .insert(tombstones)
      .values([
        {
          id: randomUUID(),
          kind: 'remote',
          path: 'x.m4a',
          remoteTarget: ':no-such-backend|/x',
          reason: 'deleted',
          createdAt: at,
        },
        {
          id: randomUUID(),
          kind: 'local',
          path: 'stray.m4a',
          reason: 'deleted',
          createdAt: at,
        },
      ])
      .run()
    await processTombstones(h.deps, new AbortController().signal)
    expect(existsSync(local)).toBe(false)
    const pending = h.db
      .select()
      .from(tombstones)
      .all()
      .filter((row) => !row.doneAt)
    expect(pending.map((row) => row.kind)).toEqual(['remote'])
  })
})
