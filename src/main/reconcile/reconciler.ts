import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import { stageForStep } from '../domain'
import { adoptFiles, detectOutsideEdits, recoverOperations } from '../inventory/inventory'
import type { Db } from '../library/db'
import { artists, contributions, files, sourceSnapshots, tracks, uploads } from '../library/schema'
import { errorKindOf } from '../net/http'
import type {
  ActivityTrackView,
  ActivityView,
  AttentionItemView,
  RefreshScope,
} from '../../shared/ipc'
import {
  checkArtistCatalog,
  checkLikedSongs,
  deactivateArtistCatalog,
  likedSnapshotSource,
  linkContributions,
  updateWantedStates,
} from './sources'
import {
  coversDir,
  createRemoteIndexCache,
  deleteTracks,
  nextStep,
  processTombstones,
  runAcquire,
  runMatch,
  runMove,
  runRetag,
  runUpload,
  type StepDeps,
  type StepKind,
} from './steps'

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000]
const CHECK_INTERVAL_MS = 30 * 60_000
const CATALOG_INTERVAL_MS = 24 * 60 * 60_000
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000
const STAGE_WEIGHTS: Record<'matching' | 'downloading' | 'uploading', [number, number]> = {
  matching: [0, 0.15],
  downloading: [0.15, 0.7],
  uploading: [0.85, 0.15],
}

export interface SessionInfo {
  /** Selected YouTube Music Account ID, or null when signed out. */
  accountId(): string | null
  /** Bumped on every account switch or sign-out. */
  generation(): number
}

export interface ReconcilerDeps extends StepDeps {
  session: SessionInfo
  coverUrl: (coverPath: string | null, fallback: string | null) => string | null
  onActivity: (view: ActivityView) => void
  onLibraryChanged: (trackIds: string[] | null) => void
}

interface CurrentWork {
  trackId: string
  step: StepKind
  fraction: number
}

export class Reconciler {
  private running = false
  private wake: (() => void) | null = null
  private controller: AbortController | null = null
  private current: CurrentWork | null = null
  private checking = false
  private planDirty = true
  private lastEmit = 0
  private emitTimer: NodeJS.Timeout | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private sourceErrors = new Map<string, string>()
  private readonly remoteIndex
  private loopPromise: Promise<void> | null = null

  constructor(private readonly deps: ReconcilerDeps) {
    this.remoteIndex = createRemoteIndexCache(deps.rclone)
  }

  private get db(): Db {
    return this.deps.db
  }

  /** Recovery, adoption, then the worker loop and the periodic check. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.prepareLibrary()
    this.loopPromise = this.loop()
    this.checkTimer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    void this.check()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.controller?.abort(new Error('stopping'))
    this.wake?.()
    await this.loopPromise?.catch(() => undefined)
  }

  /** Re-run inventory work after the library folder changes. */
  async libraryFolderChanged(): Promise<void> {
    await this.prepareLibrary()
    this.markDirty()
  }

  private async prepareLibrary(): Promise<void> {
    const settings = this.deps.settings()
    if (!settings.libraryFolder) return
    const inventory = { db: this.db, coversDir: coversDir(this.deps), now: this.deps.now }
    try {
      await recoverOperations(inventory, settings.libraryFolder)
      await adoptFiles(inventory, settings.libraryFolder)
      await detectOutsideEdits(inventory, settings.libraryFolder)
    } catch (error) {
      console.error('[reconciler] library preparation failed', error)
    }
    this.deps.onLibraryChanged(null)
    this.markDirty()
  }

  markDirty(): void {
    this.planDirty = true
    this.remoteIndex.invalidate()
    this.wake?.()
    this.emitSoon()
  }

