import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '../../src/main/library/db'
import { MIGRATIONS } from '../../src/main/library/migrations'
import { tempDir } from '../helpers/audio'

describe('migrations', () => {
  it('preserves contributions and indexes while permitting Spotify rows without a video ID', () => {
    const sqlite = new Database(':memory:')
    for (const migration of MIGRATIONS.slice(0, 4)) sqlite.exec(migration)
    sqlite.pragma('user_version = 4')
    sqlite.exec(
      "INSERT INTO contributions (id, source_key, kind, source_video_id, first_seen_at, last_seen_at) VALUES ('youtube', 'ytm-liked:a:v', 'liked', 'v', 'now', 'now')"
    )
    migrate(sqlite)
    sqlite.exec(
      "INSERT INTO contributions (id, source_key, kind, source_video_id, first_seen_at, last_seen_at) VALUES ('spotify', 'spotify-liked:a:s', 'spotify_liked', NULL, 'now', 'now')"
    )
    expect(
      sqlite
        .prepare('SELECT id, source_video_id FROM contributions ORDER BY id')
        .all()
    ).toEqual([
      { id: 'spotify', source_video_id: null },
      { id: 'youtube', source_video_id: 'v' },
    ])
    expect(() =>
      sqlite.exec(
        "UPDATE contributions SET source_key = 'ytm-liked:a:v' WHERE id = 'spotify'"
      )
    ).toThrow('UNIQUE')
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'contributions_track'"
        )
        .get()
    ).toBeTruthy()
    sqlite.close()
  })
  it('clears only exact vocal duplicates on instrumental titles and is idempotent', () => {
    const sqlite = new Database(':memory:')
    for (const migration of MIGRATIONS.slice(0, 4)) sqlite.exec(migration)
    sqlite.pragma('user_version = 4')
    const insert = sqlite.prepare(
      `INSERT INTO tracks (id, title, lyrics_text, lyrics_status, lyrics_source, language, lyrics_checked_at, created_at, updated_at) VALUES (?, ?, ?, 'synced', 'youtube-music', 'ja', 'checked', 'now', 'now')`
    )
    insert.run('vocal', 'Song', '[00:01.00]Words')
    for (const [id, title] of [
      ['one', 'Song (Instrumental)'],
      ['two', 'Song（Inst.）'],
      ['three', 'Song - Off Vocal'],
      ['four', 'Song (Karaoke)'],
      ['five', 'Song<instrumental>'],
    ])
      insert.run(id, title, '[00:01.00]Words')
    insert.run('different-timing', 'Song (Instrumental)', '[00:02.00]Words')
    insert.run('different-text', 'Song (Instrumental)', '[00:01.00]Other words')
    insert.run('trailing-space', 'Song (Instrumental)', '[00:01.00]Words ')
    insert.run('plain-unmatched', 'Song (Instrumental)', 'Words')
    insert.run('empty', 'Song (Instrumental)', '')
    migrate(sqlite)
    const rows = sqlite
      .prepare(
        'SELECT id, lyrics_status, lyrics_text, lyrics_source, language, lyrics_checked_at FROM tracks ORDER BY id'
      )
      .all()
    const cleared = sqlite
      .prepare("SELECT id FROM tracks WHERE lyrics_status = 'none' ORDER BY id")
      .all()
    expect(cleared).toEqual(
      ['five', 'four', 'one', 'three', 'two'].map((id) => ({ id }))
    )
    for (const row of rows as {
      id: string
      lyrics_status: string
      lyrics_text: string | null
      lyrics_source: string | null
      language: string | null
      lyrics_checked_at: string
    }[]) {
      if (row.lyrics_status === 'none')
        expect(row).toMatchObject({
          lyrics_text: null,
          lyrics_source: null,
          language: null,
          lyrics_checked_at: 'checked',
        })
      else expect(row.lyrics_source).toBe('youtube-music')
    }
    sqlite.exec(MIGRATIONS[4])
    migrate(sqlite)
    expect(
      sqlite
        .prepare(
          'SELECT id, lyrics_status, lyrics_text, lyrics_source, language, lyrics_checked_at FROM tracks ORDER BY id'
        )
        .all()
    ).toEqual(rows)
    sqlite.close()
  })

  it('drops the MusicBrainz columns and marks wanted matched tracks for a Last.fm genre refresh', () => {
    const sqlite = new Database(':memory:')
    // Migration 5 calls this; migrate() registers the real one.
    sqlite.function('lyrics_instrumental', (_title: string) => 0)
    for (const migration of MIGRATIONS.slice(0, 8)) sqlite.exec(migration)
    sqlite.pragma('user_version = 8')
    const insert = sqlite.prepare(
      `INSERT INTO tracks (id, title, genre, isrc, mb_recording_id, match, state, created_at, updated_at) VALUES (?, ?, 'rock', 'isrc', 'mbid', ?, ?, 'now', 'now')`
    )
    insert.run('ready', 'A', '{}', 'ready')
    insert.run('pending', 'B', '{}', 'pending')
    insert.run('unmatched', 'C', null, 'pending')
    insert.run('released', 'D', '{}', 'released')
    insert.run('unwanted', 'E', '{}', 'no_longer_wanted')
    migrate(sqlite)
    expect(
      sqlite
        .prepare('SELECT id, genre, genre_requested FROM tracks ORDER BY id')
        .all()
    ).toEqual([
      { id: 'pending', genre: null, genre_requested: 1 },
      { id: 'ready', genre: null, genre_requested: 1 },
      { id: 'released', genre: null, genre_requested: 0 },
      { id: 'unmatched', genre: null, genre_requested: 0 },
      { id: 'unwanted', genre: null, genre_requested: 0 },
    ])
    const columns = (
      sqlite.pragma('table_info(tracks)') as { name: string }[]
    ).map((column) => column.name)
    expect(columns).not.toContain('isrc')
    expect(columns).not.toContain('mb_recording_id')
    sqlite.close()
  })

  it('keeps existing artist IDs and schedules page backfill through null checkpoints', () => {
    const sqlite = new Database(':memory:')
    for (const migration of MIGRATIONS.slice(0, 3)) sqlite.exec(migration)
    sqlite.pragma('user_version = 3')
    sqlite
      .prepare(
        "INSERT INTO artists (id, name, channel_id, full_discography) VALUES ('channel:topic', 'Credit', 'topic', 1)"
      )
      .run()
    migrate(sqlite)
    expect(
      sqlite
        .prepare(
          'SELECT id, name, full_discography, native_name, primary_channel_id, page_checked_at, alias_of FROM artists'
        )
        .get()
    ).toEqual({
      id: 'channel:topic',
      name: 'Credit',
      full_discography: 1,
      native_name: null,
      primary_channel_id: null,
      page_checked_at: null,
      alias_of: null,
    })
    sqlite.close()
  })

  it('keeps Favorite Artists as Full Discography artists', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(MIGRATIONS[0])
    sqlite.pragma('user_version = 1')
    sqlite
      .prepare(
        `INSERT INTO artists (id, name, favorite, favorited_at) VALUES (?, ?, 1, ?)`
      )
      .run('channel:a', 'A', '2026-01-01T00:00:00.000Z')

    migrate(sqlite)

    expect(sqlite.pragma('user_version', { simple: true })).toBe(
      MIGRATIONS.length
    )
    expect(
      sqlite
        .prepare(
          'SELECT full_discography, full_discography_at FROM artists WHERE id = ?'
        )
        .get('channel:a')
    ).toEqual({
      full_discography: 1,
      full_discography_at: '2026-01-01T00:00:00.000Z',
    })
    sqlite.close()
  })

  it('keeps existing tombstones as plain deletes with no replacement to wait for', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(MIGRATIONS[0])
    sqlite.exec(MIGRATIONS[1])
    sqlite.pragma('user_version = 2')
    sqlite
      .prepare(
        `INSERT INTO tombstones (id, track_id, kind, path, reason, created_at) VALUES ('t', NULL, 'local', 'a.m4a', 'merged', 'now')`
      )
      .run()

    migrate(sqlite)

    expect(
      sqlite
        .prepare(
          'SELECT replacement_track_id, expected_sha256 FROM tombstones WHERE id = ?'
        )
        .get('t')
    ).toEqual({ replacement_track_id: null, expected_sha256: null })
    sqlite.close()
  })

  it('indexes tracks by album so album lookups do not scan the table', () => {
    const sqlite = new Database(':memory:')
    migrate(sqlite)
    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT cover_path FROM tracks t2 WHERE t2.album = 'a' AND t2.album_artist = 'b' AND t2.cover_path IS NOT NULL LIMIT 1`
      )
      .all() as Array<{ detail: string }>
    expect(plan.map((row) => row.detail).join(' ')).toContain(
      'USING INDEX tracks_album'
    )
    sqlite.close()
  })
})

describe('backup before migrating', () => {
  /** A database file left at an older schema version, with one track. */
  function oldDatabase(dir: string, version: number): string {
    const file = path.join(dir, 'library.db')
    const sqlite = new Database(file)
    for (const migration of MIGRATIONS.slice(0, version)) sqlite.exec(migration)
    sqlite.pragma(`user_version = ${version}`)
    sqlite.exec(
      "INSERT INTO tracks (id, title, created_at, updated_at) VALUES ('t', 'Song', 'now', 'now')"
    )
    sqlite.close()
    return file
  }
  const backups = (dir: string) =>
    readdirSync(dir)
      .filter((name) => name.includes('.before-v'))
      .sort()

  it('copies an existing database before upgrading it', () => {
    const dir = tempDir('lms-backup-')
    const file = oldDatabase(dir, 4)

    openDatabase(file).$client.close()

    const backup = `${file}.before-v${MIGRATIONS.length}`
    const copy = new Database(backup, { readonly: true })
    expect(copy.pragma('user_version', { simple: true })).toBe(4)
    expect(copy.prepare('SELECT title FROM tracks').all()).toEqual([
      { title: 'Song' },
    ])
    copy.close()
    const upgraded = new Database(file, { readonly: true })
    expect(upgraded.pragma('user_version', { simple: true })).toBe(
      MIGRATIONS.length
    )
    upgraded.close()
  })

  it('adds the genre request column as migration 8, after the album index', () => {
    const dir = tempDir('lms-backup-')
    const file = oldDatabase(dir, 4)

    const db = openDatabase(file)
    expect(
      db.$client.prepare('SELECT genre_requested FROM tracks').all()
    ).toEqual([{ genre_requested: 0 }])
    db.$client.close()
    expect(MIGRATIONS[6]).toContain('tracks_album')
    expect(MIGRATIONS[7]).toContain('genre_requested')
  })

  it('skips the backup for a new database and for one already up to date', () => {
    const dir = tempDir('lms-backup-')
    const file = path.join(dir, 'library.db')
    openDatabase(file).$client.close()
    expect(backups(dir)).toEqual([])
    openDatabase(file).$client.close()
    expect(backups(dir)).toEqual([])
  })

  it('keeps the newest three and leaves other files alone', () => {
    const dir = tempDir('lms-backup-')
    const file = oldDatabase(dir, 4)
    for (const name of [
      'library.db.before-v1',
      'library.db.before-v2',
      'library.db.before-v3',
      'library.db.before-error-fixes',
    ])
      writeFileSync(path.join(dir, name), 'x')

    openDatabase(file).$client.close()

    expect(backups(dir)).toEqual([
      'library.db.before-v2',
      'library.db.before-v3',
      `library.db.before-v${MIGRATIONS.length}`,
    ])
    expect(existsSync(`${file}.before-error-fixes`)).toBe(true)
  })
})
