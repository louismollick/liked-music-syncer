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
})
