import { type ChildProcess, spawn } from 'node:child_process'

/** Every live child process, so shutdown can stop them all. */
const live = new Set<ChildProcess>()

/** A child with no output for this long is treated as hung. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
/** How long a child gets to exit after SIGTERM before SIGKILL. */
const DEFAULT_KILL_GRACE_MS = 5_000
/** After the child exits, how long to wait for its pipes to close. */
const PIPE_CLOSE_WAIT_MS = 1_000

/** Children lead their own process group (POSIX), so signals reach descendants too. */
const GROUPS = process.platform !== 'win32'

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (GROUPS && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

/**
 * SIGTERM now, SIGKILL after the grace period. Reaches the whole process group,
 * including descendants that outlive an exited parent.
 */
function terminate(child: ChildProcess, graceMs = DEFAULT_KILL_GRACE_MS): void {
  signalTree(child, 'SIGTERM')
  const timer = setTimeout(() => signalTree(child, 'SIGKILL'), graceMs)
  timer.unref()
  // 'close' means the parent exited and every pipe is shut: nothing left to kill.
  child.once('close', () => clearTimeout(timer))
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
  input?: string | Buffer
  /** Called for each line of stdout and stderr as it arrives. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Collect stdout as a Buffer instead of text (for binary output). */
  binaryStdout?: boolean
  /**
   * Kill the process after this long without any stdout or stderr output
   * (default 5 minutes, 0 disables). Raise it for tools that stay silent while
   * working; tools that report progress can keep the default.
   */
  idleTimeoutMs?: number
  /** How long a process gets to exit after SIGTERM before SIGKILL (default 5s). */
  killGraceMs?: number
}

export interface RunResult {
  code: number | null
  stdout: string
  stdoutBytes: Buffer
  stderr: string
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
    readonly kind: 'transient' | 'permanent' = 'transient'
  ) {
    super(message)
    this.name = 'ProcessError'
  }
}

/** The process printed nothing for too long and was killed; a retry may work. */
export class ProcessTimeoutError extends ProcessError {
  constructor(command: string, idleMs: number, result: RunResult) {
    super(
      `${command.split('/').pop()} produced no output for ${Math.round(idleMs / 1000)}s and was killed`,
      result,
      'transient'
    )
    this.name = 'ProcessTimeoutError'
  }
}

export function run(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error('aborted'))
      return
    }
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: GROUPS,
    })
    live.add(child)
    const out: Buffer[] = []
    const err: Buffer[] = []
    const buffers = { stdout: '', stderr: '' }
    const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    let idleTimer: NodeJS.Timeout | undefined
    let timedOut = false
    let pipeTimer: NodeJS.Timeout | undefined
    // Stops the process tree. If the parent already exited, descendants may
    // still hold the pipes open, so drop them and settle instead of waiting.
    const stop = () => {
      terminate(child, options.killGraceMs)
      if (hasExited(child)) {
        child.stdout.destroy()
        child.stderr.destroy()
        settleKilled(child.exitCode)
      }
    }
    const armIdle = () => {
      if (idleMs <= 0) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        stop()
      }, idleMs)
    }
    armIdle()
    const feed = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      armIdle()
      if (!options.onLine) return
      buffers[stream] += chunk.toString('utf8')
      const lines = buffers[stream].split(/\r?\n|\r/)
      buffers[stream] = lines.pop() ?? ''
      for (const line of lines) if (line) options.onLine(line, stream)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk)
      feed('stdout', chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk)
      feed('stderr', chunk)
    })
    const onAbort = stop
    options.signal?.addEventListener('abort', onAbort, { once: true })
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(pipeTimer)
      live.delete(child)
      options.signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const result = (code: number | null): RunResult => {
      const stdoutBytes = Buffer.concat(out)
      return {
        code,
        stdout: options.binaryStdout ? '' : stdoutBytes.toString('utf8'),
        stdoutBytes,
        stderr: Buffer.concat(err).toString('utf8'),
      }
    }
    const settleKilled = (code: number | null) =>
      finish(() => {
        if (options.signal?.aborted)
          reject(options.signal.reason ?? new Error('aborted'))
        else if (timedOut)
          reject(new ProcessTimeoutError(command, idleMs, result(code)))
        else resolve(result(code))
      })
    child.on('error', (error) => finish(() => reject(error)))
    // A killed child's grandchildren can keep its pipes open; don't wait on
    // them forever.
    child.on('exit', (code) => {
      if (timedOut || options.signal?.aborted)
        pipeTimer = setTimeout(() => settleKilled(code), PIPE_CLOSE_WAIT_MS)
    })
    child.on('close', (code) => settleKilled(code))
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

export async function runChecked(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const result = await run(command, args, options)
  if (result.code !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-3).join(' | ')
    throw new ProcessError(
      `${command.split('/').pop()} exited with ${result.code}: ${tail}`,
      result
    )
  }
  return result
}

export function killAllChildren(): void {
  for (const child of live) terminate(child)
  live.clear()
}
