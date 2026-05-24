import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempLogMirror } from '../src/main/services/temp-log-file'

let tempDir: string | null = null

afterEach(() => {
  vi.restoreAllMocks()
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe('temp log mirror', () => {
  it('prefixes stdout/stderr lines and combines partial chunks', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-log-'))
    const mirror = createTempLogMirror(tempDir)

    expect(mirror).not.toBeNull()

    mirror!.writeStdout('first')
    mirror!.writeStdout(' line\nsecond line\n')
    mirror!.writeStderr('problem')
    mirror!.writeStderr(' happened\n')

    const content = fs.readFileSync(mirror!.getLogFilePath(), 'utf8')
    expect(content).toBe(
      '[stdout] first line\n[stdout] second line\n[stderr] problem happened\n'
    )
  })

  it('flushes trailing partial lines on dispose', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-log-'))
    const mirror = createTempLogMirror(tempDir)

    mirror!.writeStdout('tail stdout')
    mirror!.writeStderr('tail stderr')
    mirror!.dispose()

    const content = fs.readFileSync(mirror!.getLogFilePath(), 'utf8')
    expect(content).toBe('[stdout] tail stdout\n[stderr] tail stderr\n')
  })

  it('returns null and warns when sink creation fails', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-log-'))
    const blockedPath = path.join(tempDir, 'blocked')
    fs.writeFileSync(blockedPath, 'x')
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never)

    const mirror = createTempLogMirror(blockedPath)

    expect(mirror).toBeNull()
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('Temp log mirror unavailable')
    )
  })
})
