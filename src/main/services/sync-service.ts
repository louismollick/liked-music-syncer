import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import type {
  CommandResult,
  LikedArtistView,
  LogLevel,
  SyncApprovalItemView,
  SyncItemStatus,
  SyncJobKind,
  SyncJobStatus,
  SyncJobView,
  SyncSnapshot,
  SyncStage,
  SyncTrackWorkView,
} from '@shared/contracts'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { execa } from 'execa'
import type { AppDatabase } from '../db/database'
import {
  libraryFilesTable,
  libraryRootsTable,
  libraryTracksTable,
  syncApprovalItemsTable,
  syncJobsTable,
  syncJobTracksTable,
} from '../db/schema'
import type { LibraryService } from './library-service'
import type { LikedArtistsService } from './liked-artists-service'
import { logMain, writeStderrRaw } from './logger'
import type { PoTokenService } from './po-token-service'
import type { PythonWorkerService } from './python-worker'
import type { SettingsService } from './settings-service'
import { createId, nowIso } from './utils'

type SyncListener = (snapshot: SyncSnapshot) => void

interface WorkerJobEvent {
  type: 'job'
  event: 'started' | 'progress' | 'completed' | 'failed'
  job_id: string
  total_count?: number
  processed_count?: number
  stage?: SyncStage
  message?: string
  context?: Record<string, unknown>
}

interface WorkerTrackPayload {
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
  source_origin?: string | null
  catalog_release_browse_id?: string | null
  catalog_release_title?: string | null
  catalog_release_kind?: string | null
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
  lyrics_status?: 'missing' | 'plain' | 'synced'
  audio_codec?: string | null
  metadata_matched?: boolean
  musicbrainz_matched?: boolean
  lyrics_matched?: boolean
  lyrics_source?: string | null
  selected_source_url?: string | null
  output_path?: string | null
  lrc_path?: string | null
}

interface WorkerTrackEvent {
  type: 'track'
  event: 'upsert'
  job_id: string
  item: WorkerTrackPayload
}

interface WorkerLogEvent {
  type: 'log'
  job_id: string
  item_id: string
  youtube_music_track_id: string
  timestamp: string
  level: LogLevel
  stage: SyncStage
  event: string
  message: string
  context?: Record<string, unknown>
}

type WorkerEvent = WorkerJobEvent | WorkerTrackEvent | WorkerLogEvent

interface WorkerAuthStatusResponse {
  ok: boolean
  is_authenticated: boolean
  message: string
  credential_json?: string
}

interface FavoriteArtistCatalogPayload {
  id: string
  channel_id: string | null
  name: string
  normalized_name: string
}

interface ReprocessCandidatePayload {
  track_work_id: string
  library_track_id: string
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
  lyrics_status: string
  current_output_path: string
  current_lrc_path: string | null
  cover_art_present: boolean
}

interface ReprocessPreviewRow {
  track_work_id: string
  library_track_id: string
  same_video: boolean
  action_kind: 'noop' | 'update' | 'replace'
  diff: Record<string, { before: unknown; after: unknown }>
  before: Record<string, unknown>
  after: Record<string, unknown>
  album_art_diff: Record<string, unknown> | null
  payload: Record<string, unknown>
}

interface ReprocessApplyResult {
  ok: boolean
  output_path: string
  lrc_path: string | null
  replaced: boolean
}

interface ManagedFileRow {
  trackId: string
  artist: string | null
  rootKind: string
  rootUri: string
  absolutePathSnapshot: string | null
  relativePath: string
}

interface RuntimeSettingsLike {
  outputDirectory: string
  remoteCopyEnabled: boolean
  rcloneRemote: string
  remoteMusicRoot: string
  lyricsApiBaseUrl: string
  ytmusicBrowserAuth?: string
  ytDlpCookiesBrowser?: string
  folderTemplate: string
  fileTemplate: string
  embedUnsyncedLyrics: boolean
  writeLrcSidecar: boolean
  autoApproveChanges?: boolean
}

interface PoTokenBundle {
  pluginDirectory: string
  baseUrl: string
  hasPluginZip?: boolean
  hasProviderEntry?: boolean
}

interface JobCreateInput {
  kind: SyncJobKind
  scope: 'library' | 'artist' | null
  label: string
  plannedCount?: number
  status?: SyncJobStatus
  queueBucket?: SyncJobView['bucket']
}

interface RemoteBackfillCandidate {
  trackId: string
  trackWorkId: string
  payload: WorkerTrackPayload
  localAudioPath: string
  localLrcPath: string | null
  remoteTarget: string
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

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

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

export class SyncService {
  private readonly listeners = new Set<SyncListener>()
  private readonly jobSelectedArtists = new Map<string, LikedArtistView[]>()
  private readonly reprocessPreexistingManagedFiles = new Map<
    string,
    ManagedFileRow[]
  >()
  private readonly pendingWorkerLaunches = new Map<
    string,
    () => Promise<void>
  >()
  private activeJobId: string | null = null
  private activeProcess: ChildProcessWithoutNullStreams | null = null
  private cancelKillTimer: NodeJS.Timeout | null = null
  private cancelRequestedJobId: string | null = null
  private schedulerRunning = false
  private readonly poTokenService: PoTokenService
  private readonly getBundledFfmpegPath: () => string

  constructor(
    private readonly db: AppDatabase,
    private readonly settingsService: SettingsService,
    private readonly pythonWorker: PythonWorkerService,
    private readonly libraryService: LibraryService,
    private readonly likedArtistsService: LikedArtistsService,
    poTokenServiceOrGetFfmpeg: PoTokenService | (() => string),
    maybeGetBundledFfmpegPath?: () => string
  ) {
    if (typeof poTokenServiceOrGetFfmpeg === 'function') {
      this.getBundledFfmpegPath = poTokenServiceOrGetFfmpeg
      this.poTokenService = {
        ensureReady: async () => {},
        getBundleStatus: () => ({
          pluginDirectory: '',
          baseUrl: '',
          hasPluginZip: false,
          hasProviderEntry: false,
        }),
      } as PoTokenService
    } else {
      this.poTokenService = poTokenServiceOrGetFfmpeg
      this.getBundledFfmpegPath = maybeGetBundledFfmpegPath ?? (() => 'ffmpeg')
    }
  }

  subscribe(listener: SyncListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async startLikedSongsSync(): Promise<CommandResult> {
    return this.startWorkerJob({
      kind: 'liked_songs_sync',
      scope: null,
      label: 'Liked Songs Sync',
    })
  }

  async startLibraryReprocess(): Promise<CommandResult> {
    return this.startReprocessJob('library')
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
        message: 'Some selected artists are missing. Refresh library first.',
      }
    }
    return this.startReprocessJob('artist', selectedArtists)
  }

  async refreshFavoriteArtists(artistIds?: string[]): Promise<CommandResult> {
    const uniqueIds = artistIds
      ? [...new Set(artistIds.filter(Boolean))]
      : undefined
    const selectedArtists =
      await this.likedArtistsService.listFavoriteArtists(uniqueIds)
    if (selectedArtists.length === 0) {
      return { ok: false, message: 'Select at least one favorite artist.' }
    }
    if (uniqueIds && selectedArtists.length !== uniqueIds.length) {
      return { ok: false, message: 'Some selected artists are not favorites.' }
    }

    return this.startWorkerJob(
      {
        kind: 'favorite_artist_catalog_refresh',
        scope: 'artist',
        label: 'Refresh Favorite Catalog',
      },
      selectedArtists.map((artist) => ({
        id: artist.id,
        channel_id: artist.channelId,
        name: artist.name,
        normalized_name: artist.normalizedName,
      })),
      selectedArtists
    )
  }

