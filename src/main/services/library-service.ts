import path from 'node:path'
import type {
  CommandResult,
  DriftSummary,
  LibraryFileView,
  LibraryIndexStatus,
  LibraryRootView,
  LibraryTrackFilter,
  LibraryTrackView,
  LyricsStatus,
} from '@shared/contracts'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { AppDatabase } from '../db/database'
import {
  libraryFilesTable,
  libraryRootsTable,
  libraryTracksTable,
  metaTable,
} from '../db/schema'
import type { ArtworkService } from './artwork-service'
import { logMain } from './logger'
import type { PythonWorkerService } from './python-worker'
import type { SettingsService } from './settings-service'
import { createId, nowIso } from './utils'

type RootKind = 'local' | 'remote'
type RootTransport = 'filesystem' | 'rclone'
type DiscoveredVia = 'lms_tags' | 'mb_track' | 'isrc' | 'heuristic' | 'path'
type LocalIndexJobMode = 'bootstrap' | 'refresh'

const LIBRARY_INDEX_VERSION = 1

interface RootDescriptor {
  id: string
  kind: RootKind
  transport: RootTransport
  label: string
  uri: string
  writable: boolean
  managedOutput: boolean
}

interface ScannedFilePayload {
  managed_by_app: boolean
  tag_schema_version: number | null
  youtube_music_track_id: string | null
  spotify_track_id: string | null
  soundcloud_track_id: string | null
  resolved_youtube_music_track_id: string | null
  source_origin: string | null
  catalog_release_browse_id: string | null
  catalog_release_title: string | null
  catalog_release_kind: string | null
  title: string | null
  artist: string | null
  album: string | null
  album_artist: string | null
  track_number: number | null
  track_total: number | null
  disc_number: number | null
  disc_total: number | null
  year: number | null
  date: string | null
  genre: string | null
  language: string | null
  isrc: string | null
  mb_track_id: string | null
  mb_album_id: string | null
  mb_releasegroup_id: string | null
  lyrics_status: LyricsStatus
  has_embedded_lyrics: boolean
  has_sidecar_lyrics: boolean
  cover_art_present: boolean
  missing_fields: string[]
  format: string
  duration_seconds: number | null
  bitrate: number | null
  embedded_lyrics_status: LyricsStatus
  sidecar_lyrics_status: LyricsStatus
  relative_path: string
  absolute_path_snapshot: string | null
  lrc_path: string | null
  size_bytes: number | null
  modified_at: string | null
  sidecar_modified_at: string | null
  audio_sha256: string | null
  tag_fingerprint: string | null
  last_scanned_at: string
  identity_kind: LibraryTrackView['identityKind']
  identity_value: string
  discovered_via: DiscoveredVia
}

interface RootScanResult {
  scanned_at: string
  files: ScannedFilePayload[]
  deleted_relative_paths?: string[]
}

interface ScanRootsOptions {
  kinds?: RootKind[]
}

interface TrackAggregate {
  id: string
  identityKind: LibraryTrackView['identityKind']
  identityValue: string
  firstSeenAt: string
  lastSeenAt: string
  managedByApp: boolean
  tagSchemaVersion: number | null
  youtubeMusicTrackId: string | null
  spotifyTrackId: string | null
  soundcloudTrackId: string | null
  resolvedYoutubeMusicTrackId: string | null
  sourceOrigin: string | null
  catalogReleaseBrowseId: string | null
  catalogReleaseTitle: string | null
  catalogReleaseKind: string | null
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  trackNumber: number | null
  trackTotal: number | null
  discNumber: number | null
  discTotal: number | null
  year: number | null
  date: string | null
  genre: string | null
  language: string | null
  isrc: string | null
  mbTrackId: string | null
  mbAlbumId: string | null
  mbReleaseGroupId: string | null
  lyricsStatus: LyricsStatus
  hasEmbeddedLyrics: boolean
  hasSidecarLyrics: boolean
  coverArtPresent: boolean
  preferredFileId: string | null
  preferredFileRank: number
}

export class LibraryService {
  private readonly indexStatusListeners = new Set<() => void>()
  private localIndexJob: Promise<CommandResult> | null = null
  private startupBootstrapAttempted = false

  constructor(
    private readonly db: AppDatabase,
    private readonly settingsService: SettingsService,
    private readonly pythonWorker: PythonWorkerService,
    private readonly artworkService?: ArtworkService
  ) {}

  subscribeIndexStatus(listener: () => void) {
    this.indexStatusListeners.add(listener)
    return () => this.indexStatusListeners.delete(listener)
  }

  async getIndexStatus(): Promise<LibraryIndexStatus> {
    const localRoot = await this.resolveCurrentLocalRoot()
    if (!localRoot) {
      return {
        currentLocalRootUri: null,
        ready: false,
        inProgress: false,
        reason: 'missing_root',
        lastScannedAt: null,
        lastScanStatus: null,
        indexVersion: null,
      }
    }

    const [rootRow, indexVersion, indexedRootUri] = await Promise.all([
      this.getRootRowByUri(localRoot.uri),
      this.readIndexVersion(),
      this.readMetaValue('library_index_local_root_uri'),
    ])

    if (this.localIndexJob) {
      return {
        currentLocalRootUri: localRoot.uri,
        ready: false,
        inProgress: true,
        reason: 'bootstrapping',
        lastScannedAt: rootRow?.lastScannedAt ?? null,
        lastScanStatus: rootRow?.lastScanStatus ?? null,
        indexVersion,
      }
    }

    if (rootRow?.lastScanStatus?.startsWith('error:')) {
      return {
        currentLocalRootUri: localRoot.uri,
        ready: false,
        inProgress: false,
        reason: 'scan_failed',
        lastScannedAt: rootRow.lastScannedAt,
        lastScanStatus: rootRow.lastScanStatus,
        indexVersion,
      }
    }

    if (!rootRow?.lastScannedAt || !rootRow.lastScanStatus) {
      return {
        currentLocalRootUri: localRoot.uri,
        ready: false,
        inProgress: false,
        reason: 'never_scanned',
        lastScannedAt: rootRow?.lastScannedAt ?? null,
        lastScanStatus: rootRow?.lastScanStatus ?? null,
        indexVersion,
      }
    }

    if (rootRow.lastScanStatus !== 'ok') {
      return {
        currentLocalRootUri: localRoot.uri,
        ready: false,
        inProgress: false,
        reason: 'scan_failed',
        lastScannedAt: rootRow.lastScannedAt,
        lastScanStatus: rootRow.lastScanStatus,
        indexVersion,
      }
    }

    if (
      indexVersion !== LIBRARY_INDEX_VERSION ||
      indexedRootUri !== localRoot.uri
    ) {
      return {
        currentLocalRootUri: localRoot.uri,
        ready: false,
        inProgress: false,
        reason: 'stale_version',
        lastScannedAt: rootRow.lastScannedAt,
        lastScanStatus: rootRow.lastScanStatus,
        indexVersion,
      }
    }

    return {
      currentLocalRootUri: localRoot.uri,
      ready: true,
      inProgress: false,
      reason: 'ready',
      lastScannedAt: rootRow.lastScannedAt,
      lastScanStatus: rootRow.lastScanStatus,
      indexVersion,
    }
  }

  async ensureLocalIndexReady(): Promise<LibraryIndexStatus> {
    return this.getIndexStatus()
  }

  getIndexNotReadyResult(status: LibraryIndexStatus): CommandResult {
    if (status.inProgress) {
      return {
        ok: false,
        message:
          'Library indexing still in progress. Wait for refresh to finish.',
      }
    }

    if (status.reason === 'missing_root') {
      return {
        ok: false,
        message: 'Output directory must be configured first.',
      }
    }

    return {
      ok: false,
      message: 'Library index is not ready. Retry Refresh library.',
    }
  }

  async bootstrapLocalIndexIfNeeded(): Promise<CommandResult | null> {
    if (this.startupBootstrapAttempted) return null
    this.startupBootstrapAttempted = true

    const status = await this.getIndexStatus()
    if (
      status.ready ||
      status.inProgress ||
      status.reason === 'missing_root' ||
      status.reason === 'scan_failed'
    ) {
      return null
    }

    return this.runLocalIndexJob('bootstrap', {
      fullScan: true,
      successMessage: 'Library indexing complete.',
    })
  }

