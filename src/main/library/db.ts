import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { isInstrumentalTitle } from '../lyrics/query'
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
  backUpBeforeMigrating(sqlite, file)
  migrate(sqlite)
  return drizzle(sqlite, { schema }) as Db
}

const KEPT_BACKUPS = 3

/**
 * Before pending migrations change an existing database, copies it to
 * `<file>.before-v<N>` (N is the schema version being migrated to) and keeps
 * the newest few. Skipped for a new, empty database. VACUUM INTO writes a
 * consistent snapshot synchronously, so opening stays synchronous.
 */
function backUpBeforeMigrating(sqlite: Database.Database, file: string): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number
  if (sqlite.memory || current === 0 || current >= MIGRATIONS.length) return
  const backup = `${file}.before-v${MIGRATIONS.length}`
  rmSync(backup, { force: true })
  sqlite.prepare('VACUUM INTO ?').run(backup)
  const prefix = `${path.basename(file)}.before-v`
  const versions = readdirSync(path.dirname(file))
    .flatMap((name) => {
      const version = name.startsWith(prefix) ? name.slice(prefix.length) : ''
      return /^\d+$/.test(version) ? [Number(version)] : []
    })
    .sort((a, b) => b - a)
  for (const version of versions.slice(KEPT_BACKUPS))
    rmSync(`${file}.before-v${version}`, { force: true })
}

export function migrate(sqlite: Database.Database): void {
  sqlite.function('lyrics_instrumental', (title: string) =>
    Number(isInstrumentalTitle(title))
  )
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
