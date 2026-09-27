import path from 'node:path'
import type {
  AlbumDetailView,
  AlbumQuery,
  AlbumView,
  ArtistDetailView,
  ArtistQuery,
  ArtistView,
  LibraryCounts,
  RemoteState,
  SearchResultsView,
  Settings,
  SongPage,
  SongQuery,
  SongRowView,
  TrackDetailView,
} from '../../shared/ipc'
import {
  albumQuerySchema,
  artistQuerySchema,
  songQuerySchema,
} from '../../shared/ipc'
import { albumKey, decodeAlbumKey } from '../reconcile/reconciler'
import { fieldDiff, type TagFields } from '../tags/schema'
import type { Db } from './db'

/**
 * Read-side queries for the renderer. The renderer asks for exactly what it
 * shows; it never receives table rows.
 */

export type CoverUrl = (
  coverPath: string | null,
  fallback: string | null
) => string | null

interface SongSqlRow {
  id: string
  title: string
  artist: string
  album: string
  album_artist: string
  release_id: string | null
  year: number | null
  language: string | null
  duration_seconds: number | null
  lyrics_status: 'synced' | 'plain' | 'none'
  state: SongRowView['state']
  cover_path: string | null
  cover_url: string | null
  track_number: number | null
  disc_number: number | null
  has_file: number
  remote_state: 'in_sync' | 'stale' | 'missing'
  liked_at: string | null
  liked_pos: number | null
  has_catalog: number
  artist_id: string | null
  last_error_step: string | null
}

const REMOTE_STATE_SQL = `
  CASE
    WHEN u.track_id IS NULL THEN 'missing'
    WHEN f.track_id IS NOT NULL AND u.local_sha256 = f.content_sha256 AND u.remote_path = f.relative_path
      AND IFNULL(u.lrc_hash, '') = IFNULL(f.lrc_sha256, '') THEN 'in_sync'
    WHEN f.track_id IS NULL THEN 'in_sync'
    ELSE 'stale'
  END`

const SONG_SELECT = `
  SELECT t.id, t.title, t.artist, t.album, t.album_artist, t.release_id, t.year, t.language,
    t.duration_seconds, t.lyrics_status, t.state, t.cover_path, t.cover_url, t.track_number, t.disc_number,
    t.last_error_step,
    (f.track_id IS NOT NULL) AS has_file,
    ${REMOTE_STATE_SQL} AS remote_state,
    (SELECT MIN(c.first_seen_at) FROM contributions c WHERE c.track_id = t.id AND c.kind = 'liked' AND c.active = 1) AS liked_at,
    (SELECT MIN(c.liked_position) FROM contributions c WHERE c.track_id = t.id AND c.kind = 'liked' AND c.active = 1) AS liked_pos,
    EXISTS (SELECT 1 FROM contributions c WHERE c.track_id = t.id AND c.kind = 'catalog' AND c.active = 1) AS has_catalog,
    (SELECT ta.artist_id FROM track_artists ta WHERE ta.track_id = t.id ORDER BY ta.position LIMIT 1) AS artist_id
  FROM tracks t
  LEFT JOIN files f ON f.track_id = t.id
  LEFT JOIN uploads u ON u.track_id = t.id`

const IN_LIBRARY_WITH_REMOTE = `(f.track_id IS NOT NULL OR u.track_id IS NOT NULL)`
/** With the remote off, remote-only songs can't be acted on, so they're hidden. */
const IN_LIBRARY_LOCAL = `(f.track_id IS NOT NULL)`

export class LibraryQueries {
  constructor(
    private readonly db: Db,
    private readonly coverUrl: CoverUrl,
    private readonly artistImageUrl: (
      imagePath: string | null
    ) => string | null,
    private readonly settings: () => Settings
  ) {}

  private get sqlite() {
    return this.db.$client
  }

