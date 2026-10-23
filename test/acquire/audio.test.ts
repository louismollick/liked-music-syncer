import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import {
  aacEncoderArgs,
  toM4a,
  validateAudio,
} from '../../src/main/acquire/audio'
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
    expect(existsSync(input)).toBe(true)
    expect(existsSync(path.join(dir, 'audio.m4a'))).toBe(false)
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

describe('AAC encoder choice', () => {
  /** An ffmpeg stand-in that lists encoders and counts how often it is asked. */
  function fakeFfmpeg(encoders: string) {
    const dir = tempDir()
    const calls = path.join(dir, 'calls')
    const bin = path.join(dir, 'ffmpeg')
    writeFileSync(
      bin,
      `#!/bin/sh\necho x >> ${JSON.stringify(calls)}\necho ${JSON.stringify(encoders)}\n`,
      { mode: 0o755 }
    )
    return {
      bin,
      count: () => readFileSync(calls, 'utf8').split('\n').length - 1,
    }
  }

  it("uses Apple's constrained VBR encoder when the build has it, probing once", async () => {
    const { bin, count } = fakeFfmpeg(' A..... aac_at  aac (AudioToolbox)')
    const expected = ['-c:a', 'aac_at', '-aac_at_mode', 'cvbr', '-b:a', '192k']
    expect(await aacEncoderArgs(bin)).toEqual(expected)
    expect(await aacEncoderArgs(bin)).toEqual(expected)
    expect(count()).toBe(1)
  })

  it('falls back to native AAC at 256k without it', async () => {
    const { bin } = fakeFfmpeg(' A....D aac  AAC (Advanced Audio Coding)')
    expect(await aacEncoderArgs(bin)).toEqual(['-c:a', 'aac', '-b:a', '256k'])
  })

  it('falls back when the probe itself fails', async () => {
    expect(await aacEncoderArgs('/nonexistent/ffmpeg')).toEqual([
      '-c:a',
      'aac',
      '-b:a',
      '256k',
    ])
  })

  it('re-encodes with the chosen encoder and validates the result', async () => {
    const dir = tempDir()
    const input = makeM4a(path.join(dir, 'source.m4a'))
    const log = path.join(dir, 'args')
    const wrapper = path.join(dir, 'ffmpeg')
    writeFileSync(
      wrapper,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('-encoders')) { console.log(' A..... aac_at'); process.exit(0); }
// The stand-in lacks aac_at, so ask the real ffmpeg for native aac instead.
require('node:fs').appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
const real = args.map((a) => (a === 'aac_at' ? 'aac' : a)).filter((a, i, all) => !['-aac_at_mode', 'cvbr'].includes(a));
process.exit(spawnSync(${JSON.stringify(ffmpeg)}, real, { stdio: 'inherit' }).status ?? 1);
`,
      { mode: 0o755 }
    )
    const output = await toM4a(wrapper, input, 'opus', dir)
    // One encode and one validation pass.
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines[0]).toContain('-c:a aac_at -aac_at_mode cvbr -b:a 192k')
    expect(lines[1]).toContain('-f null')
    expect(existsSync(output)).toBe(true)
  })

  // resources/bin is gitignored, so this only runs where the app's ffmpeg is installed.
  const bundled = path.resolve('resources/bin/ffmpeg')
  it.skipIf(!existsSync(bundled))(
    'encodes with the bundled AudioToolbox build',
    async () => {
      const dir = tempDir()
      const input = path.join(dir, 'source.opus')
      execFileSync(bundled, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:a',
        'libopus',
        input,
      ])
      expect(await aacEncoderArgs(bundled)).toContain('aac_at')
      const output = await toM4a(bundled, input, 'opus', dir)
      await expect(validateAudio(bundled, output)).resolves.toBeUndefined()
    }
  )
})
