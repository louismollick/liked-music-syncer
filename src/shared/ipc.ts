import { z } from 'zod'

/**
 * The single IPC contract between main and renderer. Main validates every
 * invoke argument with these schemas; the preload exposes typed wrappers.
 */

export const settingsSchema = z.object({
  libraryFolder: z.string(),
  remoteEnabled: z.boolean(),
  rcloneRemote: z.string(),
  remoteFolder: z.string(),
  lyricsEnabled: z.boolean(),
  lyricsServerUrl: z.string(),
  selectedAccountId: z.string().nullable(),
})
export type Settings = z.infer<typeof settingsSchema>

export interface AccountView {
  id: string
  name: string
  handle: string | null
  photoUrl: string | null
  likedCount: number | null
}

export interface SessionView {
  state: 'signed_out' | 'signed_in' | 'checking' | 'error'
  accounts: AccountView[]
  selectedAccountId: string | null
  message: string | null
}

export type ActivityStage = 'matching' | 'downloading' | 'uploading'

export interface ActivityTrackView {
  id: string
  title: string
  artist: string
  coverUrl: string | null
  stage: ActivityStage | null
  /** Weighted progress across the whole pipeline, 0..1. */
  progress: number
  completedAt: string | null
}

export interface AttentionItemView {
  id: string
  kind: 'track' | 'source' | 'outside_edit'
  title: string
  subtitle: string | null
  reason: string
  coverUrl: string | null
}

export interface ActivityView {
  working: boolean
  checking: boolean
  lastCheckedAt: string | null
  current: ActivityTrackView | null
  upNext: ActivityTrackView[]
  upNextCount: number
  recent: ActivityTrackView[]
  needsAttention: AttentionItemView[]
}

export type LyricsFilter = 'synced' | 'plain' | 'none'
export type RemoteState =
  | 'in_sync'
  | 'stale'
  | 'missing'
  | 'uploading'
  | 'failed'
  | 'off'

export const songFiltersSchema = z.object({
  lyrics: z.enum(['synced', 'plain', 'none']).optional(),
  remote: z.enum(['in_sync', 'stale', 'missing']).optional(),
  language: z.string().optional(),
  state: z.enum(['needs_attention', 'no_longer_wanted']).optional(),
  favorite: z.boolean().optional(),
})
export type SongFilters = z.infer<typeof songFiltersSchema>

export const songSortSchema = z.enum([
  'liked',
  'title',
  'artist',
  'album',
  'year',
  'time',
])
export type SongSort = z.infer<typeof songSortSchema>

export const songQuerySchema = z.object({
  filters: songFiltersSchema.default({}),
  sort: songSortSchema.default('liked'),
  descending: z.boolean().default(true),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(5000).default(500),
  artistId: z.string().optional(),
  albumKey: z.string().optional(),
})
export type SongQuery = z.input<typeof songQuerySchema>

export interface SongRowView {
  id: string
  title: string
  artist: string
  artistId: string | null
  album: string
  albumKey: string | null
  year: number | null
  language: string | null
  durationSeconds: number | null
  lyricsStatus: LyricsFilter
  remoteState: RemoteState
  state: 'pending' | 'working' | 'done' | 'needs_attention' | 'no_longer_wanted'
  /** ISO time of the Liked Date, or null when no liked contribution backs the track. */
  likedAt: string | null
  /** True when only a Favorite Artist catalog backs the track. */
  catalogOnly: boolean
  coverUrl: string | null
  trackNumber: number | null
  standalone: boolean
}

export interface SongPage {
  total: number
  rows: SongRowView[]
}

export interface ArtistView {
  id: string
  name: string
  imageUrl: string | null
  songCount: number
  favorite: boolean
  suggested: boolean
  identified: boolean
}

export interface AlbumView {
  key: string
  title: string
  albumArtist: string
  artistId: string | null
  year: number | null
  songCount: number
  coverUrl: string | null
  durationSeconds: number
}

export interface ArtistDetailView {
  artist: ArtistView
  albums: AlbumView[]
  standalone: SongRowView[]
  albumCount: number
}

export interface AlbumDetailView {
  album: AlbumView
  tracks: SongRowView[]
}

