import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, appendFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  CommandResult,
  LikedArtistView,
  LogLevel,
  RemoteMissingPreviewResult,
  RemoteMissingTrackPreview,
  SongLogEntry,
  SyncItemStatus,
  SyncRunDetail,
  SyncRunItemView,
  SyncRunSummary,
  SyncSnapshot,
  SyncStage,
  SyncTriggerMode,
} from '@shared/contracts'
import { and, asc, desc, eq } from 'drizzle-orm'
import { app } from 'electron'
import { execa } from 'execa'
import type { AppDatabase } from '../db/database'
import {
  artifactsTable,
  libraryFilesTable,
  libraryRootsTable,
  libraryTracksTable,
  songLogsTable,
  syncRunItemsTable,
  syncRunsTable,
} from '../db/schema'
import type { LibraryService } from './library-service'
import type { LikedArtistsService } from './liked-artists-service'
import type { PoTokenService } from './po-token-service'
import type { PythonWorkerService } from './python-worker'
import type { SettingsService } from './settings-service'
import { createId, nowIso } from './utils'

type SyncListener = (snapshot: SyncSnapshot) => void
const RUN_LOG_ITEM_ID = '__run__'
const RUN_LOG_SOURCE_VIDEO_ID = '__run__'

interface WorkerRunEvent {
  type: 'run'
  event: 'started' | 'progress' | 'completed' | 'failed'
  run_id: string
  total_count?: number
  processed_count?: number
  stage?: SyncStage
  message?: string
  context?: Record<string, unknown>
}

interface WorkerItemPayload {
  id: string
  youtube_music_track_id: string
  spotify_track_id?: string | null
  soundcloud_track_id?: string | null
  resolved_youtube_music_track_id?: string | null
  title: string
  artist: string
  album: string
  album_artist: string
  source_url: string
  cover_art_url?: string | null
  status: SyncItemStatus
  stage: SyncStage
  reason_code?: string
  reason_detail?: string
  source_kind?: string
  video_type?: string | null
  resolution_method?: string
  track_number?: number | null
  track_total?: number | null
  disc_number?: number | null
  disc_total?: number | null
  year?: number | null
  date?: string | null
  genre?: string | null
  language?: string | null
  isrc?: string | null
  mb_track_id?: string | null
  mb_album_id?: string | null
  mb_releasegroup_id?: string | null
  lyrics_status?: SyncRunItemView['lyricsStatus']
  audio_codec?: string | null
  metadata_matched?: boolean
  musicbrainz_matched?: boolean
  lyrics_matched?: boolean
  lyrics_source?: string | null
  selected_source_url?: string | null
  output_path?: string | null
  lrc_path?: string | null
}

interface WorkerItemEvent {
  type: 'item'
  event: 'upsert'
  run_id: string
  item: WorkerItemPayload
}

interface WorkerLogEvent {
  type: 'log'
  run_id: string
  item_id: string
  youtube_music_track_id: string
  timestamp: string
  level: LogLevel
  stage: SyncStage
  event: string
  message: string
  context?: Record<string, unknown>
}

type WorkerEvent = WorkerRunEvent | WorkerItemEvent | WorkerLogEvent

interface WorkerAuthStatusResponse {
  ok: boolean
  is_authenticated: boolean
  message: string
  credential_json?: string
}

interface RunStartOptions {
  mode: SyncTriggerMode
  artistChannelIds?: string[]
  artistNamesNormalized?: string[]
  forceReprocess?: boolean
}

interface ManagedFileRow {
  trackId: string
  artist: string | null
  rootKind: string
  rootUri: string
  absolutePathSnapshot: string | null
  relativePath: string
}

interface RemoteMissingState {
  tracks: RemoteMissingTrackPreview[]
  remoteIdentityIds: Set<string>
  tracksById: Map<string, typeof libraryTracksTable.$inferSelect>
  filesByTrackId: Map<string, (typeof libraryFilesTable.$inferSelect)[]>
  localRoot: typeof libraryRootsTable.$inferSelect
  remoteRoot: typeof libraryRootsTable.$inferSelect
}

type RemoteMissingStateResult =
  | ({ ok: true } & RemoteMissingState)
  | ({ ok: false } & CommandResult)

interface CoverThumbnailResult {
  cover_thumbnail_data_url: string | null
}

export class SyncService {
  private readonly listeners = new Set<SyncListener>()
  private readonly logsDirectory = path.join(app.getPath('userData'), 'logs')
  private activeRunId: string | null = null
  private activeProcess: ChildProcessWithoutNullStreams | null = null
  private cancelKillTimer: NodeJS.Timeout | null = null
  private cancelRequestedRunId: string | null = null
  private readonly runSelectedArtists = new Map<string, LikedArtistView[]>()
  private readonly runPreexistingManagedFiles = new Map<
    string,
    ManagedFileRow[]
  >()

  constructor(
    private readonly db: AppDatabase,
    private readonly settingsService: SettingsService,
    private readonly pythonWorker: PythonWorkerService,
    private readonly libraryService: LibraryService,
    private readonly likedArtistsService: LikedArtistsService,
    private readonly poTokenService: PoTokenService,
    private readonly getBundledFfmpegPath: () => string
  ) {}