  async approveChanges(approvalIds: string[]): Promise<CommandResult> {
    const uniqueIds = [...new Set(approvalIds.filter(Boolean))]
    if (uniqueIds.length === 0) {
      return { ok: false, message: 'Select at least one change.' }
    }

    const approvals = await this.db
      .select()
      .from(syncApprovalItemsTable)
      .where(inArray(syncApprovalItemsTable.id, uniqueIds))
    const pending = approvals.filter((row) => row.status === 'pending')
    if (pending.length === 0) {
      return { ok: false, message: 'No pending approvals selected.' }
    }

    for (const row of pending) {
      const timestamp = nowIso()
      await this.db
        .update(syncApprovalItemsTable)
        .set({ status: 'approved', updatedAt: timestamp })
        .where(eq(syncApprovalItemsTable.id, row.id))
      await this.db
        .update(syncJobTracksTable)
        .set({
          status: 'pending',
          stage: 'idle',
          reasonCode: '',
          reasonDetail: '',
          terminalOutcome: null,
          updatedAt: timestamp,
        })
        .where(eq(syncJobTracksTable.id, row.trackWorkId))
      await this.recomputeJob(row.jobId)
    }

    await this.emitSnapshot()
    void this.runScheduler()
    return {
      ok: true,
      message: `Approved ${pending.length} change${pending.length === 1 ? '' : 's'}.`,
    }
  }

  async denyChanges(approvalIds: string[]): Promise<CommandResult> {
    const uniqueIds = [...new Set(approvalIds.filter(Boolean))]
    if (uniqueIds.length === 0) {
      return { ok: false, message: 'Select at least one change.' }
    }

    const approvals = await this.db
      .select()
      .from(syncApprovalItemsTable)
      .where(inArray(syncApprovalItemsTable.id, uniqueIds))
    const pending = approvals.filter((row) => row.status === 'pending')
    if (pending.length === 0) {
      return { ok: false, message: 'No pending approvals selected.' }
    }

    for (const row of pending) {
      const timestamp = nowIso()
      await this.db
        .update(syncApprovalItemsTable)
        .set({ status: 'denied', updatedAt: timestamp })
        .where(eq(syncApprovalItemsTable.id, row.id))
      await this.db
        .update(syncJobTracksTable)
        .set({
          status: 'completed_local_only',
          stage: 'finalize',
          reasonCode: 'approval_denied',
          reasonDetail: 'Change denied by user.',
          terminalOutcome: 'noop_denied',
          updatedAt: timestamp,
        })
        .where(eq(syncJobTracksTable.id, row.trackWorkId))
      await this.recomputeJob(row.jobId)
    }

    await this.emitSnapshot()
    return {
      ok: true,
      message: `Denied ${pending.length} change${pending.length === 1 ? '' : 's'}.`,
    }
  }