  async refreshIndex(): Promise<CommandResult> {
    const status = await this.getIndexStatus()
    if (status.inProgress) {
      return {
        ok: false,
        message: 'Library indexing already in progress.',
      }
    }

    const localRoot = await this.resolveCurrentLocalRoot()
    if (!localRoot) {
      return {
        ok: false,
        message: 'Output directory must be configured first.',
      }
    }

    const fullScan =
      !status.ready ||
      status.reason === 'never_scanned' ||
      status.reason === 'stale_version' ||
      status.reason === 'scan_failed'

    return this.runLocalIndexJob('refresh', {
      fullScan,
      successMessage: fullScan
        ? 'Library refresh complete.'
        : 'Library reconcile complete.',
    })
  }

  async upsertLocalOutputs(outputPaths: string[]): Promise<void> {
    const root = await this.resolveCurrentLocalRoot()
    if (!root || outputPaths.length === 0) return

    const normalizedPaths = [...new Set(outputPaths)]
      .map((value) => path.resolve(value))
      .filter((value) => this.isPathInsideRoot(root.uri, value))

    if (normalizedPaths.length === 0) return

    await this.upsertRoot(root)
    const scan = await this.pythonWorker.runJsonCommand<RootScanResult>(
      'library-inspect-local-files',
      {
        uri: root.uri,
        absolute_paths: normalizedPaths,
      }
    )
    await this.persistIncrementalRootChanges(root, scan)
  }

  async upsertRemoteCopyFromLocalPath(outputPath: string): Promise<void> {
    const settings = await this.settingsService.getRuntimeSettings()
    const localRootUri = settings.outputDirectory.trim()
    const remoteRootUri =
      settings.remoteCopyEnabled &&
      settings.rcloneRemote.trim() &&
      settings.remoteMusicRoot.trim()
        ? `${settings.rcloneRemote.trim()}:${settings.remoteMusicRoot.trim()}`
        : null
    if (!localRootUri || !remoteRootUri) return

    const relativePath = this.toRelativePath(localRootUri, outputPath)
    if (!relativePath) return

    const [localRootRow, remoteRoot] = await Promise.all([
      this.getRootRowByUri(localRootUri),
      this.resolveCurrentRemoteRoot(),
    ])
    if (!localRootRow || !remoteRoot) return

    await this.upsertRoot(remoteRoot)

    const localFile = await this.db.query.libraryFilesTable.findFirst({
      where: and(
        eq(libraryFilesTable.rootId, localRootRow.id),
        eq(libraryFilesTable.relativePath, relativePath)
      ),
    })
    if (!localFile) return

    const remoteAbsolutePath = `${remoteRoot.uri.replace(/\/$/, '')}/${relativePath}`
    const remoteLrcPath = localFile.lrcPath
      ? `${remoteRoot.uri.replace(/\/$/, '')}/${relativePath.replace(/\.[^/.]+$/, '.lrc')}`
      : null
    const timestamp = nowIso()

    await this.db
      .insert(libraryFilesTable)
      .values({
        id: createId('file'),
        trackId: localFile.trackId,
        rootId: remoteRoot.id,
        relativePath,
        absolutePathSnapshot: remoteAbsolutePath,
        lrcPath: remoteLrcPath,
        format: localFile.format,
        sizeBytes: localFile.sizeBytes,
        durationSeconds: localFile.durationSeconds,
        bitrate: localFile.bitrate,
        modifiedAt: localFile.modifiedAt,
        sidecarModifiedAt: localFile.sidecarModifiedAt,
        audioSha256: localFile.audioSha256,
        tagFingerprint: localFile.tagFingerprint,
        embeddedLyricsStatus: localFile.embeddedLyricsStatus,
        sidecarLyricsStatus: localFile.sidecarLyricsStatus,
        missingFieldsJson: localFile.missingFieldsJson,
        discoveredVia: localFile.discoveredVia,
        lastScannedAt: timestamp,
        firstSeenAt: localFile.firstSeenAt,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [libraryFilesTable.rootId, libraryFilesTable.relativePath],
        set: {
          trackId: localFile.trackId,
          absolutePathSnapshot: remoteAbsolutePath,
          lrcPath: remoteLrcPath,
          format: localFile.format,
          sizeBytes: localFile.sizeBytes,
          durationSeconds: localFile.durationSeconds,
          bitrate: localFile.bitrate,
          modifiedAt: localFile.modifiedAt,
          sidecarModifiedAt: localFile.sidecarModifiedAt,
          audioSha256: localFile.audioSha256,
          tagFingerprint: localFile.tagFingerprint,
          embeddedLyricsStatus: localFile.embeddedLyricsStatus,
          sidecarLyricsStatus: localFile.sidecarLyricsStatus,
          missingFieldsJson: localFile.missingFieldsJson,
          discoveredVia: localFile.discoveredVia,
          lastScannedAt: timestamp,
          updatedAt: timestamp,
        },
      })
  }

  async pruneIndexedFile(rootUri: string, relativePath: string): Promise<void> {
    const rootRow = await this.getRootRowByUri(rootUri)
    if (!rootRow) return

    const existing = await this.db.query.libraryFilesTable.findFirst({
      where: and(
        eq(libraryFilesTable.rootId, rootRow.id),
        eq(libraryFilesTable.relativePath, relativePath)
      ),
    })
    if (!existing) return

    await this.db
      .delete(libraryFilesTable)
      .where(
        and(
          eq(libraryFilesTable.rootId, rootRow.id),
          eq(libraryFilesTable.relativePath, relativePath)
        )
      )
    await this.deleteOrphanTracks()
    await this.reassignPreferredFileIds([existing.trackId])
  }

  async scanRoots(options: ScanRootsOptions = {}): Promise<CommandResult> {
    const allRoots = await this.resolveRoots()
    const kindFilter = options.kinds ? new Set(options.kinds) : null
    const roots = kindFilter
      ? allRoots.filter((root) => kindFilter.has(root.kind))
      : allRoots
    if (roots.length === 0) {
      return { ok: false, message: 'No library roots configured.' }
    }

    const configuredRootIds = new Set(allRoots.map((root) => root.id))
    const existingTracks = await this.db.select().from(libraryTracksTable)
    const trackByIdentity = new Map(
      existingTracks.map((track) => [
        `${track.identityKind}:${track.identityValue}`,
        track,
      ])
    )

    const aggregateByTrackId = new Map<string, TrackAggregate>()

    for (const root of roots) {
      const timestamp = nowIso()
      await this.db
        .insert(libraryRootsTable)
        .values({
          id: root.id,
          kind: root.kind,
          transport: root.transport,
          label: root.label,
          uri: root.uri,
          writable: root.writable,
          managedOutput: root.managedOutput,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastScannedAt: null,
          lastScanStatus: null,
        })
        .onConflictDoUpdate({
          target: libraryRootsTable.id,
          set: {
            kind: root.kind,
            transport: root.transport,
            label: root.label,
            uri: root.uri,
            writable: root.writable,
            managedOutput: root.managedOutput,
            updatedAt: timestamp,
          },
        })
    }

    if (!kindFilter) {
      const existingRoots = await this.db.select().from(libraryRootsTable)
      for (const root of existingRoots) {
        if (configuredRootIds.has(root.id)) continue
        await this.db
          .delete(libraryFilesTable)
          .where(eq(libraryFilesTable.rootId, root.id))
        await this.db
          .delete(libraryRootsTable)
          .where(eq(libraryRootsTable.id, root.id))
      }
    }

    for (const root of roots) {
      try {
        const scan = await this.pythonWorker.runJsonCommand<RootScanResult>(
          'library-scan-root',
          {
            kind: root.kind,
            transport: root.transport,
            uri: root.uri,
          }
        )
        await this.persistRootScan(
          root,
          scan,
          trackByIdentity,
          aggregateByTrackId
        )
        await this.db
          .update(libraryRootsTable)
          .set({
            updatedAt: nowIso(),
            lastScannedAt: scan.scanned_at,
            lastScanStatus: 'ok',
          })
          .where(eq(libraryRootsTable.id, root.id))
        if (root.kind === 'local') {
          await this.persistLocalIndexMeta(root.uri)
        }
      } catch (error) {
        await this.db
          .update(libraryRootsTable)
          .set({
            updatedAt: nowIso(),
            lastScannedAt: nowIso(),
            lastScanStatus:
              error instanceof Error ? `error:${error.message}` : 'error',
          })
          .where(eq(libraryRootsTable.id, root.id))
        throw error
      }
    }

    await this.rebuildTrackAggregates(aggregateByTrackId)
    await this.deleteOrphanTracks()

    return {
      ok: true,
      message: `Scanned ${roots.length} library root${roots.length === 1 ? '' : 's'}.`,
    }
  }

