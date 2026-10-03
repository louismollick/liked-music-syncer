import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { toM4a, validateAudio } from '../../src/main/acquire/audio'
import { makeM4a, tempDir } from '../helpers/audio'

const ffmpeg = ffmpegPath as unknown as string

describe('audio acquisition', () => {
  it('accepts a fully decodable AAC file', async () => {
    const dir = tempDir()
    const input = makeM4a(path.join(dir, 'source.m4a'))
    await expect(toM4a(ffmpeg, input, 'aac', dir)).resolves.toBe(
      path.join(dir, 'audio.m4a')
    )
  })

  it('rejects corrupt AAC packets even when the container is readable', async () => {
    const dir = tempDir()
    const input = makeM4a(path.join(dir, 'source.m4a'))
    const bytes = readFileSync(input)
    const payload = bytes.indexOf(Buffer.from('mdat')) + 4
    expect(payload).toBeGreaterThan(4)
    bytes.fill(0, payload, payload + 96)
    writeFileSync(input, bytes)
    await expect(toM4a(ffmpeg, input, 'aac', dir)).rejects.toThrow()
  })

  it('validates a transcoded file before removing its source', async () => {
    const dir = tempDir()
    const input = makeM4a(path.join(dir, 'source.m4a'))
    const output = await toM4a(ffmpeg, input, 'opus', dir)
    await expect(validateAudio(ffmpeg, output)).resolves.toBeUndefined()
    expect(existsSync(input)).toBe(false)
  })

  it('preserves the original source when an encoded output fails validation', async () => {
    const dir = tempDir()
    const input = makeM4a(path.join(dir, 'source.m4a'))
    const bytes = readFileSync(input)
    const payload = bytes.indexOf(Buffer.from('mdat')) + 4
    bytes.fill(0, payload, payload + 96)
    const broken = path.join(dir, 'broken.m4a')
    writeFileSync(broken, bytes)
    const wrapper = path.join(dir, 'ffmpeg')
    writeFileSync(
      wrapper,
      `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('-c:a')) {
  fs.copyFileSync(${JSON.stringify(broken)}, args.at(-1));
} else {
  const result = spawnSync(${JSON.stringify(ffmpeg)}, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`,
      { mode: 0o755 }
    )
    await expect(toM4a(wrapper, input, 'opus', dir)).rejects.toThrow()
    expect(existsSync(input)).toBe(true)
  })
})
