import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolPaths } from '../platform/tools'

export const POT_BASE_URL = 'http://127.0.0.1:4416'

export interface PotProvider {
  pluginDir: string
  ensureReady(signal?: AbortSignal): Promise<void>
  dispose(): void
}

/**
 * Runs the bundled bgutil PO token provider under Electron's Node mode.
 * It must be started with `-e import(...)`: passing the script path as an
 * argument trips the provider's CLI parser.
 */
export function createPotProvider(tools: ToolPaths): PotProvider {
  const pluginDir = path.join(tools.resourcesBin, 'yt-dlp-plugins')
  const entry = path.join(
    tools.resourcesBin,
    'bgutil-ytdlp-pot-provider',
    'server',
    'build',
    'main.js'
  )
  let child: ChildProcess | null = null
  let starting: Promise<void> | null = null
  let disposed = false

  async function ping(): Promise<boolean> {
    try {
      const response = await fetch(`${POT_BASE_URL}/ping`, {
        signal: AbortSignal.timeout(2_000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async function start(): Promise<void> {
    if (disposed) throw new Error('PO token provider is disposed')
    if (await ping()) return
    // Recheck once before restarting a hung child, and wait for its port to
    // close before spawning a replacement. Keep ownership until it exits.
    if (
      child &&
      !child.killed &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      const hung = child
      if (await ping()) return
      if (hung.exitCode === null && hung.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => hung.kill('SIGKILL'), 2_000)
          hung.once('close', () => {
            clearTimeout(timeout)
            resolve()
          })
          hung.kill('SIGTERM')
        })
      }
    }
    if (disposed) throw new Error('PO token provider is disposed')
    if (!existsSync(entry) || !existsSync(pluginDir)) {
      throw Object.assign(
        new Error(
          'PO token provider is missing. Run `pnpm tools:fetch` before downloading.'
        ),
        { kind: 'permanent' as const }
      )
    }
    const launched = spawn(
      tools.nodeRuntime,
      ['-e', `import(${JSON.stringify(pathToFileURL(entry).href)})`],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    )
    child = launched
    let failure: Error | null = null
    let stderr = ''
    launched.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096)
    })
    launched.on('error', (error) => {
      failure = error
    })
    launched.on('close', (code, signal) => {
      if (child === launched) child = null
      failure ??= new Error(
        `PO token provider exited (${signal ?? code}): ${stderr.trim()}`
      )
    })
    try {
      // A cold Electron/Node start can exceed ten seconds on a busy Mac.
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (disposed) throw new Error('PO token provider is disposed')
        if (await ping()) return
        if (failure) throw failure
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw new Error(`PO token provider startup timed out: ${stderr.trim()}`)
    } catch (error) {
      // A failed start must not leave a server behind for the next retry.
      if (!launched.killed) launched.kill('SIGTERM')
      if (child === launched) child = null
      throw error
    }
  }

  return {
    pluginDir,
    ensureReady(signal) {
      signal?.throwIfAborted()
      starting ??= start().finally(() => {
        starting = null
      })
      if (!signal) return starting
      // Each caller can stop waiting without cancelling the shared startup.
      const ready = starting
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        ready.then(resolve, reject).finally(() => {
          signal.removeEventListener('abort', onAbort)
        })
      })
    },
    dispose() {
      disposed = true
      if (child && !child.killed) child.kill('SIGTERM')
      child = null
    },
  }
}
