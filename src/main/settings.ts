import { eq } from 'drizzle-orm'
import type { Db } from './library/db'
import { settings as settingsTable } from './library/schema'
import type { Settings } from '../shared/ipc'

export const DEFAULT_SETTINGS: Settings = {
  libraryFolder: '',
  remoteEnabled: false,
  rcloneRemote: '',
  remoteFolder: '',
  lyricsEnabled: true,
  lyricsServerUrl: '',
  selectedAccountId: null,
}

type Listener = (settings: Settings) => void

export class SettingsStore {
  private cache: Settings
  private listeners = new Set<Listener>()

  constructor(private readonly db: Db) {
    this.cache = this.load()
  }

  private load(): Settings {
    const rows = this.db.select().from(settingsTable).all()
    const loaded: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    for (const row of rows) {
      if (!(row.key in DEFAULT_SETTINGS)) continue
      try {
        loaded[row.key] = JSON.parse(row.value)
      } catch {
        // Ignore unreadable values and keep the default.
      }
    }
    return loaded as unknown as Settings
  }

  get(): Settings {
    return { ...this.cache }
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.cache, ...patch }
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS)) continue
        const serialized = JSON.stringify(value)
        const existing = tx.select().from(settingsTable).where(eq(settingsTable.key, key)).get()
        if (existing) {
          tx.update(settingsTable).set({ value: serialized }).where(eq(settingsTable.key, key)).run()
        } else {
          tx.insert(settingsTable).values({ key, value: serialized }).run()
        }
      }
    })
    this.cache = next
    for (const listener of this.listeners) listener(this.get())
    return this.get()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
