import type { LogLevel } from '@shared/contracts'
import type { TempLogMirror } from './temp-log-file'
import { nowIso } from './utils'

const ANSI_RESET = '\x1b[0m'
const ANSI_RED = '\x1b[31m'
const ANSI_YELLOW = '\x1b[33m'

interface LogInput {
  level: LogLevel
  source: string
  message: string
  runId?: string
  itemId?: string
  context?: Record<string, unknown>
  timestamp?: string
}

let tempLogMirror: TempLogMirror | null = null

function shouldColorize() {
  return process.stdout.isTTY === true && !process.env.NO_COLOR
}

function formatLevel(level: LogLevel) {
  if (!shouldColorize() || (level !== 'warn' && level !== 'error')) {
    return `[${level}]`
  }
  const color = level === 'error' ? ANSI_RED : ANSI_YELLOW
  return `${color}[${level}]${ANSI_RESET}`
}

function formatContext(context?: Record<string, unknown>) {
  if (!context) return ''
  const entries = Object.entries(context).filter(([, value]) => value != null)
  if (entries.length === 0) return ''
  const parts = entries.map(([key, value]) => {
    const rendered =
      typeof value === 'string'
        ? value
        : (JSON.stringify(value) ?? String(value))
    return `${key}=${rendered}`
  })
  return ` | ${parts.join(' ')}`
}

export function formatLogLine(input: LogInput) {
  const timestamp = input.timestamp ?? nowIso()
  const runToken = input.runId ? `[${input.runId}]` : ''
  const itemToken = input.itemId ? `[${input.itemId}]` : ''
  const context = formatContext(input.context)
  return `[${timestamp}] ${formatLevel(input.level)} [${input.source}]${runToken}${itemToken} ${input.message}${context}`
}

export function setTempLogMirror(mirror: TempLogMirror | null) {
  tempLogMirror = mirror
}

export function writeStdoutRaw(chunk: string) {
  process.stdout.write(chunk)
  tempLogMirror?.writeStdout(chunk)
}

export function writeStderrRaw(chunk: string) {
  process.stderr.write(chunk)
  tempLogMirror?.writeStderr(chunk)
}

export function logMain(input: LogInput) {
  const line = formatLogLine(input)
  if (input.level === 'error') {
    writeStderrRaw(`${line}\n`)
    return
  }
  writeStdoutRaw(`${line}\n`)
}