  /** Checks liked songs (and due Favorite Artist catalogs), then plans work. */
  async check(options: { catalogs?: 'due' | 'all' | string[] } = {}): Promise<void> {
    if (this.checking) return
    this.checking = true
    this.emitSoon()
    const accountId = this.deps.session.accountId()
    const generation = this.deps.session.generation()
    try {
      if (accountId) {
        try {
          await checkLikedSongs({
            db: this.db,
            catalog: this.deps.catalog,
            accountId,
            stillCurrent: () => this.deps.session.generation() === generation,
            now: this.deps.now,
          })
          this.sourceErrors.delete(likedSnapshotSource(accountId))
        } catch (error) {
          this.sourceErrors.set(likedSnapshotSource(accountId), error instanceof Error ? error.message : String(error))
        }
      }
      const favorites = this.db.select().from(artists).where(eq(artists.favorite, true)).all()
      const cutoff = this.deps.now().getTime() - CATALOG_INTERVAL_MS
      const due = favorites.filter((artist) => {
        if (!artist.channelId) return false
        if (options.catalogs === 'all') return true
        if (Array.isArray(options.catalogs)) return options.catalogs.includes(artist.id)
        return !artist.catalogCheckedAt || Date.parse(artist.catalogCheckedAt) < cutoff
      })
      for (const artist of due) {
        try {
          await checkArtistCatalog({ db: this.db, catalog: this.deps.catalog, artistId: artist.id, channelId: artist.channelId!, now: this.deps.now })
          this.sourceErrors.delete(`catalog:${artist.id}`)
        } catch (error) {
          this.sourceErrors.set(`catalog:${artist.id}`, error instanceof Error ? error.message : String(error))
        }
      }
      linkContributions(this.db, this.deps.now)
      updateWantedStates(this.db, {
        accountId,
        favoriteArtistIds: favorites.filter((a) => a.channelId).map((a) => a.id),
      })
    } finally {
      this.checking = false
      this.deps.onLibraryChanged(null)
      this.markDirty()
    }
  }

  setFavorite(artistId: string, favorite: boolean): void {
    this.db
      .update(artists)
      .set({ favorite, suggested: false, favoritedAt: favorite ? this.deps.now().toISOString() : null })
      .where(eq(artists.id, artistId))
      .run()
    if (favorite) void this.check({ catalogs: [artistId] })
    else {
      deactivateArtistCatalog(this.db, artistId)
      void this.check({ catalogs: [] })
    }
  }

  refresh(scope: RefreshScope): void {
    const now = this.deps.now().toISOString()
    let ids: string[] = []
    if (scope.kind === 'track') ids = [scope.id]
    else if (scope.kind === 'album') {
      const [album, albumArtist] = decodeAlbumKey(scope.key)
      ids = this.db.select({ id: tracks.id }).from(tracks).where(and(eq(tracks.album, album), eq(tracks.albumArtist, albumArtist))).all().map((r) => r.id)
    } else if (scope.kind === 'artist') {
      ids = this.db.all<{ id: string }>(sql`SELECT track_id AS id FROM track_artists WHERE artist_id = ${scope.id}`).map((r) => r.id)
      void this.check({ catalogs: [scope.id] })
    } else {
      ids = this.db.select({ id: tracks.id }).from(tracks).all().map((r) => r.id)
    }
    if (ids.length === 0) return
    for (let i = 0; i < ids.length; i += 500) {
      this.db
        .update(tracks)
        .set({ refreshRequested: true, state: 'pending', attempts: 0, nextAttemptAt: null, lastError: null, updatedAt: now })
        .where(and(inArray(tracks.id, ids.slice(i, i + 500)), sql`state != 'no_longer_wanted'`))
        .run()
    }
    this.markDirty()
  }

  retry(trackId: string): void {
    this.db
      .update(tracks)
      .set({ state: 'pending', attempts: 0, nextAttemptAt: null, lastError: null, lastErrorKind: null })
      .where(eq(tracks.id, trackId))
      .run()
    this.markDirty()
  }

  /** Outside Edit: restore the app's version of the file. */
  rewrite(trackId: string): void {
    const file = this.db.select().from(files).where(eq(files.trackId, trackId)).get()
    if (file?.outsideEdit) {
      const parts = JSON.parse(file.outsideEdit) as string[]
      if (parts.includes('deleted') || parts.includes('audio')) {
        this.db.delete(files).where(eq(files.trackId, trackId)).run()
      } else {
        // Force a retag by invalidating what we believe was written.
        this.db.update(files).set({ outsideEdit: null, tagFields: '{"lms":{}}', lrcSha256: 'rewrite' }).where(eq(files.trackId, trackId)).run()
      }
    }
    this.retry(trackId)
  }

