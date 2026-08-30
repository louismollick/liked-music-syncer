import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { nativeImage, net } from 'electron'
import { buildArtistPhotoMediaUrl } from './artwork-protocol'

const ARTIST_PHOTO_MAX_EDGE = 512

type DownloadPhoto = (remoteUrl: string) => Promise<Buffer>

export function artistPhotoCacheFileName(remoteUrl: string): string {
  return `${createHash('sha256').update(`artist-photo|${remoteUrl}`).digest('hex')}.jpg`
}

async function downloadPhotoAsJpeg(remoteUrl: string): Promise<Buffer> {
  const response = await net.fetch(remoteUrl)
  if (!response.ok) {
    throw new Error(`Artist photo download failed with HTTP ${response.status}`)
  }

  const source = Buffer.from(await response.arrayBuffer())
  const image = nativeImage.createFromBuffer(source)
  if (image.isEmpty()) {
    throw new Error('Artist photo response was not a supported image')
  }

  const size = image.getSize()
  const largestEdge = Math.max(size.width, size.height)
  const thumbnail =
    largestEdge > ARTIST_PHOTO_MAX_EDGE
      ? image.resize({
          width: Math.max(
            1,
            Math.round((size.width * ARTIST_PHOTO_MAX_EDGE) / largestEdge)
          ),
          height: Math.max(
            1,
            Math.round((size.height * ARTIST_PHOTO_MAX_EDGE) / largestEdge)
          ),
          quality: 'best',
        })
      : image
  return thumbnail.toJPEG(88)
}

export class ArtistPhotoCache {
  private readonly pending = new Map<string, Promise<string>>()

  constructor(
    private readonly cacheDirectory: string,
    private readonly downloadPhoto: DownloadPhoto = downloadPhotoAsJpeg
  ) {
    fs.mkdirSync(this.cacheDirectory, { recursive: true })
  }

  resolvePhotoUrl(remoteUrl: string): string {
    const fileName = artistPhotoCacheFileName(remoteUrl)
    return fs.existsSync(path.join(this.cacheDirectory, fileName))
      ? buildArtistPhotoMediaUrl(fileName)
      : remoteUrl
  }

  async cacheRemotePhoto(remoteUrl: string): Promise<string> {
    const resolved = this.resolvePhotoUrl(remoteUrl)
    if (resolved !== remoteUrl) return resolved

    const existing = this.pending.get(remoteUrl)
    if (existing) return existing

    const job = this.downloadAndStore(remoteUrl)
    this.pending.set(remoteUrl, job)
    try {
      return await job
    } finally {
      this.pending.delete(remoteUrl)
    }
  }

  async clear(): Promise<number> {
    await Promise.allSettled(this.pending.values())
    const entries = await fs.promises.readdir(this.cacheDirectory, {
      withFileTypes: true,
    })
    const files = entries.filter((entry) => entry.isFile())
    await Promise.all(
      files.map((entry) =>
        fs.promises.unlink(path.join(this.cacheDirectory, entry.name))
      )
    )
    return files.length
  }

  private async downloadAndStore(remoteUrl: string): Promise<string> {
    const fileName = artistPhotoCacheFileName(remoteUrl)
    const cachePath = path.join(this.cacheDirectory, fileName)
    const temporaryPath = `${cachePath}.${process.pid}.tmp`
    const jpeg = await this.downloadPhoto(remoteUrl)
    try {
      await fs.promises.writeFile(temporaryPath, jpeg)
      await fs.promises.rename(temporaryPath, cachePath)
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => undefined)
    }
    return buildArtistPhotoMediaUrl(fileName)
  }
}
