import type {
  CatalogRelease,
  CatalogTrack,
  LikedSong,
  YouTubeMusicCatalog,
} from '../catalog/types'
import type { ArtistCredit, ReleaseKind } from '../domain'
import type { HttpClient } from '../net/http'

/**
 * Matcher: turns a Source Contribution into a Match (see CONTEXT.md).
 * Only the catalog decision is required; MusicBrainz enrichment is separate
 * and its failures never block acquisition.
 */

export type MatchInput =
  | { kind: 'liked'; song: LikedSong }
  | {
      kind: 'catalog'
      /** Full Discography artist whose Official Main Catalog produced this track. */
      artistId: string
      release: CatalogRelease
      track: CatalogTrack
    }

export interface MatchedRelease {
  browseId: string
  title: string
  kind: ReleaseKind | null
  artists: ArtistCredit[]
  year: number | null
  /** ISO date with its real precision: YYYY, YYYY-MM or YYYY-MM-DD. */
  date: string | null
  trackNumber: number | null
  trackTotal: number | null
  discNumber: number | null
  discTotal: number | null
  thumbnailUrl: string | null
}

export type ResolutionMethod =
  /** Full Discography catalog track; the value predates the rename and is stored in files. */
  | 'favorite_artist_release_exact'
  | 'liked_album_exact'
  | 'search_song_exact'
  | 'watch_playlist'
  | 'standalone'

export interface Match {
  version: 1
  /** The video the user liked, or the catalog track for catalog contributions. */
  sourceVideoId: string
  /**
   * The video to download. For Release Tracks this is the video ID listed on
   * the Release's own track list; for Standalone Tracks it equals sourceVideoId.
   */
  catalogVideoId: string
  /** `<releaseBrowseId>:<catalogVideoId>` or `video:<sourceVideoId>` (ADR 0002). */
  identityKey: string
  release: MatchedRelease | null
  title: string
  artists: ArtistCredit[]
  /** Album tag. For Standalone Tracks this is the title (each is its own single). */
  album: string
  albumArtist: string
  durationSeconds: number | null
  coverUrl: string | null
  /** MPLY... lyrics browse ID found while matching, if any. */
  lyricsBrowseId: string | null
  resolutionMethod: ResolutionMethod
  /**
   * Set when this app's matcher produced the Match, or when it was restored
   * from a file that records exactly that. Older saved Matches lack it.
   */
  confirmed?: true
}

export const RESOLUTION_METHODS: readonly ResolutionMethod[] = [
  'favorite_artist_release_exact',
  'liked_album_exact',
  'search_song_exact',
  'watch_playlist',
  'standalone',
]

export interface Enrichment {
  mbRecordingId: string | null
  /** Up to MUSICBRAINZ_GENRE_LIMIT genres joined with "; ", title-cased as today. */
  genre: string | null
  isrc: string | null
}

export interface Matcher {
  match(input: MatchInput, signal?: AbortSignal): Promise<Match>
  /** MusicBrainz lookup. Throws on network errors; callers record them as enrichment errors. */
  enrich(match: Match, signal?: AbortSignal): Promise<Enrichment>
}

export interface MatcherDeps {
  catalog: YouTubeMusicCatalog
  http: HttpClient
}

export function releaseIdentityKey(
  releaseBrowseId: string,
  catalogVideoId: string
): string {
  return `${releaseBrowseId}:${catalogVideoId}`
}

export function standaloneIdentityKey(sourceVideoId: string): string {
  return `video:${sourceVideoId}`
}
