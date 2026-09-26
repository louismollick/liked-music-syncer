import { type ClassifiedLyrics, classifyLyricsText } from './classify'
import { detectLyricsLanguage } from './language'
import { lrclibLyrics } from './lrclib'
import { createSpotifyClient } from './spotify'
import type {
  LyricsDeps,
  LyricsFinder,
  LyricsResult,
  LyricsSource,
} from './types'
import { youtubeMusicLyrics } from './youtube-music'

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function throwAbort(error: unknown): never {
  if (error instanceof Error && error.name === 'AbortError') throw error
  throw new DOMException('The operation was aborted', 'AbortError')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createLyricsFinder(deps: LyricsDeps): LyricsFinder {
  const spotify = createSpotifyClient(deps.http)
  return {
    async find(query, options, signal): Promise<LyricsResult> {
      if (signal?.aborted) throwAbort(signal.reason)
      const errors: LyricsResult['errors'] = {}
      let spotifyTrackId = query.spotifyTrackId
      let firstPlain: { text: string; source: LyricsSource } | null = null

      async function consider(
        source: LyricsSource,
        fetch: () => Promise<string | null>
      ) {
        try {
          const classified: ClassifiedLyrics | null = classifyLyricsText(
            await fetch()
          )
          if (!classified) return null
          if (classified.synced) return { text: classified.text, source }
          firstPlain ??= { text: classified.text, source }
          return null
        } catch (error) {
          if (isAbort(error, signal)) throwAbort(error)
          errors[source] = message(error)
          return null
        }
      }

      let synced: { text: string; source: LyricsSource } | null = null
      if (options.lyricsServerUrl?.trim()) {
        synced = await consider('spotify', async () => {
          spotifyTrackId ??= await spotify.search(query, signal)
          return spotifyTrackId
            ? spotify.lyrics(spotifyTrackId, options.lyricsServerUrl!, signal)
            : null
        })
      }
      if (!synced)
        synced = await consider('youtube-music', () =>
          youtubeMusicLyrics(deps.catalog, query, signal)
        )
      if (!synced)
        synced = await consider('lrclib', () =>
          lrclibLyrics(deps.http, query, signal)
        )
      const selected = synced ?? firstPlain
      let language: string | null = null
      if (selected) {
        try {
          language = await detectLyricsLanguage(selected.text)
        } catch (error) {
          if (isAbort(error, signal)) throwAbort(error)
          errors[selected.source] ??= message(error)
        }
      }
      return {
        lyrics: selected
          ? {
              text: selected.text,
              synced: Boolean(synced),
              source: selected.source,
              language,
            }
          : null,
        spotifyTrackId,
        errors,
      }
    },
  }
}
