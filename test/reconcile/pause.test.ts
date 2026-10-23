import { mkdirSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityView } from '../../src/shared/ipc'
import { Harness, song } from './harness'

const open: Harness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('pausing syncing', () => {
  it('lets the step in flight finish, starts nothing new, and continues on resume', async () => {
    const h = new Harness()
    open.push(h)
    h.catalog.likes = [song('one'), song('two')]
    // Pause while the first track is being matched.
    h.matcher.during = () => {
      h.reconciler.pause()
      h.matcher.during = null
    }
    await h.reconciler.start()
    await until(() => !h.reconciler.activity().checking)
    await until(() => h.reconciler.activity().current === null)
    await new Promise((resolve) => setTimeout(resolve, 200))

    const paused = h.reconciler.activity()
    expect(paused.paused).toBe(true)
    expect(paused.current).toBeNull()
    expect(h.matcher.calls).toBe(1)
    expect(h.downloads).toEqual([])
    expect(h.rows().map((row) => row.state)).toEqual(['pending', 'pending'])
    expect(paused.upNextCount).toBe(2)

    h.reconciler.resume()
    expect(h.reconciler.activity().paused).toBe(false)
    await h.idle()
    expect(h.downloads.sort()).toEqual(['one', 'two'])
    expect(h.rows().map((row) => row.state)).toEqual(['done', 'done'])
  })

  it('stops the upload lane too, and the lists cache still shows the pause at once', async () => {
    const h = new Harness({ uploadConcurrency: 1 })
    open.push(h)
    h.catalog.likes = [song('one'), song('two')]
    await h.start()
    expect(h.rows().map((row) => row.state)).toEqual(['done', 'done'])
    const uploaded = h.rows().map((row) => h.upload(row.id)?.localSha256)
    expect(uploaded.every(Boolean)).toBe(true)

    // The lists are cached and clean now; pausing must still reach listeners.
    const views: ActivityView[] = []
    h.deps.onActivity = (view) => views.push(view)
    h.reconciler.activity()
    h.reconciler.pause()
    await until(() => views.length > 0)
    expect(views.at(-1)?.paused).toBe(true)
    expect(h.reconciler.activity().paused).toBe(true)

    // Uploads become due again; the first is in flight when syncing pauses.
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: string[][] = []
    const upload = h.deps.rclone.upload
    h.deps.rclone = {
      ...h.deps.rclone,
      upload: async (...args) => {
        started.push([])
        await gate
        return upload(...args)
      },
    }
    // The remote lost its files, so each track needs a real upload.
    rmSync(h.remote, { recursive: true, force: true })
    mkdirSync(h.remote)
    h.reconciler.resume()
    h.reconciler.remoteTargetChanged()
    await until(() => started.length === 1)
    h.reconciler.pause()
    release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    // The running upload finished; the second track's upload never started.
    expect(started).toHaveLength(1)
    expect(h.rows().filter((row) => h.upload(row.id))).toHaveLength(1)
    expect(h.reconciler.activity()).toMatchObject({
      paused: true,
      uploading: [],
    })

    h.reconciler.resume()
    await until(() => views.at(-1)?.paused === false)
    await h.idle()
    expect(h.rows().map((row) => !!h.upload(row.id))).toEqual([true, true])
  })
})
