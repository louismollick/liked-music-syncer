import type {
  CommandResult,
  DriftSummary,
  LibraryFileView,
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
} from '../db/schema'
import type { PythonWorkerService } from './python-worker'
import type { SettingsService } from './settings-service'
import { createId, nowIso } from './utils'

type RootKind = 'local' | 'remote'
type RootTransport = 'filesystem' | 'rclone'
type DiscoveredVia = 'lms_tags' | 'mb_track' | 'isrc' | 'heuristic' | 'path'

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
  constructor(
    private readonly db: AppDatabase,
    private readonly settingsService: SettingsService,
    private readonly pythonWorker: PythonWorkerService
  ) {}

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
    const tracks = await this.db
      .select()
      .from(libraryTracksTable)
      .orderBy(
        asc(libraryTracksTable.artist),
        asc(libraryTracksTable.album),
        asc(libraryTracksTable.trackNumber)
      )

    if (!filter.rootKind && !filter.missingField) {
      return tracks
        .filter((track) => this.matchesTrackFilter(track, filter))
        .map((track) => this.toTrackView(track))
    }

    const files = await this.db.select().from(libraryFilesTable)
    const roots = await this.db.select().from(libraryRootsTable)
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
      .map((track) => this.toTrackView(track))
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

    return {
      ...this.toTrackView(track),
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
    track: typeof libraryTracksTable.$inferSelect
  ): LibraryTrackView {
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
