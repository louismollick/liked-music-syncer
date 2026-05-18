import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  CommandResult,
  LogLevel,
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
import type { AppDatabase } from '../db/database'
import {
  artifactsTable,
  processedSongsTable,
  songLogsTable,
  syncRunItemsTable,
  syncRunsTable,
} from '../db/schema'
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
  source_video_id: string
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
  year?: number | null
  date?: string | null
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
  source_video_id: string
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

export class SyncService {
  private readonly listeners = new Set<SyncListener>()
  private readonly logsDirectory = path.join(app.getPath('userData'), 'logs')
  private activeRunId: string | null = null
  private activeProcess: ChildProcessWithoutNullStreams | null = null
  private cancelKillTimer: NodeJS.Timeout | null = null
  private cancelRequestedRunId: string | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly settingsService: SettingsService,
    private readonly pythonWorker: PythonWorkerService,
    private readonly poTokenService: PoTokenService,
    private readonly getBundledFfmpegPath: () => string
  ) {}

  subscribe(listener: SyncListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(input?: { mode?: SyncTriggerMode }): Promise<CommandResult> {
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

    if (settings.ytmusicAuthMode === 'browser_headers') {
      if (!settings.ytmusicBrowserAuth) {
        return {
          ok: false,
          message: 'Browser auth headers must be configured first.',
        }
      }
    } else {
      if (!settings.ytmusicClientId || !settings.ytmusicClientSecret) {
        return {
          ok: false,
          message: 'YT Music client ID and secret are required.',
        }
      }
      if (!settings.ytmusicOAuthTokenJson) {
        return { ok: false, message: 'Connect a YT Music account first.' }
      }
    }

    const authResult =
      await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
        'auth-status',
        {
          mode: settings.ytmusicAuthMode,
          client_id: settings.ytmusicClientId,
          client_secret: settings.ytmusicClientSecret,
          token_json: settings.ytmusicOAuthTokenJson,
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
    const oauthTokenJson =
      settings.ytmusicAuthMode === 'oauth_device'
        ? (authResult.credential_json ?? settings.ytmusicOAuthTokenJson)
        : settings.ytmusicOAuthTokenJson
    const browserAuthInput =
      settings.ytmusicAuthMode === 'browser_headers'
        ? (authResult.credential_json ?? settings.ytmusicBrowserAuth)
        : settings.ytmusicBrowserAuth

    if (authResult.credential_json) {
      if (settings.ytmusicAuthMode === 'browser_headers') {
        await this.settingsService.saveYtMusicBrowserAuth(
          authResult.credential_json
        )
      } else {
        await this.settingsService.saveYtMusicOAuthToken(
          authResult.credential_json
        )
      }
    }

    const runId = createId('run')
    const runDirectory = path.join(this.logsDirectory, runId)
    await mkdir(runDirectory, { recursive: true })

    await this.db.insert(syncRunsTable).values({
      id: runId,
      triggerMode: input?.mode ?? 'manual',
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
      ytmusic_auth_mode: settings.ytmusicAuthMode,
      ytmusic_client_id: settings.ytmusicClientId,
      ytmusic_client_secret: settings.ytmusicClientSecret,
      ytmusic_oauth_token_json: oauthTokenJson,
      ytmusic_browser_auth: browserAuthInput,
      yt_dlp_cookies_browser: settings.ytDlpCookiesBrowser,
      folder_template: settings.folderTemplate,
      file_template: settings.fileTemplate,
      embed_unsynced_lyrics: settings.embedUnsyncedLyrics,
      write_lrc_sidecar: settings.writeLrcSidecar,
      ffmpeg_path: this.getBundledFfmpegPath(),
      yt_dlp_plugin_dir: poTokenBundle.pluginDirectory,
      yt_dlp_po_token_base_url: poTokenBundle.baseUrl,
    })

    this.activeRunId = runId
    this.activeProcess = child

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
      await this.updateRun(runId, {
        status,
        endedAt: nowIso(),
      })

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
    return { ok: true, message: 'Sync started.' }
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
    await this.db.delete(songLogsTable)
    await this.db.delete(syncRunItemsTable)
    await this.db.delete(syncRunsTable)
    await this.db.delete(processedSongsTable)
    await this.emitSnapshot()

    return {
      ok: true,
      message: 'Sync database cleared. Settings and auth left intact.',
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
      ytmusic_client_id: runtime.ytmusicClientId,
      has_client_secret: Boolean(runtime.ytmusicClientSecret),
      has_oauth_token: Boolean(runtime.ytmusicOAuthTokenJson),
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
          eq(songLogsTable.sourceVideoId, RUN_LOG_SOURCE_VIDEO_ID)
        )
      )
      .orderBy(asc(songLogsTable.id))

    return rows.map((row) => this.toSongLogEntry(row))
  }

  async getSongLogs(
    runId: string,
    sourceVideoId: string
  ): Promise<SongLogEntry[]> {
    const rows = await this.db
      .select()
      .from(songLogsTable)
      .where(
        and(
          eq(songLogsTable.runId, runId),
          eq(songLogsTable.sourceVideoId, sourceVideoId)
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
      sourceVideoId: event.source_video_id,
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
      sourceVideoId: RUN_LOG_SOURCE_VIDEO_ID,
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
      sourceVideoId: row.sourceVideoId,
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
        sourceVideoId: item.source_video_id,
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
        year: item.year ?? null,
        date: item.date ?? null,
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
          year: item.year ?? null,
          date: item.date ?? null,
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
        .insert(processedSongsTable)
        .values({
          sourceVideoId: item.source_video_id,
          title: item.title,
          artist: item.artist,
          album: item.album,
          albumArtist: item.album_artist,
          outputPath: item.output_path,
          processedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: processedSongsTable.sourceVideoId,
          set: {
            title: item.title,
            artist: item.artist,
            album: item.album,
            albumArtist: item.album_artist,
            outputPath: item.output_path,
            processedAt: timestamp,
          },
        })

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
      sourceVideoId: item.sourceVideoId,
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
      year: item.year,
      date: item.date,
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
}
