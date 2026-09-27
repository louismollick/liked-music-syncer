import type { HttpClient } from '../net/http'

/** The public YouTube title occasionally preserves a song title hidden by Music. */
export async function youtubeOriginalTitle(
  http: HttpClient,
  videoId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const url = new URL('https://www.youtube.com/oembed')
  url.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`)
  url.searchParams.set('format', 'json')
  const payload = await http.json<unknown>(url.toString(), {
    host: 'youtube',
    signal,
  })
  if (payload && typeof payload === 'object' && 'title' in payload) {
    const title = (payload as { title: unknown }).title
    return typeof title === 'string' ? title.trim() || null : null
  }
  return null
}
