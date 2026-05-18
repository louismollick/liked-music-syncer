export type SyncTriggerMode = 'manual'

export type SyncStage =
  | 'idle'
  | 'ytmusic_auth'
  | 'liked_songs_fetch'
  | 'source_resolve'
  | 'album_enrich'
  | 'musicbrainz_enrich'
  | 'lyrics_resolve'
  | 'download'
  | 'fixup'
  | 'tagging'
  | 'write_output'
  | 'remote_copy'
  | 'finalize'

export type SyncItemStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'completed_local_only'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'skipped_existing'

export type RunStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type YtMusicAuthMode = 'oauth_device' | 'browser_headers'
export type YtDlpCookiesBrowser =
  | 'brave'
  | 'chrome'
  | 'chromium'
  | 'edge'
  | 'firefox'
  | 'opera'
  | 'safari'
  | 'vivaldi'
  | 'whale'

export interface DeviceAuthSessionView {
  verificationUrl: string
  userCode: string
  intervalSeconds: number
  expiresAt: string
  startedAt: string
}

export interface AuthStatus {
  authMode: YtMusicAuthMode | 'none'
  hasClientConfig: boolean
  isAuthenticated: boolean
  hasOAuthToken: boolean
  hasBrowserAuth: boolean
  pendingDeviceAuth: DeviceAuthSessionView | null
  lastError: string | null
}

export interface AppSettingsView {
  outputDirectory: string
  dryRun: boolean
  remoteCopyEnabled: boolean
  outputFormat: 'm4a'
  rcloneRemote: string
  remoteMusicRoot: string
  ytmusicAuthMode: YtMusicAuthMode
  ytmusicClientId: string
  hasYtMusicClientSecret: boolean
  hasYtMusicOAuthToken: boolean
  hasYtMusicBrowserAuth: boolean
  ytDlpCookiesBrowser: YtDlpCookiesBrowser
  folderTemplate: string
  fileTemplate: string
  embedUnsyncedLyrics: boolean
  writeLrcSidecar: boolean
}

export interface SaveSettingsInput {
  outputDirectory: string
  dryRun: boolean
  remoteCopyEnabled: boolean
  ytmusicAuthMode: YtMusicAuthMode
  ytmusicClientId: string
  ytmusicClientSecret?: string
  ytmusicBrowserAuth?: string
  ytDlpCookiesBrowser: YtDlpCookiesBrowser
  rcloneRemote: string
  remoteMusicRoot: string
  folderTemplate: string
  fileTemplate: string
  embedUnsyncedLyrics: boolean
  writeLrcSidecar: boolean
}

export interface CommandResult {
  ok: boolean
  message: string
  details?: string
}

export interface SettingsSaveResult extends CommandResult {
  authStatus?: AuthStatus
}

export interface DeviceAuthStartResult extends CommandResult {
  pendingDeviceAuth: DeviceAuthSessionView | null
}

export interface DeviceAuthFinishResult extends CommandResult {
  state: 'pending' | 'authorized' | 'expired' | 'failed'
  authStatus: AuthStatus
}

export interface BrowserAuthCaptureResult extends CommandResult {
  authStatus: AuthStatus
}

export interface SongLogEntry {
  id: number
  runId: string
  sourceVideoId: string
  itemId: string
  timestamp: string
  level: LogLevel
  stage: SyncStage
  event: string
  message: string
  contextJson: string
}

export interface SyncRunItemView {
  id: string
  runId: string
  sourceVideoId: string
  title: string
  artist: string
  album: string
  albumArtist: string
  sourceUrl: string
  coverArtUrl: string | null
  status: SyncItemStatus
  stage: SyncStage
  reasonCode: string
  reasonDetail: string
  sourceKind: string
  videoType: string | null
  resolutionMethod: string
  trackNumber: number | null
  trackTotal: number | null
  year: number | null
  date: string | null
  audioCodec: string | null
  metadataMatched: boolean
  musicBrainzMatched: boolean
  lyricsMatched: boolean
  lyricsSource: string | null
  selectedSourceUrl: string | null
  outputPath: string | null
  lrcPath: string | null
}

export interface SyncRunSummary {
  id: string
  triggerMode: SyncTriggerMode
  status: RunStatus
  startedAt: string
  endedAt: string | null
  logDirectory: string
  totalCount: number
  processedCount: number
  completedCount: number
  failedCount: number
  skippedCount: number
}

export interface SyncRunDetail extends SyncRunSummary {
  items: SyncRunItemView[]
}

export interface SyncSnapshot {
  activeRun: SyncRunDetail | null
  runs: SyncRunSummary[]
}

export interface BinaryStatus {
  uv: string | null
  ffmpeg: string | null
  rclone: string | null
}

export interface ElectronApi {
  auth: {
    getStatus: () => Promise<AuthStatus>
    startDeviceAuth: () => Promise<DeviceAuthStartResult>
    finishDeviceAuth: () => Promise<DeviceAuthFinishResult>
    captureBrowserAuth: (
      browser: YtDlpCookiesBrowser
    ) => Promise<BrowserAuthCaptureResult>
    disconnect: () => Promise<CommandResult>
  }
  settings: {
    get: () => Promise<AppSettingsView>
    save: (input: SaveSettingsInput) => Promise<SettingsSaveResult>
    testBinaries: () => Promise<BinaryStatus>
    testRemote: () => Promise<CommandResult>
    pickOutputDirectory: () => Promise<string | null>
  }
  sync: {
    start: (input?: { mode?: SyncTriggerMode }) => Promise<CommandResult>
    cancel: (runId: string) => Promise<CommandResult>
    clearSyncData: () => Promise<CommandResult>
    doctor: () => Promise<CommandResult>
    listRuns: () => Promise<SyncRunSummary[]>
    getRun: (runId: string) => Promise<SyncRunDetail | null>
    getSnapshot: () => Promise<SyncSnapshot>
    getRunLogs: (runId: string) => Promise<SongLogEntry[]>
    getSongLogs: (input: {
      runId: string
      sourceVideoId: string
    }) => Promise<SongLogEntry[]>
    subscribe: (listener: (snapshot: SyncSnapshot) => void) => () => void
  }
}
