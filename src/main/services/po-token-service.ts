import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'

export interface PoTokenBundleStatus {
  pluginDirectory: string
  pluginZipPath: string
  providerEntryPath: string
  baseUrl: string
  hasPluginZip: boolean
  hasProviderEntry: boolean
}

export class PoTokenService {
  private readonly baseUrl = 'http://127.0.0.1:4416'
  private providerProcess: ReturnType<typeof spawn> | null = null
  private ensureReadyPromise: Promise<void> | null = null
  private lastProviderError = ''

  getBundleStatus(): PoTokenBundleStatus {
    const root = app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(process.cwd(), 'resources', 'bin')
    const pluginDirectory = path.join(root, 'yt-dlp-plugins')
    const pluginZipPath = path.join(
      pluginDirectory,
      'bgutil-ytdlp-pot-provider.zip'
    )
    const providerEntryPath = path.join(
      root,
      'bgutil-ytdlp-pot-provider',
      'server',
      'build',
      'main.js'
    )

    return {
      pluginDirectory,
      pluginZipPath,
      providerEntryPath,
      baseUrl: this.baseUrl,
      hasPluginZip: existsSync(pluginZipPath),
      hasProviderEntry: existsSync(providerEntryPath),
    }
  }

  async ensureReady(): Promise<void> {
    if (this.ensureReadyPromise) {
      return this.ensureReadyPromise
    }

    this.ensureReadyPromise = this.ensureReadyInternal().finally(() => {
      this.ensureReadyPromise = null
    })
    return this.ensureReadyPromise
  }

  dispose() {
    if (this.providerProcess && !this.providerProcess.killed) {
      this.providerProcess.kill('SIGTERM')
    }
    this.providerProcess = null
  }

  private async ensureReadyInternal(): Promise<void> {
    const bundle = this.getBundleStatus()
    if (!bundle.hasPluginZip || !bundle.hasProviderEntry) {
      throw new Error(
        'PO token assets missing. Run `pnpm tools:fetch` to fetch the bgutil plugin/provider bundle.'
      )
    }

    if (await this.ping()) {
      return
    }

    this.startProvider(bundle.providerEntryPath)
    await this.waitForServer()
  }

  private startProvider(entryPath: string) {
    if (this.providerProcess && !this.providerProcess.killed) {
      return
    }

    this.lastProviderError = ''
    const entryUrl = pathToFileURL(entryPath).href
    const child = spawn(
      process.execPath,
      ['-e', `import(${JSON.stringify(entryUrl)})`],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.lastProviderError = `${this.lastProviderError}${chunk}`.slice(-4000)
    })
    child.on('exit', () => {
      if (this.providerProcess === child) {
        this.providerProcess = null
      }
    })
    child.on('error', (error) => {
      this.lastProviderError = error.message
      if (this.providerProcess === child) {
        this.providerProcess = null
      }
    })

    this.providerProcess = child
  }

  private async waitForServer() {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await this.ping()) {
        return
      }

      if (this.providerProcess && this.providerProcess.exitCode != null) {
        const stderr = this.lastProviderError.trim()
        throw new Error(
          stderr
            ? `PO token provider exited early: ${stderr}`
            : 'PO token provider exited before becoming ready.'
        )
      }

      await delay(250)
    }

    throw new Error(
      this.lastProviderError.trim()
        ? `PO token provider did not become ready: ${this.lastProviderError.trim()}`
        : 'PO token provider did not become ready in time.'
    )
  }

  private async ping() {
    try {
      const response = await fetch(`${this.baseUrl}/ping`)
      return response.ok
    } catch {
      return false
    }
  }
}
