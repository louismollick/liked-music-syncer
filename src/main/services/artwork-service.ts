import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildAlbumKey } from '@shared/album-key'
import type { AlbumArtworkEntry } from '@shared/contracts'
import type { AppDatabase } from '../db/database'
import {
  libraryFilesTable,
  libraryRootsTable,
  libraryTracksTable,
} from '../db/schema'
import { buildArtworkMediaUrl } from './artwork-protocol'
import { logMain } from './logger'
import type { PythonWorkerService } from './python-worker'
import { runWithConcurrency } from './utils'

export const ARTWORK_THUMB_SIZE = 256

const EXTRACT_COMMAND = 'extract-embedded-cover'

interface SourceFileCandidate {
  fileId: string
  absolutePath: string
  tagFingerprint: string | null
  modifiedAt: string | null
  sizeBytes: number | null
  coverArtPresent: boolean
  localScore: number
}

interface ExtractCoverResponse {
  ok: boolean
  message?: string
  jpeg_base64?: string | null
}

export function buildArtworkCacheKey(input: {
  fileId: string
  tagFingerprint: string | null
  modifiedAt: string | null
  sizeBytes: number | null
  thumbSize?: number
}): string {
  const thumbSize = input.thumbSize ?? ARTWORK_THUMB_SIZE
  const fingerprint = [
    input.fileId,
    input.tagFingerprint ?? '',
    input.modifiedAt ?? '',
    String(input.sizeBytes ?? ''),
    String(thumbSize),
  ].join('|')
  return createHash('sha256').update(fingerprint).digest('hex')
}

export function artworkCacheFileName(cacheKey: string): string {
  return `${cacheKey}.jpg`
}

const EXTRACT_CONCURRENCY = 3

interface ArtworkLookupStats {
  requested: number
  cacheHits: number
  extracted: number
  noSource: number
  noCover: number
  extractFailed: number
  errors: number
}

interface AlbumArtworkOptions {
  onEntry?: (entry: AlbumArtworkEntry) => void
}

export class ArtworkService {
  constructor(
    private readonly db: AppDatabase,
    private readonly pythonWorker: PythonWorkerService,
    private readonly cacheDirectory: string
  ) {
    fs.mkdirSync(this.cacheDirectory, { recursive: true })
  }

