import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProcessError, run, runChecked } from '../platform/process'

/**
 * Remote Library over rclone. Only the app writes to the remote (ADR 0005), so
 * every upload is verified and recorded; nothing runs on the server.
 */

/**
 * rclone's messages for a missing directory or object. Matched exactly, because
 * stderr can also say `Config file "…" not found - using defaults`.
 */
const MISSING_OBJECT = /directory not found|object not found|doesn't exist/i

export type HashAlgo = 'md5' | 'sha1'

export interface RemoteTarget {
  /** rclone remote name, e.g. "vps" (a trailing ":" is optional). */
  remote: string
  /** Folder on the remote, e.g. "/home/me/music". */
  folder: string
}

export interface RemoteCapabilities {
  hashAlgo: HashAlgo | null
  /** Modification time precision in nanoseconds (rclone Precision). */
  precisionNs: number | null
}

export interface RemoteObject {
  path: string
  size: number
  modTime: string
  hash: string | null
}

export interface VerifiedUpload {
  size: number
  modTime: string
  hashAlgo: HashAlgo | null
  hash: string | null
}

export function remoteSpec(target: RemoteTarget, relativePath = ''): string {
  const name = target.remote.replace(/:$/, '')
  const folder = target.folder.replace(/\/+$/, '')
  const rel = relativePath.replace(/^\/+/, '')
  const joined = rel ? `${folder}/${rel}` : folder
  return `${name}:${joined}`
}

export function hashFile(
  file: string,
  algo: HashAlgo | 'sha256'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo)
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

export interface Rclone {
  capabilities(target: RemoteTarget): Promise<RemoteCapabilities>
  list(
    target: RemoteTarget,
    options: { hashAlgo?: HashAlgo | null },
    signal?: AbortSignal
  ): Promise<Map<string, RemoteObject>>
  stat(
    target: RemoteTarget,
    relativePath: string,
    hashAlgo: HashAlgo | null,
    signal?: AbortSignal
  ): Promise<RemoteObject | null>
  /** Uploads and verifies one object. Throws if verification fails. */
  upload(
    target: RemoteTarget,
    localPath: string,
    relativePath: string,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal
  ): Promise<VerifiedUpload>
  /** Verifies an existing remote object against a local file (crash recovery). */
  verify(
    target: RemoteTarget,
    localPath: string,
    relativePath: string,
    signal?: AbortSignal
  ): Promise<VerifiedUpload | null>
  move(
    target: RemoteTarget,
    fromRelative: string,
    toRelative: string,
    signal?: AbortSignal
  ): Promise<void>
  /** Deletes an object; succeeds when it is already gone. */
  delete(
    target: RemoteTarget,
    relativePath: string,
    signal?: AbortSignal
  ): Promise<void>
}

