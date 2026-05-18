import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

const SCHEMA_VERSION = '2'

const ALL_TABLES = [
  'song_logs',
  'artifacts',
  'processed_songs',
  'sync_run_items',
  'sync_runs',
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

    CREATE TABLE sync_runs (
      id TEXT PRIMARY KEY,
      trigger_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      log_directory TEXT NOT NULL,
      planned_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE sync_run_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source_video_id TEXT NOT NULL,
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
      video_type TEXT,
      resolution_method TEXT NOT NULL,
      track_number INTEGER,
      track_total INTEGER,
      year INTEGER,
      date TEXT,
      audio_codec TEXT,
      metadata_matched INTEGER NOT NULL DEFAULT 0,
      musicbrainz_matched INTEGER NOT NULL DEFAULT 0,
      lyrics_matched INTEGER NOT NULL DEFAULT 0,
      lyrics_source TEXT,
      selected_source_url TEXT,
      output_path TEXT,
      lrc_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE processed_songs (
      source_video_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      album_artist TEXT NOT NULL,
      output_path TEXT,
      processed_at TEXT NOT NULL
    );

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_item_id TEXT NOT NULL,
      audio_path TEXT,
      lrc_path TEXT,
      remote_target TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE song_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source_video_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      stage TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      context_json TEXT NOT NULL
    );
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

export function createDatabase(databaseFile: string) {
  mkdirSync(path.dirname(databaseFile), { recursive: true })
  const sqlite = new Database(databaseFile)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  if (readSchemaVersion(sqlite) !== SCHEMA_VERSION) {
    resetSchema(sqlite)
  }

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
  }
}

export type AppDatabase = ReturnType<typeof createDatabase>['db']
