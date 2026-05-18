import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
  sourceVideoId: text('source_video_id').notNull(),
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
  year: integer('year'),
  date: text('date'),
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

export const processedSongsTable = sqliteTable('processed_songs', {
  sourceVideoId: text('source_video_id').primaryKey(),
  title: text('title').notNull(),
  artist: text('artist').notNull(),
  album: text('album').notNull(),
  albumArtist: text('album_artist').notNull(),
  outputPath: text('output_path'),
  processedAt: text('processed_at').notNull(),
})

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
  sourceVideoId: text('source_video_id').notNull(),
  itemId: text('item_id').notNull(),
  timestamp: text('timestamp').notNull(),
  level: text('level').notNull(),
  stage: text('stage').notNull(),
  event: text('event').notNull(),
  message: text('message').notNull(),
  contextJson: text('context_json').notNull(),
})
