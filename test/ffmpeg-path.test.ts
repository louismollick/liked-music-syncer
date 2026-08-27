import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveFfmpegPath } from '../src/main/services/ffmpeg-path'

describe('ffmpeg path', () => {
  it('resolves an installed executable when resources/bin is empty', () => {
    const resolved = resolveFfmpegPath({
      isDev: true,
      cwd: process.cwd(),
      resourcesPath: path.join(process.cwd(), 'resources'),
    })

    expect(resolved).not.toBe('ffmpeg')
    expect(existsSync(resolved)).toBe(true)

    const versionCheck = spawnSync(resolved, ['-version'], {
      encoding: 'utf8',
    })
    expect(versionCheck.error).toBeUndefined()
    expect(versionCheck.status).toBe(0)
    expect(versionCheck.stdout).toContain('ffmpeg version')
  })
})