  async scanLocalRoots(): Promise<CommandResult> {
    return this.scanRoots({ kinds: ['local'] })
  }

  async listRoots(): Promise<LibraryRootView[]> {
    const rows = await this.db
      .select()
      .from(libraryRootsTable)
      .orderBy(asc(libraryRootsTable.kind), asc(libraryRootsTable.label))
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as LibraryRootView['kind'],
      transport: row.transport as LibraryRootView['transport'],
      label: row.label,
      uri: row.uri,
      writable: row.writable,
      managedOutput: row.managedOutput,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastScannedAt: row.lastScannedAt,
      lastScanStatus: row.lastScanStatus,
    }))
  }

  async listTracks(
    filter: LibraryTrackFilter = {}
  ): Promise<LibraryTrackView[]> {
    const [tracks, files, roots] = await Promise.all([
      this.db
        .select()
        .from(libraryTracksTable)
        .orderBy(
          asc(libraryTracksTable.artist),
          asc(libraryTracksTable.album),
          asc(libraryTracksTable.trackNumber)
        ),
      this.db.select().from(libraryFilesTable),
      this.db.select().from(libraryRootsTable),
    ])
    const rootById = new Map(roots.map((root) => [root.id, root]))
    const filesByTrackId = new Map<string, typeof files>()
    for (const file of files) {
      const list = filesByTrackId.get(file.trackId) ?? []
      list.push(file)
      filesByTrackId.set(file.trackId, list)
    }

    return tracks
      .filter((track) => this.matchesTrackFilter(track, filter))
      .filter((track) => {
        if (filter.missingField) {
          const missing = this.parseJsonArray(track.missingFieldsJson)
          if (!missing.includes(filter.missingField)) return false
        }
        if (!filter.rootKind) return true
        const trackFiles = filesByTrackId.get(track.id) ?? []
        return trackFiles.some(
          (file) => rootById.get(file.rootId)?.kind === filter.rootKind
        )
      })
      .map((track) =>
        this.toTrackView(track, filesByTrackId.get(track.id) ?? [], rootById)
      )
  }

  async getTrack(trackId: string): Promise<LibraryTrackView | null> {
    const track = await this.db.query.libraryTracksTable.findFirst({
      where: eq(libraryTracksTable.id, trackId),
    })
    if (!track) return null

    const files = await this.db
      .select()
      .from(libraryFilesTable)
      .where(eq(libraryFilesTable.trackId, trackId))
      .orderBy(asc(libraryFilesTable.relativePath))
    const roots = await this.db.select().from(libraryRootsTable)
    const rootById = new Map(roots.map((root) => [root.id, root]))

    return {
      ...this.toTrackView(track, files, rootById),
      files: files.map((file) => this.toFileView(file)),
    }
  }

  async getDriftSummary(): Promise<DriftSummary> {
    const tracks = await this.db.select().from(libraryTracksTable)
    const files = await this.db.select().from(libraryFilesTable)
    const roots = await this.db.select().from(libraryRootsTable)
    const rootById = new Map(roots.map((root) => [root.id, root]))
    const filesByTrackId = new Map<string, typeof files>()
    for (const file of files) {
      const list = filesByTrackId.get(file.trackId) ?? []
      list.push(file)
      filesByTrackId.set(file.trackId, list)
    }

    let totalManagedTracks = 0
    let inSyncTracks = 0
    let localOnlyTracks = 0
    let remoteOnlyTracks = 0
    let missingEverywhereTracks = 0

    for (const track of tracks) {
      if (!track.managedByApp) continue
      totalManagedTracks += 1
      const trackFiles = filesByTrackId.get(track.id) ?? []
      const hasLocal = trackFiles.some(
        (file) => rootById.get(file.rootId)?.kind === 'local'
      )
      const hasRemote = trackFiles.some(
        (file) => rootById.get(file.rootId)?.kind === 'remote'
      )

      if (hasLocal && hasRemote) {
        inSyncTracks += 1
      } else if (hasLocal) {
        localOnlyTracks += 1
      } else if (hasRemote) {
        remoteOnlyTracks += 1
      } else {
        missingEverywhereTracks += 1
      }
    }

    return {
      totalManagedTracks,
      inSyncTracks,
      localOnlyTracks,
      remoteOnlyTracks,
      missingEverywhereTracks,
    }
  }

  async getManagedLocalYoutubeIds(): Promise<{
    sourceIds: Set<string>
    resolvedIds: Set<string>
  }> {
    const rows = await this.db
      .select({
        id: libraryTracksTable.id,
        managedByApp: libraryTracksTable.managedByApp,
        youtubeMusicTrackId: libraryTracksTable.youtubeMusicTrackId,
        resolvedYoutubeMusicTrackId:
          libraryTracksTable.resolvedYoutubeMusicTrackId,
      })
      .from(libraryTracksTable)

    const files = await this.db.select().from(libraryFilesTable)
    const roots = await this.db.select().from(libraryRootsTable)
    const rootById = new Map(roots.map((root) => [root.id, root]))
    const localTrackIds = new Set(
      files
        .filter((file) => rootById.get(file.rootId)?.kind === 'local')
        .map((file) => file.trackId)
    )

    const sourceIds = new Set<string>()
    const resolvedIds = new Set<string>()
    for (const track of rows) {
      if (!track.managedByApp) continue
      if (!localTrackIds.has(track.id)) continue
      if (track.youtubeMusicTrackId) sourceIds.add(track.youtubeMusicTrackId)
      if (track.resolvedYoutubeMusicTrackId) {
        resolvedIds.add(track.resolvedYoutubeMusicTrackId)
      }
    }

    return { sourceIds, resolvedIds }
  }

  async getManagedLocalSignatures(): Promise<{
    sourceIds: Set<string>
    resolvedIds: Set<string>
    trackSignatures: Array<{
      youtubeMusicTrackId: string | null
      resolvedYoutubeMusicTrackId: string | null
      artist: string | null
      title: string | null
      album: string | null
      sourceOrigin: string | null
      catalogReleaseBrowseId: string | null
      catalogReleaseTitle: string | null
      catalogReleaseKind: string | null
      mbAlbumId: string | null
      trackNumber: number | null
    }>
    releaseSignatures: Array<{
      artist: string | null
      title: string | null
      sourceOrigin: string | null
      catalogReleaseBrowseId: string | null
      mbAlbumId: string | null
      trackNumber: number | null
    }>
  }> {
    const rows = await this.db.select().from(libraryTracksTable)
    const files = await this.db.select().from(libraryFilesTable)
    const roots = await this.db.select().from(libraryRootsTable)
    const rootById = new Map(roots.map((root) => [root.id, root]))
    const localTrackIds = new Set(
      files
        .filter((file) => rootById.get(file.rootId)?.kind === 'local')
        .map((file) => file.trackId)
    )

    const sourceIds = new Set<string>()
    const resolvedIds = new Set<string>()
    const trackSignatures: Array<{
      youtubeMusicTrackId: string | null
      resolvedYoutubeMusicTrackId: string | null
      artist: string | null
      title: string | null
      album: string | null
      sourceOrigin: string | null
      catalogReleaseBrowseId: string | null
      catalogReleaseTitle: string | null
      catalogReleaseKind: string | null
      mbAlbumId: string | null
      trackNumber: number | null
    }> = []
    const releaseSignatures: Array<{
      artist: string | null
      title: string | null
      sourceOrigin: string | null
      catalogReleaseBrowseId: string | null
      mbAlbumId: string | null
      trackNumber: number | null
    }> = []

    for (const track of rows) {
      if (!track.managedByApp || !localTrackIds.has(track.id)) continue
      if (track.youtubeMusicTrackId) sourceIds.add(track.youtubeMusicTrackId)
      if (track.resolvedYoutubeMusicTrackId) {
        resolvedIds.add(track.resolvedYoutubeMusicTrackId)
      }
      trackSignatures.push({
        youtubeMusicTrackId: track.youtubeMusicTrackId,
        resolvedYoutubeMusicTrackId: track.resolvedYoutubeMusicTrackId,
        artist: track.artist,
        title: track.title,
        album: track.album,
        sourceOrigin: track.sourceOrigin,
        catalogReleaseBrowseId: track.catalogReleaseBrowseId,
        catalogReleaseTitle: track.catalogReleaseTitle,
        catalogReleaseKind: track.catalogReleaseKind,
        mbAlbumId: track.mbAlbumId,
        trackNumber: track.trackNumber,
      })
      releaseSignatures.push({
        artist: track.artist,
        title: track.title,
        sourceOrigin: track.sourceOrigin,
        catalogReleaseBrowseId: track.catalogReleaseBrowseId,
        mbAlbumId: track.mbAlbumId,
        trackNumber: track.trackNumber,
      })
    }

    return { sourceIds, resolvedIds, trackSignatures, releaseSignatures }
  }

  private async runLocalIndexJob(
    _mode: LocalIndexJobMode,
    options: {
      fullScan: boolean
      successMessage: string
    }
  ): Promise<CommandResult> {
    if (this.localIndexJob) {
      return {
        ok: false,
        message: 'Library indexing already in progress.',
      }
    }

    const root = await this.resolveCurrentLocalRoot()
    if (!root) {
      return {
        ok: false,
        message: 'Output directory must be configured first.',
      }
    }

    const job = (async (): Promise<CommandResult> => {
      try {
        await this.upsertRoot(root)
        const result = options.fullScan
          ? await this.scanLocalRoots()
          : await this.reconcileLocalRoot(root)
        if (!result.ok) return result
        await this.persistLocalIndexMeta(root.uri)
        if (this.artworkService) {
          void this.artworkService.pruneStaleCache().catch((error) => {
            logMain({
              level: 'warn',
              source: 'artwork',
              message:
                'Failed to prune stale artwork cache after library index',
              context: {
                error: error instanceof Error ? error.message : String(error),
              },
            })
          })
        }
        return {
          ok: true,
          message: options.successMessage,
        }
      } finally {
        this.localIndexJob = null
        this.emitIndexStatusChanged()
      }
    })()

    this.localIndexJob = job
    this.emitIndexStatusChanged()
    return job
  }

  private async reconcileLocalRoot(
    root: RootDescriptor
  ): Promise<CommandResult> {
    try {
      const knownFiles = await this.db
        .select({
          relative_path: libraryFilesTable.relativePath,
          modified_at: libraryFilesTable.modifiedAt,
          size_bytes: libraryFilesTable.sizeBytes,
          lrc_path: libraryFilesTable.lrcPath,
          sidecar_modified_at: libraryFilesTable.sidecarModifiedAt,
        })
        .from(libraryFilesTable)
        .where(eq(libraryFilesTable.rootId, root.id))

      const scan = await this.pythonWorker.runJsonCommand<RootScanResult>(
        'library-reconcile-local-root',
        {
          uri: root.uri,
          known_files: knownFiles,
        }
      )

      await this.persistIncrementalRootChanges(root, scan)
      await this.db
        .update(libraryRootsTable)
        .set({
          updatedAt: nowIso(),
          lastScannedAt: scan.scanned_at,
          lastScanStatus: 'ok',
        })
        .where(eq(libraryRootsTable.id, root.id))

      return {
        ok: true,
        message: 'Library reconcile complete.',
      }
    } catch (error) {
      await this.markRootScanFailure(root.id, error)
      return {
        ok: false,
        message:
          error instanceof Error ? error.message : 'Library refresh failed.',
      }
    }
  }

  private async persistIncrementalRootChanges(
    root: RootDescriptor,
    scan: RootScanResult
  ) {
    const existingFiles = await this.db
      .select()
      .from(libraryFilesTable)
      .where(eq(libraryFilesTable.rootId, root.id))
    const fileByPath = new Map(
      existingFiles.map((file) => [file.relativePath, file] as const)
    )
    const trackByIdentity = await this.loadTrackByIdentity()
    const affectedTrackIds = new Set<string>()

    for (const payload of scan.files) {
      const identityKey = `${payload.identity_kind}:${payload.identity_value}`
      const existingTrack = trackByIdentity.get(identityKey)
      const trackId = existingTrack?.id ?? createId('track')
      const existingFile = fileByPath.get(payload.relative_path)
      const fileId = existingFile?.id ?? createId('file')
      const firstSeenAt = existingFile?.firstSeenAt ?? payload.last_scanned_at

      await this.db
        .insert(libraryFilesTable)
        .values({
          id: fileId,
          trackId,
          rootId: root.id,
          relativePath: payload.relative_path,
          absolutePathSnapshot: payload.absolute_path_snapshot,
          lrcPath: payload.lrc_path,
          format: payload.format,
          sizeBytes: payload.size_bytes,
          durationSeconds: payload.duration_seconds,
          bitrate: payload.bitrate,
          modifiedAt: payload.modified_at,
          sidecarModifiedAt: payload.sidecar_modified_at,
          audioSha256: payload.audio_sha256,
          tagFingerprint: payload.tag_fingerprint,
          embeddedLyricsStatus: payload.embedded_lyrics_status,
          sidecarLyricsStatus: payload.sidecar_lyrics_status,
          missingFieldsJson: JSON.stringify(payload.missing_fields),
          discoveredVia: payload.discovered_via,
          lastScannedAt: payload.last_scanned_at,
          firstSeenAt,
          updatedAt: nowIso(),
        })
        .onConflictDoUpdate({
          target: [libraryFilesTable.rootId, libraryFilesTable.relativePath],
          set: {
            trackId,
            absolutePathSnapshot: payload.absolute_path_snapshot,
            lrcPath: payload.lrc_path,
            format: payload.format,
            sizeBytes: payload.size_bytes,
            durationSeconds: payload.duration_seconds,
            bitrate: payload.bitrate,
            modifiedAt: payload.modified_at,
            sidecarModifiedAt: payload.sidecar_modified_at,
            audioSha256: payload.audio_sha256,
            tagFingerprint: payload.tag_fingerprint,
            embeddedLyricsStatus: payload.embedded_lyrics_status,
            sidecarLyricsStatus: payload.sidecar_lyrics_status,
            missingFieldsJson: JSON.stringify(payload.missing_fields),
            discoveredVia: payload.discovered_via,
            lastScannedAt: payload.last_scanned_at,
            updatedAt: nowIso(),
          },
        })

      await this.upsertTrackFromPayload(
        trackId,
        existingTrack ?? null,
        payload,
        root.kind,
        fileId
      )
      trackByIdentity.set(identityKey, {
        ...(existingTrack ?? {
          id: trackId,
          firstSeenAt: payload.last_scanned_at,
          lastSeenAt: payload.last_scanned_at,
          updatedAt: nowIso(),
        }),
        id: trackId,
      } as typeof libraryTracksTable.$inferSelect)
      affectedTrackIds.add(trackId)
      if (existingFile && existingFile.trackId !== trackId) {
        affectedTrackIds.add(existingFile.trackId)
      }
    }

    const deletedPaths = scan.deleted_relative_paths ?? []
    if (deletedPaths.length > 0) {
      const deletedRows = deletedPaths
        .map((relativePath) => fileByPath.get(relativePath))
        .filter((value): value is typeof libraryFilesTable.$inferSelect =>
          Boolean(value)
        )
      if (deletedRows.length > 0) {
        await this.db.delete(libraryFilesTable).where(
          and(
            eq(libraryFilesTable.rootId, root.id),
            inArray(
              libraryFilesTable.relativePath,
              deletedRows.map((row) => row.relativePath)
            )
          )
        )
        for (const row of deletedRows) {
          affectedTrackIds.add(row.trackId)
        }
      }
    }

    await this.deleteOrphanTracks()
    await this.reassignPreferredFileIds([...affectedTrackIds])
  }

  private async upsertTrackFromPayload(
    trackId: string,
    existingTrack: typeof libraryTracksTable.$inferSelect | null,
    payload: ScannedFilePayload,
    rootKind: RootKind,
    fileId: string
  ) {
    const timestamp = nowIso()
    const preferredFileId =
      rootKind === 'local' ? fileId : (existingTrack?.preferredFileId ?? fileId)
    const firstSeenAt = existingTrack?.firstSeenAt ?? payload.last_scanned_at
    const lastSeenAt =
      existingTrack && existingTrack.lastSeenAt > payload.last_scanned_at
        ? existingTrack.lastSeenAt
        : payload.last_scanned_at

    await this.db
      .insert(libraryTracksTable)
      .values({
        id: trackId,
        identityKind: payload.identity_kind,
        identityValue: payload.identity_value,
        managedByApp: existingTrack?.managedByApp ?? payload.managed_by_app,
        tagSchemaVersion: this.pickNumber(
          existingTrack?.tagSchemaVersion ?? null,
          payload.tag_schema_version
        ),
        youtubeMusicTrackId:
          payload.youtube_music_track_id ??
          existingTrack?.youtubeMusicTrackId ??
          null,
        spotifyTrackId:
          payload.spotify_track_id ?? existingTrack?.spotifyTrackId ?? null,
        soundcloudTrackId:
          payload.soundcloud_track_id ??
          existingTrack?.soundcloudTrackId ??
          null,
        resolvedYoutubeMusicTrackId:
          payload.resolved_youtube_music_track_id ??
          existingTrack?.resolvedYoutubeMusicTrackId ??
          null,
        sourceOrigin:
          payload.source_origin ?? existingTrack?.sourceOrigin ?? null,
        catalogReleaseBrowseId:
          payload.catalog_release_browse_id ??
          existingTrack?.catalogReleaseBrowseId ??
          null,
        catalogReleaseTitle:
          payload.catalog_release_title ??
          existingTrack?.catalogReleaseTitle ??
          null,
        catalogReleaseKind:
          payload.catalog_release_kind ??
          existingTrack?.catalogReleaseKind ??
          null,
        title: payload.title,
        artist: payload.artist,
        album: payload.album,
        albumArtist: payload.album_artist,
        trackNumber: payload.track_number,
        trackTotal: payload.track_total,
        discNumber: payload.disc_number,
        discTotal: payload.disc_total,
        year: payload.year,
        date: payload.date,
        genre: payload.genre,
        language: payload.language,
        isrc: payload.isrc,
        mbTrackId: payload.mb_track_id,
        mbAlbumId: payload.mb_album_id,
        mbReleaseGroupId: payload.mb_releasegroup_id,
        lyricsStatus: existingTrack
          ? this.bestLyricsStatus(
              existingTrack.lyricsStatus as LyricsStatus,
              payload.lyrics_status
            )
          : payload.lyrics_status,
        hasEmbeddedLyrics:
          (existingTrack?.hasEmbeddedLyrics ?? false) ||
          payload.has_embedded_lyrics,
        hasSidecarLyrics:
          (existingTrack?.hasSidecarLyrics ?? false) ||
          payload.has_sidecar_lyrics,
        coverArtPresent:
          (existingTrack?.coverArtPresent ?? false) ||
          payload.cover_art_present,
        missingFieldsJson: JSON.stringify(payload.missing_fields),
        preferredFileId,
        firstSeenAt,
        lastSeenAt,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: libraryTracksTable.id,
        set: {
          identityKind: payload.identity_kind,
          identityValue: payload.identity_value,
          managedByApp: existingTrack?.managedByApp ?? payload.managed_by_app,
          tagSchemaVersion: this.pickNumber(
            existingTrack?.tagSchemaVersion ?? null,
            payload.tag_schema_version
          ),
          youtubeMusicTrackId:
            payload.youtube_music_track_id ??
            existingTrack?.youtubeMusicTrackId ??
            null,
          spotifyTrackId:
            payload.spotify_track_id ?? existingTrack?.spotifyTrackId ?? null,
          soundcloudTrackId:
            payload.soundcloud_track_id ??
            existingTrack?.soundcloudTrackId ??
            null,
          resolvedYoutubeMusicTrackId:
            payload.resolved_youtube_music_track_id ??
            existingTrack?.resolvedYoutubeMusicTrackId ??
            null,
          sourceOrigin:
            payload.source_origin ?? existingTrack?.sourceOrigin ?? null,
          catalogReleaseBrowseId:
            payload.catalog_release_browse_id ??
            existingTrack?.catalogReleaseBrowseId ??
            null,
          catalogReleaseTitle:
            payload.catalog_release_title ??
            existingTrack?.catalogReleaseTitle ??
            null,
          catalogReleaseKind:
            payload.catalog_release_kind ??
            existingTrack?.catalogReleaseKind ??
            null,
          title: payload.title,
          artist: payload.artist,
          album: payload.album,
          albumArtist: payload.album_artist,
          trackNumber: payload.track_number,
          trackTotal: payload.track_total,
          discNumber: payload.disc_number,
          discTotal: payload.disc_total,
          year: payload.year,
          date: payload.date,
          genre: payload.genre,
          language: payload.language,
          isrc: payload.isrc,
          mbTrackId: payload.mb_track_id,
          mbAlbumId: payload.mb_album_id,
          mbReleaseGroupId: payload.mb_releasegroup_id,
          lyricsStatus: existingTrack
            ? this.bestLyricsStatus(
                existingTrack.lyricsStatus as LyricsStatus,
                payload.lyrics_status
              )
            : payload.lyrics_status,
          hasEmbeddedLyrics:
            (existingTrack?.hasEmbeddedLyrics ?? false) ||
            payload.has_embedded_lyrics,
          hasSidecarLyrics:
            (existingTrack?.hasSidecarLyrics ?? false) ||
            payload.has_sidecar_lyrics,
          coverArtPresent:
            (existingTrack?.coverArtPresent ?? false) ||
            payload.cover_art_present,
          missingFieldsJson: JSON.stringify(payload.missing_fields),
          preferredFileId,
          firstSeenAt,
          lastSeenAt,
          updatedAt: timestamp,
        },
      })
  }

  private async loadTrackByIdentity() {
    const tracks = await this.db.select().from(libraryTracksTable)
    return new Map<string, typeof libraryTracksTable.$inferSelect>(
      tracks.map(
        (track) =>
          [`${track.identityKind}:${track.identityValue}`, track] as const
      )
    )
  }

  private async reassignPreferredFileIds(trackIds: string[]) {
    const uniqueTrackIds = [...new Set(trackIds.filter(Boolean))]
    if (uniqueTrackIds.length === 0) return

    const files = await this.db
      .select()
      .from(libraryFilesTable)
      .where(inArray(libraryFilesTable.trackId, uniqueTrackIds))
    if (files.length === 0) return

    const roots = await this.db.select().from(libraryRootsTable)
    const rootById = new Map(roots.map((root) => [root.id, root] as const))
    const filesByTrackId = new Map<string, typeof files>()
    for (const file of files) {
      const list = filesByTrackId.get(file.trackId) ?? []
      list.push(file)
      filesByTrackId.set(file.trackId, list)
    }

    for (const trackId of uniqueTrackIds) {
      const candidates = filesByTrackId.get(trackId) ?? []
      if (candidates.length === 0) continue
      candidates.sort((left, right) => {
        const leftRoot = rootById.get(left.rootId)
        const rightRoot = rootById.get(right.rootId)
        const leftScore =
          (leftRoot?.kind === 'local' ? 100 : 0) +
          (left.absolutePathSnapshot ? 10 : 0)
        const rightScore =
          (rightRoot?.kind === 'local' ? 100 : 0) +
          (right.absolutePathSnapshot ? 10 : 0)
        if (leftScore !== rightScore) return rightScore - leftScore
        return left.relativePath.localeCompare(right.relativePath)
      })
      await this.db
        .update(libraryTracksTable)
        .set({
          preferredFileId: candidates[0]?.id ?? null,
          updatedAt: nowIso(),
        })
        .where(eq(libraryTracksTable.id, trackId))
    }
  }

  private async resolveCurrentLocalRoot(): Promise<RootDescriptor | null> {
    const roots = await this.resolveRoots()
    return roots.find((root) => root.kind === 'local') ?? null
  }

  private async resolveCurrentRemoteRoot(): Promise<RootDescriptor | null> {
    const roots = await this.resolveRoots()
    return roots.find((root) => root.kind === 'remote') ?? null
  }

  private async upsertRoot(root: RootDescriptor) {
    const timestamp = nowIso()
    await this.db
      .insert(libraryRootsTable)
      .values({
        id: root.id,
        kind: root.kind,
        transport: root.transport,
        label: root.label,
        uri: root.uri,
        writable: root.writable,
        managedOutput: root.managedOutput,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastScannedAt: null,
        lastScanStatus: null,
      })
      .onConflictDoUpdate({
        target: libraryRootsTable.id,
        set: {
          kind: root.kind,
          transport: root.transport,
          label: root.label,
          uri: root.uri,
          writable: root.writable,
          managedOutput: root.managedOutput,
          updatedAt: timestamp,
        },
      })
  }

  private async getRootRowByUri(uri: string) {
    const roots = await this.db.select().from(libraryRootsTable)
    return roots.find((root) => root.uri === uri) ?? null
  }

  private async readMetaValue(key: string): Promise<string | null> {
    const row = await this.db.query.metaTable.findFirst({
      where: eq(metaTable.key, key),
    })
    return row?.value ?? null
  }

  private async writeMetaValue(key: string, value: string) {
    await this.db.insert(metaTable).values({ key, value }).onConflictDoUpdate({
      target: metaTable.key,
      set: { value },
    })
  }

  private async readIndexVersion(): Promise<number | null> {
    const value = await this.readMetaValue('library_index_version')
    if (!value) return null
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }

  private async persistLocalIndexMeta(rootUri: string) {
    await Promise.all([
      this.writeMetaValue(
        'library_index_version',
        String(LIBRARY_INDEX_VERSION)
      ),
      this.writeMetaValue('library_index_local_root_uri', rootUri),
    ])
  }

  private async markRootScanFailure(rootId: string, error: unknown) {
    await this.db
      .update(libraryRootsTable)
      .set({
        updatedAt: nowIso(),
        lastScannedAt: nowIso(),
        lastScanStatus:
          error instanceof Error ? `error:${error.message}` : 'error',
      })
      .where(eq(libraryRootsTable.id, rootId))
  }

  private emitIndexStatusChanged() {
    for (const listener of this.indexStatusListeners) {
      listener()
    }
  }

  private isPathInsideRoot(rootUri: string, candidatePath: string) {
    const relative = path.relative(rootUri, candidatePath)
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative)
    )
  }

  private toRelativePath(
    rootUri: string,
    candidatePath: string
  ): string | null {
    const relativePath = path.relative(rootUri, candidatePath)
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      return null
    }
    return relativePath.split(path.sep).join('/')
  }

  private async resolveRoots(): Promise<RootDescriptor[]> {
    const settings = await this.settingsService.getRuntimeSettings()
    const roots: RootDescriptor[] = []

    if (settings.outputDirectory.trim()) {
      const uri = settings.outputDirectory.trim()
      roots.push({
        id: `root_local_${uri}`,
        kind: 'local',
        transport: 'filesystem',
        label: 'Local output',
        uri,
        writable: true,
        managedOutput: true,
      })
    }

    if (
      settings.remoteCopyEnabled &&
      settings.rcloneRemote.trim() &&
      settings.remoteMusicRoot.trim()
    ) {
      const uri = `${settings.rcloneRemote.trim()}:${settings.remoteMusicRoot.trim()}`
      roots.push({
        id: `root_remote_${uri}`,
        kind: 'remote',
        transport: 'rclone',
        label: 'Remote library',
        uri,
        writable: true,
        managedOutput: true,
      })
    }

    return roots
  }

  private async persistRootScan(
    root: RootDescriptor,
    scan: RootScanResult,
    trackByIdentity: Map<string, typeof libraryTracksTable.$inferSelect>,
    aggregateByTrackId: Map<string, TrackAggregate>
  ) {
    const timestamp = nowIso()
    const existingFiles = await this.db
      .select()
      .from(libraryFilesTable)
      .where(eq(libraryFilesTable.rootId, root.id))
    const fileByPath = new Map(
      existingFiles.map((file) => [file.relativePath, file])
    )
    const seenPaths = new Set<string>()

    for (const payload of scan.files) {
      seenPaths.add(payload.relative_path)
      const identityKey = `${payload.identity_kind}:${payload.identity_value}`
      let track = trackByIdentity.get(identityKey)
      if (!track) {
        track = {
          id: createId('track'),
          identityKind: payload.identity_kind,
          identityValue: payload.identity_value,
          managedByApp: payload.managed_by_app,
          tagSchemaVersion: payload.tag_schema_version,
          youtubeMusicTrackId: payload.youtube_music_track_id,
          spotifyTrackId: payload.spotify_track_id,
          soundcloudTrackId: payload.soundcloud_track_id,
          resolvedYoutubeMusicTrackId: payload.resolved_youtube_music_track_id,
          sourceOrigin: payload.source_origin,
          catalogReleaseBrowseId: payload.catalog_release_browse_id,
          catalogReleaseTitle: payload.catalog_release_title,
          catalogReleaseKind: payload.catalog_release_kind,
          title: payload.title,
          artist: payload.artist,
          album: payload.album,
          albumArtist: payload.album_artist,
          trackNumber: payload.track_number,
          trackTotal: payload.track_total,
          discNumber: payload.disc_number,
          discTotal: payload.disc_total,
          year: payload.year,
          date: payload.date,
          genre: payload.genre,
          language: payload.language,
          isrc: payload.isrc,
          mbTrackId: payload.mb_track_id,
          mbAlbumId: payload.mb_album_id,
          mbReleaseGroupId: payload.mb_releasegroup_id,
          lyricsStatus: payload.lyrics_status,
          hasEmbeddedLyrics: payload.has_embedded_lyrics,
          hasSidecarLyrics: payload.has_sidecar_lyrics,
          coverArtPresent: payload.cover_art_present,
          missingFieldsJson: JSON.stringify(payload.missing_fields),
          preferredFileId: null,
          firstSeenAt: payload.last_scanned_at,
          lastSeenAt: payload.last_scanned_at,
          updatedAt: timestamp,
        }
        trackByIdentity.set(identityKey, track)
      }

      const existingFile = fileByPath.get(payload.relative_path)
      const fileId = existingFile?.id ?? createId('file')
      const firstSeenAt = existingFile?.firstSeenAt ?? payload.last_scanned_at

      await this.db
        .insert(libraryFilesTable)
        .values({
          id: fileId,
          trackId: track.id,
          rootId: root.id,
          relativePath: payload.relative_path,
          absolutePathSnapshot: payload.absolute_path_snapshot,
          lrcPath: payload.lrc_path,
          format: payload.format,
          sizeBytes: payload.size_bytes,
          durationSeconds: payload.duration_seconds,
          bitrate: payload.bitrate,
          modifiedAt: payload.modified_at,
          sidecarModifiedAt: payload.sidecar_modified_at,
          audioSha256: payload.audio_sha256,
          tagFingerprint: payload.tag_fingerprint,
          embeddedLyricsStatus: payload.embedded_lyrics_status,
          sidecarLyricsStatus: payload.sidecar_lyrics_status,
          missingFieldsJson: JSON.stringify(payload.missing_fields),
          discoveredVia: payload.discovered_via,
          lastScannedAt: payload.last_scanned_at,
          firstSeenAt,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: [libraryFilesTable.rootId, libraryFilesTable.relativePath],
          set: {
            trackId: track.id,
            absolutePathSnapshot: payload.absolute_path_snapshot,
            lrcPath: payload.lrc_path,
            format: payload.format,
            sizeBytes: payload.size_bytes,
            durationSeconds: payload.duration_seconds,
            bitrate: payload.bitrate,
            modifiedAt: payload.modified_at,
            sidecarModifiedAt: payload.sidecar_modified_at,
            audioSha256: payload.audio_sha256,
            tagFingerprint: payload.tag_fingerprint,
            embeddedLyricsStatus: payload.embedded_lyrics_status,
            sidecarLyricsStatus: payload.sidecar_lyrics_status,
            missingFieldsJson: JSON.stringify(payload.missing_fields),
            discoveredVia: payload.discovered_via,
            lastScannedAt: payload.last_scanned_at,
            updatedAt: timestamp,
          },
        })

      this.mergeAggregate(
        aggregateByTrackId,
        track.id,
        payload,
        root.kind,
        fileId,
        firstSeenAt
      )
    }

    const stalePaths = existingFiles
      .filter((file) => !seenPaths.has(file.relativePath))
      .map((file) => file.relativePath)

    if (stalePaths.length > 0) {
      await this.db
        .delete(libraryFilesTable)
        .where(
          and(
            eq(libraryFilesTable.rootId, root.id),
            inArray(libraryFilesTable.relativePath, stalePaths)
          )
        )
    }
  }

  private mergeAggregate(
    aggregateByTrackId: Map<string, TrackAggregate>,
    trackId: string,
    payload: ScannedFilePayload,
    rootKind: RootKind,
    fileId: string,
    firstSeenAt: string
  ) {
    const rank =
      (payload.managed_by_app ? 100 : 0) +
      (rootKind === 'local' ? 10 : 0) +
      (payload.cover_art_present ? 2 : 0) +
      (payload.lyrics_status === 'synced'
        ? 2
        : payload.lyrics_status === 'plain'
          ? 1
          : 0)
    const aggregate = aggregateByTrackId.get(trackId) ?? {
      id: trackId,
      identityKind: payload.identity_kind,
      identityValue: payload.identity_value,
      firstSeenAt,
      lastSeenAt: payload.last_scanned_at,
      managedByApp: payload.managed_by_app,
      tagSchemaVersion: payload.tag_schema_version,
      youtubeMusicTrackId: payload.youtube_music_track_id,
      spotifyTrackId: payload.spotify_track_id,
      soundcloudTrackId: payload.soundcloud_track_id,
      resolvedYoutubeMusicTrackId: payload.resolved_youtube_music_track_id,
      sourceOrigin: payload.source_origin,
      catalogReleaseBrowseId: payload.catalog_release_browse_id,
      catalogReleaseTitle: payload.catalog_release_title,
      catalogReleaseKind: payload.catalog_release_kind,
      title: payload.title,
      artist: payload.artist,
      album: payload.album,
      albumArtist: payload.album_artist,
      trackNumber: payload.track_number,
      trackTotal: payload.track_total,
      discNumber: payload.disc_number,
      discTotal: payload.disc_total,
      year: payload.year,
      date: payload.date,
      genre: payload.genre,
      language: payload.language,
      isrc: payload.isrc,
      mbTrackId: payload.mb_track_id,
      mbAlbumId: payload.mb_album_id,
      mbReleaseGroupId: payload.mb_releasegroup_id,
      lyricsStatus: payload.lyrics_status,
      hasEmbeddedLyrics: payload.has_embedded_lyrics,
      hasSidecarLyrics: payload.has_sidecar_lyrics,
      coverArtPresent: payload.cover_art_present,
      preferredFileId: fileId,
      preferredFileRank: rank,
    }

    aggregate.firstSeenAt =
      firstSeenAt < aggregate.firstSeenAt ? firstSeenAt : aggregate.firstSeenAt
    aggregate.lastSeenAt =
      payload.last_scanned_at > aggregate.lastSeenAt
        ? payload.last_scanned_at
        : aggregate.lastSeenAt
    aggregate.managedByApp ||= payload.managed_by_app
    aggregate.tagSchemaVersion = this.pickNumber(
      aggregate.tagSchemaVersion,
      payload.tag_schema_version
    )
    aggregate.youtubeMusicTrackId ||= payload.youtube_music_track_id
    aggregate.spotifyTrackId ||= payload.spotify_track_id
    aggregate.soundcloudTrackId ||= payload.soundcloud_track_id
    aggregate.resolvedYoutubeMusicTrackId ||=
      payload.resolved_youtube_music_track_id
    aggregate.sourceOrigin ||= payload.source_origin
    aggregate.catalogReleaseBrowseId ||= payload.catalog_release_browse_id
    aggregate.catalogReleaseTitle ||= payload.catalog_release_title
    aggregate.catalogReleaseKind ||= payload.catalog_release_kind
    aggregate.hasEmbeddedLyrics ||= payload.has_embedded_lyrics
    aggregate.hasSidecarLyrics ||= payload.has_sidecar_lyrics
    aggregate.coverArtPresent ||= payload.cover_art_present
    aggregate.lyricsStatus = this.bestLyricsStatus(
      aggregate.lyricsStatus,
      payload.lyrics_status
    )

    if (rank > aggregate.preferredFileRank) {
      aggregate.title = payload.title
      aggregate.artist = payload.artist
      aggregate.album = payload.album
      aggregate.albumArtist = payload.album_artist
      aggregate.sourceOrigin = payload.source_origin
      aggregate.catalogReleaseBrowseId = payload.catalog_release_browse_id
      aggregate.catalogReleaseTitle = payload.catalog_release_title
      aggregate.catalogReleaseKind = payload.catalog_release_kind
      aggregate.trackNumber = payload.track_number
      aggregate.trackTotal = payload.track_total
      aggregate.discNumber = payload.disc_number
      aggregate.discTotal = payload.disc_total
      aggregate.year = payload.year
      aggregate.date = payload.date
      aggregate.genre = payload.genre
      aggregate.language = payload.language
      aggregate.isrc = payload.isrc
      aggregate.mbTrackId = payload.mb_track_id
      aggregate.mbAlbumId = payload.mb_album_id
      aggregate.mbReleaseGroupId = payload.mb_releasegroup_id
      aggregate.preferredFileId = fileId
      aggregate.preferredFileRank = rank
    }

    aggregateByTrackId.set(trackId, aggregate)
  }

  private async rebuildTrackAggregates(
    aggregateByTrackId: Map<string, TrackAggregate>
  ) {
    const timestamp = nowIso()
    for (const aggregate of aggregateByTrackId.values()) {
      const missingFields = this.computeTrackMissingFields(aggregate)
      await this.db
        .insert(libraryTracksTable)
        .values({
          id: aggregate.id,
          identityKind: aggregate.identityKind,
          identityValue: aggregate.identityValue,
          managedByApp: aggregate.managedByApp,
          tagSchemaVersion: aggregate.tagSchemaVersion,
          youtubeMusicTrackId: aggregate.youtubeMusicTrackId,
          spotifyTrackId: aggregate.spotifyTrackId,
          soundcloudTrackId: aggregate.soundcloudTrackId,
          resolvedYoutubeMusicTrackId: aggregate.resolvedYoutubeMusicTrackId,
          sourceOrigin: aggregate.sourceOrigin,
          catalogReleaseBrowseId: aggregate.catalogReleaseBrowseId,
          catalogReleaseTitle: aggregate.catalogReleaseTitle,
          catalogReleaseKind: aggregate.catalogReleaseKind,
          title: aggregate.title,
          artist: aggregate.artist,
          album: aggregate.album,
          albumArtist: aggregate.albumArtist,
          trackNumber: aggregate.trackNumber,
          trackTotal: aggregate.trackTotal,
          discNumber: aggregate.discNumber,
          discTotal: aggregate.discTotal,
          year: aggregate.year,
          date: aggregate.date,
          genre: aggregate.genre,
          language: aggregate.language,
          isrc: aggregate.isrc,
          mbTrackId: aggregate.mbTrackId,
          mbAlbumId: aggregate.mbAlbumId,
          mbReleaseGroupId: aggregate.mbReleaseGroupId,
          lyricsStatus: aggregate.lyricsStatus,
          hasEmbeddedLyrics: aggregate.hasEmbeddedLyrics,
          hasSidecarLyrics: aggregate.hasSidecarLyrics,
          coverArtPresent: aggregate.coverArtPresent,
          missingFieldsJson: JSON.stringify(missingFields),
          preferredFileId: aggregate.preferredFileId,
          firstSeenAt: aggregate.firstSeenAt,
          lastSeenAt: aggregate.lastSeenAt,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: libraryTracksTable.id,
          set: {
            identityKind: aggregate.identityKind,
            identityValue: aggregate.identityValue,
            managedByApp: aggregate.managedByApp,
            tagSchemaVersion: aggregate.tagSchemaVersion,
            youtubeMusicTrackId: aggregate.youtubeMusicTrackId,
            spotifyTrackId: aggregate.spotifyTrackId,
            soundcloudTrackId: aggregate.soundcloudTrackId,
            resolvedYoutubeMusicTrackId: aggregate.resolvedYoutubeMusicTrackId,
            sourceOrigin: aggregate.sourceOrigin,
            catalogReleaseBrowseId: aggregate.catalogReleaseBrowseId,
            catalogReleaseTitle: aggregate.catalogReleaseTitle,
            catalogReleaseKind: aggregate.catalogReleaseKind,
            title: aggregate.title,
            artist: aggregate.artist,
            album: aggregate.album,
            albumArtist: aggregate.albumArtist,
            trackNumber: aggregate.trackNumber,
            trackTotal: aggregate.trackTotal,
            discNumber: aggregate.discNumber,
            discTotal: aggregate.discTotal,
            year: aggregate.year,
            date: aggregate.date,
            genre: aggregate.genre,
            language: aggregate.language,
            isrc: aggregate.isrc,
            mbTrackId: aggregate.mbTrackId,
            mbAlbumId: aggregate.mbAlbumId,
            mbReleaseGroupId: aggregate.mbReleaseGroupId,
            lyricsStatus: aggregate.lyricsStatus,
            hasEmbeddedLyrics: aggregate.hasEmbeddedLyrics,
            hasSidecarLyrics: aggregate.hasSidecarLyrics,
            coverArtPresent: aggregate.coverArtPresent,
            missingFieldsJson: JSON.stringify(missingFields),
            preferredFileId: aggregate.preferredFileId,
            firstSeenAt: aggregate.firstSeenAt,
            lastSeenAt: aggregate.lastSeenAt,
            updatedAt: timestamp,
          },
        })
    }
  }

  private async deleteOrphanTracks() {
    const tracks = await this.db.select().from(libraryTracksTable)
    const files = await this.db.select().from(libraryFilesTable)
    const trackIdsWithFiles = new Set(files.map((file) => file.trackId))

    for (const track of tracks) {
      if (trackIdsWithFiles.has(track.id)) continue
      await this.db
        .delete(libraryTracksTable)
        .where(eq(libraryTracksTable.id, track.id))
    }
  }

  private matchesTrackFilter(
    track: typeof libraryTracksTable.$inferSelect,
    filter: LibraryTrackFilter
  ) {
    if (
      filter.managedByApp !== undefined &&
      track.managedByApp !== filter.managedByApp
    ) {
      return false
    }
    if (filter.identityKind && track.identityKind !== filter.identityKind) {
      return false
    }
    if (filter.lyricsStatus && track.lyricsStatus !== filter.lyricsStatus) {
      return false
    }
    return true
  }

  private toTrackView(
    track: typeof libraryTracksTable.$inferSelect,
    files: (typeof libraryFilesTable.$inferSelect)[] = [],
    rootById = new Map<string, typeof libraryRootsTable.$inferSelect>()
  ): LibraryTrackView {
    const hasLocalFile = files.some(
      (file) => rootById.get(file.rootId)?.kind === 'local'
    )
    const hasRemoteFile = files.some(
      (file) => rootById.get(file.rootId)?.kind === 'remote'
    )

    return {
      id: track.id,
      identityKind: track.identityKind as LibraryTrackView['identityKind'],
      identityValue: track.identityValue,
      managedByApp: track.managedByApp,
      tagSchemaVersion: track.tagSchemaVersion,
      youtubeMusicTrackId: track.youtubeMusicTrackId,
      spotifyTrackId: track.spotifyTrackId,
      soundcloudTrackId: track.soundcloudTrackId,
      resolvedYoutubeMusicTrackId: track.resolvedYoutubeMusicTrackId,
      sourceOrigin: track.sourceOrigin,
      catalogReleaseBrowseId: track.catalogReleaseBrowseId,
      catalogReleaseTitle: track.catalogReleaseTitle,
      catalogReleaseKind: track.catalogReleaseKind,
      title: track.title,
      artist: track.artist,
      album: track.album,
      albumArtist: track.albumArtist,
      trackNumber: track.trackNumber,
      trackTotal: track.trackTotal,
      discNumber: track.discNumber,
      discTotal: track.discTotal,
      year: track.year,
      date: track.date,
      genre: track.genre,
      language: track.language,
      isrc: track.isrc,
      mbTrackId: track.mbTrackId,
      mbAlbumId: track.mbAlbumId,
      mbReleaseGroupId: track.mbReleaseGroupId,
      lyricsStatus: track.lyricsStatus as LyricsStatus,
      hasEmbeddedLyrics: track.hasEmbeddedLyrics,
      hasSidecarLyrics: track.hasSidecarLyrics,
      coverArtPresent: track.coverArtPresent,
      hasLocalFile,
      hasRemoteFile,
      missingFields: this.parseJsonArray(track.missingFieldsJson),
      preferredFileId: track.preferredFileId,
      firstSeenAt: track.firstSeenAt,
      lastSeenAt: track.lastSeenAt,
      updatedAt: track.updatedAt,
    }
  }

  private toFileView(
    file: typeof libraryFilesTable.$inferSelect
  ): LibraryFileView {
    return {
      id: file.id,
      trackId: file.trackId,
      rootId: file.rootId,
      relativePath: file.relativePath,
      absolutePathSnapshot: file.absolutePathSnapshot,
      lrcPath: file.lrcPath,
      format: file.format,
      sizeBytes: file.sizeBytes,
      durationSeconds: file.durationSeconds,
      bitrate: file.bitrate,
      modifiedAt: file.modifiedAt,
      sidecarModifiedAt: file.sidecarModifiedAt,
      audioSha256: file.audioSha256,
      tagFingerprint: file.tagFingerprint,
      embeddedLyricsStatus: file.embeddedLyricsStatus as LyricsStatus,
      sidecarLyricsStatus: file.sidecarLyricsStatus as LyricsStatus,
      missingFields: this.parseJsonArray(file.missingFieldsJson),
      discoveredVia: file.discoveredVia as LibraryFileView['discoveredVia'],
      lastScannedAt: file.lastScannedAt,
      firstSeenAt: file.firstSeenAt,
      updatedAt: file.updatedAt,
    }
  }

  private parseJsonArray(value: string): string[] {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed)
        ? parsed.filter((item) => typeof item === 'string')
        : []
    } catch {
      return []
    }
  }

  private bestLyricsStatus(
    left: LyricsStatus,
    right: LyricsStatus
  ): LyricsStatus {
    if (left === 'synced' || right === 'synced') return 'synced'
    if (left === 'plain' || right === 'plain') return 'plain'
    return 'missing'
  }

  private computeTrackMissingFields(aggregate: TrackAggregate): string[] {
    const missing: string[] = []
    for (const [field, value] of [
      ['title', aggregate.title],
      ['artist', aggregate.artist],
      ['album', aggregate.album],
      ['album_artist', aggregate.albumArtist],
      ['track_number', aggregate.trackNumber],
      ['track_total', aggregate.trackTotal],
      ['disc_number', aggregate.discNumber],
      ['disc_total', aggregate.discTotal],
      ['year', aggregate.year],
      ['genre', aggregate.genre],
      ['isrc', aggregate.isrc],
    ] as const) {
      if (value == null || value === '' || value === 0) {
        missing.push(field)
      }
    }
    if (
      (aggregate.lyricsStatus === 'plain' ||
        aggregate.lyricsStatus === 'synced') &&
      (aggregate.language == null || aggregate.language === '')
    ) {
      missing.push('language')
    }
    if (!aggregate.coverArtPresent) missing.push('cover_art')
    if (aggregate.lyricsStatus === 'missing') missing.push('lyrics')
    return missing
  }

  private pickNumber(left: number | null, right: number | null): number | null {
    if (right == null) return left
    if (left == null) return right
    return Math.max(left, right)
  }
}
