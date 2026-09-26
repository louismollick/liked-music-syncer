import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'

export const MEDIA_SCHEME = 'app-media'

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ])
}

/** Serves cached covers and artist photos from userData. */
export function handleMediaProtocol(userData: string): void {
  const roots: Record<string, string> = {
    covers: path.join(userData, 'covers'),
    artists: path.join(userData, 'artists'),
  }
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const root = roots[url.host]
    const file = path.basename(decodeURIComponent(url.pathname))
    if (!root || !/^[a-f0-9]{64}\.jpg$/.test(file))
      return new Response('Not found', { status: 404 })
    const response = await net.fetch(
      pathToFileURL(path.join(root, file)).toString()
    )
    // Allow canvas reads for artwork-tinted headers; files are immutable (content-addressed).
    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cache-Control', 'max-age=31536000, immutable')
    return new Response(response.body, { status: response.status, headers })
  })
}

export function coverUrlFor(
  coverPath: string | null,
  fallback: string | null
): string | null {
  if (coverPath) return `${MEDIA_SCHEME}://covers/${path.basename(coverPath)}`
  return fallback
}

export function artistImageUrlFor(imagePath: string | null): string | null {
  return imagePath
    ? `${MEDIA_SCHEME}://artists/${path.basename(imagePath)}`
    : null
}
