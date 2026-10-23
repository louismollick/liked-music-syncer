import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createArtistImages } from '../src/main/artist-images'
import type { YouTubeMusicCatalog } from '../src/main/catalog/types'
import { openDatabase } from '../src/main/library/db'
import { artists } from '../src/main/library/schema'
import type { HttpClient } from '../src/main/net/http'

function setup(thumbnail: () => Promise<string | null>) {
  const db = openDatabase(':memory:')
  db.insert(artists).values({ id: 'a', name: 'A', channelId: 'chan' }).run()
  const images = createArtistImages({
    db,
    catalog: {
      artist: async () => ({ thumbnailUrl: await thumbnail() }),
    } as unknown as YouTubeMusicCatalog,
    http: {
      bytes: async () => new Uint8Array([1, 2, 3]),
    } as unknown as HttpClient,
    dir: mkdtempSync(path.join(tmpdir(), 'lms-artist-images-')),
    onUpdated: () => {},
  })
  const row = () => db.select().from(artists).where(eq(artists.id, 'a')).get()
  return { images, row }
}

describe('artist images', () => {
  it('leaves an artist unchecked when the lookup fails, then retries', async () => {
    let fail = true
    const { images, row } = setup(async () => {
      if (fail) throw new Error('offline')
      return 'https://images.test/a.jpg'
    })
    await images.run()
    expect(row()).toMatchObject({ imageCheckedAt: null, imagePath: null })
    fail = false
    await images.run()
    expect(row()?.imageCheckedAt).not.toBeNull()
    expect(row()?.imagePath).toMatch(/\.jpg$/)
  })

  it('records an artist without a photo as checked', async () => {
    const { images, row } = setup(async () => null)
    await images.run()
    expect(row()?.imageCheckedAt).not.toBeNull()
    expect(row()?.imagePath).toBeNull()
  })
})