  subscribe(listener: SyncListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(input?: { mode?: SyncTriggerMode }): Promise<CommandResult> {
    return this.startRun({ mode: input?.mode ?? 'manual' })
  }

  async reprocessArtists(artistIds: string[]): Promise<CommandResult> {
    const uniqueIds = [...new Set(artistIds.filter(Boolean))]
    if (uniqueIds.length === 0) {
      return { ok: false, message: 'Select at least one artist.' }
    }
    const selectedArtists =
      await this.likedArtistsService.listArtistsByIds(uniqueIds)
    if (selectedArtists.length !== uniqueIds.length) {
      return {
        ok: false,
        message: 'Some selected artists are missing. Refresh artists first.',
      }
    }
    const artistChannelIds = selectedArtists
      .map((artist) => artist.channelId)
      .filter((value): value is string => Boolean(value))
    const artistNamesNormalized = selectedArtists.map(
      (artist) => artist.normalizedName
    )
    return this.startRun(
      {
        mode: 'artist_reprocess',
        artistChannelIds,
        artistNamesNormalized,
        forceReprocess: true,
      },
      selectedArtists
    )
  }

  private async startRun(
    options: RunStartOptions,
    selectedArtists: LikedArtistView[] = []
  ): Promise<CommandResult> {
    if (this.activeRunId || this.activeProcess) {
      return { ok: false, message: 'A sync run is already active.' }
    }

    const settings = await this.settingsService.getRuntimeSettings()
    if (!settings.outputDirectory) {
      return {
        ok: false,
        message: 'Output directory must be configured first.',
      }
    }

    if (!settings.ytmusicBrowserAuth) {
      return {
        ok: false,
        message: 'Pull YT Music auth from your browser first.',
      }
    }

    const authResult =
      await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
        'auth-status',
        {
          browser_auth_input: settings.ytmusicBrowserAuth,
        }
      )

    if (!authResult.ok || !authResult.is_authenticated) {
      return {
        ok: false,
        message: authResult.message || 'YT Music auth check failed.',
      }
    }

    try {
      await this.poTokenService.ensureReady()
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }

    const poTokenBundle = this.poTokenService.getBundleStatus()
    const scanResult = await this.libraryService.scanRoots({
      includeRemote: false,
    })
    if (!scanResult.ok) {
      return scanResult
    }
    const existingLocalIds =
      await this.libraryService.getManagedLocalYoutubeIds()
    const browserAuthInput =
      authResult.credential_json ?? settings.ytmusicBrowserAuth

    if (authResult.credential_json) {
      await this.settingsService.saveYtMusicBrowserAuth(
        authResult.credential_json
      )
    }

    const runId = createId('run')
    const runDirectory = path.join(this.logsDirectory, runId)
    await mkdir(runDirectory, { recursive: true })

    await this.db.insert(syncRunsTable).values({
      id: runId,
      triggerMode: options.mode,
      status: 'running',
      startedAt: nowIso(),
      endedAt: null,
      logDirectory: runDirectory,
      plannedCount: 0,
    })

    const child = this.pythonWorker.spawnNdjsonCommand('sync-run', {
      run_id: runId,
      output_directory: settings.outputDirectory,
      dry_run: settings.dryRun,
      remote_copy_enabled: settings.remoteCopyEnabled,
      rclone_remote: settings.rcloneRemote,
      remote_music_root: settings.remoteMusicRoot,
      ytmusic_browser_auth: browserAuthInput,
      yt_dlp_cookies_browser: settings.ytDlpCookiesBrowser,
      folder_template: settings.folderTemplate,
      file_template: settings.fileTemplate,
      embed_unsynced_lyrics: settings.embedUnsyncedLyrics,
      write_lrc_sidecar: settings.writeLrcSidecar,
      existing_local_youtube_music_track_ids: [...existingLocalIds.sourceIds],
      existing_local_resolved_youtube_music_track_ids: [
        ...existingLocalIds.resolvedIds,
      ],
      artist_filter_channel_ids: [...(options.artistChannelIds ?? [])],
      artist_filter_names_normalized: [
        ...(options.artistNamesNormalized ?? []),
      ],
      force_reprocess: Boolean(options.forceReprocess),
      ffmpeg_path: this.getBundledFfmpegPath(),
      yt_dlp_plugin_dir: poTokenBundle.pluginDirectory,
      yt_dlp_po_token_base_url: poTokenBundle.baseUrl,
    })

    this.activeRunId = runId
    this.activeProcess = child
    if (selectedArtists.length > 0) {
      this.runSelectedArtists.set(runId, selectedArtists)
      this.runPreexistingManagedFiles.set(
        runId,
        await this.getManagedFilesForArtists(selectedArtists)
      )
    }

    const ndjsonPath = path.join(runDirectory, 'worker.ndjson')
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let finalized = false

    const finalize = async (
      status: 'completed' | 'failed' | 'cancelled',
      details?: {
        code?: number | null
        signal?: NodeJS.Signals | null
        errorMessage?: string
      }
    ) => {
      if (finalized) return
      finalized = true
      if (this.cancelKillTimer) {
        clearTimeout(this.cancelKillTimer)
        this.cancelKillTimer = null
      }
      this.cancelRequestedRunId = null
      this.activeRunId = null
      this.activeProcess = null
      if (status === 'completed') {
        await this.cleanupArtistReprocessFiles(runId)
      }
      await this.updateRun(runId, {
        status,
        endedAt: nowIso(),
      })
      this.runSelectedArtists.delete(runId)
      this.runPreexistingManagedFiles.delete(runId)

      if (status !== 'completed') {
        const stderrText = stderrBuffer.trim()
        const message =
          details?.errorMessage ??
          stderrText.split('\n').filter(Boolean).at(-1) ??
          `Worker exited with status ${status}.`

        await this.insertRunLog(
          runId,
          status === 'cancelled' ? 'warn' : 'error',
          'finalize',
          status === 'cancelled' ? 'worker-cancelled' : 'worker-exit',
          message,
          {
            exit_code: details?.code ?? null,
            signal: details?.signal ?? null,
            stderr: stderrText || null,
            stderr_path: path.join(runDirectory, 'worker.stderr.log'),
            ndjson_path: ndjsonPath,
          }
        )
      }
      await this.emitSnapshot()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      void appendFile(ndjsonPath, chunk, 'utf8')

      let nextNewline = stdoutBuffer.indexOf('\n')
      while (nextNewline >= 0) {
        const line = stdoutBuffer.slice(0, nextNewline).trim()
        stdoutBuffer = stdoutBuffer.slice(nextNewline + 1)
        if (line.startsWith('{')) {
          void this.handleWorkerEvent(runId, line)
        }
        nextNewline = stdoutBuffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      void appendFile(
        path.join(runDirectory, 'worker.stderr.log'),
        chunk,
        'utf8'
      )
    })

    child.on('exit', (code, signal) => {
      const status =
        this.cancelRequestedRunId === runId
          ? 'cancelled'
          : code === 0
            ? 'completed'
            : signal === 'SIGTERM'
              ? 'cancelled'
              : 'failed'
      void finalize(status, {
        code,
        signal,
      })
    })
    child.on('error', (error) => {
      void finalize('failed', { errorMessage: error.message })
    })

    await this.emitSnapshot()
    return {
      ok: true,
      message:
        options.mode === 'artist_reprocess'
          ? 'Artist reprocess started.'
          : 'Sync started.',
    }
  }

