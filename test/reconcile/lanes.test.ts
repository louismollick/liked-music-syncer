import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { files, tracks, uploads } from '../../src/main/library/schema'
import type { Tuning } from '../../src/main/reconcile/reconciler'
import { runUpload } from '../../src/main/reconcile/steps'
import {
  createRclone,
  type Rclone,
  type RemoteObject,
} from '../../src/main/remote/rclone'
import { makeM4a } from '../helpers/audio'
import { Harness, song } from './harness'

const open: Harness[] = []
function harness(tuning?: Partial<Tuning>) {
  const h = new Harness(tuning)
  open.push(h)
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

async function until(condition: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting for a condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const outage = () =>
  new Error(
    'rclone exited with 1: Failed to copy: dial tcp 10.0.0.2:22: i/o timeout'
  )

/** Wraps the real rclone (local backend) so a test can watch and break it. */
function instrument(h: Harness) {
  const real = h.deps.rclone
  const spy = {
    uploadCalls: [] as string[][],
    lists: 0,
    active: 0,
    maxActive: 0,
    uploadDelayMs: 0,
    gate: null as Promise<void> | null,
    uploadDown: false,
    listDown: false,
    listHang: false,
    listError: null as Error | null,
    /** Leaves a same-size, same-time remote sidecar with other bytes. */
    corruptSidecar: false,
  }
  const wrapped: Rclone = {
    ...real,
    async list(target, options, signal) {
      spy.lists += 1
      if (spy.listDown) throw outage()
      if (spy.listError) throw spy.listError
      if (spy.listHang)
        return new Promise<Map<string, RemoteObject>>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason))
        })
      return real.list(target, options, signal)
    },
    async upload(target, root, relativePaths, onProgress, signal) {
      spy.uploadCalls.push(relativePaths)
      if (spy.uploadDown) throw outage()
      if (spy.corruptSidecar) {
        for (const relative of relativePaths.filter((item) =>
          item.endsWith('.lrc')
        )) {
          const local = path.join(root, relative)
          const remote = path.join(target.folder, relative)
          mkdirSync(path.dirname(remote), { recursive: true })
          writeFileSync(remote, 'x'.repeat(statSync(local).size))
          // rclone skips a remote file with the same size and time.
          const time = new Date('2026-01-01T00:00:00Z')
          utimesSync(local, time, time)
          utimesSync(remote, time, time)
        }
      }
      spy.active += 1
      spy.maxActive = Math.max(spy.maxActive, spy.active)
      try {
        await spy.gate
        if (spy.uploadDelayMs)
          await new Promise((resolve) => setTimeout(resolve, spy.uploadDelayMs))
        return await real.upload(
          target,
          root,
          relativePaths,
          onProgress,
          signal
        )
      } finally {
        spy.active -= 1
      }
    },
  }
  h.deps.rclone = wrapped
  return spy
}

