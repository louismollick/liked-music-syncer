import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createYtDlpBinary } from '../../src/main/acquire/ytdlp-binary'
import { createHttpClient } from '../../src/main/net/http'
import { tempDir } from '../helpers/audio'

it('checks an unchanged executable once and rechecks when it changes', async () => {
  const userData = tempDir()
  const dir = path.join(userData, 'bin')
  mkdirSync(dir)
  const marker = path.join(userData, 'versions')
  const executable = path.join(dir, 'yt-dlp')
  writeFileSync(
    executable,
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'checked\\n');
console.log('2026.10.02');
`,
    { mode: 0o755 }
  )
  writeFileSync(path.join(dir, 'yt-dlp.checked'), String(Date.now()))
  const binary = createYtDlpBinary({
    userData,
    http: createHttpClient(async () => {
      throw new Error('No update is due')
    }),
  })
  for (let i = 0; i < 4; i++) expect(await binary.ensure()).toBe(executable)
  expect(readFileSync(marker, 'utf8')).toBe('checked\n')
  utimesSync(executable, new Date(0), new Date(0))
  expect(await binary.ensure()).toBe(executable)
  expect(readFileSync(marker, 'utf8')).toBe('checked\nchecked\n')
})