  async cancel(runId: string): Promise<CommandResult> {
    if (this.activeRunId !== runId || !this.activeProcess) {
      return { ok: false, message: 'That run is not active.' }
    }

    const child = this.activeProcess
    const killed = this.killActiveRun('SIGTERM')
    if (!killed) {
      return { ok: false, message: 'Unable to stop the active run.' }
    }

    if (this.cancelKillTimer) {
      clearTimeout(this.cancelKillTimer)
    }
    this.cancelRequestedRunId = runId
    this.activeRunId = null
    this.cancelKillTimer = setTimeout(() => {
      if (this.activeProcess === child) {
        this.killActiveRun('SIGKILL')
      }
    }, 5_000)

    await this.updateRun(runId, {
      status: 'cancelled',
      endedAt: nowIso(),
    })

    await this.insertRunLog(
      runId,
      'warn',
      'finalize',
      'cancel-requested',
      'Cancellation requested.'
    )
    await this.emitSnapshot()

    return { ok: true, message: 'Cancellation requested.' }
  }

  async clearSyncData(): Promise<CommandResult> {
    if (this.activeRunId || this.activeProcess) {
      return {
        ok: false,
        message: 'Stop the active run before clearing sync data.',
      }
    }

    await this.db.delete(artifactsTable)
    await this.db.delete(libraryFilesTable)
    await this.db.delete(libraryTracksTable)
    await this.db.delete(libraryRootsTable)
    await this.db.delete(songLogsTable)
    await this.db.delete(syncRunItemsTable)
    await this.db.delete(syncRunsTable)
    await this.emitSnapshot()

    return {
      ok: true,
      message: 'Sync database cleared. Settings and auth left intact.',
    }
  }

  async findMissingRemoteTracks(): Promise<RemoteMissingPreviewResult> {
    const state = await this.buildRemoteMissingState()
    if (!state.ok) {
      return { ...state, tracks: [] }
    }

    return {
      ok: true,
      message:
        state.tracks.length > 0
          ? `Found ${state.tracks.length} missing remote tracks.`
          : 'Remote already has all local tracks.',
      tracks: state.tracks,
    }
  }

