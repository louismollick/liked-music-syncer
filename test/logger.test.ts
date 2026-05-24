import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatLogLine,
  logMain,
  setTempLogMirror,
  writeStderrRaw,
} from '../src/main/services/logger'
import { createTempLogMirror } from '../src/main/services/temp-log-file'

const originalNoColor = process.env.NO_COLOR
const originalIsTTY = process.stdout.isTTY
let tempDir: string | null = null
let activeMirror: ReturnType<typeof createTempLogMirror> = null

function setIsTTY(value: boolean) {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  })
}

beforeEach(() => {
  setTempLogMirror(null)
  activeMirror = null
})

afterEach(() => {
  activeMirror?.dispose()
  activeMirror = null
  setTempLogMirror(null)
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR
  } else {
    process.env.NO_COLOR = originalNoColor
  }
  setIsTTY(Boolean(originalIsTTY))
  vi.restoreAllMocks()
})

describe('logger', () => {
  it('colors only warn/error level token and resets immediately', () => {
    setIsTTY(true)
    delete process.env.NO_COLOR

    const warnLine = formatLogLine({
      level: 'warn',
      source: 'sync',
      message: 'hello',
      timestamp: '2026-05-22T00:00:00.000Z',
    })
    const errorLine = formatLogLine({
      level: 'error',
      source: 'sync',
      message: 'boom',
      timestamp: '2026-05-22T00:00:00.000Z',
    })
    const infoLine = formatLogLine({
      level: 'info',
      source: 'sync',
      message: 'plain',
      timestamp: '2026-05-22T00:00:00.000Z',
    })

    expect(warnLine).toContain('\x1b[33m[warn]\x1b[0m [sync] hello')
    expect(errorLine).toContain('\x1b[31m[error]\x1b[0m [sync] boom')
    expect(infoLine).toContain('[info] [sync] plain')
    expect(infoLine).not.toContain('\x1b[')
  })

  it('disables color for non-tty or NO_COLOR', () => {
    setIsTTY(false)
    delete process.env.NO_COLOR
    const nonTty = formatLogLine({
      level: 'warn',
      source: 'sync',
      message: 'x',
      timestamp: '2026-05-22T00:00:00.000Z',
    })
    expect(nonTty).toContain('[warn]')
    expect(nonTty).not.toContain('\x1b[')

    setIsTTY(true)
    process.env.NO_COLOR = '1'
    const noColor = formatLogLine({
      level: 'error',
      source: 'sync',
      message: 'y',
      timestamp: '2026-05-22T00:00:00.000Z',
    })
    expect(noColor).toContain('[error]')
    expect(noColor).not.toContain('\x1b[')
  })

  it('routes error to stderr and others to stdout', () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true as never)
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never)

    logMain({ level: 'debug', source: 'sync', message: 'dbg' })
    logMain({ level: 'info', source: 'sync', message: 'info' })
    logMain({ level: 'warn', source: 'sync', message: 'warn' })
    logMain({ level: 'error', source: 'sync', message: 'err' })

    expect(stdoutWrite).toHaveBeenCalledTimes(3)
    expect(stderrWrite).toHaveBeenCalledTimes(1)
  })

  it('mirrors structured stdout and raw stderr into temp log file without ansi', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-log-'))
    activeMirror = createTempLogMirror(tempDir)
    setTempLogMirror(activeMirror)

    setIsTTY(true)
    delete process.env.NO_COLOR

    logMain({
      level: 'warn',
      source: 'sync',
      message: 'colored',
      timestamp: '2026-05-23T18:42:11.123Z',
    })
    writeStderrRaw('yt-dlp: \x1b[31mERROR\x1b[0m boom\n')
    activeMirror?.dispose()

    const content = fs.readFileSync(activeMirror!.getLogFilePath(), 'utf8')
    expect(content).toContain(
      '[stdout] [2026-05-23T18:42:11.123Z] [warn] [sync] colored\n'
    )
    expect(content).toContain('[stderr] yt-dlp: ERROR boom\n')
    expect(content).not.toContain('\x1b[')
  })
})