export interface TrackDetailView {
  song: SongRowView
  artists: Array<{ id: string; name: string }>
  contributions: Array<{
    kind: 'liked' | 'catalog'
    label: string
    at: string | null
  }>
  match: {
    catalogVideoId: string | null
    sourceVideoId: string | null
    releaseTitle: string | null
    releaseYear: number | null
    resolution: string | null
    genre: string | null
    genreSource: string | null
  }
  lyrics: {
    status: LyricsFilter
    source: string | null
    language: string | null
  }
  file: { path: string | null; absolutePath: string | null }
  remote: { state: RemoteState; differences: string[] }
  outsideEdit: string[] | null
  enrichmentErrors: Record<string, string>
  lastError: string | null
}

export interface SearchResultsView {
  artists: ArtistView[]
  albums: AlbumView[]
  songs: SongRowView[]
}

export const artistQuerySchema = z.object({
  favorites: z.boolean().optional(),
  suggested: z.boolean().optional(),
  sort: z.enum(['songs', 'name']).default('songs'),
})
export type ArtistQuery = z.input<typeof artistQuerySchema>

export const albumQuerySchema = z.object({
  sort: z.enum(['liked', 'title', 'year']).default('liked'),
})
export type AlbumQuery = z.input<typeof albumQuerySchema>

export const refreshScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('track'), id: z.string() }),
  z.object({ kind: z.literal('album'), key: z.string() }),
  z.object({ kind: z.literal('artist'), id: z.string() }),
  z.object({ kind: z.literal('all') }),
])
export type RefreshScope = z.infer<typeof refreshScopeSchema>

export const deleteRequestSchema = z.object({
  trackIds: z.array(z.string()).min(1),
  where: z.enum(['local', 'remote', 'both']),
})

export interface LibraryCounts {
  songs: number
  artists: number
  albums: number
  needsAttention: number
  noLongerWanted: number
  unmanaged: number
}

/** Invoke channels: name -> [argument, result]. */
export interface InvokeMap {
  'settings:get': [void, Settings]
  'settings:update': [Partial<Settings>, Settings]
  'settings:chooseFolder': [void, string | null]
  'session:get': [void, SessionView]
  'session:signIn': [void, SessionView]
  'session:signOut': [void, SessionView]
  'session:selectAccount': [string, SessionView]
  'activity:get': [void, ActivityView]
  'activity:check': [void, void]
  'activity:refreshCatalogs': [void, void]
  'activity:retry': [string, void]
  'activity:rewrite': [string, void]
  'activity:stopManaging': [string, void]
  'library:counts': [void, LibraryCounts]
  'library:songs': [SongQuery, SongPage]
  'library:artists': [ArtistQuery, ArtistView[]]
  'library:albums': [AlbumQuery, AlbumView[]]
  'library:artist': [string, ArtistDetailView | null]
  'library:album': [string, AlbumDetailView | null]
  'library:track': [string, TrackDetailView | null]
  'library:search': [string, SearchResultsView]
  'library:setFavorite': [{ artistId: string; favorite: boolean }, void]
  'library:refresh': [RefreshScope, void]
  'library:delete': [z.infer<typeof deleteRequestSchema>, string[]]
  'library:unmanaged': [void, Array<{ path: string; size: number }>]
  'app:showInFinder': [string, void]
}

export type InvokeChannel = keyof InvokeMap

/** Event channels pushed from main. */
export interface EventMap {
  'activity:changed': ActivityView
  'library:changed': { trackIds: string[] | null }
  'session:changed': SessionView
  'settings:changed': Settings
}

export type EventChannel = keyof EventMap

export const invokeArgSchemas: Partial<Record<InvokeChannel, z.ZodType>> = {
  'settings:update': settingsSchema.partial(),
  'session:selectAccount': z.string(),
  'activity:retry': z.string(),
  'activity:rewrite': z.string(),
  'activity:stopManaging': z.string(),
  'library:songs': songQuerySchema,
  'library:artists': artistQuerySchema,
  'library:albums': albumQuerySchema,
  'library:artist': z.string(),
  'library:album': z.string(),
  'library:track': z.string(),
  'library:search': z.string().max(200),
  'library:setFavorite': z.object({
    artistId: z.string(),
    favorite: z.boolean(),
  }),
  'library:refresh': refreshScopeSchema,
  'library:delete': deleteRequestSchema,
  'app:showInFinder': z.string(),
}

export interface RendererApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeMap[C][0] extends void ? [] : [InvokeMap[C][0]]
  ): Promise<InvokeMap[C][1]>
  on<C extends EventChannel>(
    channel: C,
    listener: (payload: EventMap[C]) => void
  ): () => void
}