  async syncMissingToRemote(input: {
    trackIds: string[]
  }): Promise<CommandResult> {
    const requestedTrackIds = new Set(input.trackIds.filter(Boolean))
    if (requestedTrackIds.size === 0) {
      return { ok: false, message: 'No missing remote tracks selected.' }
    }

    const state = await this.buildRemoteMissingState()
    if (!state.ok) {
      return state
    }

    let copied = 0
    let skippedExisting = 0
    let skippedNoLocal = 0
    let failed = 0

    const missingByTrackId = new Map(
      state.tracks.map((track) => [track.trackId, track])
    )

    for (const trackId of requestedTrackIds) {
      const preview = missingByTrackId.get(trackId)
      if (!preview) {
        const track = state.tracksById.get(trackId)
        if (
          track &&
          this.remoteHasTrackIdentity(track, state.remoteIdentityIds)
        ) {
          skippedExisting += 1
        } else {
          skippedNoLocal += 1
        }
        continue
      }

      const track = state.tracksById.get(trackId)
      if (!track) {
        skippedNoLocal += 1
        continue
      }

      const sourceId = track.youtubeMusicTrackId
      const resolvedId = track.resolvedYoutubeMusicTrackId
      if (
        (sourceId && state.remoteIdentityIds.has(sourceId)) ||
        (resolvedId && state.remoteIdentityIds.has(resolvedId))
      ) {
        skippedExisting += 1
        continue
      }

      try {
        await access(preview.localAudioPath)
      } catch {
        skippedNoLocal += 1
        continue
      }

      const audioCopy = await execa(
        'rclone',
        ['copyto', preview.localAudioPath, preview.remoteAudioPath],
        {
          reject: false,
        }
      )
      if (audioCopy.exitCode !== 0) {
        failed += 1
        console.error('backfill-copy-failed', {
          track_id: track.id,
          local_audio_path: preview.localAudioPath,
          remote_audio_path: preview.remoteAudioPath,
          stderr: audioCopy.stderr || null,
        })
        continue
      }

      const selected = this.selectPreferredLocalFile(
        track,
        state.filesByTrackId,
        state.localRoot
      )
      const lrcCandidates = [
        selected?.lrcPath,
        preview.localAudioPath.replace(/\.[^/.]+$/, '.lrc'),
      ].filter((value): value is string => Boolean(value))
      let lrcPath: string | null = null
      for (const candidate of [...new Set(lrcCandidates)]) {
        try {
          await access(candidate)
          lrcPath = candidate
          break
        } catch {
          // ignore missing candidate
        }
      }

      if (lrcPath) {
        const remoteLrcPath = `${state.remoteRoot.uri.replace(/\/$/, '')}/${preview.relativePath.replace(/\.[^/.]+$/, '.lrc')}`
        const lrcCopy = await execa(
          'rclone',
          ['copyto', lrcPath, remoteLrcPath],
          {
            reject: false,
          }
        )
        if (lrcCopy.exitCode !== 0) {
          failed += 1
          console.error('backfill-copy-lrc-failed', {
            track_id: track.id,
            local_lrc_path: lrcPath,
            remote_lrc_path: remoteLrcPath,
            stderr: lrcCopy.stderr || null,
          })
          continue
        }
      }

      copied += 1
    }

    return {
      ok: failed === 0,
      message:
        failed === 0
          ? 'Remote backfill complete.'
          : 'Remote backfill completed with failures.',
      details: `Copied ${copied}; skipped existing ${skippedExisting}; skipped no local ${skippedNoLocal}; failed ${failed}.`,
    }
  }

  private async buildRemoteMissingState(): Promise<RemoteMissingStateResult> {
    if (this.activeRunId || this.activeProcess) {
      return { ok: false, message: 'A sync run is already active.' }
    }

    const settings = await this.settingsService.getRuntimeSettings()
    if (
      !settings.remoteCopyEnabled ||
      !settings.rcloneRemote.trim() ||
      !settings.remoteMusicRoot.trim()
    ) {
      return {
        ok: false,
        message: 'Remote copy settings are incomplete.',
      }
    }

    const scanResult = await this.libraryService.scanRoots({
      includeRemote: true,
    })
    if (!scanResult.ok) {
      return {
        ok: false,
        message: scanResult.message,
        details: scanResult.details,
      }
    }

    const localRootUri = settings.outputDirectory.trim()
    const remoteRootUri = `${settings.rcloneRemote.trim()}:${settings.remoteMusicRoot.trim()}`
    const roots = await this.db.select().from(libraryRootsTable)
    const localRoot = roots.find(
      (root) => root.kind === 'local' && root.uri === localRootUri
    )
    const remoteRoot = roots.find(
      (root) => root.kind === 'remote' && root.uri === remoteRootUri
    )
    if (!localRoot) {
      return {
        ok: false,
        message: 'Local output root not found in library scan.',
      }
    }
    if (!remoteRoot) {
      return {
        ok: false,
        message:
          'Remote root not found in library scan. Check rclone settings.',
      }
    }

    const tracks = await this.db.select().from(libraryTracksTable)
    const tracksById = new Map(tracks.map((track) => [track.id, track]))
    const files = await this.db.select().from(libraryFilesTable)
    const filesByTrackId = new Map<
      string,
      (typeof libraryFilesTable.$inferSelect)[]
    >()
    for (const file of files) {
      const list = filesByTrackId.get(file.trackId) ?? []
      list.push(file)
      filesByTrackId.set(file.trackId, list)
    }

    const remoteTrackIds = new Set(
      files
        .filter((file) => file.rootId === remoteRoot.id)
        .map((file) => file.trackId)
    )
    const remoteIdentityIds = new Set<string>()
    for (const track of tracks) {
      if (!remoteTrackIds.has(track.id)) continue
      if (track.youtubeMusicTrackId) {
        remoteIdentityIds.add(track.youtubeMusicTrackId)
      }
      if (track.resolvedYoutubeMusicTrackId) {
        remoteIdentityIds.add(track.resolvedYoutubeMusicTrackId)
      }
    }

    const previews: RemoteMissingTrackPreview[] = []
    for (const track of tracks) {
      if (!track.managedByApp) continue
      if (this.remoteHasTrackIdentity(track, remoteIdentityIds)) continue

      const selected = this.selectPreferredLocalFile(
        track,
        filesByTrackId,
        localRoot
      )
      if (!selected) continue

      const localAudioPath =
        selected.absolutePathSnapshot ||
        path.join(localRoot.uri, selected.relativePath)
      const remoteAudioPath = `${remoteRoot.uri.replace(/\/$/, '')}/${selected.relativePath}`
      const coverThumbnailDataUrl =
        await this.extractCoverThumbnailDataUrl(localAudioPath)

      previews.push({
        trackId: track.id,
        title: track.title || 'Unknown title',
        artist: track.artist || 'Unknown artist',
        album: track.album || 'Unknown album',
        relativePath: selected.relativePath,
        localAudioPath,
        remoteAudioPath,
        lyricsStatus:
          track.lyricsStatus as RemoteMissingTrackPreview['lyricsStatus'],
        hasEmbeddedLyrics: track.hasEmbeddedLyrics,
        hasSidecarLyrics: track.hasSidecarLyrics,
        coverThumbnailDataUrl,
      })
    }

    return {
      ok: true,
      tracks: previews,
      remoteIdentityIds,
      tracksById,
      filesByTrackId,
      localRoot,
      remoteRoot,
    }
  }

