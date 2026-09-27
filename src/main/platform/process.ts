import { type ChildProcess, spawn } from 'node:child_process'

/** Every live child process, so shutdown can stop them all. */
const live = new Set<ChildProcess>()

export interface RunOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
  input?: string | Buffer
  /** Called for each line of stdout and stderr as it arrives. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Collect stdout as a Buffer instead of text (for binary output). */
  binaryStdout?: boolean
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
    })
    live.add(child)
    const out: Buffer[] = []
    const err: Buffer[] = []
    const buffers = { stdout: '', stderr: '' }
    const feed = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
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
    const onAbort = () => child.kill('SIGTERM')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      live.delete(child)
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      live.delete(child)
      options.signal?.removeEventListener('abort', onAbort)
      const stdoutBytes = Buffer.concat(out)
      const result = {
        code,
        stdout: options.binaryStdout ? '' : stdoutBytes.toString('utf8'),
        stdoutBytes,
        stderr: Buffer.concat(err).toString('utf8'),
      }
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new Error('aborted'))
        return
      }
      resolve(result)
    })
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
  for (const child of live) {
    if (!child.killed) child.kill('SIGTERM')
  }
  live.clear()
}
