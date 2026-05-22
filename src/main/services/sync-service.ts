import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, appendFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  CommandResult,
  LikedArtistView,
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

export interface RemoteShellTrackIdentity {
  relativePath: string
  youtubeMusicTrackId: string | null
  resolvedYoutubeMusicTrackId: string | null
}

export interface RemoteShellScanResult {
  scannedAt: string
  filesScanned: number
  identities: RemoteShellTrackIdentity[]
}

export interface RcloneSftpConfig {
  type: 'sftp'
  host: string
  user: string
  keyFile: string
}

interface ExiftoolJsonRow {
  SourceFile?: unknown
  LMS_YOUTUBE_MUSIC_TRACK_ID?: unknown
  LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID?: unknown
}

const REMOTE_EXIFTOOL_MISSING_MESSAGE =
  'Remote scanner requires exiftool on the VPS. Install libimage-exiftool-perl.'

export function parseRcloneSftpConfig(output: string): RcloneSftpConfig {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    values.set(match[1].trim(), match[2].trim())
  }

  if (values.get('type') !== 'sftp') {
    throw new Error('Remote backfill requires an SFTP rclone remote.')
  }
  const host = values.get('host')
  const user = values.get('user')
  const keyFile = values.get('key_file')
  if (!host || !user || !keyFile) {
    throw new Error('SFTP rclone remote must include host, user, and key_file.')
  }

  return { type: 'sftp', host, user, keyFile }
}