  private remoteHasTrackIdentity(
    track: typeof libraryTracksTable.$inferSelect,
    remoteIdentityIds: Set<string>
  ) {
    return Boolean(
      (track.youtubeMusicTrackId &&
        remoteIdentityIds.has(track.youtubeMusicTrackId)) ||
        (track.resolvedYoutubeMusicTrackId &&
          remoteIdentityIds.has(track.resolvedYoutubeMusicTrackId))
    )
  }

  private selectPreferredLocalFile(
    track: typeof libraryTracksTable.$inferSelect,
    filesByTrackId: Map<string, (typeof libraryFilesTable.$inferSelect)[]>,
    localRoot: typeof libraryRootsTable.$inferSelect
  ) {
    const localFiles = (filesByTrackId.get(track.id) ?? []).filter(
      (file) => file.rootId === localRoot.id
    )
    localFiles.sort((left, right) => {
      const leftPreferred = left.id === track.preferredFileId ? 1 : 0
      const rightPreferred = right.id === track.preferredFileId ? 1 : 0
      if (leftPreferred !== rightPreferred) {
        return rightPreferred - leftPreferred
      }
      const leftAbsolute = left.absolutePathSnapshot ? 1 : 0
      const rightAbsolute = right.absolutePathSnapshot ? 1 : 0
      if (leftAbsolute !== rightAbsolute) return rightAbsolute - leftAbsolute
      return left.relativePath.localeCompare(right.relativePath)
    })
    return localFiles[0] ?? null
  }

  private async extractCoverThumbnailDataUrl(
    localAudioPath: string
  ): Promise<string | null> {
    try {
      const result =
        await this.pythonWorker.runJsonCommand<CoverThumbnailResult>(
          'cover-thumbnail',
          { path: localAudioPath }
        )
      return result.cover_thumbnail_data_url
    } catch {
      return null
    }
  }

  async doctor(): Promise<CommandResult> {
    const runtime = await this.settingsService.getRuntimeSettings()
    const poTokenBundle = this.poTokenService.getBundleStatus()
    const result = await this.pythonWorker.runJsonCommand<{
      ok: boolean
      message: string
      details?: string
    }>('doctor', {
      output_directory: runtime.outputDirectory,
      has_browser_auth: Boolean(runtime.ytmusicBrowserAuth),
      ffmpeg_path: this.getBundledFfmpegPath(),
      remote_copy_enabled: runtime.remoteCopyEnabled,
      rclone_remote: runtime.rcloneRemote,
      remote_music_root: runtime.remoteMusicRoot,
      yt_dlp_plugin_dir: poTokenBundle.pluginDirectory,
      yt_dlp_po_token_base_url: poTokenBundle.baseUrl,
      yt_dlp_plugin_zip_exists: poTokenBundle.hasPluginZip,
      yt_dlp_provider_entry_exists: poTokenBundle.hasProviderEntry,
    })

    return result
  }

  async listRuns(): Promise<SyncRunSummary[]> {
    const rows = await this.db
      .select()
      .from(syncRunsTable)
      .orderBy(desc(syncRunsTable.startedAt))

    return Promise.all(rows.map((row) => this.hydrateRunSummary(row.id)))
  }

  async getRun(runId: string): Promise<SyncRunDetail | null> {
    const row = await this.db.query.syncRunsTable.findFirst({
      where: eq(syncRunsTable.id, runId),
    })
    if (!row) return null

    const summary = await this.hydrateRunSummary(runId)
    const itemRows = await this.db
      .select()
      .from(syncRunItemsTable)
      .where(eq(syncRunItemsTable.runId, runId))
      .orderBy(
        asc(syncRunItemsTable.trackNumber),
        asc(syncRunItemsTable.title),
        asc(syncRunItemsTable.createdAt)
      )

    return {
      ...summary,
      items: itemRows.map((item) => this.toRunItemView(item)),
    }
  }

