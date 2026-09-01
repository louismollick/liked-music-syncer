import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
  net: {
    fetch: vi.fn(),
  },
}))

import {
  ArtistPhotoCache,
  artistPhotoCacheFileName,
} from '../src/main/services/artist-photo-cache'
import { buildArtistPhotoMediaUrl } from '../src/main/services/artwork-protocol'

describe('ArtistPhotoCache', () => {
  const cacheDirs: string[] = []

  afterEach(() => {
    for (const dir of cacheDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('downloads a remote photo once and resolves it locally afterwards', async () => {
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lms-artist-photo-cache-')
    )
    cacheDirs.push(cacheDir)
    const downloadPhoto = vi.fn().mockResolvedValue(Buffer.from('jpeg-data'))
    const cache = new ArtistPhotoCache(cacheDir, downloadPhoto)
    const remoteUrl = 'https://example.test/artist.jpg'
    const fileName = artistPhotoCacheFileName(remoteUrl)

    expect(cache.resolvePhotoUrl(remoteUrl)).toBe(remoteUrl)

    const firstUrl = await cache.cacheRemotePhoto(remoteUrl)
    const secondUrl = await cache.cacheRemotePhoto(remoteUrl)

    expect(firstUrl).toBe(buildArtistPhotoMediaUrl(fileName))
    expect(secondUrl).toBe(firstUrl)
    expect(cache.resolvePhotoUrl(remoteUrl)).toBe(firstUrl)
    expect(downloadPhoto).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(path.join(cacheDir, fileName))).toEqual(
      Buffer.from('jpeg-data')
    )
  })

  it('clears only files in the artist photo cache directory', async () => {
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lms-artist-photo-cache-')
    )
    cacheDirs.push(cacheDir)
    fs.writeFileSync(path.join(cacheDir, 'first.jpg'), 'first')
    fs.writeFileSync(path.join(cacheDir, 'second.tmp'), 'second')
    const cache = new ArtistPhotoCache(cacheDir, vi.fn())

    await expect(cache.clear()).resolves.toBe(2)
    expect(fs.readdirSync(cacheDir)).toEqual([])
  })
})