  private toSong(row: SongSqlRow): SongRowView {
    const remoteOn = this.remoteOn()
    // No Longer Wanted tracks are never uploaded, so "missing" is expected;
    // a copy still on the remote is worth showing (it can be deleted there).
    const expectedMissing =
      row.state === 'no_longer_wanted' && row.remote_state === 'missing'
    let remoteState: RemoteState =
      remoteOn && !expectedMissing ? row.remote_state : 'off'
    if (
      remoteOn &&
      row.state === 'needs_attention' &&
      row.last_error_step === 'upload'
    )
      remoteState = 'failed'
    return {
      id: row.id,
      title: row.title,
      artist: row.artist,
      artistId: row.artist_id,
      album: row.album,
      albumKey: row.release_id ? albumKey(row.album, row.album_artist) : null,
      year: row.year,
      language: row.language,
      durationSeconds: row.duration_seconds,
      lyricsStatus: row.lyrics_status,
      remoteState,
      state: row.state,
      likedAt: row.liked_at,
      catalogOnly: !row.liked_at && Boolean(row.has_catalog),
      coverUrl: this.coverUrl(row.cover_path, row.cover_url),
      trackNumber: row.track_number,
      standalone: !row.release_id,
    }
  }

  private inLibrary(): string {
    return this.remoteOn() ? IN_LIBRARY_WITH_REMOTE : IN_LIBRARY_LOCAL
  }

  private remoteOn(): boolean {
    const s = this.settings()
    return (
      s.remoteEnabled &&
      Boolean(s.rcloneRemote.trim()) &&
      Boolean(s.remoteFolder.trim())
    )
  }

  songs(input: SongQuery): SongPage {
    const query = songQuerySchema.parse(input)
    const where: string[] = []
    const params: unknown[] = []
    const f = query.filters
    // Matches the count and the Activity drawer: failures plus Outside Edits.
    if (f.state === 'needs_attention')
      where.push(`(t.state = 'needs_attention' OR f.outside_edit IS NOT NULL)`)
    else if (f.state === 'no_longer_wanted')
      where.push(`t.state = 'no_longer_wanted' AND ${this.inLibrary()}`)
    else where.push(this.inLibrary())
    if (f.lyrics) {
      where.push('t.lyrics_status = ?')
      params.push(f.lyrics)
    }
    if (f.language) {
      where.push('t.language = ?')
      params.push(f.language)
    }
    if (f.remote) {
      where.push(
        `(${REMOTE_STATE_SQL}) = ? AND NOT (t.state = 'no_longer_wanted' AND u.track_id IS NULL)`
      )
      params.push(f.remote)
    }
    if (f.favorite) {
      where.push(
        `EXISTS (SELECT 1 FROM track_artists ta JOIN artists a ON a.id = ta.artist_id WHERE ta.track_id = t.id AND a.favorite = 1)`
      )
    }
    if (query.artistId) {
      where.push(
        'EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = t.id AND ta.artist_id = ?)'
      )
      params.push(query.artistId)
    }
    if (query.albumKey) {
      const [album, artist] = decodeAlbumKey(query.albumKey)
      where.push(
        't.album = ? AND t.album_artist = ? AND t.release_id IS NOT NULL'
      )
      params.push(album, artist)
    }
    const direction = query.descending ? 'DESC' : 'ASC'
    const flip = query.descending ? 'ASC' : 'DESC'
    const order: Record<typeof query.sort, string> = {
      liked: `liked_at IS NULL, liked_at ${direction}, liked_pos ${flip}, t.year DESC, t.title`,
      title: `t.title COLLATE NOCASE ${direction}`,
      artist: `t.artist COLLATE NOCASE ${direction}, t.album, t.disc_number, t.track_number`,
      album: `t.album COLLATE NOCASE ${direction}, t.disc_number, t.track_number`,
      year: `t.year IS NULL, t.year ${direction}, t.album, t.track_number`,
      time: `t.duration_seconds ${direction}`,
    }
    if (query.albumKey) order.liked = 't.disc_number, t.track_number, t.title'
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (
      this.sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM tracks t LEFT JOIN files f ON f.track_id = t.id LEFT JOIN uploads u ON u.track_id = t.id ${whereSql}`
        )
        .get(...params) as { n: number }
    ).n
    const rows = this.sqlite
      .prepare(
        `${SONG_SELECT} ${whereSql} ORDER BY ${order[query.sort]} LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit, query.offset) as SongSqlRow[]
    return { total, rows: rows.map((row) => this.toSong(row)) }
  }