  async cancel(jobId: string): Promise<CommandResult> {
    const job = await this.db.query.syncJobsTable.findFirst({
      where: eq(syncJobsTable.id, jobId),
    })
    if (!job) {
      return { ok: false, message: 'That job does not exist.' }
    }

    if (this.activeJobId === jobId) {
      this.cancelRequestedJobId = jobId
      if (this.activeProcess) {
        const child = this.activeProcess
        const killed = this.killActiveProcess('SIGTERM')
        if (!killed)
          return { ok: false, message: 'Unable to stop the active job.' }
        if (this.cancelKillTimer) clearTimeout(this.cancelKillTimer)
        this.cancelKillTimer = setTimeout(() => {
          if (this.activeProcess === child) {
            this.killActiveProcess('SIGKILL')
          }
        }, 5_000)
      }
      await this.failPendingTracksForCancellation(jobId)
      await this.db
        .update(syncJobsTable)
        .set({
          status: 'cancelled',
          queueBucket: 'failures',
          endedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(eq(syncJobsTable.id, jobId))
      await this.emitSnapshot()
      return { ok: true, message: 'Cancellation requested.' }
    }

    if (!['queued', 'waiting_approval'].includes(job.status)) {
      return { ok: false, message: 'That job cannot be cancelled now.' }
    }

    await this.failPendingTracksForCancellation(jobId)
    await this.db
      .update(syncJobsTable)
      .set({
        status: 'cancelled',
        queueBucket: 'failures',
        endedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(eq(syncJobsTable.id, jobId))
    await this.db
      .update(syncApprovalItemsTable)
      .set({ status: 'denied', updatedAt: nowIso() })
      .where(eq(syncApprovalItemsTable.jobId, jobId))
    await this.emitSnapshot()
    return { ok: true, message: 'Cancellation requested.' }
  }

  async clearSyncData(): Promise<CommandResult> {
    if (this.activeJobId || this.activeProcess) {
      return {
        ok: false,
        message: 'Stop the active job before clearing sync data.',
      }
    }

    await this.db.delete(syncApprovalItemsTable)
    await this.db.delete(syncJobTracksTable)
    await this.db.delete(syncJobsTable)
    await this.emitSnapshot()
    return {
      ok: true,
      message: 'Sync database cleared. Settings and auth left intact.',
    }
  }

  async syncMissingToRemote(): Promise<CommandResult> {
    const settings =
      (await this.settingsService.getRuntimeSettings()) as RuntimeSettingsLike
    if (
      !settings.remoteCopyEnabled ||
      !settings.rcloneRemote.trim() ||
      !settings.remoteMusicRoot.trim()
    ) {
      return { ok: false, message: 'Remote copy settings are incomplete.' }
    }

    const indexStatus = await this.libraryService.ensureLocalIndexReady()
    if (!indexStatus.ready) {
      return this.libraryService.getIndexNotReadyResult(indexStatus)
    }

    const jobId = await this.createJob({
      kind: 'sync_missing_to_remote',
      scope: null,
      label: 'Sync Missing to Remote',
    })
    await this.emitSnapshot()
    if (this.activeJobId) {
      void this.runScheduler()
      return { ok: true, message: 'Sync Missing to Remote queued.' }
    }
    return this.runRemoteBackfillJob(jobId)
  }

  async doctor(): Promise<CommandResult> {
    const runtime =
      (await this.settingsService.getRuntimeSettings()) as RuntimeSettingsLike
    const poTokenBundle = this.getPoTokenBundle()
    return this.pythonWorker.runJsonCommand<CommandResult>('doctor', {
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
  }

  async getSnapshot(): Promise<SyncSnapshot> {
    const [jobs, tracks, approvals] = await Promise.all([
      this.db
        .select()
        .from(syncJobsTable)
        .orderBy(desc(syncJobsTable.startedAt)),
      this.db.select().from(syncJobTracksTable),
      this.db
        .select()
        .from(syncApprovalItemsTable)
        .where(eq(syncApprovalItemsTable.status, 'pending')),
    ])

    const visibleTracks = tracks.filter((track) => track.visible)
    const tracksByJobId = new Map<string, typeof visibleTracks>()
    for (const track of visibleTracks) {
      const current = tracksByJobId.get(track.jobId) ?? []
      current.push(track)
      tracksByJobId.set(track.jobId, current)
    }

    const approvalsByTrackId = new Map(
      approvals.map((row) => [row.trackWorkId, row])
    )
    const queue: SyncJobView[] = []
    const completed: SyncJobView[] = []
    const failures: SyncJobView[] = []

    for (const job of jobs) {
      const jobTracks = [...(tracksByJobId.get(job.id) ?? [])].sort((a, b) => {
        const left = a.sortIndex ?? Number.MAX_SAFE_INTEGER
        const right = b.sortIndex ?? Number.MAX_SAFE_INTEGER
        if (left !== right) return left - right
        return a.createdAt.localeCompare(b.createdAt)
      })
      const completedTracks = jobTracks.filter((track) =>
        ['completed', 'completed_local_only'].includes(track.status)
      ).length
      const failedTracks = jobTracks.filter((track) =>
        track.status.startsWith('failed')
      ).length
      const processedTracks = completedTracks + failedTracks
      const pendingApprovalTracks = jobTracks.filter((track) =>
        Boolean(approvalsByTrackId.get(track.id))
      ).length
      const view: SyncJobView = {
        id: job.id,
        kind: job.kind as SyncJobKind,
        scope: (job.scope as SyncJobView['scope']) ?? null,
        label: job.label,
        status: job.status as SyncJobStatus,
        bucket: job.queueBucket as SyncJobView['bucket'],
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        totalTracks: jobTracks.length,
        processedTracks,
        completedTracks,
        failedTracks,
        pendingApprovalTracks,
        tracks:
          job.queueBucket === 'needs_approval'
            ? []
            : jobTracks.map((track) => this.toTrackView(track)),
      }

      if (view.bucket === 'queue') queue.push(view)
      else if (view.bucket === 'completed') completed.push(view)
      else if (view.bucket === 'failures') failures.push(view)
    }

    const trackById = new Map(tracks.map((track) => [track.id, track]))
    const needsApproval: SyncApprovalItemView[] = approvals
      .map((approval) => {
        const track = trackById.get(approval.trackWorkId)
        if (!track) return null
        return {
          id: approval.id,
          jobId: approval.jobId,
          trackWorkId: approval.trackWorkId,
          title: track.title,
          artist: track.artist,
          album: track.album,
          status: 'pending',
          actionKind: approval.actionKind as 'update' | 'replace' | 'delete',
          diffJson: approval.diffJson,
          beforeJson: approval.beforeJson,
          afterJson: approval.afterJson,
        }
      })
      .filter((value): value is SyncApprovalItemView => Boolean(value))

    return {
      queue,
      needsApproval,
      completed,
      failures,
      counts: {
        queue: queue.reduce((sum, job) => sum + job.totalTracks, 0),
        needsApproval: needsApproval.length,
        completed: completed.reduce((sum, job) => sum + job.totalTracks, 0),
        failures: failures.reduce((sum, job) => sum + job.totalTracks, 0),
      },
    }
  }

  async scanRemoteShell(
    rcloneRemote: string,
    remoteMusicRoot: string
  ): Promise<RemoteShellScanResult> {
    const configResult = await execa(
      'rclone',
      ['config', 'show', rcloneRemote],
      {
        reject: false,
      }
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

  private async startWorkerJob(
    input: Pick<JobCreateInput, 'kind' | 'scope' | 'label'>,
    favoriteArtistCatalogs: FavoriteArtistCatalogPayload[] = [],
    selectedArtists: LikedArtistView[] = []
  ): Promise<CommandResult> {
    logMain({
      level: 'debug',
      source: 'sync',
      message: 'startRun setup started',
      context: {
        kind: input.kind,
        selectedArtistCount: selectedArtists.length,
        favoriteArtistCatalogCount: favoriteArtistCatalogs.length,
      },
    })
    const runtime =
      (await this.settingsService.getRuntimeSettings()) as RuntimeSettingsLike
    if (!runtime.outputDirectory) {
      logMain({
        level: 'warn',
        source: 'sync',
        message: 'startRun blocked: missing output directory',
        context: { kind: input.kind },
      })
      return {
        ok: false,
        message: 'Output directory must be configured first.',
      }
    }
    if (!runtime.ytmusicBrowserAuth) {
      logMain({
        level: 'warn',
        source: 'sync',
        message: 'startRun blocked: missing YT Music auth',
        context: { kind: input.kind },
      })
      return {
        ok: false,
        message: 'Pull YT Music auth from your browser first.',
      }
    }

    const authResult =
      await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
        'auth-status',
        { browser_auth_input: runtime.ytmusicBrowserAuth }
      )
    if (!authResult.ok || !authResult.is_authenticated) {
      return {
        ok: false,
        message: authResult.message || 'YT Music auth check failed.',
      }
    }

    const indexStatus = await this.libraryService.ensureLocalIndexReady()
    if (!indexStatus.ready) {
      return this.libraryService.getIndexNotReadyResult(indexStatus)
    }

    await this.poTokenService.ensureReady()
    const poTokenBundle = this.getPoTokenBundle()
    const existingLocalIds =
      await this.libraryService.getManagedLocalSignatures()
    const browserAuthInput =
      authResult.credential_json ?? runtime.ytmusicBrowserAuth
    if (authResult.credential_json) {
      await this.settingsService.saveYtMusicBrowserAuth(
        authResult.credential_json
      )
    }

    const jobId = await this.createJob({
      kind: input.kind,
      scope: input.scope,
      label: input.label,
    })
    if (selectedArtists.length > 0) {
      this.jobSelectedArtists.set(jobId, selectedArtists)
    }
    const launch = async () => {
      await this.launchWorkerJob(
        jobId,
        runtime,
        browserAuthInput,
        poTokenBundle,
        {
          sourceIds: [...existingLocalIds.sourceIds],
          resolvedIds: [...existingLocalIds.resolvedIds],
          trackSignatures: existingLocalIds.trackSignatures,
          releaseSignatures: existingLocalIds.releaseSignatures,
          favoriteArtistCatalogs,
        }
      )
    }

    if (this.activeJobId) {
      this.pendingWorkerLaunches.set(jobId, launch)
      await this.emitSnapshot()
      return {
        ok: true,
        message:
          input.kind === 'favorite_artist_catalog_refresh'
            ? 'Favorite artist catalog refresh queued.'
            : 'Sync queued.',
      }
    }

    await launch()
    return {
      ok: true,
      message:
        input.kind === 'favorite_artist_catalog_refresh'
          ? 'Favorite artist catalog refresh started.'
          : 'Sync started.',
    }
  }

  private async launchWorkerJob(
    jobId: string,
    runtime: RuntimeSettingsLike,
    browserAuthInput: string,
    poTokenBundle: PoTokenBundle,
    existingLocalIds: {
      sourceIds: string[]
      resolvedIds: string[]
      trackSignatures: unknown[]
      releaseSignatures: unknown[]
      favoriteArtistCatalogs: FavoriteArtistCatalogPayload[]
    }
  ) {
    const child = this.pythonWorker.spawnNdjsonCommand('sync-job', {
      job_id: jobId,
      output_directory: runtime.outputDirectory,
      remote_copy_enabled: runtime.remoteCopyEnabled,
      rclone_remote: runtime.rcloneRemote,
      remote_music_root: runtime.remoteMusicRoot,
      ytmusic_browser_auth: browserAuthInput,
      yt_dlp_cookies_browser: runtime.ytDlpCookiesBrowser,
      folder_template: runtime.folderTemplate,
      file_template: runtime.fileTemplate,
      embed_unsynced_lyrics: runtime.embedUnsyncedLyrics,
      write_lrc_sidecar: runtime.writeLrcSidecar,
      lyrics_api_base_url: runtime.lyricsApiBaseUrl,
      spotify_match_enabled: Boolean(runtime.lyricsApiBaseUrl.trim()),
      existing_local_youtube_music_track_ids: existingLocalIds.sourceIds,
      existing_local_resolved_youtube_music_track_ids:
        existingLocalIds.resolvedIds,
      existing_local_track_signatures: existingLocalIds.trackSignatures,
      existing_local_release_signatures: existingLocalIds.releaseSignatures,
      favorite_artist_catalogs: existingLocalIds.favoriteArtistCatalogs,
      force_reprocess: false,
      ffmpeg_path: this.getBundledFfmpegPath(),
      yt_dlp_plugin_dir: poTokenBundle.pluginDirectory,
      yt_dlp_po_token_base_url: poTokenBundle.baseUrl,
    })

    this.pendingWorkerLaunches.delete(jobId)
    await this.db
      .update(syncJobsTable)
      .set({
        status: 'running',
        queueBucket: 'queue',
        updatedAt: nowIso(),
      })
      .where(eq(syncJobsTable.id, jobId))

    this.activeJobId = jobId
    this.activeProcess = child

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

      const cancelled =
        this.cancelRequestedJobId === jobId || status === 'cancelled'
      this.activeProcess = null
      if (this.activeJobId === jobId) this.activeJobId = null
      if (this.cancelRequestedJobId === jobId) this.cancelRequestedJobId = null

      await this.recomputeJob(jobId, cancelled ? 'cancelled' : undefined)
      const job = await this.db.query.syncJobsTable.findFirst({
        where: eq(syncJobsTable.id, jobId),
      })
      if (status === 'completed' && job?.status === 'completed') {
        await this.refreshIndexedOutputsForJob(jobId)
      }
      if (status !== 'completed') {
        this.logSync({
          level: status === 'cancelled' ? 'warn' : 'error',
          jobId,
          stage: 'finalize',
          event: status === 'cancelled' ? 'worker-cancelled' : 'worker-exit',
          message:
            details?.errorMessage ??
            stderrBuffer.trim().split('\n').filter(Boolean).at(-1) ??
            `Worker exited with status ${status}.`,
          context: {
            exit_code: details?.code ?? null,
            signal: details?.signal ?? null,
          },
        })
      }
      await this.emitSnapshot()
      void this.runScheduler()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      let nextNewline = stdoutBuffer.indexOf('\n')
      while (nextNewline >= 0) {
        const line = stdoutBuffer.slice(0, nextNewline).trim()
        stdoutBuffer = stdoutBuffer.slice(nextNewline + 1)
        if (line.startsWith('{')) {
          void this.handleWorkerEvent(jobId, line)
        }
        nextNewline = stdoutBuffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      writeStderrRaw(chunk)
    })

    child.on('exit', (code, signal) => {
      const status =
        this.cancelRequestedJobId === jobId
          ? 'cancelled'
          : code === 0
            ? 'completed'
            : signal === 'SIGTERM'
              ? 'cancelled'
              : 'failed'
      void finalize(status, { code, signal })
    })
    child.on('error', (error) => {
      void finalize('failed', { errorMessage: error.message })
    })

    await this.emitSnapshot()
  }

  private async startReprocessJob(
    scope: 'library' | 'artist',
    selectedArtists: LikedArtistView[] = []
  ): Promise<CommandResult> {
    const runtime =
      (await this.settingsService.getRuntimeSettings()) as RuntimeSettingsLike
    if (!runtime.outputDirectory) {
      return {
        ok: false,
        message: 'Output directory must be configured first.',
      }
    }
    if (!runtime.ytmusicBrowserAuth) {
      return {
        ok: false,
        message: 'Pull YT Music auth from your browser first.',
      }
    }

    const indexStatus = await this.libraryService.ensureLocalIndexReady()
    if (!indexStatus.ready) {
      return this.libraryService.getIndexNotReadyResult(indexStatus)
    }

    const authResult =
      await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
        'auth-status',
        { browser_auth_input: runtime.ytmusicBrowserAuth }
      )
    if (!authResult.ok || !authResult.is_authenticated) {
      return {
        ok: false,
        message: authResult.message || 'YT Music auth check failed.',
      }
    }

    await this.poTokenService.ensureReady()
    const poTokenBundle = this.getPoTokenBundle()
    const browserAuthInput =
      authResult.credential_json ?? runtime.ytmusicBrowserAuth
    if (authResult.credential_json) {
      await this.settingsService.saveYtMusicBrowserAuth(
        authResult.credential_json
      )
    }

    const candidates = await this.buildReprocessCandidates(selectedArtists)
    if (candidates.length === 0) {
      return {
        ok: false,
        message:
          scope === 'artist'
            ? 'No eligible local artist tracks found to reprocess.'
            : 'No eligible local tracks found to reprocess.',
      }
    }

    const jobId = await this.createJob({
      kind: 'reprocess',
      scope,
      label:
        scope === 'artist' ? 'Reprocess Artist Songs' : 'Reprocess Library',
      status: 'running',
      queueBucket: 'queue',
      plannedCount: candidates.length,
    })
    if (scope === 'artist' && selectedArtists.length > 0) {
      this.reprocessPreexistingManagedFiles.set(
        jobId,
        await this.getManagedFilesForArtists(selectedArtists)
      )
    }

    const preview = await this.pythonWorker.runJsonCommand<{
      items: ReprocessPreviewRow[]
    }>('reprocess-preview', {
      job_id: jobId,
      output_directory: runtime.outputDirectory,
      remote_copy_enabled: runtime.remoteCopyEnabled,
      rclone_remote: runtime.rcloneRemote,
      remote_music_root: runtime.remoteMusicRoot,
      ytmusic_browser_auth: browserAuthInput,
      yt_dlp_cookies_browser: runtime.ytDlpCookiesBrowser,
      folder_template: runtime.folderTemplate,
      file_template: runtime.fileTemplate,
      embed_unsynced_lyrics: runtime.embedUnsyncedLyrics,
      write_lrc_sidecar: runtime.writeLrcSidecar,
      lyrics_api_base_url: runtime.lyricsApiBaseUrl,
      spotify_match_enabled: Boolean(runtime.lyricsApiBaseUrl.trim()),
      ffmpeg_path: this.getBundledFfmpegPath(),
      yt_dlp_plugin_dir: poTokenBundle.pluginDirectory,
      yt_dlp_po_token_base_url: poTokenBundle.baseUrl,
      items: candidates,
    })

    let visibleCount = 0
    const timestamp = nowIso()
    const autoApprove = Boolean(runtime.autoApproveChanges)
    for (const [index, row] of preview.items.entries()) {
      if (row.action_kind === 'noop' || Object.keys(row.diff).length === 0) {
        continue
      }
      visibleCount += 1
      const itemPayload = row.payload.item as WorkerTrackPayload
      await this.upsertJobTrack(jobId, itemPayload, {
        id: row.track_work_id,
        libraryTrackId: row.library_track_id,
        currentOutputPath:
          typeof row.before.outputPath === 'string'
            ? row.before.outputPath
            : null,
        outputPath:
          typeof row.after.outputPath === 'string'
            ? row.after.outputPath
            : null,
        lrcPath:
          typeof row.after.lrcPath === 'string' ? row.after.lrcPath : null,
        visible: true,
        approvalRequired: true,
        sortIndex: index,
        status: 'pending',
        stage: 'idle',
        reasonCode: autoApprove ? '' : 'awaiting_approval',
        reasonDetail: autoApprove ? '' : 'Waiting for approval.',
        jobPhase: 'reprocess_preview',
      })
      await this.db.insert(syncApprovalItemsTable).values({
        id: createId('approval'),
        jobId,
        trackWorkId: row.track_work_id,
        libraryTrackId: row.library_track_id,
        status: autoApprove ? 'approved' : 'pending',
        actionKind: row.action_kind,
        diffJson: JSON.stringify(row.diff),
        beforeJson: JSON.stringify(row.before),
        afterJson: JSON.stringify(row.after),
        albumArtDiffJson: row.album_art_diff
          ? JSON.stringify(row.album_art_diff)
          : null,
        payloadJson: JSON.stringify(row.payload),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }

    if (visibleCount === 0) {
      await this.db
        .update(syncJobsTable)
        .set({
          status: 'completed',
          queueBucket: 'completed',
          endedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(eq(syncJobsTable.id, jobId))
      await this.emitSnapshot()
      return {
        ok: true,
        message: 'Reprocess preview complete. No changes found.',
      }
    }

    await this.recomputeJob(jobId)
    await this.emitSnapshot()
    if (autoApprove) void this.runScheduler()
    return {
      ok: true,
      message: autoApprove
        ? 'Reprocess queued.'
        : 'Reprocess preview complete. Review changes in Needs Approval.',
    }
  }

  private async runScheduler() {
    if (this.schedulerRunning || this.activeJobId) return
    this.schedulerRunning = true
    try {
      while (!this.activeJobId) {
        const next = await this.getNextRunnableJob()
        if (!next) break
        if (this.pendingWorkerLaunches.has(next.id)) {
          await this.pendingWorkerLaunches.get(next.id)!()
        } else if (next.kind === 'reprocess') {
          await this.runReprocessApplyJob(
            next.id,
            next.scope as 'library' | 'artist' | null
          )
        } else if (next.kind === 'sync_missing_to_remote') {
          await this.runRemoteBackfillJob(next.id)
        } else {
          break
        }
      }
    } finally {
      this.schedulerRunning = false
    }
  }

  private async getNextRunnableJob() {
    const jobs = await this.db
      .select()
      .from(syncJobsTable)
      .where(eq(syncJobsTable.status, 'queued'))
      .orderBy(desc(syncJobsTable.createdAt))
    for (const job of jobs.reverse()) {
      if (job.kind !== 'reprocess') return job
      const approved = await this.db
        .select()
        .from(syncApprovalItemsTable)
        .where(
          and(
            eq(syncApprovalItemsTable.jobId, job.id),
            eq(syncApprovalItemsTable.status, 'approved')
          )
        )
      if (approved.length > 0) return job
    }
    return null
  }

  private async runReprocessApplyJob(
    jobId: string,
    scope: 'library' | 'artist' | null
  ) {
    this.activeJobId = jobId
    await this.db
      .update(syncJobsTable)
      .set({ status: 'running', queueBucket: 'queue', updatedAt: nowIso() })
      .where(eq(syncJobsTable.id, jobId))
    await this.emitSnapshot()

    const approvals = await this.db
      .select()
      .from(syncApprovalItemsTable)
      .where(
        and(
          eq(syncApprovalItemsTable.jobId, jobId),
          eq(syncApprovalItemsTable.status, 'approved')
        )
      )

    for (const approval of approvals) {
      if (this.cancelRequestedJobId === jobId) break
      await this.applyApprovedReprocessTrack(
        jobId,
        approval.trackWorkId,
        approval.id
      )
    }

    if (scope === 'artist' && this.cancelRequestedJobId !== jobId) {
      await this.cleanupArtistReprocessFiles(jobId)
    }
    await this.recomputeJob(
      jobId,
      this.cancelRequestedJobId === jobId ? 'cancelled' : undefined
    )
    if (this.cancelRequestedJobId === jobId) this.cancelRequestedJobId = null
    this.activeJobId = null
    await this.emitSnapshot()
  }

  private async runRemoteBackfillJob(jobId: string) {
    this.activeJobId = jobId
    const settings =
      (await this.settingsService.getRuntimeSettings()) as RuntimeSettingsLike
    let copied = 0
    let skippedExisting = 0
    let skippedNoLocal = 0
    let skippedMissingIdentity = 0
    let failed = 0
    let result: CommandResult = {
      ok: true,
      message: 'Remote backfill complete.',
      details:
        'Copied 0; skipped existing 0; skipped no local 0; skipped missing identity 0; failed 0.',
    }

    try {
      await this.db
        .update(syncJobsTable)
        .set({ status: 'running', queueBucket: 'queue', updatedAt: nowIso() })
        .where(eq(syncJobsTable.id, jobId))
      await this.emitSnapshot()

      const localRootUri = settings.outputDirectory.trim()
      const remoteRootUri = `${settings.rcloneRemote.trim()}:${settings.remoteMusicRoot.trim()}`
      const roots = await this.db.select().from(libraryRootsTable)
      const localRoot = roots.find(
        (root) => root.kind === 'local' && root.uri === localRootUri
      )
      if (!localRoot)
        throw new Error('Local output root not found in library scan.')

      const remoteScan = await this.scanRemoteShell(
        settings.rcloneRemote.trim(),
        settings.remoteMusicRoot.trim()
      )
      const tracks = (await this.db.select().from(libraryTracksTable)).filter(
        (track) => track.managedByApp
      )
      const files = await this.db.select().from(libraryFilesTable)
      const filesByTrackId = new Map<string, typeof files>()
      for (const file of files) {
        const current = filesByTrackId.get(file.trackId) ?? []
        current.push(file)
        filesByTrackId.set(file.trackId, current)
      }

      const remoteSourceIds = new Set<string>()
      const remoteResolvedIds = new Set<string>()
      for (const identity of remoteScan.identities) {
        if (identity.youtubeMusicTrackId)
          remoteSourceIds.add(identity.youtubeMusicTrackId)
        if (identity.resolvedYoutubeMusicTrackId) {
          remoteResolvedIds.add(identity.resolvedYoutubeMusicTrackId)
        }
      }

      const actionable: RemoteBackfillCandidate[] = []
      for (const [index, track] of tracks.entries()) {
        const payload = this.toRemoteBackfillTrackPayload(track)
        const sourceId = track.youtubeMusicTrackId
        const resolvedId = track.resolvedYoutubeMusicTrackId
        if (
          (sourceId && remoteSourceIds.has(sourceId)) ||
          (resolvedId && remoteResolvedIds.has(resolvedId))
        ) {
          skippedExisting += 1
          continue
        }
        if (!sourceId && !resolvedId) {
          skippedMissingIdentity += 1
          continue
        }

        const localFiles = (filesByTrackId.get(track.id) ?? [])
          .filter((file) => file.rootId === localRoot.id)
          .sort((left, right) => {
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
          continue
        }

        const localAudioPath =
          selected.absolutePathSnapshot ||
          path.join(localRoot.uri, selected.relativePath)
        const lrcCandidates = [
          selected.lrcPath,
          localAudioPath.replace(/\.[^/.]+$/, '.lrc'),
        ].filter((value): value is string => Boolean(value))
        let localLrcPath: string | null = null
        for (const candidate of [...new Set(lrcCandidates)]) {
          try {
            await access(candidate)
            localLrcPath = candidate
            break
          } catch {
            // ignore
          }
        }

        const remoteTarget = `${remoteRootUri.replace(/\/$/, '')}/${selected.relativePath}`
        const trackWorkId = `${jobId}:${track.id}`
        actionable.push({
          trackId: track.id,
          trackWorkId,
          payload,
          localAudioPath,
          localLrcPath,
          remoteTarget,
        })
        await this.upsertJobTrack(jobId, payload, {
          id: trackWorkId,
          libraryTrackId: track.id,
          visible: true,
          approvalRequired: false,
          sortIndex: index,
          status: 'pending',
          stage: 'remote_copy',
          reasonCode: '',
          reasonDetail: '',
          jobPhase: 'remote_backfill',
          remoteTarget,
          outputPath: localAudioPath,
          lrcPath: localLrcPath,
        })
      }

      await this.db
        .update(syncJobsTable)
        .set({ plannedCount: actionable.length, updatedAt: nowIso() })
        .where(eq(syncJobsTable.id, jobId))
      await this.recomputeJob(jobId)
      await this.emitSnapshot()

      for (const candidate of actionable) {
        if (this.cancelRequestedJobId === jobId) break
        await this.db
          .update(syncJobTracksTable)
          .set({
            status: 'processing',
            stage: 'remote_copy',
            updatedAt: nowIso(),
          })
          .where(eq(syncJobTracksTable.id, candidate.trackWorkId))
        await this.emitSnapshot()

        const audioCopy = await execa(
          'rclone',
          ['copyto', candidate.localAudioPath, candidate.remoteTarget],
          { reject: false }
        )
        if (audioCopy.exitCode !== 0) {
          failed += 1
          await this.db
            .update(syncJobTracksTable)
            .set({
              status: 'failed_retryable',
              stage: 'finalize',
              reasonCode: 'remote_audio_copy_failed',
              reasonDetail: audioCopy.stderr || 'rclone audio copy failed.',
              terminalOutcome: 'failed_remote_copy',
              updatedAt: nowIso(),
            })
            .where(eq(syncJobTracksTable.id, candidate.trackWorkId))
          await this.emitSnapshot()
          continue
        }

        if (candidate.localLrcPath) {
          const remoteLrcPath = candidate.remoteTarget.replace(
            /\.[^/.]+$/,
            '.lrc'
          )
          const lrcCopy = await execa(
            'rclone',
            ['copyto', candidate.localLrcPath, remoteLrcPath],
            { reject: false }
          )
          if (lrcCopy.exitCode !== 0) {
            failed += 1
            await this.db
              .update(syncJobTracksTable)
              .set({
                status: 'failed_retryable',
                stage: 'finalize',
                reasonCode: 'remote_lrc_copy_failed',
                reasonDetail: lrcCopy.stderr || 'rclone lrc copy failed.',
                terminalOutcome: 'failed_remote_copy',
                updatedAt: nowIso(),
              })
              .where(eq(syncJobTracksTable.id, candidate.trackWorkId))
            await this.emitSnapshot()
            continue
          }
        }

        await this.libraryService.upsertRemoteCopyFromLocalPath(
          candidate.localAudioPath
        )
        copied += 1
        await this.db
          .update(syncJobTracksTable)
          .set({
            status: 'completed',
            stage: 'finalize',
            reasonCode: 'remote_copied',
            reasonDetail: 'Copied local file to remote.',
            terminalOutcome: 'remote_copied',
            updatedAt: nowIso(),
          })
          .where(eq(syncJobTracksTable.id, candidate.trackWorkId))
        await this.emitSnapshot()
      }
      result = {
        ok: failed === 0,
        message:
          failed === 0
            ? 'Remote backfill complete.'
            : 'Remote backfill completed with failures.',
        details: `Copied ${copied}; skipped existing ${skippedExisting}; skipped no local ${skippedNoLocal}; skipped missing identity ${skippedMissingIdentity}; failed ${failed}.`,
      }
    } catch (error) {
      await this.db
        .update(syncJobsTable)
        .set({
          status: 'failed',
          queueBucket: 'failures',
          endedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(eq(syncJobsTable.id, jobId))
      this.activeJobId = null
      if (this.cancelRequestedJobId === jobId) this.cancelRequestedJobId = null
      await this.emitSnapshot()
      return {
        ok: false,
        message:
          error instanceof Error ? error.message : 'Remote backfill failed.',
      }
    }

    await this.recomputeJob(
      jobId,
      this.cancelRequestedJobId === jobId ? 'cancelled' : undefined
    )
    this.activeJobId = null
    if (this.cancelRequestedJobId === jobId) this.cancelRequestedJobId = null
    await this.emitSnapshot()
    logMain({
      level: failed === 0 ? 'info' : 'error',
      source: 'sync',
      runId: jobId,
      message: result.details
        ? `${result.message} ${result.details}`
        : result.message,
    })
    return result
  }

  private async handleWorkerEvent(jobId: string, line: string) {
    let event: WorkerEvent
    try {
      event = JSON.parse(line) as WorkerEvent
    } catch (error) {
      this.logSync({
        level: 'error',
        jobId,
        stage: 'finalize',
        event: 'ndjson-parse-failed',
        message: 'Worker emitted malformed NDJSON.',
        context: {
          line,
          parse_error: error instanceof Error ? error.message : String(error),
        },
      })
      return
    }

    if (event.type === 'job') {
      if (event.total_count != null) {
        await this.db
          .update(syncJobsTable)
          .set({ plannedCount: event.total_count, updatedAt: nowIso() })
          .where(eq(syncJobsTable.id, jobId))
      }
      if (event.message) {
        this.logSync({
          level:
            event.event === 'failed'
              ? 'error'
              : event.event === 'completed'
                ? 'info'
                : 'debug',
          jobId,
          stage: event.stage ?? 'finalize',
          event: `job.${event.event}`,
          message: event.message,
          context: event.context,
        })
      }
      if (event.event === 'completed') {
        await this.updateFavoriteCatalogStatsFromContext(jobId, event.context)
      }
      await this.recomputeJob(
        jobId,
        event.event === 'failed' ? 'failed' : undefined
      )
      await this.emitSnapshot()
      return
    }

    if (event.type === 'track') {
      await this.upsertJobTrack(jobId, event.item, {
        visible: event.item.status !== 'skipped_existing',
        approvalRequired: false,
      })
      await this.recomputeJob(jobId)
      await this.emitSnapshot()
      return
    }

    this.logWorkerEvent(event)
  }

  private logWorkerEvent(event: WorkerLogEvent) {
    logMain({
      level: event.level,
      source: 'worker',
      runId: event.job_id,
      itemId: event.item_id,
      timestamp: event.timestamp,
      message: `[${event.stage}] ${event.event} ${event.message}`,
      context: event.context,
    })
  }

  private logSync(input: {
    level: LogLevel
    jobId: string
    stage: SyncStage
    event: string
    message: string
    context?: Record<string, unknown>
  }) {
    logMain({
      level: input.level,
      source: 'sync',
      runId: input.jobId,
      message: `[${input.stage}] ${input.event} ${input.message}`,
      context: input.context,
    })
  }

  private async createJob(input: JobCreateInput) {
    const id = createId('job')
    const timestamp = nowIso()
    await this.db.insert(syncJobsTable).values({
      id,
      kind: input.kind,
      scope: input.scope,
      label: input.label,
      status: input.status ?? 'queued',
      queueBucket: input.queueBucket ?? 'queue',
      startedAt: timestamp,
      endedAt: null,
      plannedCount: input.plannedCount ?? 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    return id
  }

  private async upsertJobTrack(
    jobId: string,
    item: WorkerTrackPayload,
    overrides: Partial<{
      id: string
      libraryTrackId: string | null
      currentOutputPath: string | null
      outputPath: string | null
      lrcPath: string | null
      visible: boolean
      approvalRequired: boolean
      terminalOutcome: string | null
      sortIndex: number | null
      remoteTarget: string | null
      jobPhase: string | null
      status: SyncItemStatus
      stage: SyncStage
      reasonCode: string
      reasonDetail: string
    }> = {}
  ) {
    const timestamp = nowIso()
    const visible = overrides.visible ?? item.status !== 'skipped_existing'
    const status = overrides.status ?? item.status
    const stage = overrides.stage ?? item.stage
    const reasonCode = overrides.reasonCode ?? item.reason_code ?? ''
    const reasonDetail = overrides.reasonDetail ?? item.reason_detail ?? ''
    const terminalOutcome =
      overrides.terminalOutcome ??
      (status === 'completed'
        ? 'completed'
        : status === 'completed_local_only'
          ? 'completed_local_only'
          : status.startsWith('failed')
            ? status
            : status === 'skipped_existing'
              ? 'skipped_existing'
              : null)

    const values = {
      id: overrides.id ?? item.id,
      jobId,
      libraryTrackId: overrides.libraryTrackId ?? null,
      youtubeMusicTrackId: item.youtube_music_track_id,
      spotifyTrackId: item.spotify_track_id ?? null,
      soundcloudTrackId: item.soundcloud_track_id ?? null,
      resolvedYoutubeMusicTrackId: item.resolved_youtube_music_track_id ?? null,
      title: item.title,
      artist: item.artist,
      album: item.album,
      albumArtist: item.album_artist,
      sourceUrl: item.source_url,
      coverArtUrl: item.cover_art_url ?? null,
      status,
      stage,
      reasonCode,
      reasonDetail,
      sourceKind: item.source_kind ?? 'unknown',
      sourceOrigin: item.source_origin ?? null,
      catalogReleaseBrowseId: item.catalog_release_browse_id ?? null,
      catalogReleaseTitle: item.catalog_release_title ?? null,
      catalogReleaseKind: item.catalog_release_kind ?? null,
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
      visible,
      approvalRequired: overrides.approvalRequired ?? false,
      terminalOutcome,
      sortIndex: overrides.sortIndex ?? null,
      remoteTarget: overrides.remoteTarget ?? null,
      jobPhase: overrides.jobPhase ?? null,
      currentOutputPath: overrides.currentOutputPath ?? null,
      outputPath: overrides.outputPath ?? item.output_path ?? null,
      lrcPath: overrides.lrcPath ?? item.lrc_path ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    await this.db
      .insert(syncJobTracksTable)
      .values(values)
      .onConflictDoUpdate({
        target: syncJobTracksTable.id,
        set: {
          ...values,
          createdAt: undefined,
          updatedAt: timestamp,
        },
      })
  }

  private async recomputeJob(
    jobId: string,
    forcedTerminal?: 'failed' | 'cancelled'
  ) {
    const [job, tracks, approvals] = await Promise.all([
      this.db.query.syncJobsTable.findFirst({
        where: eq(syncJobsTable.id, jobId),
      }),
      this.db
        .select()
        .from(syncJobTracksTable)
        .where(eq(syncJobTracksTable.jobId, jobId)),
      this.db
        .select()
        .from(syncApprovalItemsTable)
        .where(eq(syncApprovalItemsTable.jobId, jobId)),
    ])
    if (!job) return

    const visibleTracks = tracks.filter((track) => track.visible)
    const hasFailedVisibleTrack = visibleTracks.some((track) =>
      track.status.startsWith('failed')
    )
    const hasPendingApproval = approvals.some((row) => row.status === 'pending')
    const hasProcessing = visibleTracks.some(
      (track) => track.status === 'processing'
    )
    const hasPending = visibleTracks.some((track) => track.status === 'pending')

    let status: SyncJobStatus
    let queueBucket: SyncJobView['bucket']
    let endedAt: string | null

    if (forcedTerminal === 'cancelled' || job.status === 'cancelled') {
      status = 'cancelled'
      queueBucket = 'failures'
      endedAt = nowIso()
    } else if (forcedTerminal === 'failed' || hasFailedVisibleTrack) {
      status = 'failed'
      queueBucket = 'failures'
      endedAt = nowIso()
    } else if (hasProcessing || this.activeJobId === jobId) {
      status = 'running'
      queueBucket = 'queue'
      endedAt = null
    } else if (hasPending) {
      status = 'queued'
      queueBucket = 'queue'
      endedAt = null
    } else if (hasPendingApproval) {
      status = 'waiting_approval'
      queueBucket = 'needs_approval'
      endedAt = null
    } else {
      status = 'completed'
      queueBucket = 'completed'
      endedAt = nowIso()
    }

    await this.db
      .update(syncJobsTable)
      .set({
        status,
        queueBucket,
        endedAt,
        updatedAt: nowIso(),
      })
      .where(eq(syncJobsTable.id, jobId))
  }

  private toTrackView(
    track: typeof syncJobTracksTable.$inferSelect
  ): SyncTrackWorkView {
    return {
      id: track.id,
      jobId: track.jobId,
      title: track.title,
      artist: track.artist,
      album: track.album,
      youtubeMusicTrackId: track.youtubeMusicTrackId,
      resolvedYoutubeMusicTrackId: track.resolvedYoutubeMusicTrackId,
      status: track.status as SyncItemStatus,
      stage: track.stage as SyncStage,
      reasonCode: track.reasonCode,
      reasonDetail: track.reasonDetail,
      outputPath: track.outputPath,
      lrcPath: track.lrcPath,
    }
  }

  private getPoTokenBundle(): PoTokenBundle {
    return this.poTokenService.getBundleStatus() as PoTokenBundle
  }

  private async buildReprocessCandidates(
    selectedArtists: LikedArtistView[]
  ): Promise<ReprocessCandidatePayload[]> {
    const settings =
      (await this.settingsService.getRuntimeSettings()) as RuntimeSettingsLike
    const localRoot = await this.db.query.libraryRootsTable.findFirst({
      where: and(
        eq(libraryRootsTable.kind, 'local'),
        eq(libraryRootsTable.uri, settings.outputDirectory)
      ),
    })
    if (!localRoot) return []

    const [tracks, files] = await Promise.all([
      this.db.select().from(libraryTracksTable),
      this.db
        .select()
        .from(libraryFilesTable)
        .where(eq(libraryFilesTable.rootId, localRoot.id)),
    ])
    const filesByTrackId = new Map<string, typeof files>()
    for (const file of files) {
      const current = filesByTrackId.get(file.trackId) ?? []
      current.push(file)
      filesByTrackId.set(file.trackId, current)
    }

    const candidates: ReprocessCandidatePayload[] = []
    for (const track of tracks) {
      if (!track.managedByApp || !track.sourceOrigin) continue
      if (
        selectedArtists.length > 0 &&
        !this.trackMatchesSelectedArtists(track.artist, selectedArtists)
      ) {
        continue
      }
      const localFiles = filesByTrackId.get(track.id) ?? []
      const selectedFile =
        localFiles.find((file) => file.id === track.preferredFileId) ??
        localFiles.find((file) => Boolean(file.absolutePathSnapshot)) ??
        null
      if (!selectedFile?.absolutePathSnapshot) continue
      try {
        await access(selectedFile.absolutePathSnapshot)
      } catch {
        continue
      }
      candidates.push({
        track_work_id: createId('track'),
        library_track_id: track.id,
        youtube_music_track_id: track.youtubeMusicTrackId,
        spotify_track_id: track.spotifyTrackId,
        soundcloud_track_id: track.soundcloudTrackId,
        resolved_youtube_music_track_id: track.resolvedYoutubeMusicTrackId,
        source_origin: track.sourceOrigin,
        catalog_release_browse_id: track.catalogReleaseBrowseId,
        catalog_release_title: track.catalogReleaseTitle,
        catalog_release_kind: track.catalogReleaseKind,
        title: track.title,
        artist: track.artist,
        album: track.album,
        album_artist: track.albumArtist,
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
        lyrics_status: track.lyricsStatus,
        current_output_path: selectedFile.absolutePathSnapshot,
        current_lrc_path: selectedFile.lrcPath,
        cover_art_present: track.coverArtPresent,
      })
    }
    return candidates
  }

  private async applyApprovedReprocessTrack(
    jobId: string,
    trackId: string,
    approvalId: string
  ) {
    const [track, approval, settings] = await Promise.all([
      this.db.query.syncJobTracksTable.findFirst({
        where: eq(syncJobTracksTable.id, trackId),
      }),
      this.db.query.syncApprovalItemsTable.findFirst({
        where: eq(syncApprovalItemsTable.id, approvalId),
      }),
      this.settingsService.getRuntimeSettings(),
    ])
    if (!track || !approval) return

    await this.db
      .update(syncJobTracksTable)
      .set({
        status: 'processing',
        stage: approval.actionKind === 'replace' ? 'download' : 'tagging',
        reasonCode: '',
        reasonDetail: '',
        jobPhase: 'reprocess_apply',
        updatedAt: nowIso(),
      })
      .where(eq(syncJobTracksTable.id, trackId))
    await this.emitSnapshot()

    try {
      await this.poTokenService.ensureReady()
      const poTokenBundle = this.getPoTokenBundle()
      const runtime = settings as RuntimeSettingsLike
      const authStatus =
        await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
          'auth-status',
          { browser_auth_input: runtime.ytmusicBrowserAuth }
        )
      const browserAuthInput =
        authStatus.credential_json ?? runtime.ytmusicBrowserAuth
      const result =
        await this.pythonWorker.runJsonCommand<ReprocessApplyResult>(
          'reprocess-apply',
          {
            job_id: jobId,
            output_directory: runtime.outputDirectory,
            remote_copy_enabled: runtime.remoteCopyEnabled,
            rclone_remote: runtime.rcloneRemote,
            remote_music_root: runtime.remoteMusicRoot,
            ytmusic_browser_auth: browserAuthInput,
            yt_dlp_cookies_browser: runtime.ytDlpCookiesBrowser,
            folder_template: runtime.folderTemplate,
            file_template: runtime.fileTemplate,
            embed_unsynced_lyrics: runtime.embedUnsyncedLyrics,
            write_lrc_sidecar: runtime.writeLrcSidecar,
            lyrics_api_base_url: runtime.lyricsApiBaseUrl,
            spotify_match_enabled: Boolean(runtime.lyricsApiBaseUrl.trim()),
            ffmpeg_path: this.getBundledFfmpegPath(),
            yt_dlp_plugin_dir: poTokenBundle.pluginDirectory,
            yt_dlp_po_token_base_url: poTokenBundle.baseUrl,
            payload: JSON.parse(approval.payloadJson),
          }
        )

      const before = JSON.parse(approval.beforeJson) as {
        outputPath?: string | null
        lrcPath?: string | null
      }
      await this.db
        .update(syncJobTracksTable)
        .set({
          status: 'completed',
          stage: 'finalize',
          reasonCode: 'reprocess_applied',
          reasonDetail: 'Approved reprocess applied.',
          outputPath: result.output_path,
          lrcPath: result.lrc_path,
          terminalOutcome: result.replaced ? 'replaced' : 'updated',
          updatedAt: nowIso(),
        })
        .where(eq(syncJobTracksTable.id, trackId))
      await this.syncIndexedArtifacts({
        previousOutputPath: before.outputPath ?? null,
        previousLrcPath: before.lrcPath ?? null,
        nextOutputPath: result.output_path,
      })
    } catch (error) {
      await this.db
        .update(syncJobTracksTable)
        .set({
          status: 'failed_terminal',
          stage: 'finalize',
          reasonCode: 'reprocess_apply_failed',
          reasonDetail:
            error instanceof Error ? error.message : 'Reprocess apply failed.',
          terminalOutcome: 'failed_reprocess_apply',
          updatedAt: nowIso(),
        })
        .where(eq(syncJobTracksTable.id, trackId))
    }
  }

  private async syncIndexedArtifacts(input: {
    previousOutputPath: string | null
    previousLrcPath: string | null
    nextOutputPath: string
  }) {
    const settings =
      (await this.settingsService.getRuntimeSettings()) as RuntimeSettingsLike
    await this.libraryService.upsertLocalOutputs([input.nextOutputPath])
    if (
      input.previousOutputPath &&
      input.previousOutputPath !== input.nextOutputPath
    ) {
      const relativePath = path
        .relative(settings.outputDirectory, input.previousOutputPath)
        .split(path.sep)
        .join('/')
      await this.libraryService.pruneIndexedFile(
        settings.outputDirectory,
        relativePath
      )
    }
    if (settings.remoteCopyEnabled) {
      await this.libraryService.upsertRemoteCopyFromLocalPath(
        input.nextOutputPath
      )
    }
    await this.likedArtistsService.refreshArtists()
  }

  private async refreshIndexedOutputsForJob(jobId: string) {
    try {
      const tracks = await this.db
        .select()
        .from(syncJobTracksTable)
        .where(eq(syncJobTracksTable.jobId, jobId))

      const touchedLocalOutputs = tracks
        .filter((track) =>
          ['completed', 'completed_local_only'].includes(track.status)
        )
        .map((track) => track.outputPath)
        .filter((value): value is string => Boolean(value))

      if (touchedLocalOutputs.length > 0) {
        await this.libraryService.upsertLocalOutputs(touchedLocalOutputs)
        await this.likedArtistsService.refreshArtists()
      }

      for (const track of tracks) {
        if (track.status !== 'completed' || !track.outputPath) continue
        await this.libraryService.upsertRemoteCopyFromLocalPath(
          track.outputPath
        )
      }
    } catch (error) {
      this.logSync({
        level: 'error',
        jobId,
        stage: 'finalize',
        event: 'post-job-index-update-failed',
        message:
          error instanceof Error
            ? error.message
            : 'Post-job index update failed.',
      })
    }
  }

  private async updateFavoriteCatalogStatsFromContext(
    jobId: string,
    context?: Record<string, unknown>
  ) {
    const counts = context?.favorite_artist_catalog_counts
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return

    const selectedArtists = this.jobSelectedArtists.get(jobId) ?? []
    const selectedIds = new Set(selectedArtists.map((artist) => artist.id))
    const parsed: Record<string, number> = {}
    for (const [artistId, count] of Object.entries(counts)) {
      if (
        selectedIds.has(artistId) &&
        typeof count === 'number' &&
        Number.isFinite(count) &&
        count >= 0
      ) {
        parsed[artistId] = Math.trunc(count)
      }
    }
    if (Object.keys(parsed).length > 0) {
      await this.likedArtistsService.updateFavoriteCatalogStats(parsed)
    }
  }

  private toRemoteBackfillTrackPayload(
    track: typeof libraryTracksTable.$inferSelect
  ): WorkerTrackPayload {
    return {
      id: track.id,
      youtube_music_track_id:
        track.youtubeMusicTrackId ??
        track.resolvedYoutubeMusicTrackId ??
        track.id,
      spotify_track_id: track.spotifyTrackId,
      soundcloud_track_id: track.soundcloudTrackId,
      resolved_youtube_music_track_id: track.resolvedYoutubeMusicTrackId,
      title: track.title ?? track.identityValue,
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
      source_origin: track.sourceOrigin,
      catalog_release_browse_id: track.catalogReleaseBrowseId,
      catalog_release_title: track.catalogReleaseTitle,
      catalog_release_kind: track.catalogReleaseKind,
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
      lyrics_status: track.lyricsStatus as 'missing' | 'plain' | 'synced',
      metadata_matched: true,
      musicbrainz_matched: Boolean(track.mbTrackId),
      lyrics_matched: track.lyricsStatus !== 'missing',
    }
  }

  private async emitSnapshot() {
    const snapshot = await this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private killActiveProcess(signal: NodeJS.Signals) {
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

  private async failPendingTracksForCancellation(jobId: string) {
    await this.db
      .update(syncJobTracksTable)
      .set({
        status: 'failed_terminal',
        stage: 'finalize',
        reasonCode: 'cancelled',
        reasonDetail: 'Job cancelled.',
        terminalOutcome: 'cancelled',
        updatedAt: nowIso(),
      })
      .where(eq(syncJobTracksTable.jobId, jobId))
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

  private async cleanupArtistReprocessFiles(jobId: string) {
    const previous = this.reprocessPreexistingManagedFiles.get(jobId) ?? []
    if (previous.length === 0) return

    const settings =
      (await this.settingsService.getRuntimeSettings()) as RuntimeSettingsLike
    const tracks = await this.db
      .select()
      .from(syncJobTracksTable)
      .where(eq(syncJobTracksTable.jobId, jobId))
    const currentLocal = new Set(
      tracks
        .filter((row) =>
          ['completed', 'completed_local_only'].includes(row.status)
        )
        .map((row) => row.outputPath)
        .filter((value): value is string => Boolean(value))
    )
    const currentRemote = new Set(
      tracks
        .filter((row) => row.status === 'completed' && Boolean(row.outputPath))
        .map((row) => {
          if (
            !settings.remoteCopyEnabled ||
            !settings.rcloneRemote.trim() ||
            !settings.remoteMusicRoot.trim() ||
            !row.outputPath
          ) {
            return null
          }
          const relativePath = path
            .relative(settings.outputDirectory, row.outputPath)
            .split(path.sep)
            .join('/')
          return `${settings.rcloneRemote.trim()}:${settings.remoteMusicRoot.trim()}|${relativePath}`
        })
        .filter((value): value is string => Boolean(value))
    )

    for (const row of previous) {
      if (row.rootKind === 'local') {
        if (
          !row.absolutePathSnapshot ||
          currentLocal.has(row.absolutePathSnapshot)
        ) {
          continue
        }
        const relativePath = path
          .relative(settings.outputDirectory, row.absolutePathSnapshot)
          .split(path.sep)
          .join('/')
        await this.libraryService.pruneIndexedFile(row.rootUri, relativePath)
      } else {
        const remoteKey = `${row.rootUri}|${row.relativePath}`
        if (currentRemote.has(remoteKey)) continue
        await this.libraryService.pruneIndexedFile(
          row.rootUri,
          row.relativePath
        )
      }
    }
    this.reprocessPreexistingManagedFiles.delete(jobId)
  }
}
