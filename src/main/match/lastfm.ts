import { z } from 'zod'
import type { HttpClient } from '../net/http'
import genreList from './genres.txt?raw'

const MIN_COUNT = 10
const GENRE_LIMIT = 3
const NOT_FOUND = 6

/**
 * The vendored list of recognized genre names (genres.txt). Last.fm tags are
 * free text ("seen live", "japanese"), so only these count as genres. Keyed
 * without spaces and hyphens so "post punk" finds "post-punk".
 */
const GENRES = new Map(
  genreList
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .map((genre) => [genre.replace(/[\s-]/g, ''), genre])
)

const topTagsSchema = z.union([
  z.object({
    toptags: z.object({
      tag: z.array(z.object({ name: z.string(), count: z.coerce.number() })),
    }),
  }),
  z.object({ error: z.number(), message: z.string().optional() }),
])

/** Up to three real genres with enough votes, lowercased and joined with "; ". */
export function lastfmGenres(payload: unknown): string | null {
  const parsed = topTagsSchema.parse(payload)
  if ('error' in parsed) {
    if (parsed.error === NOT_FOUND) return null
    throw new Error(`Last.fm error ${parsed.error}: ${parsed.message ?? ''}`)
  }
  const genres = new Set<string>()
  for (const { name, count } of parsed.toptags.tag) {
    const genre = GENRES.get(name.toLowerCase().replace(/[\s-]/g, ''))
    if (genre && count >= MIN_COUNT) genres.add(genre)
  }
  return genres.size ? [...genres].slice(0, GENRE_LIMIT).join('; ') : null
}

/**
 * Genres for an artist from Last.fm top tags, cached by our trusted artist ID
 * until cleared. Last.fm only takes a name, so callers must not ask for artists
 * whose name is ambiguous or unidentified, and autocorrect stays off so Last.fm
 * never swaps in a differently spelled artist.
 */
export function createLastfmGenres(http: HttpClient) {
  const cache = new Map<string, string | null>()
  return {
    clear: () => cache.clear(),
    async lookup(
      artist: { id: string; name: string },
      apiKey: string,
      signal?: AbortSignal
    ): Promise<string | null> {
      const cached = cache.get(artist.id)
      if (cached !== undefined) return cached
      const url = new URL('https://ws.audioscrobbler.com/2.0/')
      url.searchParams.set('method', 'artist.gettoptags')
      url.searchParams.set('artist', artist.name)
      url.searchParams.set('api_key', apiKey)
      url.searchParams.set('autocorrect', '0')
      url.searchParams.set('format', 'json')
      const genre = lastfmGenres(
        await http.json<unknown>(url.toString(), { host: 'lastfm', signal })
      )
      cache.set(artist.id, genre)
      return genre
    },
  }
}
