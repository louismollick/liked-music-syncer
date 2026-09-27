import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * Library store schema. Migrations live in ./migrations.ts and must be kept in
 * step with these table definitions. Migrations never drop user data.
 */

export const tracks = sqliteTable(
  'tracks',
  {
    id: text('id').primaryKey(),
    identityKey: text('identity_key'),
    adopted: integer('adopted', { mode: 'boolean' }).notNull().default(false),
    title: text('title').notNull(),
    artistCredits: text('artist_credits').notNull().default('[]'),
    artist: text('artist').notNull().default(''),
    album: text('album').notNull().default(''),
    albumArtist: text('album_artist').notNull().default(''),
    releaseId: text('release_id'),
    releaseKind: text('release_kind'),
    trackNumber: integer('track_number'),
    trackTotal: integer('track_total'),
    discNumber: integer('disc_number'),
    discTotal: integer('disc_total'),
    date: text('date'),
    year: integer('year'),
    durationSeconds: real('duration_seconds'),
    genre: text('genre'),
    isrc: text('isrc'),
    mbRecordingId: text('mb_recording_id'),
    language: text('language'),
    lyricsStatus: text('lyrics_status').notNull().default('none'),
    lyricsSource: text('lyrics_source'),
    lyricsText: text('lyrics_text'),
    lyricsCheckedAt: text('lyrics_checked_at'),
    spotifyTrackId: text('spotify_track_id'),
    enrichmentErrors: text('enrichment_errors').notNull().default('{}'),
    coverUrl: text('cover_url'),
    coverPath: text('cover_path'),
    match: text('match'),
    refreshRequested: integer('refresh_requested', { mode: 'boolean' })
      .notNull()
      .default(false),
    state: text('state').notNull().default('pending'),
    currentStep: text('current_step'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    lastError: text('last_error'),
    lastErrorKind: text('last_error_kind'),
    lastErrorStep: text('last_error_step'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('tracks_identity_key').on(table.identityKey),
    index('tracks_state').on(table.state),
  ]
)

export const contributions = sqliteTable(
  'contributions',
  {
    id: text('id').primaryKey(),
    sourceKey: text('source_key').notNull(),
    kind: text('kind').notNull(),
    accountId: text('account_id'),
    artistId: text('artist_id'),
    trackId: text('track_id'),
    sourceVideoId: text('source_video_id').notNull(),
    releaseId: text('release_id'),
    likedPosition: integer('liked_position'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    raw: text('raw').notNull().default('{}'),
  },
  (table) => [
    uniqueIndex('contributions_source_key').on(table.sourceKey),
    index('contributions_track').on(table.trackId),
  ]
)

export const files = sqliteTable(
  'files',
  {
    trackId: text('track_id').primaryKey(),
    relativePath: text('relative_path').notNull(),
    audioVideoId: text('audio_video_id'),
    size: integer('size').notNull(),
    mtimeMs: real('mtime_ms').notNull(),
    contentSha256: text('content_sha256').notNull(),
    tagFields: text('tag_fields').notNull(),
    lrcSha256: text('lrc_sha256'),
    writtenAt: text('written_at').notNull(),
    outsideEdit: text('outside_edit'),
  },
  (table) => [uniqueIndex('files_path').on(table.relativePath)]
)

export const uploads = sqliteTable('uploads', {
  trackId: text('track_id').primaryKey(),
  /** `remote|folder` the record belongs to; a different target means no upload yet. */
  remoteTarget: text('remote_target'),
  remotePath: text('remote_path'),
  hashAlgo: text('hash_algo'),
  contentHash: text('content_hash'),
  remoteSize: integer('remote_size'),
  remoteMtime: text('remote_mtime'),
  lrcRemotePath: text('lrc_remote_path'),
  lrcHash: text('lrc_hash'),
  lrcRemoteSize: integer('lrc_remote_size'),
  tagFields: text('tag_fields'),
  localSha256: text('local_sha256'),
  verifiedAt: text('verified_at'),
  uploadedAt: text('uploaded_at').notNull(),
})

export const unmanagedFiles = sqliteTable('unmanaged_files', {
  relativePath: text('relative_path').primaryKey(),
  size: integer('size').notNull(),
  mtimeMs: real('mtime_ms').notNull(),
  seenAt: text('seen_at').notNull(),
  /** The app stopped managing this file (Outside Edit → Stop managing); never re-adopt it. */
  released: integer('released', { mode: 'boolean' }).notNull().default(false),
})

export const artists = sqliteTable('artists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  channelId: text('channel_id'),
  imagePath: text('image_path'),
  imageCheckedAt: text('image_checked_at'),
  favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
  suggested: integer('suggested', { mode: 'boolean' }).notNull().default(false),
  favoritedAt: text('favorited_at'),
  catalogCheckedAt: text('catalog_checked_at'),
})

export const trackArtists = sqliteTable(
  'track_artists',
  {
    trackId: text('track_id').notNull(),
    artistId: text('artist_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    uniqueIndex('track_artists_pk').on(table.trackId, table.artistId),
    index('track_artists_artist').on(table.artistId),
  ]
)

export const sourceSnapshots = sqliteTable('source_snapshots', {
  source: text('source').primaryKey(),
  status: text('status').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  itemCount: integer('item_count'),
  error: text('error'),
  lastSuccessAt: text('last_success_at'),
})

export const tombstones = sqliteTable('tombstones', {
  id: text('id').primaryKey(),
  trackId: text('track_id'),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  remoteTarget: text('remote_target'),
  reason: text('reason').notNull(),
  createdAt: text('created_at').notNull(),
  doneAt: text('done_at'),
})

export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  trackId: text('track_id').notNull(),
  step: text('step').notNull(),
  artifact: text('artifact').notNull(),
  kind: text('kind').notNull(),
  fromPath: text('from_path'),
  toPath: text('to_path').notNull(),
  expectedSha256: text('expected_sha256'),
  audioVideoId: text('audio_video_id'),
  phase: text('phase').notNull(),
  startedAt: text('started_at').notNull(),
})

export const trackHistory = sqliteTable(
  'track_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trackId: text('track_id').notNull(),
    at: text('at').notNull(),
    event: text('event').notNull(),
    detail: text('detail').notNull().default('{}'),
  },
  (table) => [index('track_history_track').on(table.trackId)]
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
})

export type TrackRow = typeof tracks.$inferSelect
export type ContributionRow = typeof contributions.$inferSelect
export type FileRow = typeof files.$inferSelect
export type UploadRow = typeof uploads.$inferSelect
export type ArtistRow = typeof artists.$inferSelect
export type OperationRow = typeof operations.$inferSelect
export type TombstoneRow = typeof tombstones.$inferSelect