export function normalizeExiftoolJson(
  stdout: string,
  scannedAt = nowIso()
): RemoteShellScanResult {
  let rows: ExiftoolJsonRow[]
  try {
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed)) {
      throw new Error('not an array')
    }
    rows = parsed as ExiftoolJsonRow[]
  } catch (error) {
    throw new Error(
      `Malformed exiftool JSON: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }

  const identities = rows.map((row) => {
    const sourceFile = String(row.SourceFile ?? '')
    return {
      relativePath: sourceFile.replace(/^\.\//, ''),
      youtubeMusicTrackId: stringOrNull(row.LMS_YOUTUBE_MUSIC_TRACK_ID),
      resolvedYoutubeMusicTrackId: stringOrNull(
        row.LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID
      ),
    }
  })

  return {
    scannedAt,
    filesScanned: identities.length,
    identities,
  }
}

export function buildRemoteScannerSshArgs(input: {
  config: RcloneSftpConfig
  remoteMusicRoot: string
}): string[] {
  const shellRoot = resolveRemoteShellRoot(
    input.remoteMusicRoot,
    input.config.user
  )
  return [
    '-i',
    input.config.keyFile,
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    `${input.config.user}@${input.config.host}`,
    buildRemoteScannerCommand(shellRoot),
  ]
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function resolveRemoteShellRoot(remoteMusicRoot: string, user: string) {
  const trimmed = remoteMusicRoot.trim()
  if (trimmed.startsWith('/')) return trimmed
  return `/home/${user}/${trimmed.replace(/^\/+/, '')}`
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildRemoteScannerCommand(shellRoot: string) {
  return `cd ${shellQuote(shellRoot)} || { echo "__LMS_REMOTE_ROOT_MISSING__" >&2; exit 44; }
command -v exiftool >/dev/null 2>&1 || { echo "__LMS_EXIFTOOL_MISSING__" >&2; exit 45; }
python3 - <<'PY'
import json
import os
import subprocess
import sys

root = "."
paths = []
for current, _, files in os.walk(root):
    for name in files:
        if name.lower().endswith(".m4a"):
            paths.append(os.path.join(current, name))

rows = []
for index in range(0, len(paths), 100):
    batch = paths[index:index + 100]
    if not batch:
        continue
    proc = subprocess.run(
        [
            "exiftool",
            "-json",
            "-charset",
            "filename=UTF8",
            "-LMS_YOUTUBE_MUSIC_TRACK_ID",
            "-LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID",
            *batch,
        ],
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(proc.returncode)
    rows.extend(json.loads(proc.stdout or "[]"))

print(json.dumps(rows))
PY`
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
    const scanResult = await this.libraryService.scanRoots()
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
    if (this.activeRunId !== runId) {
      return { ok: false, message: 'That run is not active.' }
    }

    if (!this.activeProcess) {
      this.cancelRequestedRunId = runId
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

  async syncMissingToRemote(): Promise<CommandResult> {
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

    const runId = createId('run')
    const runDirectory = path.join(this.logsDirectory, runId)
    await mkdir(runDirectory, { recursive: true })
    await this.db.insert(syncRunsTable).values({
      id: runId,
      triggerMode: 'remote_backfill',
      status: 'running',
      startedAt: nowIso(),
      endedAt: null,
      logDirectory: runDirectory,
      plannedCount: 0,
    })
    this.activeRunId = runId
    await this.insertRunLog(
      runId,
      'info',
      'remote_copy',
      'remote-backfill-started',
      'Finding local tracks missing from remote.'
    )
    await this.emitSnapshot()

    let copied = 0
    let skippedExisting = 0
    let skippedNoLocal = 0
    let skippedMissingIdentity = 0
    let failed = 0
    let result: CommandResult = {
      ok: true,
      message: 'Remote backfill complete.',
      details: 'Copied 0; skipped existing 0; skipped no local 0; failed 0.',
    }

    try {
      const scanResult = await this.libraryService.scanLocalRoots()
      if (!scanResult.ok) {
        result = scanResult
        await this.insertRunLog(
          runId,
          'error',
          'remote_copy',
          'library-scan-failed',
          scanResult.message,
          scanResult.details ? { details: scanResult.details } : undefined
        )
        return result
      }

      const localRootUri = settings.outputDirectory.trim()
      const remoteRootUri = `${settings.rcloneRemote.trim()}:${settings.remoteMusicRoot.trim()}`
      const roots = await this.db.select().from(libraryRootsTable)
      const localRoot = roots.find(
        (root) => root.kind === 'local' && root.uri === localRootUri
      )
      if (!localRoot) {
        result = {
          ok: false,
          message: 'Local output root not found in library scan.',
        }
        return result
      }

      await this.insertRunLog(
        runId,
        'info',
        'remote_copy',
        'remote-shell-scan-started',
        'Scanning remote tags over SSH.'
      )
      await this.emitSnapshot()

      const remoteScan = await this.scanRemoteShell(
        settings.rcloneRemote.trim(),
        settings.remoteMusicRoot.trim()
      )
      await this.insertRunLog(
        runId,
        'info',
        'remote_copy',
        'remote-shell-scan-completed',
        `Scanned ${remoteScan.filesScanned} remote files.`,
        {
          scannedAt: remoteScan.scannedAt,
          identityCount: remoteScan.identities.length,
        }
      )

      const tracks = (await this.db.select().from(libraryTracksTable)).filter(
        (track) => track.managedByApp
      )
      await this.updateRun(runId, { plannedCount: tracks.length })
      await this.insertRunLog(
        runId,
        'info',
        'remote_copy',
        'remote-backfill-planned',
        `Checking ${tracks.length} managed tracks.`
      )
      await this.emitSnapshot()

      const files = await this.db.select().from(libraryFilesTable)
      const filesByTrackId = new Map<string, typeof files>()
      for (const file of files) {
        const list = filesByTrackId.get(file.trackId) ?? []
        list.push(file)
        filesByTrackId.set(file.trackId, list)
      }

      const remoteSourceIds = new Set<string>()
      const remoteResolvedIds = new Set<string>()
      for (const identity of remoteScan.identities) {
        if (identity.youtubeMusicTrackId) {
          remoteSourceIds.add(identity.youtubeMusicTrackId)
        }
        if (identity.resolvedYoutubeMusicTrackId) {
          remoteResolvedIds.add(identity.resolvedYoutubeMusicTrackId)
        }
      }

      let processed = 0
      let lastSnapshotAt = 0
      const emitProgressSnapshot = async (force = false) => {
        const now = Date.now()
        if (force || processed % 10 === 0 || now - lastSnapshotAt >= 500) {
          lastSnapshotAt = now
          await this.emitSnapshot()
        }
      }

      for (const track of tracks) {
        const runItem = this.toRemoteBackfillRunItem(runId, track)
        if (this.cancelRequestedRunId === runId) {
          result = { ok: false, message: 'Remote backfill cancelled.' }
          break
        }

        await this.upsertRunItem(runId, {
          ...runItem,
          status: 'processing',
          stage: 'remote_copy',
        })
        await emitProgressSnapshot()

        const sourceId = track.youtubeMusicTrackId
        const resolvedId = track.resolvedYoutubeMusicTrackId
        if (
          (sourceId && remoteSourceIds.has(sourceId)) ||
          (resolvedId && remoteResolvedIds.has(resolvedId))
        ) {
          skippedExisting += 1
          await this.upsertRunItem(runId, {
            ...runItem,
            status: 'skipped_existing',
            stage: 'remote_copy',
            reason_code: 'remote_exists',
            reason_detail:
              'Matching source or resolved id already exists on remote.',
          })
          processed += 1
          await emitProgressSnapshot()
          continue
        }

        if (!sourceId && !resolvedId) {
          skippedMissingIdentity += 1
          await this.upsertRunItem(runId, {
            ...runItem,
            status: 'skipped_existing',
            stage: 'remote_copy',
            reason_code: 'missing_source_identity',
            reason_detail: 'No source or resolved id exists to compare.',
          })
          processed += 1
          await emitProgressSnapshot()
          continue
        }

        const localFiles = (filesByTrackId.get(track.id) ?? []).filter(
          (file) => file.rootId === localRoot.id
        )
        if (localFiles.length === 0) {
          skippedNoLocal += 1
          await this.upsertRunItem(runId, {
            ...runItem,
            status: 'skipped_existing',
            stage: 'remote_copy',
            reason_code: 'missing_local_file',
            reason_detail: 'No local file exists to copy.',
          })
          processed += 1
          await emitProgressSnapshot()
          continue
        }

        localFiles.sort((left, right) => {
          const leftPreferred = left.id === track.preferredFileId ? 1 : 0
          const rightPreferred = right.id === track.preferredFileId ? 1 : 0
          if (leftPreferred !== rightPreferred)
            return rightPreferred - leftPreferred
          const leftAbsolute = left.absolutePathSnapshot ? 1 : 0
          const rightAbsolute = right.absolutePathSnapshot ? 1 : 0
          if (leftAbsolute !== rightAbsolute)
            return rightAbsolute - leftAbsolute
          return left.relativePath.localeCompare(right.relativePath)
        })

        const selected = localFiles[0]
        if (!selected) {
          skippedNoLocal += 1
          await this.upsertRunItem(runId, {
            ...runItem,
            status: 'skipped_existing',
            stage: 'remote_copy',
            reason_code: 'missing_local_file',
            reason_detail: 'No local file exists to copy.',
          })
          processed += 1
          await emitProgressSnapshot()
          continue
        }

        const localAudioPath =
          selected.absolutePathSnapshot ||
          path.join(localRoot.uri, selected.relativePath)
        const remoteAudioPath = `${remoteRootUri.replace(/\/$/, '')}/${selected.relativePath}`

        const audioCopy = await execa(
          'rclone',
          ['copyto', localAudioPath, remoteAudioPath],
          {
            reject: false,
          }
        )
        if (audioCopy.exitCode !== 0) {
          failed += 1
          console.error('backfill-copy-failed', {
            track_id: track.id,
            local_audio_path: localAudioPath,
            remote_audio_path: remoteAudioPath,
            stderr: audioCopy.stderr || null,
          })
          await this.upsertRunItem(runId, {
            ...runItem,
            status: 'failed_retryable',
            stage: 'remote_copy',
            reason_code: 'remote_audio_copy_failed',
            reason_detail: audioCopy.stderr || 'rclone audio copy failed.',
            output_path: localAudioPath,
          })
          processed += 1
          await emitProgressSnapshot(true)
          continue
        }

        const lrcCandidates = [
          selected.lrcPath,
          localAudioPath.replace(/\.[^/.]+$/, '.lrc'),
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
          const remoteLrcPath = `${remoteRootUri.replace(/\/$/, '')}/${selected.relativePath.replace(/\.[^/.]+$/, '.lrc')}`
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
            await this.upsertRunItem(runId, {
              ...runItem,
              status: 'failed_retryable',
              stage: 'remote_copy',
              reason_code: 'remote_lrc_copy_failed',
              reason_detail: lrcCopy.stderr || 'rclone lrc copy failed.',
              output_path: localAudioPath,
              lrc_path: lrcPath,
            })
            processed += 1
            await emitProgressSnapshot(true)
            continue
          }
        }

        copied += 1
        await this.upsertRunItem(runId, {
          ...runItem,
          status: 'completed',
          stage: 'remote_copy',
          reason_code: 'remote_copied',
          reason_detail: 'Copied local file to remote.',
          output_path: localAudioPath,
          lrc_path: lrcPath,
        })
        processed += 1
        await emitProgressSnapshot()
      }

      if (this.cancelRequestedRunId !== runId) {
        result = {
          ok: failed === 0,
          message:
            failed === 0
              ? 'Remote backfill complete.'
              : 'Remote backfill completed with failures.',
          details: `Copied ${copied}; skipped existing ${skippedExisting}; skipped no local ${skippedNoLocal}; skipped missing identity ${skippedMissingIdentity}; failed ${failed}.`,
        }
      }
      return result
    } catch (error) {
      result = {
        ok: false,
        message:
          error instanceof Error ? error.message : 'Remote backfill failed.',
      }
      await this.insertRunLog(
        runId,
        'error',
        'remote_copy',
        'remote-backfill-failed',
        result.message
      )
      await this.emitSnapshot()
      return result
    } finally {
      const cancelled = this.cancelRequestedRunId === runId
      if (!cancelled && !result.ok) {
        await this.updateRun(runId, {
          status: 'failed',
          endedAt: nowIso(),
        })
      } else if (!cancelled) {
        await this.updateRun(runId, {
          status: failed === 0 ? 'completed' : 'failed',
          endedAt: nowIso(),
        })
      }
      if (!cancelled) {
        await this.insertRunLog(
          runId,
          failed === 0 && result.ok ? 'info' : 'error',
          'remote_copy',
          'remote-backfill-finished',
          result.details
            ? `${result.message} ${result.details}`
            : result.message
        )
      }
      if (this.activeRunId === runId) {
        this.activeRunId = null
      }
      if (this.cancelRequestedRunId === runId) {
        this.cancelRequestedRunId = null
      }
      await this.emitSnapshot()
    }
  }

  private async scanRemoteShell(
    rcloneRemote: string,
    remoteMusicRoot: string
  ): Promise<RemoteShellScanResult> {
    const configResult = await execa(
      'rclone',
      ['config', 'show', rcloneRemote],
      { reject: false }
    )
    if (configResult.exitCode !== 0) {
      throw new Error(
        configResult.stderr ||
          `Unable to read rclone config for ${rcloneRemote}.`
      )
    }

    const config = parseRcloneSftpConfig(configResult.stdout)
    const sshArgs = buildRemoteScannerSshArgs({ config, remoteMusicRoot })
    const scanResult = await execa('ssh', sshArgs, { reject: false })
    if (scanResult.exitCode !== 0) {
      if (scanResult.stderr.includes('__LMS_EXIFTOOL_MISSING__')) {
        throw new Error(REMOTE_EXIFTOOL_MISSING_MESSAGE)
      }
      if (scanResult.stderr.includes('__LMS_REMOTE_ROOT_MISSING__')) {
        throw new Error('Remote music root does not exist on the VPS.')
      }
      throw new Error(scanResult.stderr || 'Remote shell scan failed.')
    }

    return normalizeExiftoolJson(scanResult.stdout)
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

  private toRemoteBackfillRunItem(
    runId: string,
    track: typeof libraryTracksTable.$inferSelect
  ): WorkerItemPayload {
    const fallbackTitle = track.title ?? track.identityValue
    return {
      id: `${runId}:${track.id}`,
      youtube_music_track_id:
        track.youtubeMusicTrackId ??
        track.resolvedYoutubeMusicTrackId ??
        track.id,
      spotify_track_id: track.spotifyTrackId,
      soundcloud_track_id: track.soundcloudTrackId,
      resolved_youtube_music_track_id: track.resolvedYoutubeMusicTrackId,
      title: fallbackTitle,
      artist: track.artist ?? 'Unknown artist',
      album: track.album ?? 'Unknown album',
      album_artist: track.albumArtist ?? track.artist ?? 'Unknown artist',
      source_url: track.youtubeMusicTrackId
        ? `https://music.youtube.com/watch?v=${track.youtubeMusicTrackId}`
        : '',
      status: 'pending',
      stage: 'remote_copy',
      reason_code: '',
      reason_detail: '',
      source_kind: 'library',
      resolution_method: 'library',
      track_number: track.trackNumber,
      track_total: track.trackTotal,
      disc_number: track.discNumber,
      disc_total: track.discTotal,
      year: track.year,
      date: track.date,
      genre: track.genre,
      language: track.language,
      isrc: track.isrc,
      mb_track_id: track.mbTrackId,
      mb_album_id: track.mbAlbumId,
      mb_releasegroup_id: track.mbReleaseGroupId,
      lyrics_status: track.lyricsStatus as SyncRunItemView['lyricsStatus'],
      metadata_matched: true,
      musicbrainz_matched: Boolean(track.mbTrackId),
      lyrics_matched: track.lyricsStatus !== 'missing',
    }
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

    await this.libraryService.scanRoots()
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