  async getSnapshot(): Promise<SyncSnapshot> {
    return {
      activeRun: this.activeRunId ? await this.getRun(this.activeRunId) : null,
      runs: await this.listRuns(),
    }
  }

  async getRunLogs(runId: string): Promise<SongLogEntry[]> {
    const rows = await this.db
      .select()
      .from(songLogsTable)
      .where(
        and(
          eq(songLogsTable.runId, runId),
          eq(songLogsTable.youtubeMusicTrackId, RUN_LOG_SOURCE_VIDEO_ID)
        )
      )
      .orderBy(asc(songLogsTable.id))

    return rows.map((row) => this.toSongLogEntry(row))
  }

  async getSongLogs(
    runId: string,
    youtubeMusicTrackId: string
  ): Promise<SongLogEntry[]> {
    const rows = await this.db
      .select()
      .from(songLogsTable)
      .where(
        and(
          eq(songLogsTable.runId, runId),
          eq(songLogsTable.youtubeMusicTrackId, youtubeMusicTrackId)
        )
      )
      .orderBy(asc(songLogsTable.id))

    return rows.map((row) => this.toSongLogEntry(row))
  }

  private async handleWorkerEvent(runId: string, line: string) {
    let event: WorkerEvent
    try {
      event = JSON.parse(line) as WorkerEvent
    } catch (error) {
      await this.insertRunLog(
        runId,
        'error',
        'finalize',
        'ndjson-parse-failed',
        'Worker emitted malformed NDJSON.',
        {
          line,
          parse_error: error instanceof Error ? error.message : String(error),
        }
      )
      return
    }

    if (event.type === 'run') {
      if (event.total_count != null) {
        await this.updateRun(runId, { plannedCount: event.total_count })
      }
      if (event.message) {
        await this.insertRunLog(
          runId,
          event.event === 'failed'
            ? 'error'
            : event.event === 'completed'
              ? 'info'
              : 'debug',
          event.stage ?? 'finalize',
          `run-${event.event}`,
          event.message,
          event.context
        )
      }
      if (this.cancelRequestedRunId === runId) {
        await this.emitSnapshot()
        return
      }
      if (event.event === 'failed') {
        await this.updateRun(runId, {
          status: 'failed',
          endedAt: nowIso(),
        })
      }
      if (event.event === 'completed') {
        await this.updateRun(runId, {
          status: 'completed',
          endedAt: nowIso(),
        })
      }
      await this.emitSnapshot()
      return
    }

    if (event.type === 'item') {
      await this.upsertRunItem(runId, event.item)
      await this.emitSnapshot()
      return
    }

    await this.db.insert(songLogsTable).values({
      runId: event.run_id,
      youtubeMusicTrackId: event.youtube_music_track_id,
      itemId: event.item_id,
      timestamp: event.timestamp,
      level: event.level,
      stage: event.stage,
      event: event.event,
      message: event.message,
      contextJson: JSON.stringify(event.context ?? {}),
    })
  }

  private async insertRunLog(
    runId: string,
    level: LogLevel,
    stage: SyncStage,
    event: string,
    message: string,
    context?: Record<string, unknown>
  ) {
    await this.db.insert(songLogsTable).values({
      runId,
      youtubeMusicTrackId: RUN_LOG_SOURCE_VIDEO_ID,
      itemId: RUN_LOG_ITEM_ID,
      timestamp: nowIso(),
      level,
      stage,
      event,
      message,
      contextJson: JSON.stringify(context ?? {}),
    })
  }

  private toSongLogEntry(row: typeof songLogsTable.$inferSelect): SongLogEntry {
    return {
      id: row.id,
      runId: row.runId,
      youtubeMusicTrackId: row.youtubeMusicTrackId,
      itemId: row.itemId,
      timestamp: row.timestamp,
      level: row.level as LogLevel,
      stage: row.stage as SyncStage,
      event: row.event,
      message: row.message,
      contextJson: row.contextJson,
    }
  }

