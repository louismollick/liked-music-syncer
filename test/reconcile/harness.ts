import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import ffmpegPath from 'ffmpeg-static'
import type { AudioDownloader } from '../../src/main/acquire/audio'
import {
  type CatalogRelease,
  type CatalogReleaseRef,
  CatalogShapeError,
  type LikedSong,
  type YouTubeMusicCatalog,
} from '../../src/main/catalog/types'
import { openDatabase } from '../../src/main/library/db'
import {
  contributions,
  files,
  tracks,
  uploads,
} from '../../src/main/library/schema'
import type { LyricsFinder } from '../../src/main/lyrics/types'
import {
  type Match,
  type Matcher,
  type MatchInput,
  standaloneIdentityKey,
} from '../../src/main/match/types'
import type { HttpClient } from '../../src/main/net/http'
import {
  Reconciler,
  type ReconcilerDeps,
} from '../../src/main/reconcile/reconciler'
import { createRclone } from '../../src/main/remote/rclone'
import type { Settings } from '../../src/shared/ipc'
import { makeM4a, TINY_JPEG } from '../helpers/audio'

export const credit = { name: 'Test Artist', channelId: 'artist-1' }
export function song(
  videoId: string,
  title = videoId,
  position = 0
): LikedSong {
  return {
    videoId,
    title,
    artists: [credit],
    album: null,
    durationSeconds: 1,
    videoType: 'ATV',
    isExplicit: false,
    thumbnailUrl: null,
    trackNumber: null,
    discNumber: null,
    isAvailable: true,
    position,
  }
}
export function release(
  browseId: string,
  ...items: LikedSong[]
): CatalogRelease {
  return {
    browseId,
    audioPlaylistId: null,
    title: 'Test Album',
    kindLabel: 'Album',
    artists: [credit],
    year: 2024,
    thumbnailUrl: null,
    trackCount: items.length,
    tracks: items.map((item, i) => ({
      ...item,
      album: { browseId, name: 'Test Album' },
      trackNumber: i + 1,
    })),
  }
}

export class FakeCatalog implements YouTubeMusicCatalog {
  likes: LikedSong[] = []
  declaredCount: number | null = null
  likedError: Error | null = null
  releases = new Map<string, CatalogRelease>()
  refs: CatalogReleaseRef[] = []
  async likedSongs() {
    if (this.likedError) throw this.likedError
    return {
      tracks: this.likes,
      declaredCount: this.declaredCount,
      pageCount: 1,
    }
  }
  async release(id: string) {
    const item = this.releases.get(id)
    if (!item) throw new CatalogShapeError(`Missing release ${id}`)
    return item
  }
  async artist(): Promise<never> {
    throw new Error('not used')
  }
  async artistReleases() {
    return this.refs
  }
  async searchSongs() {
    return []
  }
  async watch() {
    return { lyricsBrowseId: null, track: null }
  }
  async lyrics() {
    return null
  }
  async account() {
    return null
  }
}

export class FakeMatcher implements Matcher {
  matches = new Map<string, Match>()
  error: Error | null = null
  calls = 0
  async match(input: MatchInput): Promise<Match> {
    this.calls++
    if (this.error) throw this.error
    const item = input.kind === 'liked' ? input.song : input.track
    const fromMap = this.matches.get(item.videoId)
    if (fromMap) return fromMap
    return {
      version: 1,
      sourceVideoId: item.videoId,
      catalogVideoId: item.videoId,
      identityKey: standaloneIdentityKey(item.videoId),
      release: null,
      title: item.title,
      artists: item.artists,
      album: item.title,
      albumArtist: item.artists[0]?.name ?? '',
      durationSeconds: item.durationSeconds,
      coverUrl: item.thumbnailUrl,
      lyricsBrowseId: null,
      resolutionMethod: 'standalone',
    }
  }
  async enrich() {
    return { mbRecordingId: null, genre: null, isrc: null }
  }
}

export function releaseMatch(
  source: LikedSong,
  album: CatalogRelease,
  catalogVideoId = source.videoId
): Match {
  const item =
    album.tracks.find((track) => track.videoId === catalogVideoId) ??
    album.tracks[0]
  return {
    version: 1,
    sourceVideoId: source.videoId,
    catalogVideoId,
    identityKey: `${album.browseId}:${catalogVideoId}`,
    release: {
      browseId: album.browseId,
      title: album.title,
      kind: 'album',
      artists: album.artists,
      year: album.year,
      date: String(album.year),
      trackNumber: item.trackNumber,
      trackTotal: album.tracks.length,
      discNumber: null,
      discTotal: null,
      thumbnailUrl: null,
    },
    title: item.title,
    artists: item.artists,
    album: album.title,
    albumArtist: album.artists[0]?.name ?? '',
    durationSeconds: item.durationSeconds,
    coverUrl: item.thumbnailUrl,
    lyricsBrowseId: null,
    resolutionMethod: 'liked_album_exact',
  }
}