  /** Outside Edit: stop managing the file; it becomes an Unmanaged File. */
  stopManaging(trackId: string): void {
    this.db.transaction((tx) => {
      const db = tx as unknown as Db
      db.delete(files).where(eq(files.trackId, trackId)).run()
      db.delete(uploads).where(eq(uploads.trackId, trackId)).run()
      db.update(contributions).set({ active: false }).where(eq(contributions.trackId, trackId)).run()
      db.update(tracks).set({ state: 'no_longer_wanted' }).where(eq(tracks.id, trackId)).run()
    })
    this.markDirty()
  }

  delete(trackIds: string[], where: 'local' | 'remote' | 'both'): void {
    deleteTracks(this.deps, trackIds, where)
    this.deps.onLibraryChanged(null)
    this.markDirty()
  }

  // ------------------------------------------------------------ worker

  /** Sets state from facts for every track that is not paused. */
  private plan(): void {
    this.planDirty = false
    const settings = this.deps.settings()
    const rows = this.db
      .select()
      .from(tracks)
      .where(inArray(tracks.state, ['pending', 'done', 'working']))
      .all()
    const fileRows = new Map(this.db.select().from(files).all().map((row) => [row.trackId, row]))
    const uploadRows = new Map(this.db.select().from(uploads).all().map((row) => [row.trackId, row]))
    const toPending: string[] = []
    const toDone: string[] = []
    for (const track of rows) {
      const step = nextStep(this.db, track, fileRows.get(track.id), uploadRows.get(track.id), settings)
      if (step && track.state !== 'pending') toPending.push(track.id)
      if (!step && track.state !== 'done') toDone.push(track.id)
    }
    const chunked = (ids: string[], state: 'pending' | 'done') => {
      for (let i = 0; i < ids.length; i += 500) {
        this.db.update(tracks).set({ state }).where(inArray(tracks.id, ids.slice(i, i + 500))).run()
      }
    }
    chunked(toPending, 'pending')
    chunked(toDone, 'done')
  }

