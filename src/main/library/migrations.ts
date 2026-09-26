/**
 * Numbered migrations, applied in order and tracked with PRAGMA user_version.
 * Append new migrations; never edit or remove one that has shipped, and never
 * drop user data.
 */
export const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    identity_key TEXT,
    adopted INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    artist_credits TEXT NOT NULL DEFAULT '[]',
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    album_artist TEXT NOT NULL DEFAULT '',
    release_id TEXT,
    release_kind TEXT,
    track_number INTEGER,
    track_total INTEGER,
    disc_number INTEGER,
    disc_total INTEGER,
    date TEXT,
    year INTEGER,
    duration_seconds REAL,
    genre TEXT,
    isrc TEXT,
    mb_recording_id TEXT,
    language TEXT,
    lyrics_status TEXT NOT NULL DEFAULT 'none',
    lyrics_source TEXT,
    lyrics_text TEXT,
    lyrics_checked_at TEXT,
    spotify_track_id TEXT,
    enrichment_errors TEXT NOT NULL DEFAULT '{}',
    cover_url TEXT,
    cover_path TEXT,
    match TEXT,
    refresh_requested INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    current_step TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    last_error_kind TEXT,
    last_error_step TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX tracks_identity_key ON tracks(identity_key);
  CREATE INDEX tracks_state ON tracks(state);

  CREATE TABLE contributions (
    id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    account_id TEXT,
    artist_id TEXT,
    track_id TEXT,
    source_video_id TEXT NOT NULL,
    release_id TEXT,
    liked_position INTEGER,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    raw TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX contributions_source_key ON contributions(source_key);
  CREATE INDEX contributions_track ON contributions(track_id);

  CREATE TABLE files (
    track_id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL,
    audio_video_id TEXT,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    content_sha256 TEXT NOT NULL,
    tag_fields TEXT NOT NULL,
    lrc_sha256 TEXT,
    written_at TEXT NOT NULL,
    outside_edit TEXT
  );
  CREATE UNIQUE INDEX files_path ON files(relative_path);

  CREATE TABLE uploads (
    track_id TEXT PRIMARY KEY,
    remote_path TEXT,
    hash_algo TEXT,
    content_hash TEXT,
    remote_size INTEGER,
    remote_mtime TEXT,
    lrc_remote_path TEXT,
    lrc_hash TEXT,
    lrc_remote_size INTEGER,
    tag_fields TEXT,
    local_sha256 TEXT,
    verified_at TEXT,
    uploaded_at TEXT NOT NULL
  );

  CREATE TABLE unmanaged_files (
    relative_path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    seen_at TEXT NOT NULL
  );

  CREATE TABLE artists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    channel_id TEXT,
    image_path TEXT,
    image_checked_at TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    suggested INTEGER NOT NULL DEFAULT 0,
    favorited_at TEXT,
    catalog_checked_at TEXT
  );

  CREATE TABLE track_artists (
    track_id TEXT NOT NULL,
    artist_id TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX track_artists_pk ON track_artists(track_id, artist_id);
  CREATE INDEX track_artists_artist ON track_artists(artist_id);

  CREATE TABLE source_snapshots (
    source TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    item_count INTEGER,
    error TEXT,
    last_success_at TEXT
  );

  CREATE TABLE tombstones (
    id TEXT PRIMARY KEY,
    track_id TEXT,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    done_at TEXT
  );

  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    step TEXT NOT NULL,
    artifact TEXT NOT NULL,
    kind TEXT NOT NULL,
    from_path TEXT,
    to_path TEXT NOT NULL,
    expected_sha256 TEXT,
    phase TEXT NOT NULL,
    started_at TEXT NOT NULL
  );

  CREATE TABLE track_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    at TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX track_history_track ON track_history(track_id);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0
  );
  `,
]
