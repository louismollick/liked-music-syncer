import type { ArtistCredit } from '../domain'

/**
 * YouTube Music catalog interface. All response-shape knowledge lives inside
 * src/main/catalog; callers only see these plain objects.
 *
 * Parsers must throw CatalogShapeError when a response does not have the
 * expected shape, instead of returning an empty list. Source snapshots rely on
 * this to avoid treating a changed page as "the user unliked everything".
 */

export type VideoType =
  | 'ATV'
  | 'OMV'
  | 'UGC'
  | 'OFFICIAL_SOURCE_MUSIC'
  | 'OTHER'

export interface CatalogAlbumRef {
  /** Release browse ID (MPREb_...) when known. */
  browseId: string | null
  name: string
}

export interface CatalogTrack {
  videoId: string
  title: string
  artists: ArtistCredit[]
  album: CatalogAlbumRef | null
  durationSeconds: number | null
  videoType: VideoType | null
  isExplicit: boolean
  thumbnailUrl: string | null
  /** Position on a release track list (1-based) when parsed from a release page. */
  trackNumber: number | null
  /** Disc number when the release page groups tracks by disc; null otherwise. */
  discNumber: number | null
  /** False when YouTube Music marks the item unavailable/greyed out. */
  isAvailable: boolean
}

export interface LikedSong extends CatalogTrack {
  /** 0-based position in the Liked Music playlist (0 = most recently liked). */
  position: number
}

export interface LikedSongsResult {
  tracks: LikedSong[]
  /** Count shown in the playlist header ("1,506 songs"), when present. */
  declaredCount: number | null
  pageCount: number
}

export interface CatalogReleaseRef {
  browseId: string
  title: string
  /** Raw type label from YouTube Music, e.g. "Album", "Single", "EP". */
  kindLabel: string | null
  year: number | null
  thumbnailUrl: string | null
}

export interface CatalogRelease {
  browseId: string
  /** OLAK5uy_... audio playlist ID when present. */
  audioPlaylistId: string | null
  title: string
  kindLabel: string | null
  artists: ArtistCredit[]
  year: number | null
  thumbnailUrl: string | null
  trackCount: number | null
  tracks: CatalogTrack[]
}

export interface CatalogArtist {
  channelId: string
  name: string
  thumbnailUrl: string | null
  /** Releases shown directly on the artist page (may be truncated). */
  albums: CatalogReleaseRef[]
  singles: CatalogReleaseRef[]
  /** Browse endpoints for the full "Albums" / "Singles & EPs" lists, when the page links to them. */
  albumsMore: { browseId: string; params: string | null } | null
  singlesMore: { browseId: string; params: string | null } | null
}

export interface WatchInfo {
  /** MPLY... browse ID of the lyrics tab, when the track has one. */
  lyricsBrowseId: string | null
  /** Metadata of the requested video as the watch page describes it. */
  track: CatalogTrack | null
}

export interface TimedLyricLine {
  startMs: number
  endMs: number | null
  text: string
}

export interface CatalogLyrics {
  /** Timed lines, when YouTube Music has synced lyrics. */
  timed: TimedLyricLine[] | null
  /** Plain lyrics text, when available. */
  plain: string | null
  /** Provider credit line, e.g. "Source: LyricFind". */
  source: string | null
}

export interface CatalogAccount {
  name: string
  handle: string | null
  channelId: string | null
  photoUrl: string | null
}

export interface SearchOptions {
  /** Mirrors ytmusicapi's ignore_spelling (disable autocorrect). */
  ignoreSpelling?: boolean
  limit?: number
}

export interface YouTubeMusicCatalog {
  /** Every item of the signed-in account's Liked Music playlist (VLLM), all pages. */
  likedSongs(signal?: AbortSignal): Promise<LikedSongsResult>
  release(browseId: string, signal?: AbortSignal): Promise<CatalogRelease>
  artist(channelId: string, signal?: AbortSignal): Promise<CatalogArtist>
  /** Full album + single/EP lists for an artist, following "more" links and continuations. */
  artistReleases(
    channelId: string,
    signal?: AbortSignal
  ): Promise<CatalogReleaseRef[]>
  searchSongs(
    query: string,
    options?: SearchOptions,
    signal?: AbortSignal
  ): Promise<CatalogTrack[]>
  watch(videoId: string, signal?: AbortSignal): Promise<WatchInfo>
  lyrics(browseId: string, signal?: AbortSignal): Promise<CatalogLyrics | null>
  account(signal?: AbortSignal): Promise<CatalogAccount | null>
}

export type InnertubeClientName = 'WEB_REMIX' | 'ANDROID_MUSIC'

export interface InnertubeRequest {
  endpoint: 'browse' | 'next' | 'search' | 'player' | 'account/account_menu'
  body: Record<string, unknown>
  /** Send the Google Session's cookies and SAPISIDHASH. Only for personal reads. */
  authenticated: boolean
  client?: InnertubeClientName
  signal?: AbortSignal
}

/** Transport provided by the Google Session module; returns parsed JSON. */
export interface InnertubeTransport {
  call(request: InnertubeRequest): Promise<unknown>
}

export class CatalogShapeError extends Error {
  readonly kind = 'permanent' as const
  constructor(message: string) {
    super(message)
    this.name = 'CatalogShapeError'
  }
}