export class Harness {
  root = mkdtempSync(path.join(tmpdir(), 'lms-reconcile-'))
  userData = path.join(this.root, 'userData')
  library = path.join(this.root, 'library')
  remote = path.join(this.root, 'remote')
  dbPath = path.join(this.userData, 'library.sqlite')
  db: ReturnType<typeof openDatabase>
  catalog = new FakeCatalog()
  matcher = new FakeMatcher()
  downloads: string[] = []
  account: string | null = 'account-a'
  generation = 0
  time = new Date('2026-09-26T12:00:00.000Z')
  lyricsText: string | null = null
  settings: Settings = {
    libraryFolder: this.library,
    remoteEnabled: true,
    rcloneRemote: ':local',
    remoteFolder: this.remote,
    lyricsEnabled: true,
    lyricsServerUrl: '',
    selectedAccountId: 'account-a',
  }
  reconciler: Reconciler
  deps: ReconcilerDeps
  constructor() {
    mkdirSync(this.userData, { recursive: true })
    mkdirSync(this.library, { recursive: true })
    mkdirSync(this.remote, { recursive: true })
    this.db = openDatabase(this.dbPath)
    const downloader: AudioDownloader = {
      download: async (id, dir, progress) => {
        this.downloads.push(id)
        const file = path.join(dir, 'audio.m4a')
        makeM4a(file)
        progress({ fraction: 1 })
        return file
      },
    }
    const lyrics: LyricsFinder = {
      find: async () => ({
        lyrics: this.lyricsText
          ? {
              text: this.lyricsText,
              synced: true,
              source: 'youtube-music',
              language: 'en',
            }
          : null,
        spotifyTrackId: null,
        errors: {},
      }),
    }
    const http: HttpClient = {
      bytes: async () => TINY_JPEG,
      request: async () => new Response(TINY_JPEG),
      json: async <T>() => ({}) as T,
      text: async () => '',
    }
    this.deps = {
      db: this.db,
      catalog: this.catalog,
      matcher: this.matcher,
      downloader,
      lyrics,
      http,
      rclone: createRclone(process.env.RCLONE_BINARY ?? 'rclone'),
      tools: {
        userData: this.userData,
        resourcesBin: this.userData,
        nodeRuntime: process.execPath,
        ffmpeg: ffmpegPath as string,
        rclone: process.env.RCLONE_BINARY ?? 'rclone',
      },
      settings: () => this.settings,
      now: () => this.time,
      session: {
        accountId: () => this.account,
        generation: () => this.generation,
      },
      coverUrl: (_path, fallback) => fallback,
      onActivity: () => {},
      onLibraryChanged: () => {},
    }
    this.reconciler = new Reconciler(this.deps)
  }
  setAccount(account: string) {
    this.account = account
    this.generation++
    this.settings.selectedAccountId = account
  }
  async start() {
    await this.reconciler.start()
    await this.idle()
  }
  async check() {
    await this.reconciler.check()
    await this.idle()
  }
  /** Wait for the single worker and source check to settle; delayed retries are idle. */
  async idle(timeoutMs = 20000) {
    const until = Date.now() + timeoutMs
    let stable = 0
    while (Date.now() < until) {
      const activity = this.reconciler.activity()
      const busy =
        activity.checking || activity.current || activity.upNextCount > 0
      if (!busy && ++stable >= 3) return
      if (busy) stable = 0
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(
      `Worker did not become idle: ${JSON.stringify(this.reconciler.activity())}`
    )
  }
  rows() {
    return this.db.select().from(tracks).all()
  }
  row(key: string) {
    return this.db
      .select()
      .from(tracks)
      .where(eq(tracks.identityKey, key))
      .get()
  }
  file(trackId: string) {
    return this.db.select().from(files).where(eq(files.trackId, trackId)).get()
  }
  upload(trackId: string) {
    return this.db
      .select()
      .from(uploads)
      .where(eq(uploads.trackId, trackId))
      .get()
  }
  contributions() {
    return this.db.select().from(contributions).all()
  }
  async stop() {
    await this.reconciler.stop()
  }
  async close() {
    await this.stop()
    this.db.$client.close()
    rmSync(this.root, { recursive: true, force: true })
  }
  reopen() {
    this.db.$client.close()
    this.db = openDatabase(this.dbPath)
    this.deps.db = this.db
    this.reconciler = new Reconciler(this.deps)
  }
}
