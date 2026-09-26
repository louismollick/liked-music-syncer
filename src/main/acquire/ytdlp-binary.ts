import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { HttpClient } from '../net/http'

const execFileAsync = promisify(execFile)
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

function assetName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'yt-dlp_macos'
  if (platform === 'win32') return 'yt-dlp.exe'
  return 'yt-dlp_linux'
}

export interface YtDlpBinary {
  /** Path to a working yt-dlp binary, downloading or updating it when needed. */
  ensure(signal?: AbortSignal): Promise<string>
}

/**
 * Manages the official standalone yt-dlp binary in userData/bin. It is never
 * bundled, because YouTube breaks yt-dlp often and a signed app bundle cannot
 * update itself. Updates keep the previous binary and roll back when the new
 * one fails `--version`.
 */
export function createYtDlpBinary(options: {
  userData: string
  http: HttpClient
  platform?: NodeJS.Platform
  now?: () => number
}): YtDlpBinary {
  const platform = options.platform ?? process.platform
  const binDir = path.join(options.userData, 'bin')
  const binary = path.join(
    binDir,
    platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  )
  const stampFile = path.join(binDir, 'yt-dlp.checked')
  const now = options.now ?? Date.now
  let inflight: Promise<string> | null = null

  async function version(file: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(file, ['--version'], {
        timeout: 60_000,
      })
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  async function download(signal?: AbortSignal): Promise<void> {
    const asset = assetName(platform)
    const [bytes, sums] = await Promise.all([
      options.http.bytes(`${RELEASE_BASE}/${asset}`, {
        host: 'images',
        signal,
      }),
      options.http.text(`${RELEASE_BASE}/SHA2-256SUMS`, {
        host: 'images',
        signal,
      }),
    ])
    const expected = sums
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === asset)?.[0]
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (!expected || expected !== actual) {
      throw new Error(`yt-dlp checksum mismatch for ${asset}`)
    }
    await mkdir(binDir, { recursive: true })
    const incoming = `${binary}.new`
    await writeFile(incoming, bytes)
    await chmod(incoming, 0o755)
    if (!(await version(incoming))) {
      await rm(incoming, { force: true })
      throw new Error('Downloaded yt-dlp binary does not run')
    }
    const previous = `${binary}.previous`
    const hadBinary = await stat(binary).then(
      () => true,
      () => false
    )
    if (hadBinary) await rename(binary, previous)
    await rename(incoming, binary)
    if (!(await version(binary))) {
      if (hadBinary) await rename(previous, binary)
      throw new Error('Updated yt-dlp failed its version check; rolled back')
    }
    if (hadBinary) await rm(previous, { force: true })
  }

  async function lastChecked(): Promise<number> {
    try {
      return Number(await readFile(stampFile, 'utf8')) || 0
    } catch {
      return 0
    }
  }

  async function ensureInner(signal?: AbortSignal): Promise<string> {
    const current = await version(binary)
    if (!current) {
      await download(signal)
      await writeFile(stampFile, String(now()))
      return binary
    }
    if (now() - (await lastChecked()) > UPDATE_INTERVAL_MS) {
      try {
        await download(signal)
      } catch (error) {
        console.warn('[yt-dlp] update failed, keeping current binary', error)
      }
      await writeFile(stampFile, String(now()))
    }
    return binary
  }

  return {
    ensure(signal) {
      inflight ??= ensureInner(signal).finally(() => {
        inflight = null
      })
      return inflight
    },
  }
}
