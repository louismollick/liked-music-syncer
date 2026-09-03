import type { ArtistCredit } from './artist-credit'

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
  | 'ytm_release_track'
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
  | 'helium'
  | 'opera'
  | 'safari'
  | 'vivaldi'
  | 'whale'
  | 'zen'

export type SyncJobKind =
  | 'liked_songs_sync'
  | 'reprocess'
  | 'favorite_artist_catalog_refresh'
  | 'sync_missing_to_remote'

export type SyncJobScopeKind = 'library' | 'artist'
export type SyncJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type SyncJobDisplayStatus = 'in_progress' | 'completed'
export type SyncTrackDisplayStatus =
  | 'queued'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
export type SyncFilter = 'all' | 'in_progress' | 'completed' | 'failed'

export interface AuthStatus {
  authMode: 'browser_headers' | 'none'
  isAuthenticated: boolean
  hasBrowserAuth: boolean
  lastError: string | null
}

export type AuthSourceCheckState =
  | 'unchecked'
  | 'checking'
  | 'signed_in'
  | 'signed_out'
  | 'issue'
export type AuthSessionState =
  | 'loading'
  | 'signed_in'
  | 'signed_out'
  | 'issue'
  | 'no_supported_browser'
export type AuthRefreshReason =
  | 'startup'
  | 'picker_opened'
  | 'retry'
  | 'focus_return'
  | 'credential_rejected'
export type AuthIssueCode =
  | 'cookie_store_unreadable'
  | 'keychain_denied'
  | 'permission_denied'
  | 'browser_profile_missing'
  | 'network_unavailable'
  | 'credential_rejected'
  | 'account_enumeration_failed'
  | 'unexpected_response'

export interface AuthIssueView {
  code: AuthIssueCode
  message: string
  recovery: string
}
export interface AuthSourceView {
  id: string
  browserName: string
  browserLogoUrl: string
  applicationPath: string
  profileName: string | null
  status: AuthSourceCheckState
  accountCount: number | null
  accountsComplete: boolean
  issue: AuthIssueView | null
}
export interface YouTubeMusicAccountView {
  key: string
  displayName: string
  handle: string | null
  imageUrl: string | null
  cachedImageUrl: string | null
  likedSongCount: number | null
  likedSongCountState: 'unrequested' | 'loading' | 'loaded' | 'unavailable'
}
export interface AuthSessionView {
  state: AuthSessionState
  selectedSourceId: string | null
  selectedAccountKey: string | null
  activeAccount: YouTubeMusicAccountView | null
  sources: AuthSourceView[]
  accounts: YouTubeMusicAccountView[]
  accountsComplete: boolean
  isRefreshing: boolean
  switchingDisabledReason: string | null
  issue: AuthIssueView | null
}

export interface AppSettingsView {
  outputDirectory: string
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
export type UpdateSettingsInput = Partial<
  Omit<SaveSettingsInput, 'ytmusicBrowserAuth' | 'ytDlpCookiesBrowser'>
>

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
  displayStatus: SyncTrackDisplayStatus
  stage: SyncStage
  reasonCode: string
  reasonDetail: string
  outputPath: string | null
  lrcPath: string | null
}

export interface SyncJobView {
  id: string
  kind: SyncJobKind
  scope: SyncJobScopeKind | null
  label: string
  status: SyncJobStatus
  displayStatus: SyncJobDisplayStatus
  startedAt: string
  endedAt: string | null
  totalTracks: number
  processedTracks: number
  completedTracks: number
  failedTracks: number
  tracks: SyncTrackWorkView[]
}

export interface SyncSnapshot {
  jobs: SyncJobView[]
  counts: {
    all: number
    inProgress: number
    completed: number
    failed: number
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
  sidecarSha256: string | null
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
  artistCredits: ArtistCredit[]
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
    getSnapshot: () => Promise<AuthSessionView>
    refresh: (
      scope: 'selected' | 'all',
      reason: AuthRefreshReason
    ) => Promise<AuthSessionView>
    selectSource: (sourceId: string) => Promise<AuthSessionView>
    selectAccount: (accountKey: string) => Promise<AuthSessionView>
    loadAccountCounts: () => Promise<AuthSessionView>
    openSignIn: () => Promise<void>
    subscribe: (listener: (snapshot: AuthSessionView) => void) => () => void
  }
  settings: {
    get: () => Promise<AppSettingsView>
    update: (input: UpdateSettingsInput) => Promise<CommandResult>
    testBinaries: () => Promise<BinaryStatus>
    testRemote: () => Promise<CommandResult>
    pickOutputDirectory: () => Promise<string | null>
  }
  sync: {
    startLikedSongsSync: () => Promise<CommandResult>
    startLibraryReprocess: () => Promise<CommandResult>
    reprocessArtists: (artistIds: string[]) => Promise<CommandResult>
    refreshFavoriteArtists: (artistIds?: string[]) => Promise<CommandResult>
    retryFailedTracks: (jobId: string) => Promise<CommandResult>
    clearFailures: () => Promise<CommandResult>
    syncMissingToRemote: () => Promise<CommandResult>
    cancel: (jobId: string) => Promise<CommandResult>
    clearSyncData: () => Promise<CommandResult>
    doctor: () => Promise<CommandResult>
    getSnapshot: () => Promise<SyncSnapshot>
    subscribe: (listener: (snapshot: SyncSnapshot) => void) => () => void
  }
  library: {
    refreshIndex: () => Promise<CommandResult>
    refreshArtists: () => Promise<CommandResult>
    listArtists: () => Promise<LikedArtistView[]>
    refreshArtistImages: () => Promise<CommandResult>
    clearArtistImageCache: () => Promise<CommandResult>
    subscribeArtists: (listener: () => void) => () => void
    subscribeArtistPhotos: (
      listener: (update: ArtistPhotoUpdate) => void
    ) => () => void
    subscribeAlbumArtwork: (
      listener: (update: AlbumArtworkUpdate) => void
    ) => () => void
    subscribeInventory: (listener: () => void) => () => void
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
