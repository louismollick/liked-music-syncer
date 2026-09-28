import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/library/db'
import { MIGRATIONS } from '../../src/main/library/migrations'

describe('migrations', () => {
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
})