  async getAlbumArtwork(
    albumKeys: string[],
    options: AlbumArtworkOptions = {}
  ): Promise<AlbumArtworkEntry[]> {
    const uniqueKeys = [...new Set(albumKeys.filter(Boolean))]
    if (uniqueKeys.length === 0) return []
    const publishEntry = (entry: AlbumArtworkEntry) => {
      options.onEntry?.(entry)
      results.push(entry)
    }

    const startedAt = Date.now()
    const stats: ArtworkLookupStats = {
      requested: uniqueKeys.length,
      cacheHits: 0,
      extracted: 0,
      noSource: 0,
      noCover: 0,
      extractFailed: 0,
      errors: 0,
    }

    logMain({
      level: 'info',
      source: 'artwork',
      message: 'Album artwork batch started',
      context: { albumCount: uniqueKeys.length },
    })

    const indexStartedAt = Date.now()
    const index = await this.buildAlbumSourceIndex()
    logMain({
      level: 'debug',
      source: 'artwork',
      message: 'Album source index built',
      context: {
        albumSlots: index.size,
        durationMs: Date.now() - indexStartedAt,
      },
    })

    const results: AlbumArtworkEntry[] = []
    const pendingExtractions: Array<{
      albumKey: string
      source: SourceFileCandidate
    }> = []

    for (const albumKey of uniqueKeys) {
      const source = index.get(albumKey) ?? null
      if (!source) {
        stats.noSource++
        publishEntry({ albumKey, artworkUrl: null })
        continue
      }

      const cacheKey = buildArtworkCacheKey({
        fileId: source.fileId,
        tagFingerprint: source.tagFingerprint,
        modifiedAt: source.modifiedAt,
        sizeBytes: source.sizeBytes,
      })
      const cacheFileName = artworkCacheFileName(cacheKey)
      const cachePath = path.join(this.cacheDirectory, cacheFileName)

      if (fs.existsSync(cachePath)) {
        stats.cacheHits++
        publishEntry({
          albumKey,
          artworkUrl: buildArtworkMediaUrl(cacheFileName),
        })
        continue
      }

      if (!source.coverArtPresent) {
        stats.noCover++
        publishEntry({ albumKey, artworkUrl: null })
        continue
      }

      pendingExtractions.push({ albumKey, source })
    }

    if (pendingExtractions.length > 0) {
      logMain({
        level: 'info',
        source: 'artwork',
        message: 'Extracting embedded album artwork',
        context: {
          pendingCount: pendingExtractions.length,
          concurrency: EXTRACT_CONCURRENCY,
        },
      })
    }

    let extractionCompleted = 0
    const extractionTotal = pendingExtractions.length
    const logProgressEvery =
      extractionTotal >= 20 ? 10 : extractionTotal >= 5 ? 5 : 0

    await runWithConcurrency(
      pendingExtractions,
      EXTRACT_CONCURRENCY,
      async ({ albumKey, source }) => {
        try {
          const outcome = await this.extractAndCacheArtwork(albumKey, source)
          if (outcome === 'extracted') stats.extracted++
          else if (outcome === 'failed') stats.extractFailed++
          extractionCompleted++
          if (
            logProgressEvery > 0 &&
            (extractionCompleted % logProgressEvery === 0 ||
              extractionCompleted === extractionTotal)
          ) {
            logMain({
              level: 'info',
              source: 'artwork',
              message: 'Album artwork extraction progress',
              context: {
                completed: extractionCompleted,
                total: extractionTotal,
              },
            })
          }
          publishEntry({
            albumKey,
            artworkUrl:
              outcome === 'extracted'
                ? buildArtworkMediaUrl(
                    artworkCacheFileName(
                      buildArtworkCacheKey({
                        fileId: source.fileId,
                        tagFingerprint: source.tagFingerprint,
                        modifiedAt: source.modifiedAt,
                        sizeBytes: source.sizeBytes,
                      })
                    )
                  )
                : null,
          })
        } catch (error) {
          stats.errors++
          logMain({
            level: 'warn',
            source: 'artwork',
            message: 'Album artwork extraction failed',
            context: {
              albumKey,
              fileId: source.fileId,
              filePath: source.absolutePath,
              error: error instanceof Error ? error.message : String(error),
            },
          })
          publishEntry({ albumKey, artworkUrl: null })
        }
      }
    )

    logMain({
      level: 'info',
      source: 'artwork',
      message: 'Album artwork batch finished',
      context: {
        ...stats,
        resolved: results.filter((entry) => entry.artworkUrl != null).length,
        durationMs: Date.now() - startedAt,
      },
    })

    return results
  }

  async pruneStaleCache(): Promise<void> {
    const validNames = await this.collectValidCacheFileNames()
    let entries: string[]
    try {
      entries = await fs.promises.readdir(this.cacheDirectory)
    } catch {
      return
    }

    const staleEntries = entries.filter(
      (entry) => entry.endsWith('.jpg') && !validNames.has(entry)
    )

    await Promise.all(
      staleEntries.map(async (entry) => {
        try {
          await fs.promises.unlink(path.join(this.cacheDirectory, entry))
        } catch {
          return undefined
        }
      })
    )

    if (staleEntries.length > 0) {
      logMain({
        level: 'info',
        source: 'artwork',
        message: 'Pruned stale artwork cache entries',
        context: {
          removedCount: staleEntries.length,
          validCount: validNames.size,
        },
      })
    }
  }

  private async collectValidCacheFileNames(): Promise<Set<string>> {
    const files = await this.db
      .select({
        id: libraryFilesTable.id,
        tagFingerprint: libraryFilesTable.tagFingerprint,
        modifiedAt: libraryFilesTable.modifiedAt,
        sizeBytes: libraryFilesTable.sizeBytes,
      })
      .from(libraryFilesTable)

    const names = new Set<string>()
    for (const file of files) {
      const cacheKey = buildArtworkCacheKey({
        fileId: file.id,
        tagFingerprint: file.tagFingerprint,
        modifiedAt: file.modifiedAt,
        sizeBytes: file.sizeBytes,
      })
      names.add(artworkCacheFileName(cacheKey))
    }
    return names
  }

  private async buildAlbumSourceIndex(): Promise<
    Map<string, SourceFileCandidate>
  > {
    const tracks = await this.db.select().from(libraryTracksTable)
    const files = await this.db.select().from(libraryFilesTable)
    const roots = await this.db.select().from(libraryRootsTable)
    const rootById = new Map(roots.map((root) => [root.id, root]))
    const filesByTrackId = new Map<string, (typeof files)[number][]>()

    for (const file of files) {
      const list = filesByTrackId.get(file.trackId) ?? []
      list.push(file)
      filesByTrackId.set(file.trackId, list)
    }

    const index = new Map<string, SourceFileCandidate>()

    for (const track of tracks) {
      const albumKey = buildAlbumKey(track.album, track.albumArtist)
      const trackFiles = filesByTrackId.get(track.id) ?? []
      const candidate = this.pickSourceCandidate(
        track.preferredFileId,
        track.coverArtPresent,
        trackFiles,
        rootById
      )
      if (!candidate) continue

      const existing = index.get(albumKey)
      if (!existing || candidate.localScore > existing.localScore) {
        index.set(albumKey, candidate)
      } else if (
        candidate.localScore === existing.localScore &&
        candidate.coverArtPresent &&
        !existing.coverArtPresent
      ) {
        index.set(albumKey, candidate)
      }
    }

    return index
  }

