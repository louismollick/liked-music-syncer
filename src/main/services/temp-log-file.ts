import * as fs from 'node:fs'
import path from 'node:path'

// biome-ignore lint/complexity/useRegexLiterals: literal form trips control-char regex lint.
const ANSI_PATTERN = new RegExp(
  // Covers common CSI and OSC terminal escape sequences.
  '\\u001B(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|\\u001B\\\\))',
  'g'
)

export interface TempLogMirror {
  writeStdout(chunk: string): void
  writeStderr(chunk: string): void
  dispose(): void
  getLogFilePath(): string
}

type StreamName = 'stdout' | 'stderr'

class FileTempLogMirror implements TempLogMirror {
  private enabled = true
  private readonly buffers: Record<StreamName, string> = {
    stdout: '',
    stderr: '',
  }

  constructor(private readonly logFilePath: string) {}

  writeStdout(chunk: string): void {
    this.write('stdout', chunk)
  }

  writeStderr(chunk: string): void {
    this.write('stderr', chunk)
  }

  dispose(): void {
    this.flushBufferedLine('stdout')
    this.flushBufferedLine('stderr')
  }

  getLogFilePath(): string {
    return this.logFilePath
  }

  private write(stream: StreamName, chunk: string): void {
    if (!this.enabled || chunk.length === 0) {
      return
    }

    const text = `${this.buffers[stream]}${stripAnsi(chunk)}`
    const lines = text.split('\n')
    this.buffers[stream] = lines.pop() ?? ''

    for (const line of lines) {
      this.appendLine(stream, line)
      if (!this.enabled) {
        return
      }
    }
  }

  private flushBufferedLine(stream: StreamName): void {
    if (!this.enabled) {
      return
    }
    if (this.buffers[stream].length === 0) {
      return
    }

    this.appendLine(stream, this.buffers[stream])
    this.buffers[stream] = ''
  }

  private appendLine(stream: StreamName, line: string): void {
    this.append(`[${stream}] ${line.replace(/\r$/, '')}\n`)
  }

  private append(text: string): void {
    if (!this.enabled) {
      return
    }

    try {
      fs.appendFileSync(this.logFilePath, text, 'utf8')
    } catch (error) {
      this.enabled = false
      try {
        process.stderr.write(
          `Temp log mirror disabled: ${error instanceof Error ? error.message : String(error)}\n`
        )
      } catch {
        // Ignore terminal write failure.
      }
    }
  }
}

export function createTempLogMirror(tempRoot: string): TempLogMirror | null {
  const logsDir = path.join(tempRoot, 'liked-music-syncer', 'logs')
  const logFilePath = path.join(
    logsDir,
    `launch-${toSafeIsoTimestamp(new Date().toISOString())}-pid-${process.pid}.log`
  )

  try {
    fs.mkdirSync(logsDir, { recursive: true })
    fs.appendFileSync(logFilePath, '', 'utf8')
    return new FileTempLogMirror(logFilePath)
  } catch (error) {
    try {
      process.stderr.write(
        `Temp log mirror unavailable at ${logFilePath}: ${error instanceof Error ? error.message : String(error)}\n`
      )
    } catch {
      // Ignore terminal write failure.
    }
    return null
  }
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

function toSafeIsoTimestamp(value: string): string {
  return value.replace(/:/g, '-')
}