  private async upsertRunItem(runId: string, item: WorkerItemPayload) {
    const timestamp = nowIso()
    await this.db
      .insert(syncRunItemsTable)
      .values({
        id: item.id,
        runId,
        youtubeMusicTrackId: item.youtube_music_track_id,
        spotifyTrackId: item.spotify_track_id ?? null,
        soundcloudTrackId: item.soundcloud_track_id ?? null,
        resolvedYoutubeMusicTrackId:
          item.resolved_youtube_music_track_id ?? null,
        title: item.title,
        artist: item.artist,
        album: item.album,
        albumArtist: item.album_artist,
        sourceUrl: item.source_url,
        coverArtUrl: item.cover_art_url ?? null,
        status: item.status,
        stage: item.stage,
        reasonCode: item.reason_code ?? '',
        reasonDetail: item.reason_detail ?? '',
        sourceKind: item.source_kind ?? 'unknown',
        videoType: item.video_type ?? null,
        resolutionMethod: item.resolution_method ?? 'unresolved',
        trackNumber: item.track_number ?? null,
        trackTotal: item.track_total ?? null,
        discNumber: item.disc_number ?? null,
        discTotal: item.disc_total ?? null,
        year: item.year ?? null,
        date: item.date ?? null,
        genre: item.genre ?? null,
        language: item.language ?? null,
        isrc: item.isrc ?? null,
        mbTrackId: item.mb_track_id ?? null,
        mbAlbumId: item.mb_album_id ?? null,
        mbReleaseGroupId: item.mb_releasegroup_id ?? null,
        lyricsStatus: item.lyrics_status ?? 'missing',
        audioCodec: item.audio_codec ?? null,
        metadataMatched: item.metadata_matched ?? false,
        musicBrainzMatched: item.musicbrainz_matched ?? false,
        lyricsMatched: item.lyrics_matched ?? false,
        lyricsSource: item.lyrics_source ?? null,
        selectedSourceUrl: item.selected_source_url ?? null,
        outputPath: item.output_path ?? null,
        lrcPath: item.lrc_path ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: syncRunItemsTable.id,
        set: {
          youtubeMusicTrackId: item.youtube_music_track_id,
          spotifyTrackId: item.spotify_track_id ?? null,
          soundcloudTrackId: item.soundcloud_track_id ?? null,
          resolvedYoutubeMusicTrackId:
            item.resolved_youtube_music_track_id ?? null,
          title: item.title,
          artist: item.artist,
          album: item.album,
          albumArtist: item.album_artist,
          sourceUrl: item.source_url,
          coverArtUrl: item.cover_art_url ?? null,
          status: item.status,
          stage: item.stage,
          reasonCode: item.reason_code ?? '',
          reasonDetail: item.reason_detail ?? '',
          sourceKind: item.source_kind ?? 'unknown',
          videoType: item.video_type ?? null,
          resolutionMethod: item.resolution_method ?? 'unresolved',
          trackNumber: item.track_number ?? null,
          trackTotal: item.track_total ?? null,
          discNumber: item.disc_number ?? null,
          discTotal: item.disc_total ?? null,
          year: item.year ?? null,
          date: item.date ?? null,
          genre: item.genre ?? null,
          language: item.language ?? null,
          isrc: item.isrc ?? null,
          mbTrackId: item.mb_track_id ?? null,
          mbAlbumId: item.mb_album_id ?? null,
          mbReleaseGroupId: item.mb_releasegroup_id ?? null,
          lyricsStatus: item.lyrics_status ?? 'missing',
          audioCodec: item.audio_codec ?? null,
          metadataMatched: item.metadata_matched ?? false,
          musicBrainzMatched: item.musicbrainz_matched ?? false,
          lyricsMatched: item.lyrics_matched ?? false,
          lyricsSource: item.lyrics_source ?? null,
          selectedSourceUrl: item.selected_source_url ?? null,
          outputPath: item.output_path ?? null,
          lrcPath: item.lrc_path ?? null,
          updatedAt: timestamp,
        },
      })

    if (item.output_path && item.status === 'completed') {
      await this.db
        .insert(artifactsTable)
        .values({
          id: createId('artifact'),
          runItemId: item.id,
          audioPath: item.output_path,
          lrcPath: item.lrc_path ?? null,
          remoteTarget: null,
          createdAt: timestamp,
        })
        .onConflictDoNothing()
    }
  }

