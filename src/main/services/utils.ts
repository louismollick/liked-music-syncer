import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sanitizeFilename from 'sanitize-filename'

export function nowIso() {
  return new Date().toISOString()
}

export function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`
}

export function expandHome(value: string) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

export function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function jaccardSimilarity(left: string, right: string) {
  const leftTokens = new Set(normalizeText(left).split(' ').filter(Boolean))
  const rightTokens = new Set(normalizeText(right).split(' ').filter(Boolean))

  if (leftTokens.size === 0 || rightTokens.size === 0) return 0

  let overlap = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1
  }

  return overlap / (leftTokens.size + rightTokens.size - overlap)
}

export function durationSimilarity(
  leftSeconds: number | null,
  rightSeconds: number | null
) {
  if (!leftSeconds || !rightSeconds) return 0.5
  const delta = Math.abs(leftSeconds - rightSeconds)
  return Math.max(0, 1 - delta / 15)
}

export function parseYoutubeDuration(duration: string | null | undefined) {
  if (!duration) return null
  const match =
    /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/u.exec(duration) ?? []
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  const seconds = Number(match[4] ?? 0)
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds
  return Number.isFinite(total) && total > 0 ? total : null
}

export function sanitizePathSegment(value: string, fallback: string) {
  const sanitized = sanitizeFilename(value.trim(), { replacement: '_' })
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized === '' ? fallback : sanitized
}

export function buildLibraryPath(
  outputDirectory: string,
  artist: string,
  album: string,
  title: string,
  extension: string
) {
  const safeArtist = sanitizePathSegment(artist, 'Unknown Artist')
  const safeAlbum = sanitizePathSegment(album || '_Singles', '_Singles')
  const safeTitle = sanitizePathSegment(title, 'Unknown Title')
  return path.join(
    outputDirectory,
    safeArtist,
    safeAlbum,
    `${safeTitle}${extension}`
  )
}

export function cleanYoutubeTitle(rawTitle: string) {
  const withoutDecorators = rawTitle
    .replace(/\[(?:official|lyrics?|audio|video)[^\]]*\]/giu, '')
    .replace(/\((?:official|lyrics?|audio|video)[^)]*\)/giu, '')
    .replace(/\s+/g, ' ')
    .trim()

  const separatorMatch = withoutDecorators.split(/\s[-–—]\s/u)
  if (separatorMatch.length >= 2) {
    const [artist, ...titleParts] = separatorMatch
    const title = titleParts.join(' - ').trim()
    return {
      title: title || withoutDecorators,
      artistGuess: artist.trim(),
    }
  }

  return {
    title: withoutDecorators,
    artistGuess: '',
  }
}

export async function fileExists(target: string) {
  try {
    const details = await stat(target)
    return details.isFile()
  } catch {
    return false
  }
}

export async function sha256File(contents: Buffer) {
  return createHash('sha256').update(contents).digest('hex')
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return

  let nextIndex = 0
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex
        nextIndex += 1
        await worker(items[currentIndex], currentIndex)
      }
    }
  )
  await Promise.all(runners)
}