  private nextTrack() {
    const now = this.deps.now().toISOString()
    return this.db
      .select()
      .from(tracks)
      .where(and(eq(tracks.state, 'pending'), or(sql`${tracks.nextAttemptAt} IS NULL`, lte(tracks.nextAttemptAt, now))))
      .orderBy(...queueOrder())
      .limit(1)
      .get()
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.planDirty) this.plan()
      const track = this.nextTrack()
      if (!track) {
        this.current = null
        this.emitSoon()
        try {
          this.controller = new AbortController()
          await processTombstones(this.deps, this.controller.signal)
        } catch (error) {
          console.warn('[reconciler] tombstones', error)
        }
        await this.idle(this.nextWakeDelay())
        continue
      }
      await this.work(track.id)
    }
  }

  private nextWakeDelay(): number {
    const next = this.db
      .select({ at: tracks.nextAttemptAt })
      .from(tracks)
      .where(and(eq(tracks.state, 'pending'), isNotNull(tracks.nextAttemptAt)))
      .orderBy(asc(tracks.nextAttemptAt))
      .get()
    if (!next?.at) return 60_000
    return Math.max(1_000, Math.min(60_000, Date.parse(next.at) - this.deps.now().getTime()))
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        resolve()
      }
      this.wake = () => {
        this.wake = null
        done()
      }
    })
  }

  private async work(initialTrackId: string): Promise<void> {
    let trackId = initialTrackId
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.db.update(tracks).set({ state: 'working' }).where(eq(tracks.id, trackId)).run()
    let acquired = false
    for (let guard = 0; guard < 8 && this.running; guard += 1) {
      const track = this.db.select().from(tracks).where(eq(tracks.id, trackId)).get()
      if (!track) return
      const file = this.db.select().from(files).where(eq(files.trackId, trackId)).get()
      const upload = this.db.select().from(uploads).where(eq(uploads.trackId, trackId)).get()
      const step = nextStep(this.db, track, file, upload, this.deps.settings())
      if (!step) {
        this.db
          .update(tracks)
          .set({
            state: 'done',
            currentStep: null,
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
            ...(acquired ? { completedAt: this.deps.now().toISOString() } : {}),
          })
          .where(eq(tracks.id, trackId))
          .run()
        this.current = null
        this.deps.onLibraryChanged([trackId])
        this.emitSoon()
        return
      }
      this.current = { trackId, step, fraction: 0 }
      this.db.update(tracks).set({ currentStep: step }).where(eq(tracks.id, trackId)).run()
      this.emitSoon()
      const run = {
        signal,
        progress: (fraction: number) => {
          if (this.current) this.current.fraction = fraction
          this.emitSoon()
        },
      }
      try {
        if (step === 'match') {
          const outcome = await runMatch(this.deps, track, run)
          if (outcome.trackId !== trackId) {
            trackId = outcome.trackId
            this.db.update(tracks).set({ state: 'working' }).where(eq(tracks.id, trackId)).run()
          }
        } else if (step === 'acquire') {
          await runAcquire(this.deps, track, run)
          acquired = true
        } else if (step === 'retag') await runRetag(this.deps, track, run)
        else if (step === 'move') await runMove(this.deps, track, run)
        else if (step === 'upload') await runUpload(this.deps, track, run, this.remoteIndex)
      } catch (error) {
        if (!this.running || signal.aborted) {
          this.db.update(tracks).set({ state: 'pending', currentStep: null }).where(eq(tracks.id, trackId)).run()
          return
        }
        this.fail(trackId, step, error)
        return
      }
    }
    this.db.update(tracks).set({ state: 'pending', currentStep: null }).where(eq(tracks.id, trackId)).run()
  }

  private fail(trackId: string, step: StepKind, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const kind = errorKindOf(error)
    const track = this.db.select().from(tracks).where(eq(tracks.id, trackId)).get()
    const attempts = (track?.attempts ?? 0) + 1
    const giveUp = kind === 'permanent' || attempts > BACKOFF_MS.length
    console.warn(`[reconciler] ${step} failed for ${track?.title ?? trackId}: ${message}`)
    this.db
      .update(tracks)
      .set({
        state: giveUp ? 'needs_attention' : 'pending',
        currentStep: null,
        attempts,
        nextAttemptAt: giveUp ? null : new Date(this.deps.now().getTime() + BACKOFF_MS[attempts - 1]).toISOString(),
        lastError: message,
        lastErrorKind: kind,
        lastErrorStep: step,
      })
      .where(eq(tracks.id, trackId))
      .run()
    this.current = null
    this.deps.onLibraryChanged([trackId])
    this.emitSoon()
  }

  // ------------------------------------------------------------ activity

  private emitSoon(): void {
    if (this.emitTimer) return
    const wait = Math.max(0, 100 - (Date.now() - this.lastEmit))
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.lastEmit = Date.now()
      this.deps.onActivity(this.activity())
    }, wait)
  }

  activity(): ActivityView {
    const cover = this.deps.coverUrl
    const toView = (row: typeof tracks.$inferSelect, extra: Partial<ActivityTrackView> = {}): ActivityTrackView => ({
      id: row.id,
      title: row.title,
      artist: row.artist,
      coverUrl: cover(row.coverPath, row.coverUrl),
      stage: null,
      progress: 0,
      completedAt: row.completedAt,
      ...extra,
    })
    let current: ActivityTrackView | null = null
    if (this.current) {
      const row = this.db.select().from(tracks).where(eq(tracks.id, this.current.trackId)).get()
      if (row) {
        const stage = stageForStep(this.current.step)
        const [base, weight] = STAGE_WEIGHTS[stage]
        current = toView(row, { stage, progress: Math.min(1, base + weight * this.current.fraction) })
      }
    }
    const now = this.deps.now()
    const pendingWhere = and(eq(tracks.state, 'pending'), or(sql`${tracks.nextAttemptAt} IS NULL`, lte(tracks.nextAttemptAt, now.toISOString())))
    const upNextRows = this.db.select().from(tracks).where(pendingWhere).orderBy(...queueOrder()).limit(40).all()
    const upNextCount = this.db.select({ n: sql<number>`count(*)` }).from(tracks).where(pendingWhere).get()?.n ?? 0
    const recentRows = this.db
      .select()
      .from(tracks)
      .where(and(isNotNull(tracks.completedAt), gte(tracks.completedAt, new Date(now.getTime() - RECENT_WINDOW_MS).toISOString())))
      .orderBy(asc(tracks.completedAt))
      .limit(400)
      .all()
    const attention: AttentionItemView[] = this.db
      .select()
      .from(tracks)
      .where(eq(tracks.state, 'needs_attention'))
      .orderBy(desc(tracks.updatedAt))
      .limit(200)
      .all()
      .map((row) => ({
        id: row.id,
        kind: 'track' as const,
        title: row.title,
        subtitle: row.artist,
        reason: humanizeError(row.lastErrorStep, row.lastError),
        coverUrl: cover(row.coverPath, row.coverUrl),
      }))
    const edited = this.db
      .select({ track: tracks, file: files })
      .from(files)
      .innerJoin(tracks, eq(tracks.id, files.trackId))
      .where(isNotNull(files.outsideEdit))
      .limit(100)
      .all()
      .map(({ track, file }) => ({
        id: track.id,
        kind: 'outside_edit' as const,
        title: track.title,
        subtitle: track.artist,
        reason: `Changed outside the app (${(JSON.parse(file.outsideEdit!) as string[]).join(', ')}). Rewrite it or stop managing it.`,
        coverUrl: cover(track.coverPath, track.coverUrl),
      }))
    const sources = [...this.sourceErrors.entries()].map(([source, message]) => ({
      id: source,
      kind: 'source' as const,
      title: source.startsWith('liked:') ? 'Liked songs check' : 'Favorite Artist catalog',
      subtitle: null,
      reason: message,
      coverUrl: null,
    }))
    const accountId = this.deps.session.accountId()
    const lastChecked = accountId
      ? this.db.select().from(sourceSnapshots).where(eq(sourceSnapshots.source, likedSnapshotSource(accountId))).get()?.lastSuccessAt ?? null
      : null
    return {
      working: Boolean(current) || upNextCount > 0,
      checking: this.checking,
      lastCheckedAt: lastChecked,
      current,
      upNext: upNextRows.filter((row) => row.id !== current?.id).map((row) => toView(row)),
      upNextCount: Math.max(0, upNextCount - (current ? 0 : 0)),
      recent: recentRows.filter((row) => row.id !== current?.id).map((row) => toView(row)),
      needsAttention: [...sources, ...edited, ...attention],
    }
  }
}

