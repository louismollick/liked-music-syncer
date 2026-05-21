export type SyncTriggerMode = 'manual' | 'artist_reprocess'

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
export type LyricsStatus = 'missing' | 'plain' | 'synced'
export type IdentityKind =
  | 'lms_source'
  | 'mb_track'
  | 'isrc'
  | 'heuristic'
  | 'path'
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

export interface AuthStatus {
  authMode: 'browser_headers' | 'none'
  isAuthenticated: boolean
  hasBrowserAuth: boolean
  lastError: string | null
}

export interface AppSettingsView {
  outputDirectory: string
  dryRun: boolean
  remoteCopyEnabled: boolean
  outputFormat: 'm4a'
  rcloneRemote: string
  remoteMusicRoot: string
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

export interface RemoteMissingTrackPreview {
  trackId: string
  title: string
  artist: string
  album: string
  relativePath: string
  localAudioPath: string
  remoteAudioPath: string
  lyricsStatus: LyricsStatus
  hasEmbeddedLyrics: boolean
  hasSidecarLyrics: boolean
  coverThumbnailDataUrl: string | null
}

export interface RemoteMissingPreviewResult extends CommandResult {
  tracks: RemoteMissingTrackPreview[]
}

export interface SettingsSaveResult extends CommandResult {
  authStatus?: AuthStatus
}

export interface BrowserAuthCaptureResult extends CommandResult {
  authStatus: AuthStatus
}

export interface SongLogEntry {
  id: number
  runId: string
  youtubeMusicTrackId: string
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
  youtubeMusicTrackId: string
  spotifyTrackId: string | null
  soundcloudTrackId: string | null
  resolvedYoutubeMusicTrackId: string | null
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

export interface LibraryRootView {
  id: string
  kind: 'local' | 'remote'
  transport: 'filesystem' | 'rclone'
  label: string
  uri: string
  writable: boolean
  managedOutput: boolean
  createdAt: string
  updatedAt: string
  lastScannedAt: string | null
  lastScanStatus: string | null
}

export interface LibraryFileView {
  id: string
  trackId: string
  rootId: string
  relativePath: string
  absolutePathSnapshot: string | null
  lrcPath: string | null
  format: string
  sizeBytes: number | null
  durationSeconds: number | null
  bitrate: number | null
  modifiedAt: string | null
  audioSha256: string | null
  tagFingerprint: string | null
  embeddedLyricsStatus: LyricsStatus
  sidecarLyricsStatus: LyricsStatus
  missingFields: string[]
  discoveredVia: IdentityKind | 'lms_tags'
  lastScannedAt: string
  firstSeenAt: string
  updatedAt: string
}

export interface LibraryTrackView {
  id: string
  identityKind: IdentityKind
  identityValue: string
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
  missingFields: string[]
  preferredFileId: string | null
  firstSeenAt: string
  lastSeenAt: string
  updatedAt: string
  files?: LibraryFileView[]
}

export interface LibraryTrackFilter {
  managedByApp?: boolean
  identityKind?: IdentityKind
  rootKind?: 'local' | 'remote'
  lyricsStatus?: LyricsStatus
  missingField?: string
}

export interface DriftSummary {
  totalManagedTracks: number
  inSyncTracks: number
  localOnlyTracks: number
  remoteOnlyTracks: number
  missingEverywhereTracks: number
}

export interface BinaryStatus {
  uv: string | null
  ffmpeg: string | null
  rclone: string | null
}

export interface LikedArtistView {
  id: string
  channelId: string | null
  name: string
  normalizedName: string
  photoUrl: string | null
  likedTrackCount: number
  lastRefreshedAt: string
}

export interface ElectronApi {
  auth: {
    getStatus: () => Promise<AuthStatus>
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
    reprocessArtists: (artistIds: string[]) => Promise<CommandResult>
    cancel: (runId: string) => Promise<CommandResult>
    clearSyncData: () => Promise<CommandResult>
    findMissingRemoteTracks: () => Promise<RemoteMissingPreviewResult>
    syncMissingToRemote: (input: {
      trackIds: string[]
    }) => Promise<CommandResult>
    doctor: () => Promise<CommandResult>
    listRuns: () => Promise<SyncRunSummary[]>
    getRun: (runId: string) => Promise<SyncRunDetail | null>
    getSnapshot: () => Promise<SyncSnapshot>
    getRunLogs: (runId: string) => Promise<SongLogEntry[]>
    getSongLogs: (input: {
      runId: string
      youtubeMusicTrackId: string
    }) => Promise<SongLogEntry[]>
    subscribe: (listener: (snapshot: SyncSnapshot) => void) => () => void
  }
  library: {
    scanRoots: () => Promise<CommandResult>
    refreshArtists: () => Promise<CommandResult>
    listArtists: () => Promise<LikedArtistView[]>
    listTracks: (filter?: LibraryTrackFilter) => Promise<LibraryTrackView[]>
    getTrack: (trackId: string) => Promise<LibraryTrackView | null>
    getDriftSummary: () => Promise<DriftSummary>
    listRoots: () => Promise<LibraryRootView[]>
  }
}
