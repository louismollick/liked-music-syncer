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

export type SyncJobKind =
  | 'liked_songs_sync'
  | 'reprocess'
  | 'favorite_artist_catalog_refresh'
  | 'sync_missing_to_remote'

export type SyncJobScopeKind = 'library' | 'artist'
export type SyncBucket = 'queue' | 'needs_approval' | 'completed' | 'failures'
export type SyncJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AuthStatus {
  authMode: 'browser_headers' | 'none'
  isAuthenticated: boolean
  hasBrowserAuth: boolean
  lastError: string | null
}

export interface AppSettingsView {
  outputDirectory: string
  autoApproveChanges: boolean
  remoteCopyEnabled: boolean
  outputFormat: 'm4a'
  rcloneRemote: string
  remoteMusicRoot: string
  lyricsApiBaseUrl: string
  hasYtMusicBrowserAuth: boolean
  ytDlpCookiesBrowser: YtDlpCookiesBrowser
  folderTemplate: string
  fileTemplate: string
  embedUnsyncedLyrics: boolean
  writeLrcSidecar: boolean
}

export interface SaveSettingsInput {
  outputDirectory: string
  autoApproveChanges: boolean
  remoteCopyEnabled: boolean
  ytmusicBrowserAuth?: string
  ytDlpCookiesBrowser: YtDlpCookiesBrowser
  rcloneRemote: string
  remoteMusicRoot: string
  lyricsApiBaseUrl: string
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

export interface BrowserAuthCaptureResult extends CommandResult {
  authStatus: AuthStatus
}

export interface SyncTrackWorkView {
  id: string
  jobId: string
  title: string
  artist: string
  album: string
  youtubeMusicTrackId: string
  resolvedYoutubeMusicTrackId: string | null
  status: SyncItemStatus
  stage: SyncStage
  reasonCode: string
  reasonDetail: string
  outputPath: string | null
  lrcPath: string | null
}

export interface SyncApprovalItemView {
  id: string
  jobId: string
  trackWorkId: string
  title: string
  artist: string
  album: string
  status: 'pending' | 'approved' | 'denied'
  actionKind: 'update' | 'replace' | 'delete'
  diffJson: string
  beforeJson: string
  afterJson: string
}

export interface SyncJobView {
  id: string
  kind: SyncJobKind
  scope: SyncJobScopeKind | null
  label: string
  status: SyncJobStatus
  bucket: SyncBucket
  startedAt: string
  endedAt: string | null
  totalTracks: number
  processedTracks: number
  completedTracks: number
  failedTracks: number
  pendingApprovalTracks: number
  tracks: SyncTrackWorkView[]
}

export interface SyncSnapshot {
  queue: SyncJobView[]
  needsApproval: SyncApprovalItemView[]
  completed: SyncJobView[]
  failures: SyncJobView[]
  counts: {
    queue: number
    needsApproval: number
    completed: number
    failures: number
  }
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
  sidecarModifiedAt: string | null
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
  hasLocalFile: boolean
  hasRemoteFile: boolean
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

export interface AlbumArtworkEntry {
  albumKey: string
  artworkUrl: string | null
}

export interface AlbumArtworkBatchResult {
  entries: AlbumArtworkEntry[]
}

export interface AlbumArtworkUpdate extends AlbumArtworkEntry {}

export interface DriftSummary {
  totalManagedTracks: number
  inSyncTracks: number
  localOnlyTracks: number
  remoteOnlyTracks: number
  missingEverywhereTracks: number
}

export interface LibraryIndexStatus {
  currentLocalRootUri: string | null
  ready: boolean
  inProgress: boolean
  reason:
    | 'ready'
    | 'missing_root'
    | 'never_scanned'
    | 'stale_version'
    | 'scan_failed'
    | 'bootstrapping'
  lastScannedAt: string | null
  lastScanStatus: string | null
  indexVersion: number | null
}

export interface BinaryStatus {
  uv: string | null
  ffmpeg: string | null
  rclone: string | null
}

export interface ArtistPhotoUpdate {
  artistId: string
  photoUrl: string
  channelId: string | null
}

export interface LikedArtistView {
  id: string
  channelId: string | null
  name: string
  normalizedName: string
  photoUrl: string | null
  likedTrackCount: number
  lastRefreshedAt: string
  isFavorite: boolean
  favoritedAt: string | null
  lastCatalogRefreshedAt: string | null
  catalogTrackCount: number | null
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
    startLikedSongsSync: () => Promise<CommandResult>
    startLibraryReprocess: () => Promise<CommandResult>
    reprocessArtists: (artistIds: string[]) => Promise<CommandResult>
    refreshFavoriteArtists: (artistIds?: string[]) => Promise<CommandResult>
    clearFailures: () => Promise<CommandResult>
    syncMissingToRemote: () => Promise<CommandResult>
    approveChanges: (approvalIds: string[]) => Promise<CommandResult>
    denyChanges: (approvalIds: string[]) => Promise<CommandResult>
    cancel: (jobId: string) => Promise<CommandResult>
    clearSyncData: () => Promise<CommandResult>
    doctor: () => Promise<CommandResult>
    getSnapshot: () => Promise<SyncSnapshot>
    subscribe: (listener: (snapshot: SyncSnapshot) => void) => () => void
  }
  library: {
    scanRoots: () => Promise<CommandResult>
    getIndexStatus: () => Promise<LibraryIndexStatus>
    refreshIndex: () => Promise<CommandResult>
    refreshArtists: () => Promise<CommandResult>
    listArtists: () => Promise<LikedArtistView[]>
    refreshArtistImages: () => Promise<CommandResult>
    subscribeArtists: (listener: () => void) => () => void
    subscribeArtistPhotos: (
      listener: (update: ArtistPhotoUpdate) => void
    ) => () => void
    subscribeAlbumArtwork: (
      listener: (update: AlbumArtworkUpdate) => void
    ) => () => void
    subscribeIndexStatus: (listener: () => void) => () => void
    setArtistFavorite: (
      artistId: string,
      isFavorite: boolean
    ) => Promise<CommandResult>
    listTracks: (filter?: LibraryTrackFilter) => Promise<LibraryTrackView[]>
    getTrack: (trackId: string) => Promise<LibraryTrackView | null>
    getDriftSummary: () => Promise<DriftSummary>
    listRoots: () => Promise<LibraryRootView[]>
    getAlbumArtwork: (albumKeys: string[]) => Promise<AlbumArtworkBatchResult>
  }
}