  private async updateRun(
    runId: string,
    patch: Partial<{
      status: string
      endedAt: string | null
      plannedCount: number
    }>
  ) {
    await this.db
      .update(syncRunsTable)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
        ...(patch.plannedCount !== undefined
          ? { plannedCount: patch.plannedCount }
          : {}),
      })
      .where(eq(syncRunsTable.id, runId))
  }

  private async hydrateRunSummary(runId: string): Promise<SyncRunSummary> {
    const row = await this.db.query.syncRunsTable.findFirst({
      where: eq(syncRunsTable.id, runId),
    })
    if (!row) {
      throw new Error(`Run not found: ${runId}`)
    }

    const items = await this.db
      .select({
        status: syncRunItemsTable.status,
      })
      .from(syncRunItemsTable)
      .where(eq(syncRunItemsTable.runId, runId))

    const totalCount = Math.max(row.plannedCount, items.length)
    const completedCount = items.filter(
      (item) =>
        item.status === 'completed' || item.status === 'completed_local_only'
    ).length
    const failedCount = items.filter((item) =>
      item.status.startsWith('failed')
    ).length
    const skippedCount = items.filter(
      (item) => item.status === 'skipped_existing'
    ).length
    const processedCount = completedCount + failedCount + skippedCount

    return {
      id: row.id,
      triggerMode: row.triggerMode as SyncTriggerMode,
      status: row.status as SyncRunSummary['status'],
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      logDirectory: row.logDirectory,
      totalCount,
      processedCount,
      completedCount,
      failedCount,
      skippedCount,
    }
  }

  private toRunItemView(
    item: typeof syncRunItemsTable.$inferSelect
  ): SyncRunItemView {
    return {
      id: item.id,
      runId: item.runId,
      youtubeMusicTrackId: item.youtubeMusicTrackId,
      spotifyTrackId: item.spotifyTrackId,
      soundcloudTrackId: item.soundcloudTrackId,
      resolvedYoutubeMusicTrackId: item.resolvedYoutubeMusicTrackId,
      title: item.title,
      artist: item.artist,
      album: item.album,
      albumArtist: item.albumArtist,
      sourceUrl: item.sourceUrl,
      coverArtUrl: item.coverArtUrl,
      status: item.status as SyncItemStatus,
      stage: item.stage as SyncStage,
      reasonCode: item.reasonCode,
      reasonDetail: item.reasonDetail,
      sourceKind: item.sourceKind,
      videoType: item.videoType,
      resolutionMethod: item.resolutionMethod,
      trackNumber: item.trackNumber,
      trackTotal: item.trackTotal,
      discNumber: item.discNumber,
      discTotal: item.discTotal,
      year: item.year,
      date: item.date,
      genre: item.genre,
      language: item.language,
      isrc: item.isrc,
      mbTrackId: item.mbTrackId,
      mbAlbumId: item.mbAlbumId,
      mbReleaseGroupId: item.mbReleaseGroupId,
      lyricsStatus: item.lyricsStatus as SyncRunItemView['lyricsStatus'],
      audioCodec: item.audioCodec,
      metadataMatched: item.metadataMatched,
      musicBrainzMatched: item.musicBrainzMatched,
      lyricsMatched: item.lyricsMatched,
      lyricsSource: item.lyricsSource,
      selectedSourceUrl: item.selectedSourceUrl,
      outputPath: item.outputPath,
      lrcPath: item.lrcPath,
    }
  }

  private async emitSnapshot() {
    const snapshot = await this.getSnapshot()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private killActiveRun(signal: NodeJS.Signals) {
    const child = this.activeProcess
    if (!child) return false

    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, signal)
      } else {
        child.kill(signal)
      }
      return true
    } catch {
      return false
    }
  }

  private normalizeArtistName(value: string) {
    return value
      .toLowerCase()
      .replace(/[^\w\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private trackMatchesSelectedArtists(
    artist: string | null,
    selected: LikedArtistView[]
  ) {
    if (!artist) return false
    const parts = artist
      .split(',')
      .map((part) => this.normalizeArtistName(part))
      .filter(Boolean)
    if (parts.length === 0) return false
    const wanted = new Set(
      selected.map((item) => this.normalizeArtistName(item.name))
    )
    return parts.some((part) => wanted.has(part))
  }

  private async getManagedFilesForArtists(
    selected: LikedArtistView[]
  ): Promise<ManagedFileRow[]> {
    const tracks = await this.db.select().from(libraryTracksTable)
    const matchedTrackIds = new Set(
      tracks
        .filter(
          (track) =>
            track.managedByApp &&
            this.trackMatchesSelectedArtists(track.artist, selected)
        )
        .map((track) => track.id)
    )
    if (matchedTrackIds.size === 0) return []
    const files = await this.db.select().from(libraryFilesTable)
    const roots = await this.db.select().from(libraryRootsTable)
    const rootById = new Map(roots.map((root) => [root.id, root]))
    return files
      .filter((file) => matchedTrackIds.has(file.trackId))
      .map((file) => {
        const root = rootById.get(file.rootId)
        return {
          trackId: file.trackId,
          artist:
            tracks.find((track) => track.id === file.trackId)?.artist ?? null,
          rootKind: root?.kind ?? 'local',
          rootUri: root?.uri ?? '',
          absolutePathSnapshot: file.absolutePathSnapshot,
          relativePath: file.relativePath,
        }
      })
  }

  private async cleanupArtistReprocessFiles(runId: string) {
    const selected = this.runSelectedArtists.get(runId)
    if (!selected || selected.length === 0) return
    const previous = this.runPreexistingManagedFiles.get(runId) ?? []
    if (previous.length === 0) return

    await this.libraryService.scanRoots({ includeRemote: true })
    const current = await this.getManagedFilesForArtists(selected)
    const currentLocal = new Set(
      current
        .filter((row) => row.rootKind === 'local')
        .map((row) => row.absolutePathSnapshot)
        .filter((value): value is string => Boolean(value))
    )
    const currentRemote = new Set(
      current
        .filter((row) => row.rootKind === 'remote')
        .map((row) => `${row.rootUri}|${row.relativePath}`)
    )

    for (const row of previous) {
      if (row.rootKind === 'local') {
        if (!row.absolutePathSnapshot) continue
        if (currentLocal.has(row.absolutePathSnapshot)) continue
        try {
          await rm(row.absolutePathSnapshot, { force: true })
        } catch {
          // non-fatal: continue cleanup for other files
        }
        continue
      }

      const remoteKey = `${row.rootUri}|${row.relativePath}`
      if (currentRemote.has(remoteKey)) continue
      const remoteTarget = `${row.rootUri.replace(/\/$/, '')}/${row.relativePath}`
      try {
        await execa('rclone', ['deletefile', remoteTarget], {
          reject: false,
        })
      } catch {
        // non-fatal: continue cleanup for other files
      }
    }
  }
}
