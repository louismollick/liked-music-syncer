import type { YouTubeMusicCatalog } from '../catalog/types'
import type { ArtistCredit } from '../domain'
import type { HttpClient } from '../net/http'

export type LyricsSource =
  | 'spotify'
  | 'youtube-music'
  | 'lrclib'
  | 'petitlyrics'

export interface LyricsQuery {
  title: string
  artists: ArtistCredit[]
  /** Canonical and native channel-page names, alongside the original credits. */
  artistVariants?: string[]
  album: string | null
  durationSeconds: number | null
  /** MPLY... browse ID from the Match, when known. */
  lyricsBrowseId: string | null
  /** Spotify track ID remembered from an earlier lookup, if any. */
  spotifyTrackId: string | null
}

export interface FoundLyrics {
  /** LRC text (`[mm:ss.xx]line`) when synced, else plain text. Trimmed, no trailing newline. */
  text: string
  synced: boolean
  source: LyricsSource
  /** ISO 639-1 code detected from the lyrics text, or null. */
  language: string | null
}

export interface LyricsResult {
  lyrics: FoundLyrics | null
  /** Spotify track ID found or reused during the lookup (saved for next time). */
  spotifyTrackId: string | null
  /** One message per provider that failed; failures never throw. */
  errors: Partial<Record<LyricsSource, string>>
}

export interface LyricsOptions {
  /** Optional lyricbridge-compatible server (`GET <url>?trackid=<id>&format=lrc`). */
  lyricsServerUrl: string | null
}

export interface LyricsFinder {
  /**
   * Looks for synced lyrics first (Spotify via the lyrics server, then YouTube
   * Music, then LRCLIB), then plain lyrics in the same order.
   */
  find(
    query: LyricsQuery,
    options: LyricsOptions,
    signal?: AbortSignal
  ): Promise<LyricsResult>
}

export interface LyricsDeps {
  http: HttpClient
  catalog: YouTubeMusicCatalog
}
