import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPotProvider } from './acquire/pot-provider'
import { openDatabase } from './library/db'
import { runChecked } from './platform/process'
import type { ToolPaths } from './platform/tools'
import { emptyLmsFields, readTags, writeTags } from './tags/schema'

/**
 * `--smoke-test`: proves a packaged build can open its database, run its
 * bundled tools, and read/write tags. Exits non-zero on any failure.
 */
export async function runSmokeTest(
  tools: ToolPaths,
  checkRenderer: () => Promise<void>
): Promise<number> {
  const dir = mkdtempSync(path.join(tmpdir(), 'lms-smoke-'))
  try {
    const db = openDatabase(path.join(dir, 'smoke.db'))
    db.$client.prepare('SELECT COUNT(*) FROM tracks').get()
    db.$client.close()
    console.log('[smoke] database ok')

    await runChecked(tools.ffmpeg, ['-version'])
    const audio = path.join(dir, 'tone.m4a')
    await runChecked(tools.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.3',
      '-c:a',
      'aac',
      '-y',
      audio,
    ])
    console.log('[smoke] ffmpeg ok')

    writeTags(
      audio,
      {
        title: 'Smoke',
        artist: 'Test',
        album: 'Smoke',
        albumArtist: 'Test',
        trackNumber: 1,
        trackTotal: 1,
        discNumber: null,
        discTotal: null,
        date: '2026-09',
        genre: null,
        language: null,
        isrc: null,
        mbRecordingId: null,
        lyrics: null,
        coverSha256: null,
        lms: { ...emptyLmsFields(), sourceVideoId: 'smoke' },
      },
      null
    )
    const read = readTags(audio)
    if (
      read.fields.date !== '2026-09' ||
      read.fields.lms.sourceVideoId !== 'smoke'
    ) {
      throw new Error('tag round-trip mismatch')
    }
    console.log('[smoke] tags ok')

    await runChecked(tools.rclone, ['version'])
    console.log('[smoke] rclone ok')

    const pot = createPotProvider(tools)
    try {
      await pot.ensureReady()
    } finally {
      pot.dispose()
    }
    console.log('[smoke] PO token provider ok')

    await checkRenderer()
    console.log('[smoke] renderer and preload ok')
    return 0
  } catch (error) {
    console.error('[smoke] failed', error)
    return 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