/** Newest Liked Date first; catalog-only tracks after, newest release first. */
function queueOrder() {
  return [
    desc(sql`(SELECT MAX(c.first_seen_at) FROM contributions c WHERE c.track_id = tracks.id AND c.kind = 'liked' AND c.active = 1)`),
    asc(sql`(SELECT MIN(c.liked_position) FROM contributions c WHERE c.track_id = tracks.id AND c.kind = 'liked' AND c.active = 1)`),
    desc(tracks.year),
    asc(tracks.createdAt),
  ]
}

export function albumKey(album: string, albumArtist: string): string {
  return `${encodeURIComponent(album)}|${encodeURIComponent(albumArtist)}`
}

export function decodeAlbumKey(key: string): [string, string] {
  const [album, artist] = key.split('|')
  return [decodeURIComponent(album ?? ''), decodeURIComponent(artist ?? '')]
}

export function humanizeError(step: string | null, message: string | null): string {
  const text = message ?? 'Unknown error'
  if (/Video unavailable|Private video|has been removed/i.test(text)) return 'Video unavailable on YouTube. Nothing to download.'
  if (/Sign in to confirm your age/i.test(text)) return 'YouTube requires age verification for this video.'
  if (step === 'upload') return `Upload to remote failed: ${text}`
  if (step === 'acquire') return `Download failed: ${text}`
  if (step === 'match') return `Could not match on YouTube Music: ${text}`
  return text
}
