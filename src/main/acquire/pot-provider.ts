import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolPaths } from '../platform/tools'

export const POT_BASE_URL = 'http://127.0.0.1:4416'

export interface PotProvider {
  pluginDir: string
  ensureReady(): Promise<void>
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
    if (await ping()) return
    if (!existsSync(entry) || !existsSync(pluginDir)) {
      throw Object.assign(
        new Error(
          'PO token provider is missing. Run `pnpm tools:fetch` before downloading.'
        ),
        { kind: 'permanent' as const }
      )
    }
    child = spawn(
      tools.nodeRuntime,
      ['-e', `import(${JSON.stringify(pathToFileURL(entry).href)})`],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
      }
    )
    child.on('exit', () => {
      child = null
    })
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await ping()) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('PO token provider did not start')
  }

  return {
    pluginDir,
    ensureReady() {
      starting ??= start().finally(() => {
        starting = null
      })
      return starting
    },
    dispose() {
      if (child && !child.killed) child.kill('SIGTERM')
      child = null
    },
  }
}
