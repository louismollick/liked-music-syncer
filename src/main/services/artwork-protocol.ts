import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { logMain } from './logger'

export const APP_MEDIA_SCHEME = 'app-media'
const ARTWORK_CACHE_SEGMENT = 'artwork'
const ARTIST_PHOTO_CACHE_SEGMENT = 'artist-photo'

export const ARTWORK_FILENAME_PATTERN = /^[a-f0-9]{64}\.jpg$/u

const loggedProtocolEvents = new Set<string>()

function logProtocolOnce(
  eventKey: string,
  input: Parameters<typeof logMain>[0]
) {
  if (loggedProtocolEvents.has(eventKey)) return
  loggedProtocolEvents.add(eventKey)
  logMain(input)
}

export function buildArtworkMediaUrl(cacheFileName: string): string {
  return `${APP_MEDIA_SCHEME}://${ARTWORK_CACHE_SEGMENT}/${cacheFileName}`
}

export function buildArtistPhotoMediaUrl(cacheFileName: string): string {
  return `${APP_MEDIA_SCHEME}://${ARTIST_PHOTO_CACHE_SEGMENT}/${cacheFileName}`
}

export function resolveArtworkCacheFileName(
  requestUrl: string,
  cacheDirectory: string
): string | null {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== `${APP_MEDIA_SCHEME}:`) {
    return null
  }

  if (parsed.hostname !== ARTWORK_CACHE_SEGMENT) {
    return null
  }

  const fileName = path.basename(parsed.pathname)
  if (!ARTWORK_FILENAME_PATTERN.test(fileName)) {
    return null
  }

  const resolvedCacheDirectory = path.resolve(cacheDirectory)
  const resolvedFilePath = path.resolve(resolvedCacheDirectory, fileName)
  if (
    resolvedFilePath !== resolvedCacheDirectory &&
    !resolvedFilePath.startsWith(`${resolvedCacheDirectory}${path.sep}`)
  ) {
    return null
  }

  return fileName
}

export function resolveArtistPhotoCacheFileName(
  requestUrl: string,
  cacheDirectory: string
): string | null {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (
    parsed.protocol !== `${APP_MEDIA_SCHEME}:` ||
    parsed.hostname !== ARTIST_PHOTO_CACHE_SEGMENT
  ) {
    return null
  }
  const fileName = path.basename(parsed.pathname)
  if (!ARTWORK_FILENAME_PATTERN.test(fileName)) return null
  const resolvedCacheDirectory = path.resolve(cacheDirectory)
  const resolvedFilePath = path.resolve(resolvedCacheDirectory, fileName)
  return resolvedFilePath.startsWith(`${resolvedCacheDirectory}${path.sep}`)
    ? fileName
    : null
}

export function registerArtworkProtocol(
  cacheDirectory: string,
  artistPhotoCacheDirectory?: string
) {
  protocol.handle(APP_MEDIA_SCHEME, async (request) => {
    const artistPhotoFileName = artistPhotoCacheDirectory
      ? resolveArtistPhotoCacheFileName(request.url, artistPhotoCacheDirectory)
      : null
    const fileName =
      artistPhotoFileName ??
      resolveArtworkCacheFileName(request.url, cacheDirectory)
    const selectedCacheDirectory =
      artistPhotoFileName && artistPhotoCacheDirectory
        ? artistPhotoCacheDirectory
        : cacheDirectory
    if (!fileName) {
      logProtocolOnce(`reject:${request.url}`, {
        level: 'debug',
        source: 'artwork-protocol',
        message: 'Rejected artwork media request',
        context: { url: request.url },
      })
      return new Response(null, { status: 404 })
    }

    const filePath = path.join(path.resolve(selectedCacheDirectory), fileName)
    if (!fs.existsSync(filePath)) {
      logProtocolOnce(`miss:${fileName}`, {
        level: 'debug',
        source: 'artwork-protocol',
        message: 'Artwork cache miss for media request',
        context: { fileName },
      })
      return new Response(null, { status: 404 })
    }

    try {
      return net.fetch(pathToFileURL(filePath).toString())
    } catch (error) {
      logMain({
        level: 'warn',
        source: 'artwork-protocol',
        message: 'Failed to serve cached artwork',
        context: {
          fileName,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return new Response(null, { status: 404 })
    }
  })
}

export function registerArtworkSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}