describe('upload lane', () => {
  it('uploads up to three tracks at once while the next ones download', async () => {
    const h = harness()
    const spy = instrument(h)
    spy.uploadDelayMs = 200
    const activeAtDownload: number[] = []
    const download = h.deps.downloader.download
    h.deps.downloader = {
      download: async (...args) => {
        activeAtDownload.push(spy.active)
        return download(...args)
      },
    }
    await h.start()
    h.catalog.likes = [1, 2, 3, 4, 5, 6].map((n) => song(`track-${n}`))
    await h.check()
    expect(spy.maxActive).toBe(3)
    expect(Math.max(...activeAtDownload)).toBeGreaterThan(0)
    expect(h.rows().every((row) => row.state === 'done')).toBe(true)
    expect(h.db.select().from(uploads).all()).toHaveLength(6)
  })

  it('runs no other step on a track while it uploads', async () => {
    const h = harness()
    const spy = instrument(h)
    let release!: () => void
    spy.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.catalog.likes = [song('busy')]
    await h.reconciler.start()
    await until(() => h.reconciler.activity().uploading.length === 1)
    const track = h.rows()[0]
    const live = h.reconciler.activity()
    expect(live.current).toBeNull()
    expect(live.uploading[0]).toMatchObject({
      id: track.id,
      stage: 'uploading',
    })

    // A refresh wants a new match, but the upload is still the track's step.
    const matched = h.matcher.calls
    h.reconciler.refresh({ kind: 'track', id: track.id })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(h.matcher.calls).toBe(matched)
    expect(h.reconciler.activity().uploading).toHaveLength(1)
    expect(h.reconciler.activity().upNext).toEqual([])

    release()
    await h.idle()
    expect(h.matcher.calls).toBeGreaterThan(matched)
    expect(h.row('video:busy')?.state).toBe('done')
    expect(h.upload(track.id)?.localSha256).toBe(
      h.file(track.id)?.contentSha256
    )
  })

  it('uploads the audio and its sidecar in one run and spends two rclone processes per track', async () => {
    const h = harness()
    const log = path.join(h.root, 'rclone.log')
    const wrapper = path.join(h.root, 'rclone-wrapper.sh')
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho "$1" >> '${log}'\nexec ${process.env.RCLONE_BINARY ?? 'rclone'} "$@"\n`,
      { mode: 0o755 }
    )
    h.deps.rclone = createRclone(wrapper)
    h.lyricsText = '[00:01.00]Hello'
    await h.start()
    await h.reconciler.checkRemote()
    // The first upload also reads the remote's features once.
    h.catalog.likes = [song('one')]
    await h.check()
    writeFileSync(log, '')

    h.catalog.likes = [song('one'), song('two')]
    await h.check()

    // One copy for the audio and the .lrc together, one hashed listing of both.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'copy',
      'lsjson',
    ])
    const two = h.file(h.row('video:two')!.id)!
    expect(existsSync(path.join(h.remote, two.relativePath))).toBe(true)
    expect(
      existsSync(
        path.join(h.remote, two.relativePath.replace(/\.m4a$/, '.lrc'))
      )
    ).toBe(true)
  })

  it('records nothing and retries when one file of a batch fails verification', async () => {
    const h = harness()
    const spy = instrument(h)
    spy.corruptSidecar = true
    h.lyricsText = '[00:01.00]Hello'
    await h.start()
    h.catalog.likes = [song('bad')]
    await h.check()

    const track = h.row('video:bad')!
    expect(spy.uploadCalls.at(-1)).toHaveLength(2)
    expect(h.upload(track.id)).toBeUndefined()
    expect(track).toMatchObject({ state: 'pending', attempts: 1 })
    expect(track.lastError).toMatch(/verification failed for .*bad\.lrc$/)

    spy.corruptSidecar = false
    rmSync(
      path.join(
        h.remote,
        h.file(track.id)!.relativePath.replace(/\.m4a$/, '.lrc')
      )
    )
    h.time = new Date(h.time.getTime() + 120_000)
    h.reconciler.markDirty()
    await h.idle()
    expect(h.upload(track.id)?.verifiedAt).toBeTruthy()
    expect(h.row('video:bad')?.state).toBe('done')
  })
})

describe('remote path reservations', () => {
  /**
   * Track A is retagged and moves locally from P to Q, so its upload sends Q and
   * then deletes the old remote P. Track B downloads to the freed P meanwhile and
   * uploads it, while A's upload of Q is still in flight.
   */
  it("keeps another track's verified upload when the old path is cleaned up", async () => {
    const h = harness()
    await h.start()
    h.catalog.likes = [song('a', 'Alpha'), song('b', 'Beta')]
    await h.check()
    await h.stop()
    const a = h.rows().find((row) => row.identityKey === 'video:a')!
    const b = h.rows().find((row) => row.identityKey === 'video:b')!
    const p = h.file(a.id)!.relativePath
    const q = 'Test Artist/Alpha Retagged/Alpha.m4a'

    // A: new bytes at a new local path; its remote copy is still at P.
    mkdirSync(path.dirname(path.join(h.library, q)), { recursive: true })
    rmSync(path.join(h.library, p))
    makeM4a(path.join(h.library, q), 0.5, 880)
    const aBytes = readFileSync(path.join(h.library, q))
    h.db
      .update(files)
      .set({
        relativePath: q,
        size: aBytes.length,
        contentSha256: createHash('sha256').update(aBytes).digest('hex'),
      })
      .where(eq(files.trackId, a.id))
      .run()
    // B: downloaded to the freed P, with no upload record yet.
    renameSync(
      path.join(h.library, h.file(b.id)!.relativePath),
      path.join(h.library, p)
    )
    h.db
      .update(files)
      .set({ relativePath: p })
      .where(eq(files.trackId, b.id))
      .run()
    h.db.delete(uploads).where(eq(uploads.trackId, b.id)).run()

    // Hold A's upload until B has been started.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const real = h.deps.rclone
    h.deps.rclone = {
      ...real,
      async upload(target, root, relativePaths, onProgress, signal) {
        if (relativePaths.includes(q)) await gate
        return real.upload(target, root, relativePaths, onProgress, signal)
      },
    }
    const step = (id: string) =>
      runUpload(
        h.deps,
        h.db.select().from(tracks).where(eq(tracks.id, id)).get()!,
        {
          signal: new AbortController().signal,
          progress: () => {},
        }
      )
    const aRun = step(a.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const bRun = step(b.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    await Promise.all([aRun, bRun])

    expect(h.upload(a.id)?.remotePath).toBe(q)
    expect(h.upload(b.id)?.remotePath).toBe(p)
    // The recorded copy of B is really there, with B's bytes.
    expect(readFileSync(path.join(h.remote, p))).toEqual(
      readFileSync(path.join(h.library, p))
    )
    expect(existsSync(path.join(h.remote, q))).toBe(true)
  })
})

describe('outages', () => {
  it('waits out a VPS outage without using the retries of any track, then catches up', async () => {
    const h = harness({ probeBackoffMs: [30, 30] })
    const spy = instrument(h)
    spy.uploadDown = true
    h.catalog.likes = [song('a'), song('b')]
    await h.reconciler.start()
    await until(() => h.reconciler.activity().remoteUnreachable)
    // Several failed uploads would exhaust the retries of a per-track backoff.
    await until(() => spy.uploadCalls.length >= 6)
    for (const row of h.rows()) {
      expect(row.state).not.toBe('needs_attention')
      expect(row).toMatchObject({ attempts: 0, lastError: null })
    }
    expect(h.reconciler.activity().offline).toBe(false)
    // Downloads were not held up.
    expect(h.db.select().from(uploads).all()).toEqual([])
    await until(() => h.rows().every((row) => h.file(row.id)))

    spy.uploadDown = false
    await h.idle()
    expect(h.db.select().from(uploads).all()).toHaveLength(2)
    expect(h.rows().every((row) => row.state === 'done')).toBe(true)
    expect(h.reconciler.activity().remoteUnreachable).toBe(false)
  })

  it('pauses uploads when the startup audit cannot reach the VPS and shows why', async () => {
    const h = harness({ probeBackoffMs: [30, 30] })
    const spy = instrument(h)
    spy.listDown = true
    h.catalog.likes = [song('a')]
    await h.reconciler.start()
    await until(() => h.reconciler.activity().remoteUnreachable)
    await until(() => spy.lists >= 3)
    expect(h.reconciler.activity().needsAttention).toMatchObject([
      { kind: 'source', title: 'Remote Library check' },
    ])
    expect(spy.uploadCalls).toEqual([])

    spy.listDown = false
    await h.idle()
    expect(h.upload(h.rows()[0].id)).toBeTruthy()
    expect(h.reconciler.activity()).toMatchObject({
      remoteUnreachable: false,
      needsAttention: [],
    })
  })

  it('waits out an internet outage without using retries, then catches up', async () => {
    const h = harness({ probeBackoffMs: [30, 30] })
    let online = false
    let attempts = 0
    const download = h.deps.downloader.download
    h.deps.downloader = {
      download: async (...args) => {
        attempts += 1
        if (!online)
          throw new Error(
            'yt-dlp failed: ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>'
          )
        return download(...args)
      },
    }
    h.catalog.likes = [song('x')]
    await h.reconciler.start()
    await until(() => h.reconciler.activity().offline)
    // Between probes the track is pending; during one it is briefly working.
    await until(() => attempts >= 5 && h.rows()[0].state === 'pending')
    expect(h.rows()[0]).toMatchObject({ state: 'pending', attempts: 0 })
    expect(h.reconciler.activity().remoteUnreachable).toBe(false)

    online = true
    await h.idle()
    expect(h.row('video:x')?.state).toBe('done')
    expect(h.upload(h.rows()[0].id)).toBeTruthy()
    expect(h.reconciler.activity().offline).toBe(false)
  })

  it('still counts an ordinary upload failure against the track', async () => {
    const h = harness()
    h.deps.rclone = {
      ...h.deps.rclone,
      upload: async () => {
        throw new Error('rclone exited with 1: permission denied')
      },
    }
    h.catalog.likes = [song('denied')]
    await h.start()
    expect(h.rows()[0]).toMatchObject({ state: 'pending', attempts: 1 })
    expect(h.reconciler.activity().remoteUnreachable).toBe(false)
  })
})

describe('runnable work', () => {
  it.each([
    ['no library folder is set', ''],
    ['the library folder is unavailable', '/nonexistent/lms-library'],
  ])('is false for pending tracks when %s', async (_name, folder) => {
    const h = harness()
    h.settings.libraryFolder = folder
    h.catalog.likes = [song('waiting')]
    await h.reconciler.start()
    await until(
      () =>
        !h.reconciler.activity().checking &&
        h.reconciler.activity().lastCheckedAt !== null
    )
    const view = h.reconciler.activity()
    expect(view.upNextCount).toBe(1)
    expect(view.runnable).toBe(false)
  })

  it('is false when only uploads are queued and the VPS is unreachable', async () => {
    const h = harness({ probeBackoffMs: [60_000] })
    const spy = instrument(h)
    spy.uploadDown = true
    h.catalog.likes = [song('queued')]
    await h.reconciler.start()
    await until(() => {
      const view = h.reconciler.activity()
      return (
        view.remoteUnreachable &&
        !view.checking &&
        view.current === null &&
        view.uploading.length === 0
      )
    })
    const view = h.reconciler.activity()
    expect(view.upNextCount).toBe(1)
    expect(view.runnable).toBe(false)
  })

  it('stays true while an upload runs even though the internet is out', async () => {
    const h = harness({ probeBackoffMs: [60_000] })
    const spy = instrument(h)
    let release!: () => void
    spy.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const downloadReal = h.deps.downloader.download
    h.deps.downloader = {
      download: async (id, ...rest) => {
        if (id === 'offline-b')
          throw new Error(
            'yt-dlp failed: ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>'
          )
        return downloadReal(id, ...rest)
      },
    }
    h.catalog.likes = [song('ok-a', 'a', 0), song('offline-b', 'b', 1)]
    await h.reconciler.start()
    await until(() => {
      const view = h.reconciler.activity()
      return view.offline && view.uploading.length === 1
    })
    expect(h.reconciler.activity().runnable).toBe(true)
    release()
  })
})

describe('remote audit', () => {
  it('runs at startup and when the target changes, never as part of a check', async () => {
    const h = harness()
    const spy = instrument(h)
    await h.start()
    expect(spy.lists).toBe(1)
    await h.check()
    await h.check()
    expect(spy.lists).toBe(1)

    h.settings.remoteFolder = path.join(h.root, 'other-remote')
    mkdirSync(h.settings.remoteFolder)
    h.reconciler.remoteTargetChanged()
    await until(() => spy.lists === 2)
  })

  it('does not hold up a like check while the VPS is slow', async () => {
    const h = harness()
    const spy = instrument(h)
    spy.listHang = true
    await h.start()
    h.catalog.likes = [song('late')]
    await Promise.race([
      h.check(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('check waited for the audit')), 5_000)
      ),
    ])
    expect(h.reconciler.activity().checking).toBe(false)
    expect(h.row('video:late')?.state).toBe('done')
    expect(spy.lists).toBe(1)
  })

  it('shows an audit failure in Activity and retries it on request', async () => {
    const h = harness()
    const spy = instrument(h)
    spy.listError = new Error('rclone lsjson failed: permission denied')
    await h.start()
    expect(h.reconciler.activity().needsAttention).toMatchObject([
      {
        kind: 'source',
        title: 'Remote Library check',
        reason: expect.stringContaining('permission denied'),
      },
    ])
    expect(h.reconciler.activity().remoteUnreachable).toBe(false)

    spy.listError = null
    h.reconciler.retryAll()
    await until(() => h.reconciler.activity().needsAttention.length === 0)
  })
})

describe('activity updates', () => {
  it('still sends a full update after a snapshot read, not just progress', async () => {
    const h = harness()
    await h.start()
    // With a progress channel installed, a timer with nothing but progress to
    // report sends only the live part.
    const full: unknown[] = []
    const progress: unknown[] = []
    h.deps.onActivity = (view) => full.push(view)
    h.deps.onProgress = (live) => progress.push(live)
    await new Promise((resolve) => setTimeout(resolve, 150))
    full.length = 0
    progress.length = 0

    h.reconciler.markDirty()
    // A snapshot read (e.g. an IPC query) between the change and the timer.
    h.reconciler.activity()
    await until(() => full.length > 0 || progress.length > 0)
    expect(full).toHaveLength(1)
    expect(progress).toHaveLength(0)
  })
})

describe('stopping', () => {
  it('gives up on work that ignores the abort', async () => {
    const h = harness({ stopWaitMs: 200 })
    h.matcher.during = () => new Promise<void>(() => {})
    h.catalog.likes = [song('stuck')]
    await h.reconciler.start()
    await until(() => h.matcher.calls > 0)
    const started = Date.now()
    await h.reconciler.stop()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
