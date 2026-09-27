import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { YouTubeMusicCatalog } from './catalog/types'
import type { Db } from './library/db'
import { artists } from './library/schema'
import type { HttpClient } from './net/http'
import { sha256 } from './tags/schema'

/** Fetches and caches artist photos for identified Artists, a few at a time. */
export function createArtistImages(deps: {
  db: Db
  catalog: YouTubeMusicCatalog
  http: HttpClient
  dir: string
  onUpdated: () => void
}) {
  let running = false
  return {
    async run(limit = 400): Promise<void> {
      if (running) return
      running = true
      try {
        const todo = deps.db
          .select()
          .from(artists)
          .where(
            and(isNotNull(artists.channelId), isNull(artists.imageCheckedAt))
          )
          .limit(limit)
          .all()
        await mkdir(deps.dir, { recursive: true })
        let changed = 0
        const queue = [...todo]
        const worker = async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            let imagePath: string | null = null
            try {
              const artist = await deps.catalog.artist(next.channelId!)
              if (artist.thumbnailUrl) {
                const bytes = await deps.http.bytes(artist.thumbnailUrl, {
                  host: 'images',
                })
                imagePath = path.join(deps.dir, `${sha256(bytes)}.jpg`)
                await writeFile(imagePath, bytes)
              }
            } catch {
              imagePath = null
            }
            deps.db
              .update(artists)
              .set({ imagePath, imageCheckedAt: new Date().toISOString() })
              .where(eq(artists.id, next.id))
              .run()
            changed += 1
            if (changed % 12 === 0) deps.onUpdated()
          }
        }
        await Promise.all([worker(), worker(), worker()])
        if (changed) deps.onUpdated()
      } finally {
        running = false
      }
    },
  }
}
