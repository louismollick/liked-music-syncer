import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import { pathKey } from './layout'

export const STAGING_DIR = '.lms-staging'

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}

export class PathTakenError extends Error {
  constructor(readonly target: string) {
    super(`Path already exists: ${target}`)
    this.name = 'PathTakenError'
  }
}

/**
 * Places `source` at `target` without ever replacing an existing entry:
 * hard-link (fails with EEXIST if taken), then unlink the source. Both paths
 * must be on the same volume.
 */
export async function placeNoClobber(
  source: string,
  target: string
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await link(source, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new PathTakenError(target)
    throw error
  }
  await unlink(source)
}

/**
 * The relative path as the filesystem spells it. On a case-insensitive volume
 * an existing `Ne-Yo/` folder takes a new `NE-YO/…` file, so recording the
 * layout path would not match what later scans find.
 */
export async function onDiskRelative(
  root: string,
  relative: string
): Promise<string> {
  try {
    const [base, full] = await Promise.all([
      realpath(root),
      realpath(path.join(root, relative)),
    ])
    const actual = path.relative(base, full).normalize('NFC')
    // Symlinks resolve elsewhere; only accept a spelling difference.
    if (pathKey(actual) === pathKey(relative)) return actual
  } catch {
    // Missing file: keep the path as given.
  }
  return relative
}

/** Replaces a file the app owns with a staged version atomically. */
export async function replaceOwned(
  source: string,
  target: string
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  await rename(source, target)
}

export async function copyToStaging(
  source: string,
  target: string
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(source, target)
}

export async function removeIfExists(file: string): Promise<void> {
  await rm(file, { force: true })
}

/** Removes empty directories from `dir` up to (not including) `root`. */
export async function pruneEmptyDirs(root: string, dir: string): Promise<void> {
  let current = dir
  const stop = path.resolve(root)
  while (
    path.resolve(current).startsWith(stop) &&
    path.resolve(current) !== stop
  ) {
    try {
      const entries = await readdir(current)
      if (entries.some((entry) => entry !== '.DS_Store')) return
      await rm(current, { recursive: true, force: true })
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

export interface WalkEntry {
  relativePath: string
  size: number
  mtimeMs: number
}

/** Lists .m4a files under root, skipping hidden directories and staging. */
export async function walkAudio(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  async function visit(dir: string, rel: string) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      const relative = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await visit(full, relative)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.m4a')) {
        const info = await lstat(full)
        out.push({
          relativePath: relative.normalize('NFC'),
          size: info.size,
          mtimeMs: info.mtimeMs,
        })
      }
    }
  }
  await visit(root, '')
  return out
}
