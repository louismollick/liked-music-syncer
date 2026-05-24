import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

const SCHEMA_VERSION = '11'

const ALL_TABLES = [
  'library_files',
  'library_tracks',
  'library_roots',
  'sync_approval_items',
  'sync_job_tracks',
  'sync_jobs',
  'liked_artists',
  'settings',
  'ytmusic_decisions',
  'meta',
]

function resetSchema(sqlite: Database.Database) {
  for (const table of ALL_TABLES) {
    sqlite.exec(`DROP TABLE IF EXISTS ${table};`)
  }

  sqlite.exec(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE liked_artists (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      photo_url TEXT,
      liked_track_count INTEGER NOT NULL,
      last_refreshed_at TEXT NOT NULL,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      favorited_at TEXT,
      last_catalog_refreshed_at TEXT,
      catalog_track_count INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE sync_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope TEXT,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      queue_bucket TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      planned_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE sync_job_tracks (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      library_track_id TEXT,
      youtube_music_track_id TEXT NOT NULL,
      spotify_track_id TEXT,
      soundcloud_track_id TEXT,
      resolved_youtube_music_track_id TEXT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      album_artist TEXT NOT NULL,
      source_url TEXT NOT NULL,
      cover_art_url TEXT,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reason_detail TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_origin TEXT,
      catalog_release_browse_id TEXT,
      catalog_release_title TEXT,
      catalog_release_kind TEXT,
      video_type TEXT,
      resolution_method TEXT NOT NULL,
      track_number INTEGER,
      track_total INTEGER,
      disc_number INTEGER,
      disc_total INTEGER,
      year INTEGER,
      date TEXT,
      genre TEXT,
      language TEXT,
      isrc TEXT,
      mb_track_id TEXT,
      mb_album_id TEXT,
      mb_releasegroup_id TEXT,
      lyrics_status TEXT NOT NULL DEFAULT 'missing',
      audio_codec TEXT,
      metadata_matched INTEGER NOT NULL DEFAULT 0,
      musicbrainz_matched INTEGER NOT NULL DEFAULT 0,
      lyrics_matched INTEGER NOT NULL DEFAULT 0,
      lyrics_source TEXT,
      selected_source_url TEXT,
      visible INTEGER NOT NULL DEFAULT 1,
      approval_required INTEGER NOT NULL DEFAULT 0,
      terminal_outcome TEXT,
      sort_index INTEGER,
      remote_target TEXT,
      job_phase TEXT,
      current_output_path TEXT,
      output_path TEXT,
      lrc_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE sync_approval_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      track_work_id TEXT NOT NULL,
      library_track_id TEXT,
      status TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      album_art_diff_json TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE library_roots (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      transport TEXT NOT NULL,
      label TEXT NOT NULL,
      uri TEXT NOT NULL UNIQUE,
      writable INTEGER NOT NULL,
      managed_output INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_scanned_at TEXT,
      last_scan_status TEXT
    );

    CREATE TABLE library_tracks (
      id TEXT PRIMARY KEY,
      identity_kind TEXT NOT NULL,
      identity_value TEXT NOT NULL,
      managed_by_app INTEGER NOT NULL,
      tag_schema_version INTEGER,
      youtube_music_track_id TEXT,
      spotify_track_id TEXT,
      soundcloud_track_id TEXT,
      resolved_youtube_music_track_id TEXT,
      source_origin TEXT,
      catalog_release_browse_id TEXT,
      catalog_release_title TEXT,
      catalog_release_kind TEXT,
      title TEXT,
      artist TEXT,
      album TEXT,
      album_artist TEXT,
      track_number INTEGER,
      track_total INTEGER,
      disc_number INTEGER,
      disc_total INTEGER,
      year INTEGER,
      date TEXT,
      genre TEXT,
      language TEXT,
      isrc TEXT,
      mb_track_id TEXT,
      mb_album_id TEXT,
      mb_releasegroup_id TEXT,
      lyrics_status TEXT NOT NULL,
      has_embedded_lyrics INTEGER NOT NULL,
      has_sidecar_lyrics INTEGER NOT NULL,
      cover_art_present INTEGER NOT NULL,
      missing_fields_json TEXT NOT NULL DEFAULT '[]',
      preferred_file_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX library_tracks_identity_key_unique
      ON library_tracks (identity_kind, identity_value);

    CREATE TABLE library_files (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      absolute_path_snapshot TEXT,
      lrc_path TEXT,
      format TEXT NOT NULL,
      size_bytes INTEGER,
      duration_seconds REAL,
      bitrate INTEGER,
      modified_at TEXT,
      sidecar_modified_at TEXT,
      audio_sha256 TEXT,
      tag_fingerprint TEXT,
      embedded_lyrics_status TEXT NOT NULL,
      sidecar_lyrics_status TEXT NOT NULL,
      missing_fields_json TEXT NOT NULL DEFAULT '[]',
      discovered_via TEXT NOT NULL,
      last_scanned_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX library_files_root_path_unique
      ON library_files (root_id, relative_path);

  `)

  sqlite
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    .run('schemaVersion', SCHEMA_VERSION)
}

function readSchemaVersion(sqlite: Database.Database) {
  const metaExists = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
    )
    .get() as { name?: string } | undefined

  if (!metaExists?.name) {
    return null
  }

  const row = sqlite
    .prepare("SELECT value FROM meta WHERE key = 'schemaVersion'")
    .get() as { value?: string } | undefined

  return row?.value ?? null
}

function migrateSchema(sqlite: Database.Database, version: string | null) {
  if (version === SCHEMA_VERSION) {
    return
  }

  resetSchema(sqlite)
}

export function createDatabase(databaseFile: string) {
  mkdirSync(path.dirname(databaseFile), { recursive: true })
  const sqlite = new Database(databaseFile)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  const schemaVersion = readSchemaVersion(sqlite)
  if (schemaVersion === null) {
    resetSchema(sqlite)
  } else if (schemaVersion !== SCHEMA_VERSION) {
    migrateSchema(sqlite, schemaVersion)
  }

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
  }
}

export type AppDatabase = ReturnType<typeof createDatabase>['db']