  private artistRows(
    where: string,
    params: unknown[],
    orderBy: string
  ): ArtistView[] {
    const rows = this.sqlite
      .prepare(
        `SELECT a.id, a.name, a.image_path, a.favorite, a.suggested, a.channel_id,
           COUNT(DISTINCT t.id) AS song_count
         FROM artists a
         JOIN track_artists ta ON ta.artist_id = a.id
         JOIN tracks t ON t.id = ta.track_id
         LEFT JOIN files f ON f.track_id = t.id
         LEFT JOIN uploads u ON u.track_id = t.id
         WHERE ${this.inLibrary()} ${where}
         GROUP BY a.id
         ORDER BY ${orderBy}`
      )
      .all(...params) as Array<{
      id: string
      name: string
      image_path: string | null
      favorite: number
      suggested: number
      channel_id: string | null
      song_count: number
    }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      imageUrl: this.artistImageUrl(row.image_path),
      songCount: row.song_count,
      favorite: Boolean(row.favorite),
      suggested: Boolean(row.suggested),
      identified: Boolean(row.channel_id),
    }))
  }

  artists(input: ArtistQuery): ArtistView[] {
    const query = artistQuerySchema.parse(input)
    const where = [
      query.favorites ? 'AND a.favorite = 1' : '',
      query.suggested ? 'AND a.suggested = 1' : '',
    ].join(' ')
    const order =
      query.sort === 'name'
        ? 'a.name COLLATE NOCASE'
        : 'song_count DESC, a.name COLLATE NOCASE'
    return this.artistRows(where, [], order)
  }

  private albumRows(
    where: string,
    params: unknown[],
    orderBy: string
  ): AlbumView[] {
    const rows = this.sqlite
      .prepare(
        `SELECT t.album, t.album_artist, MAX(t.year) AS year, COUNT(*) AS song_count,
           SUM(IFNULL(t.duration_seconds, 0)) AS duration,
           (SELECT t2.cover_path FROM tracks t2 WHERE t2.album = t.album AND t2.album_artist = t.album_artist AND t2.cover_path IS NOT NULL LIMIT 1) AS cover_path,
           (SELECT t2.cover_url FROM tracks t2 WHERE t2.album = t.album AND t2.album_artist = t.album_artist AND t2.cover_url IS NOT NULL LIMIT 1) AS cover_url,
           MAX((SELECT MIN(c.first_seen_at) FROM contributions c WHERE c.track_id = t.id AND c.kind = 'liked' AND c.active = 1)) AS liked_at,
           (SELECT ta.artist_id FROM track_artists ta JOIN tracks t3 ON t3.id = ta.track_id WHERE t3.album = t.album AND t3.album_artist = t.album_artist ORDER BY ta.position LIMIT 1) AS artist_id
         FROM tracks t
         LEFT JOIN files f ON f.track_id = t.id
         LEFT JOIN uploads u ON u.track_id = t.id
         WHERE ${this.inLibrary()} AND t.release_id IS NOT NULL ${where}
         GROUP BY t.album, t.album_artist
         ORDER BY ${orderBy}`
      )
      .all(...params) as Array<{
      album: string
      album_artist: string
      year: number | null
      song_count: number
      duration: number
      cover_path: string | null
      cover_url: string | null
      artist_id: string | null
    }>
    return rows.map((row) => ({
      key: albumKey(row.album, row.album_artist),
      title: row.album,
      albumArtist: row.album_artist,
      artistId: row.artist_id,
      year: row.year,
      songCount: row.song_count,
      coverUrl: this.coverUrl(row.cover_path, row.cover_url),
      durationSeconds: row.duration,
    }))
  }

  albums(input: AlbumQuery): AlbumView[] {
    const query = albumQuerySchema.parse(input)
    const order =
      query.sort === 'title'
        ? 't.album COLLATE NOCASE'
        : query.sort === 'year'
          ? 'year IS NULL, year DESC, t.album COLLATE NOCASE'
          : 'liked_at IS NULL, liked_at DESC, t.album COLLATE NOCASE'
    const where = query.favorites
      ? 'AND EXISTS (SELECT 1 FROM track_artists ta JOIN artists a ON a.id = ta.artist_id WHERE ta.track_id = t.id AND a.favorite = 1)'
      : ''
    return this.albumRows(where, [], order)
  }

  artist(id: string): ArtistDetailView | null {
    const [artist] = this.artistRows('AND a.id = ?', [id], 'a.name')
    if (!artist) return null
    const albums = this.albumRows(
      'AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = t.id AND ta.artist_id = ?)',
      [id],
      'year IS NULL, year DESC, t.album COLLATE NOCASE'
    )
    const standalone = (
      this.sqlite
        .prepare(
          `${SONG_SELECT} WHERE ${this.inLibrary()} AND t.release_id IS NULL AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = t.id AND ta.artist_id = ?) ORDER BY liked_at IS NULL, liked_at DESC, t.title`
        )
        .all(id) as SongSqlRow[]
    ).map((row) => this.toSong(row))
    return { artist, albums, standalone, albumCount: albums.length }
  }

  album(key: string): AlbumDetailView | null {
    const [album, albumArtist] = decodeAlbumKey(key)
    const [view] = this.albumRows(
      'AND t.album = ? AND t.album_artist = ?',
      [album, albumArtist],
      't.album'
    )
    if (!view) return null
    return {
      album: view,
      tracks: this.songs({ albumKey: key, limit: 5000, sort: 'liked' }).rows,
    }
  }

  track(id: string): TrackDetailView | null {
    const row = this.sqlite.prepare(`${SONG_SELECT} WHERE t.id = ?`).get(id) as
      | SongSqlRow
      | undefined
    if (!row) return null
    const full = this.sqlite
      .prepare('SELECT * FROM tracks WHERE id = ?')
      .get(id) as Record<string, unknown>
    const file = this.sqlite
      .prepare('SELECT * FROM files WHERE track_id = ?')
      .get(id) as Record<string, unknown> | undefined
    const upload = this.sqlite
      .prepare('SELECT * FROM uploads WHERE track_id = ?')
      .get(id) as Record<string, unknown> | undefined
    const artistRows = this.sqlite
      .prepare(
        'SELECT a.id, a.name FROM track_artists ta JOIN artists a ON a.id = ta.artist_id WHERE ta.track_id = ? ORDER BY ta.position'
      )
      .all(id) as Array<{ id: string; name: string }>
    const contributionRows = this.sqlite
      .prepare(
        `SELECT c.kind, c.first_seen_at, a.name AS artist_name FROM contributions c
         LEFT JOIN artists a ON a.id = c.artist_id WHERE c.track_id = ? AND c.active = 1 ORDER BY c.first_seen_at`
      )
      .all(id) as Array<{
      kind: 'liked' | 'catalog'
      first_seen_at: string
      artist_name: string | null
    }>
    const match = full.match
      ? (JSON.parse(String(full.match)) as {
          catalogVideoId?: string
          sourceVideoId?: string
          release?: { title?: string; year?: number }
          resolutionMethod?: string
        })
      : null
    const song = this.toSong(row)
    let differences: string[] = []
    if (file && upload?.tag_fields && song.remoteState === 'stale') {
      differences = fieldDiff(
        JSON.parse(String(upload.tag_fields)) as TagFields,
        JSON.parse(String(file.tag_fields)) as TagFields
      )
        .filter((field) => field !== 'lms.schemaVersion')
        .map(humanField)
      if (
        differences.length === 0 &&
        upload.local_sha256 !== file.content_sha256
      )
        differences = ['audio']
      if (upload.remote_path !== file.relative_path) differences.push('path')
    }
    const settings = this.settings()
    const relative = file ? String(file.relative_path) : null
    return {
      song,
      artists: artistRows,
      contributions: contributionRows.map((c) => ({
        kind: c.kind,
        label:
          c.kind === 'liked'
            ? 'Liked on YouTube Music'
            : `In ${c.artist_name ?? 'a Favorite Artist'}'s catalog (Favorite Artist)`,
        at: c.kind === 'liked' ? c.first_seen_at : null,
      })),
      match: {
        catalogVideoId: match?.catalogVideoId ?? null,
        sourceVideoId: match?.sourceVideoId ?? null,
        releaseTitle: match?.release?.title ?? null,
        releaseYear: match?.release?.year ?? null,
        resolution: match?.resolutionMethod ?? null,
        genre: (full.genre as string | null) ?? null,
        genreSource: full.genre ? 'MusicBrainz' : null,
      },
      lyrics: {
        status: row.lyrics_status,
        source: (full.lyrics_source as string | null) ?? null,
        language: row.language,
      },
      file: {
        path: relative,
        absolutePath:
          relative && settings.libraryFolder
            ? path.join(settings.libraryFolder, relative)
            : null,
      },
      remote: { state: song.remoteState, differences },
      outsideEdit: file?.outside_edit
        ? (JSON.parse(String(file.outside_edit)) as string[])
        : null,
      enrichmentErrors: JSON.parse(
        String(full.enrichment_errors ?? '{}')
      ) as Record<string, string>,
      lastError: (full.last_error as string | null) ?? null,
    }
  }

  search(text: string): SearchResultsView {
    const term = `%${text.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`
    if (!text.trim()) return { artists: [], albums: [], songs: [] }
    const artists = this.artistRows(
      `AND a.name LIKE ? ESCAPE '\\'`,
      [term],
      'song_count DESC'
    ).slice(0, 6)
    const albums = this.albumRows(
      `AND (t.album LIKE ? ESCAPE '\\' OR t.album_artist LIKE ? ESCAPE '\\')`,
      [term, term],
      'year DESC'
    ).slice(0, 6)
    const songs = (
      this.sqlite
        .prepare(
          `${SONG_SELECT} WHERE ${this.inLibrary()} AND (t.title LIKE ? ESCAPE '\\' OR t.artist LIKE ? ESCAPE '\\') ORDER BY liked_at IS NULL, liked_at DESC LIMIT 8`
        )
        .all(term, term) as SongSqlRow[]
    ).map((row) => this.toSong(row))
    return { artists, albums, songs }
  }

  counts(): LibraryCounts {
    const one = (query: string) =>
      (this.sqlite.prepare(query).get() as { n: number }).n
    const base = `FROM tracks t LEFT JOIN files f ON f.track_id = t.id LEFT JOIN uploads u ON u.track_id = t.id`
    return {
      songs: one(`SELECT COUNT(*) AS n ${base} WHERE ${this.inLibrary()}`),
      artists: one(
        `SELECT COUNT(DISTINCT ta.artist_id) AS n FROM track_artists ta JOIN tracks t ON t.id = ta.track_id LEFT JOIN files f ON f.track_id = t.id LEFT JOIN uploads u ON u.track_id = t.id WHERE ${this.inLibrary()}`
      ),
      albums: one(
        `SELECT COUNT(*) AS n FROM (SELECT 1 ${base} WHERE ${this.inLibrary()} AND t.release_id IS NOT NULL GROUP BY t.album, t.album_artist)`
      ),
      needsAttention: one(
        `SELECT COUNT(*) AS n ${base} WHERE t.state = 'needs_attention' OR f.outside_edit IS NOT NULL`
      ),
      noLongerWanted: one(
        `SELECT COUNT(*) AS n ${base} WHERE t.state = 'no_longer_wanted' AND ${this.inLibrary()}`
      ),
      unmanaged: one('SELECT COUNT(*) AS n FROM unmanaged_files'),
    }
  }

  unmanaged(): Array<{ path: string; size: number }> {
    return this.sqlite
      .prepare(
        'SELECT relative_path AS path, size FROM unmanaged_files ORDER BY relative_path'
      )
      .all() as Array<{ path: string; size: number }>
  }
}

function humanField(field: string): string {
  const names: Record<string, string> = {
    albumArtist: 'album artist',
    trackNumber: 'track number',
    trackTotal: 'track count',
    discNumber: 'disc number',
    discTotal: 'disc count',
    mbRecordingId: 'MusicBrainz ID',
    coverSha256: 'artwork',
    isrc: 'ISRC',
  }
  if (field.startsWith('lms.')) return field.slice(4)
  return names[field] ?? field
}