export function createRclone(binary: string): Rclone {
  const capabilityCache = new Map<string, RemoteCapabilities>()

  async function capabilities(
    target: RemoteTarget
  ): Promise<RemoteCapabilities> {
    const key = target.remote
    const cached = capabilityCache.get(key)
    if (cached) return cached
    const result = await runChecked(binary, [
      'backend',
      'features',
      `${target.remote.replace(/:$/, '')}:`,
    ])
    const parsed = JSON.parse(result.stdout) as {
      Hashes?: string[]
      Precision?: number
    }
    const hashes = (parsed.Hashes ?? []).map((value) => value.toLowerCase())
    const caps: RemoteCapabilities = {
      hashAlgo: hashes.includes('md5')
        ? 'md5'
        : hashes.includes('sha1')
          ? 'sha1'
          : null,
      precisionNs:
        typeof parsed.Precision === 'number' ? parsed.Precision : null,
    }
    capabilityCache.set(key, caps)
    return caps
  }

  function parseObjects(stdout: string, hashAlgo: HashAlgo | null | undefined) {
    const items = JSON.parse(stdout || '[]') as Array<{
      Path: string
      Size: number
      ModTime: string
      IsDir: boolean
      Hashes?: Record<string, string>
    }>
    return items
      .filter((item) => !item.IsDir)
      .map((item) => ({
        path: item.Path.normalize('NFC'),
        size: item.Size,
        modTime: item.ModTime,
        hash: hashAlgo ? (item.Hashes?.[hashAlgo] ?? null) : null,
      }))
  }

  async function stat(
    target: RemoteTarget,
    relativePath: string,
    hashAlgo: HashAlgo | null,
    signal?: AbortSignal
  ): Promise<RemoteObject | null> {
    const args = ['lsjson', remoteSpec(target, relativePath)]
    if (hashAlgo) args.push('--hash', '--hash-type', hashAlgo)
    const result = await run(binary, args, { signal })
    if (
      result.code === 3 ||
      (result.code !== 0 && MISSING_OBJECT.test(result.stderr))
    ) {
      return null
    }
    if (result.code !== 0) {
      throw new ProcessError(
        `rclone lsjson failed: ${result.stderr.trim()}`,
        result
      )
    }
    const [item] = parseObjects(result.stdout, hashAlgo)
    return item ? { ...item, path: relativePath } : null
  }

  async function verify(
    target: RemoteTarget,
    localPath: string,
    relativePath: string,
    signal?: AbortSignal
  ): Promise<VerifiedUpload | null> {
    const caps = await capabilities(target)
    const object = await stat(target, relativePath, caps.hashAlgo, signal)
    if (!object) return null
    if (caps.hashAlgo && object.hash) {
      const local = await hashFile(localPath, caps.hashAlgo)
      if (local !== object.hash) return null
      return {
        size: object.size,
        modTime: object.modTime,
        hashAlgo: caps.hashAlgo,
        hash: local,
      }
    }
    // No comparable hash on this backend: download and compare locally.
    const dir = await mkdtemp(path.join(tmpdir(), 'lms-verify-'))
    try {
      const copy = path.join(dir, 'object')
      await runChecked(
        binary,
        ['copyto', remoteSpec(target, relativePath), copy],
        { signal }
      )
      const [remoteDigest, localDigest] = await Promise.all([
        hashFile(copy, 'sha256'),
        hashFile(localPath, 'sha256'),
      ])
      if (remoteDigest !== localDigest) return null
      return {
        size: object.size,
        modTime: object.modTime,
        hashAlgo: null,
        hash: null,
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  return {
    capabilities,
    async list(target, options, signal) {
      const args = ['lsjson', '--recursive', '--files-only', remoteSpec(target)]
      if (options.hashAlgo) args.push('--hash', '--hash-type', options.hashAlgo)
      const result = await run(binary, args, { signal })
      if (
        result.code === 3 ||
        (result.code !== 0 && MISSING_OBJECT.test(result.stderr))
      ) {
        return new Map()
      }
      if (result.code !== 0) {
        throw new ProcessError(
          `rclone lsjson failed: ${result.stderr.trim()}`,
          result
        )
      }
      const map = new Map<string, RemoteObject>()
      for (const item of parseObjects(result.stdout, options.hashAlgo)) {
        map.set(item.path, item)
      }
      return map
    },
    stat,
    verify,
    async upload(target, localPath, relativePath, onProgress, signal) {
      await runChecked(
        binary,
        [
          'copyto',
          localPath,
          remoteSpec(target, relativePath),
          '--stats',
          '500ms',
          '--stats-one-line',
          '-v',
        ],
        {
          signal,
          onLine(line) {
            const match = line.match(/,\s*(\d{1,3})%/)
            if (match) onProgress(Math.min(1, Number(match[1]) / 100))
          },
        }
      )
      onProgress(1)
      const verified = await verify(target, localPath, relativePath, signal)
      if (!verified) {
        throw Object.assign(
          new Error(`Upload verification failed for ${relativePath}`),
          {
            kind: 'transient' as const,
          }
        )
      }
      return verified
    },
    async move(target, fromRelative, toRelative, signal) {
      await runChecked(
        binary,
        [
          'moveto',
          remoteSpec(target, fromRelative),
          remoteSpec(target, toRelative),
        ],
        { signal }
      )
    },
    async delete(target, relativePath, signal) {
      const result = await run(
        binary,
        ['deletefile', remoteSpec(target, relativePath)],
        {
          signal,
        }
      )
      if (result.code === 0) return
      if (
        result.code === 4 ||
        (result.code !== 0 && MISSING_OBJECT.test(result.stderr))
      )
        return
      throw new ProcessError(
        `rclone deletefile failed: ${result.stderr.trim()}`,
        result
      )
    },
  }
}
