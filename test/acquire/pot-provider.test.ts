import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPotProvider } from '../../src/main/acquire/pot-provider'
import { tempDir } from '../helpers/audio'

function provider(script: string) {
  const dir = tempDir()
  const build = path.join(dir, 'bgutil-ytdlp-pot-provider/server/build')
  mkdirSync(build, { recursive: true })
  mkdirSync(path.join(dir, 'yt-dlp-plugins'))
  writeFileSync(path.join(build, 'main.js'), script)
  return createPotProvider({
    userData: dir,
    resourcesBin: dir,
    nodeRuntime: process.execPath,
    ffmpeg: 'unused',
    rclone: 'unused',
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('PO token provider startup', () => {
  it('lets a cancelled caller stop waiting while another caller finishes startup', async () => {
    const marker = path.join(tempDir(), 'starts')
    vi.stubGlobal('fetch', async () => {
      if (!existsSync(marker)) throw new Error('not ready')
      return new Response(null, { status: 200 })
    })
    const pot = provider(
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'), 300); setInterval(() => {}, 1000)`
    )
    const controller = new AbortController()
    try {
      const cancelled = pot.ensureReady(controller.signal)
      const shared = pot.ensureReady()
      controller.abort(new Error('cancelled download'))
      await expect(cancelled).rejects.toThrow('cancelled download')
      expect(existsSync(marker)).toBe(false)
      await expect(shared).resolves.toBeUndefined()
    } finally {
      pot.dispose()
    }
  })

  it('keeps its live child after a missed health check', async () => {
    const marker = path.join(tempDir(), 'starts')
    let healthy = true
    vi.stubGlobal('fetch', async () => {
      if (!healthy || !existsSync(marker)) throw new Error('not ready')
      return new Response(null, { status: 200 })
    })
    const pot = provider(
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n'); setInterval(() => {}, 1000)`
    )
    try {
      await pot.ensureReady()
      healthy = false
      await expect(pot.ensureReady()).rejects.toThrow(
        'running but not responding'
      )
      healthy = true
      await pot.ensureReady()
      expect(readFileSync(marker, 'utf8')).toBe('started\n')
    } finally {
      pot.dispose()
    }
  })
  it('reports an early process failure instead of waiting for the startup deadline', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('not ready')
    })
    const pot = provider("throw new Error('fixture startup failure')")
    try {
      await expect(pot.ensureReady()).rejects.toThrow('fixture startup failure')
    } finally {
      pot.dispose()
    }
  })

  it('shares one cold start among concurrent downloads', async () => {
    const marker = path.join(tempDir(), 'starts')
    vi.stubGlobal('fetch', async () => {
      if (!existsSync(marker)) throw new Error('not ready')
      return new Response(null, { status: 200 })
    })
    const pot = provider(
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n'); setInterval(() => {}, 1000)`
    )
    try {
      await Promise.all([
        pot.ensureReady(),
        pot.ensureReady(),
        pot.ensureReady(),
      ])
      expect(readFileSync(marker, 'utf8')).toBe('started\n')
    } finally {
      pot.dispose()
    }
  })
})
