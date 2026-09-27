import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ sidecarLink: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (fault.sidecarLink && to.endsWith('.lrc'))
        throw new Error('sidecar placement failed')
      return actual.link(from, to)
    },
  }
})

import { files, operations } from '../../src/main/library/schema'
import { runMove } from '../../src/main/reconcile/steps'
import { Harness, song } from './harness'

const open: Harness[] = []
afterEach(async () => {
  fault.sidecarLink = false
  for (const h of open.splice(0)) await h.close()
})

it('keeps the source sidecar and fails the move when sidecar placement fails', async () => {
  const h = new Harness()
  open.push(h)
  h.settings.remoteEnabled = false
  h.lyricsText = '[00:01.00]Hello'
  h.catalog.likes = [song('move-sidecar', 'Move Sidecar')]
  await h.start()
  await h.stop()
  const track = h.rows()[0]
  const current = h.file(track.id)!
  const oldPath = 'Test Artist/Old Place/Move Sidecar.m4a'
  mkdirSync(path.dirname(path.join(h.library, oldPath)), { recursive: true })
  renameSync(
    path.join(h.library, current.relativePath),
    path.join(h.library, oldPath)
  )
  renameSync(
    path.join(h.library, current.relativePath.replace(/\.m4a$/, '.lrc')),
    path.join(h.library, oldPath.replace(/\.m4a$/, '.lrc'))
  )
  h.db
    .update(files)
    .set({ relativePath: oldPath })
    .where(eq(files.trackId, track.id))
    .run()
  fault.sidecarLink = true
  await expect(
    runMove(h.deps, track, {
      signal: new AbortController().signal,
      progress: () => {},
    })
  ).rejects.toThrow('sidecar placement failed')
  expect(existsSync(path.join(h.library, oldPath))).toBe(true)
  expect(
    existsSync(path.join(h.library, oldPath.replace(/\.m4a$/, '.lrc')))
  ).toBe(true)
})

it('journals the acquisition audio video ID before a failed sidecar placement', async () => {
  const h = new Harness()
  open.push(h)
  h.settings.remoteEnabled = false
  h.lyricsText = '[00:01.00]Hello'
  h.catalog.likes = [song('journal-video')]
  fault.sidecarLink = true
  await h.start()
  const audio = h.db
    .select()
    .from(operations)
    .all()
    .find((row) => row.artifact === 'audio')
  expect(audio?.audioVideoId).toBe('journal-video')
})
