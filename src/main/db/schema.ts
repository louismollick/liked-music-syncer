import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const metaTable = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
})

export const likedArtistsTable = sqliteTable('liked_artists', {
  id: text('id').primaryKey(),
  channelId: text('channel_id'),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  photoUrl: text('photo_url'),
  likedTrackCount: integer('liked_track_count').notNull(),
  lastRefreshedAt: text('last_refreshed_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const syncRunsTable = sqliteTable('sync_runs', {
  id: text('id').primaryKey(),
  triggerMode: text('trigger_mode').notNull(),
  status: text('status').notNull(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  logDirectory: text('log_directory').notNull(),
  plannedCount: integer('planned_count').notNull().default(0),
})

export const syncRunItemsTable = sqliteTable('sync_run_items', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  youtubeMusicTrackId: text('youtube_music_track_id').notNull(),
  spotifyTrackId: text('spotify_track_id'),
  soundcloudTrackId: text('soundcloud_track_id'),
  resolvedYoutubeMusicTrackId: text('resolved_youtube_music_track_id'),
  title: text('title').notNull(),
  artist: text('artist').notNull(),
  album: text('album').notNull(),
  albumArtist: text('album_artist').notNull(),
  sourceUrl: text('source_url').notNull(),
  coverArtUrl: text('cover_art_url'),
  status: text('status').notNull(),
  stage: text('stage').notNull(),
  reasonCode: text('reason_code').notNull(),
  reasonDetail: text('reason_detail').notNull(),
  sourceKind: text('source_kind').notNull(),
  videoType: text('video_type'),
  resolutionMethod: text('resolution_method').notNull(),
  trackNumber: integer('track_number'),
  trackTotal: integer('track_total'),
  discNumber: integer('disc_number'),
  discTotal: integer('disc_total'),
  year: integer('year'),
  date: text('date'),
  genre: text('genre'),
  language: text('language'),
  isrc: text('isrc'),
  mbTrackId: text('mb_track_id'),
  mbAlbumId: text('mb_album_id'),
  mbReleaseGroupId: text('mb_releasegroup_id'),
  lyricsStatus: text('lyrics_status').notNull().default('missing'),
  audioCodec: text('audio_codec'),
  metadataMatched: integer('metadata_matched', { mode: 'boolean' })
    .notNull()
    .default(false),
  musicBrainzMatched: integer('musicbrainz_matched', { mode: 'boolean' })
    .notNull()
    .default(false),
  lyricsMatched: integer('lyrics_matched', { mode: 'boolean' })
    .notNull()
    .default(false),
  lyricsSource: text('lyrics_source'),
  selectedSourceUrl: text('selected_source_url'),
  outputPath: text('output_path'),
  lrcPath: text('lrc_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const libraryRootsTable = sqliteTable('library_roots', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  transport: text('transport').notNull(),
  label: text('label').notNull(),
  uri: text('uri').notNull().unique(),
  writable: integer('writable', { mode: 'boolean' }).notNull(),
  managedOutput: integer('managed_output', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastScannedAt: text('last_scanned_at'),
  lastScanStatus: text('last_scan_status'),
})

export const libraryTracksTable = sqliteTable(
  'library_tracks',
  {
    id: text('id').primaryKey(),
    identityKind: text('identity_kind').notNull(),
    identityValue: text('identity_value').notNull(),
    managedByApp: integer('managed_by_app', { mode: 'boolean' }).notNull(),
    tagSchemaVersion: integer('tag_schema_version'),
    youtubeMusicTrackId: text('youtube_music_track_id'),
    spotifyTrackId: text('spotify_track_id'),
    soundcloudTrackId: text('soundcloud_track_id'),
    resolvedYoutubeMusicTrackId: text('resolved_youtube_music_track_id'),
    title: text('title'),
    artist: text('artist'),
    album: text('album'),
    albumArtist: text('album_artist'),
    trackNumber: integer('track_number'),
    trackTotal: integer('track_total'),
    discNumber: integer('disc_number'),
    discTotal: integer('disc_total'),
    year: integer('year'),
    date: text('date'),
    genre: text('genre'),
    language: text('language'),
    isrc: text('isrc'),
    mbTrackId: text('mb_track_id'),
    mbAlbumId: text('mb_album_id'),
    mbReleaseGroupId: text('mb_releasegroup_id'),
    lyricsStatus: text('lyrics_status').notNull(),
    hasEmbeddedLyrics: integer('has_embedded_lyrics', {
      mode: 'boolean',
    }).notNull(),
    hasSidecarLyrics: integer('has_sidecar_lyrics', {
      mode: 'boolean',
    }).notNull(),
    coverArtPresent: integer('cover_art_present', {
      mode: 'boolean',
    }).notNull(),
    missingFieldsJson: text('missing_fields_json').notNull().default('[]'),
    preferredFileId: text('preferred_file_id'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    identityKeyUnique: uniqueIndex('library_tracks_identity_key_unique').on(
      table.identityKind,
      table.identityValue
    ),
  })
)

export const libraryFilesTable = sqliteTable(
  'library_files',
  {
    id: text('id').primaryKey(),
    trackId: text('track_id').notNull(),
    rootId: text('root_id').notNull(),
    relativePath: text('relative_path').notNull(),
    absolutePathSnapshot: text('absolute_path_snapshot'),
    lrcPath: text('lrc_path'),
    format: text('format').notNull(),
    sizeBytes: integer('size_bytes'),
    durationSeconds: real('duration_seconds'),
    bitrate: integer('bitrate'),
    modifiedAt: text('modified_at'),
    audioSha256: text('audio_sha256'),
    tagFingerprint: text('tag_fingerprint'),
    embeddedLyricsStatus: text('embedded_lyrics_status').notNull(),
    sidecarLyricsStatus: text('sidecar_lyrics_status').notNull(),
    missingFieldsJson: text('missing_fields_json').notNull().default('[]'),
    discoveredVia: text('discovered_via').notNull(),
    lastScannedAt: text('last_scanned_at').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    rootPathUnique: uniqueIndex('library_files_root_path_unique').on(
      table.rootId,
      table.relativePath
    ),
  })
)

export const artifactsTable = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  runItemId: text('run_item_id').notNull(),
  audioPath: text('audio_path'),
  lrcPath: text('lrc_path'),
  remoteTarget: text('remote_target'),
  createdAt: text('created_at').notNull(),
})

export const songLogsTable = sqliteTable('song_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  youtubeMusicTrackId: text('youtube_music_track_id').notNull(),
  itemId: text('item_id').notNull(),
  timestamp: text('timestamp').notNull(),
  level: text('level').notNull(),
  stage: text('stage').notNull(),
  event: text('event').notNull(),
  message: text('message').notNull(),
  contextJson: text('context_json').notNull(),
})
