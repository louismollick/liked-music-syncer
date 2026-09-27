import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { MIGRATIONS } from './migrations'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database
}

export function openDatabase(file: string): Db {
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  migrate(sqlite)
  return drizzle(sqlite, { schema }) as Db
}

export function migrate(sqlite: Database.Database): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema ${current} is newer than this app (${MIGRATIONS.length}). Update the app.`
    )
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    sqlite.transaction(() => {
      sqlite.exec(MIGRATIONS[version])
      sqlite.pragma(`user_version = ${version + 1}`)
    })()
  }
}