  private pickSourceCandidate(
    preferredFileId: string | null,
    coverArtPresent: boolean,
    trackFiles: (typeof libraryFilesTable.$inferSelect)[],
    rootById: Map<string, typeof libraryRootsTable.$inferSelect>
  ): SourceFileCandidate | null {
    const ranked = [...trackFiles].sort((left, right) => {
      const leftScore = this.scoreFile(left, rootById, preferredFileId)
      const rightScore = this.scoreFile(right, rootById, preferredFileId)
      if (leftScore !== rightScore) return rightScore - leftScore
      return left.relativePath.localeCompare(right.relativePath)
    })

    for (const file of ranked) {
      const absolutePath = this.resolveLocalAbsolutePath(file, rootById)
      if (!absolutePath) continue
      const root = rootById.get(file.rootId)
      return {
        fileId: file.id,
        absolutePath,
        tagFingerprint: file.tagFingerprint,
        modifiedAt: file.modifiedAt,
        sizeBytes: file.sizeBytes,
        coverArtPresent,
        localScore: root?.kind === 'local' ? 100 : 0,
      }
    }

    return null
  }

  private scoreFile(
    file: typeof libraryFilesTable.$inferSelect,
    rootById: Map<string, typeof libraryRootsTable.$inferSelect>,
    preferredFileId: string | null
  ) {
    const root = rootById.get(file.rootId)
    return (
      (preferredFileId === file.id ? 1000 : 0) +
      (root?.kind === 'local' ? 100 : 0) +
      (file.absolutePathSnapshot ? 10 : 0)
    )
  }

  private resolveLocalAbsolutePath(
    file: typeof libraryFilesTable.$inferSelect,
    rootById: Map<string, typeof libraryRootsTable.$inferSelect>
  ): string | null {
    const root = rootById.get(file.rootId)
    if (!root || root.transport !== 'filesystem') {
      return null
    }

    const snapshot = file.absolutePathSnapshot?.trim()
    if (snapshot && fs.existsSync(snapshot)) {
      return path.resolve(snapshot)
    }

    if (root.kind !== 'local') {
      return null
    }

    const candidate = path.resolve(root.uri, file.relativePath)
    return fs.existsSync(candidate) ? candidate : null
  }

  private async extractAndCacheArtwork(
    albumKey: string,
    source: SourceFileCandidate
  ): Promise<'extracted' | 'failed'> {
    const extractStartedAt = Date.now()
    const payload =
      await this.pythonWorker.runJsonCommand<ExtractCoverResponse>(
        EXTRACT_COMMAND,
        {
          file_path: source.absolutePath,
          size: ARTWORK_THUMB_SIZE,
        }
      )

    if (!payload.ok || !payload.jpeg_base64) {
      logMain({
        level: 'debug',
        source: 'artwork',
        message:
          payload.message ?? 'No artwork extracted for album source file',
        context: {
          albumKey,
          fileId: source.fileId,
          filePath: source.absolutePath,
          durationMs: Date.now() - extractStartedAt,
        },
      })
      return 'failed'
    }

    const cacheKey = buildArtworkCacheKey({
      fileId: source.fileId,
      tagFingerprint: source.tagFingerprint,
      modifiedAt: source.modifiedAt,
      sizeBytes: source.sizeBytes,
    })
    const cacheFileName = artworkCacheFileName(cacheKey)
    const cachePath = path.join(this.cacheDirectory, cacheFileName)
    const imageBytes = Buffer.from(payload.jpeg_base64, 'base64')
    await fs.promises.writeFile(cachePath, imageBytes)

    logMain({
      level: 'debug',
      source: 'artwork',
      message: 'Cached album artwork thumbnail',
      context: {
        albumKey,
        fileId: source.fileId,
        cacheFileName,
        bytes: imageBytes.length,
        durationMs: Date.now() - extractStartedAt,
      },
    })
    return 'extracted'
  }
}
