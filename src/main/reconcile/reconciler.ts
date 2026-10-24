import { existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from 'drizzle-orm'
import type {
  ActivityLive,
  ActivityStage,
  ActivityTrackView,
  ActivityView,
  AttentionItemView,
  RefreshScope,
} from '../../shared/ipc'
import { stageForStep } from '../domain'
import { sha256File } from '../inventory/files'
import {
  adoptFiles,
  detectOutsideEdits,
  readableDirectory,
  recoverOperations,
} from '../inventory/inventory'
import { sidecarPath } from '../inventory/layout'
import { canonicalArtist } from '../library/artists'
import type { Db } from '../library/db'
import {
  artists,
  files,
  sourceSnapshots,
  tracks,
  unmanagedFiles,
  uploads,
} from '../library/schema'
import { isConnectivityError } from '../net/connectivity'
import { errorKindOf } from '../net/http'
import type { SpotifyLibrary } from '../spotify/library'
import { readTags, sha256 } from '../tags/schema'
import {
  checkArtistCatalog,
  checkLikedSongs,
  checkSpotifyLikedSongs,
  claimAdoptedFiles,
  deactivateArtistCatalog,
  likedSnapshotSource,
  linkContributions,
  spotifyLikedSnapshotSource,
  updateWantedStates,
} from './sources'
import {
  auditRemote,
  cancelMergeCleanup,
  coversDir,
  deleteTracks,
  invalidateReleaseCache,
  nextStep,
  OutsideEditError,
  processTombstones,
  REWRITE_AUDIO,
  RetryLaterError,
  runAcquire,
  runGenre,
  runLyrics,
  runMatch,
  runMove,
  runRetag,
  runUpload,
  type StepDeps,
  type StepKind,
  type StepRun,
} from './steps'

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000]
const CHECK_INTERVAL_MS = 30 * 60_000
const CATALOG_INTERVAL_MS = 24 * 60 * 60_000
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000
const MAX_WAIT_MS = 6 * 60 * 60_000
/** Source-error key for a failed Remote Library audit. */
const REMOTE_AUDIT = 'remote-audit'
/** Steps that need the network; only they show a lane is back online. */
const NETWORK_STEPS: ReadonlySet<StepKind> = new Set([
  'match',
  'lyrics',
  'acquire',
  'upload',
])
const STAGE_WEIGHTS: Record<ActivityStage, [number, number]> = {
  matching: [0, 0.15],
  lyrics: [0.15, 0.7],
  genres: [0.15, 0.7],
  downloading: [0.15, 0.7],
  uploading: [0.85, 0.15],
}

export interface SessionInfo {
  /** Selected YouTube Music Account ID, or null when signed out. */
  accountId(): string | null
  message?(): string | null
  refresh?(): Promise<unknown>
  /** Bumped on every account switch or sign-out. */
  generation(): number
  /** Called with the account's liked-song count after each successful check. */
  likedCountChanged?(accountId: string, count: number): void
}

/** Timing the app keeps fixed; tests shorten it. */
export interface Tuning {
  /** Uploads that may run at once. */
  uploadConcurrency: number
  /** Waits before probing a lane that lost its connection; the last repeats. */
  probeBackoffMs: readonly number[]
  /** How long stop() waits for running work before giving up on it. */
  stopWaitMs: number
}

const DEFAULT_TUNING: Tuning = {
  uploadConcurrency: 3,
  probeBackoffMs: [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000],
  // Aborting a child process is SIGTERM, then SIGKILL after 5s.
  stopWaitMs: 8_000,
}

export interface ReconcilerDeps extends StepDeps {
  session: SessionInfo
  spotify?: { session: SessionInfo; library: SpotifyLibrary }
  coverUrl: (coverPath: string | null, fallback: string | null) => string | null
  onActivity: (view: ActivityView) => void
  /** Frequent progress ticks; when absent, ticks go through onActivity. */
  onProgress?: (live: ActivityLive) => void
  onLibraryChanged: (trackIds: string[] | null) => void
  tuning?: Partial<Tuning>
}

/**
 * Track work runs in two lanes. The acquire lane (match, lyrics, download,
 * retag, move) takes one track at a time; the upload lane runs several uploads
 * at once. A track is in at most one lane and one step at a time.
 */
type Lane = 'acquire' | 'upload'

const laneOf = (step: StepKind): Lane =>
  step === 'upload' ? 'upload' : 'acquire'

/** A track being worked on right now. */
interface Flight {
  trackId: string
  lane: Lane
  step: StepKind | null
  fraction: number
  /** Shown in Activity; loaded when the step starts. */
  row: ActivityRow | null
  controller: AbortController
}

/** A lane that lost its connection waits until `until`, then probes again. */
interface Pause {
  until: number
  failures: number
}

/** The columns Activity shows for a track. */
const ACTIVITY_COLUMNS = {
  id: tracks.id,
  title: tracks.title,
  artist: tracks.artist,
  coverPath: tracks.coverPath,
  coverUrl: tracks.coverUrl,
  completedAt: tracks.completedAt,
  state: tracks.state,
}
type ActivityRow = {
  [K in keyof typeof ACTIVITY_COLUMNS]: (typeof tracks.$inferSelect)[K]
}

/** The parts of Activity that change only when track states change. */
type ActivityLists = Omit<
  ActivityView,
  | 'current'
  | 'uploading'
  | 'working'
  | 'checking'
  | 'remoteUnreachable'
  | 'offline'
>

export class Reconciler {
  private running = false
  /** Wakes every sleeping lane loop. */
  private readonly wakers = new Set<() => void>()
  /** Tracks being worked on, by track ID: the one-step-per-track guard. */
  private readonly flights = new Map<string, Flight>()
  /** Aborts work that belongs to no track (tombstones, audits). */
  private readonly background = new Set<AbortController>()
  /** Running track work, so a library folder change can wait for it. */
  private readonly works = new Set<Promise<void>>()
  private readonly pauses: Record<Lane, Pause | null> = {
    acquire: null,
    upload: null,
  }
  /** Each track's next step as of the last plan; picks the lane for pending tracks. */
  private planned = new Map<string, StepKind>()
  /** Remote object sizes from the last audit of the current remote. */
  private remoteListing: Map<string, number> | null = null
  /** Bumped when the remote target changes, so an old audit's result is dropped. */
  private remoteGeneration = 0
  private probing: Promise<void> | null = null
  private checking = false
  private queuedCheck: CatalogRequest | null = null
  private planDirty = true
  private lastEmit = 0
  private emitTimer: NodeJS.Timeout | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private sourceErrors = new Map<string, string>()
  /** Failed enrichment lookups (`<step>:<trackId>`) that wait for the next check pass. */
  private readonly deferred = new Set<string>()
  private loopPromise: Promise<unknown> | null = null
  /** Cached Activity lists, rebuilt only when track states change. */
  private lists: ActivityLists | null = null
  /** Observers owe a full update. Cleared by the emit, not by reading a snapshot. */
  private listsDirty = true
  private folderChangePromise: Promise<void> | null = null
  /** Checks and audits still touching the database; stop() waits for them. */
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly tuning: Tuning

  constructor(private readonly deps: ReconcilerDeps) {
    this.tuning = { ...DEFAULT_TUNING, ...deps.tuning }
  }

  private get db(): Db {
    return this.deps.db
  }

  /** Recovery, adoption, then the worker loop and the periodic check. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.prepareLibrary()
    // The remote may be slow or unreachable; don't hold up the workers for it.
    void this.auditRemote()
    this.loopPromise = Promise.all([
      this.laneLoop('acquire'),
      ...Array.from({ length: this.tuning.uploadConcurrency }, () =>
        this.laneLoop('upload')
      ),
    ])
    this.checkTimer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    void this.check()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.checkTimer) clearInterval(this.checkTimer)
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    this.abortAll(new Error('stopping'))
    this.wakeAll()
    // A hung process or request must not hold up quitting.
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled([this.loopPromise, ...this.inFlight]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, this.tuning.stopWaitMs)
      }),
    ])
    clearTimeout(timer)
  }

  private abortAll(reason: Error): void {
    for (const flight of this.flights.values()) flight.controller.abort(reason)
    for (const controller of this.background) controller.abort(reason)
  }

  private wakeAll(): void {
    for (const wake of [...this.wakers]) wake()
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise)
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => {})
    return promise
  }

  /**
   * Upload records describe one remote; after the target changes they no
   * longer apply. The next uploads re-check the new remote (identical copies
   * are recorded without uploading).
   */
  remoteTargetChanged(): void {
    this.db.delete(uploads).run()
    // Nothing learned about the old remote applies to the new one.
    this.remoteGeneration += 1
    this.remoteListing = null
    this.pauses.upload = null
    this.sourceErrors.delete(REMOTE_AUDIT)
    void this.auditRemote()
    this.markDirty()
  }

  /** Re-run inventory work after the library folder changes. */
  async libraryFolderChanged(): Promise<void> {
    if (this.folderChangePromise) await this.folderChangePromise
    const change = (async () => {
      this.abortAll(new Error('library folder changed'))
      await Promise.allSettled([...this.works])
      await this.prepareLibrary()
      this.markDirty()
    })()
    this.folderChangePromise = change
    try {
      await change
    } finally {
      if (this.folderChangePromise === change) this.folderChangePromise = null
    }
  }

  /**
   * Checks the Remote Library against the upload records. It runs at startup,
   * when the remote target changes and when probing a lost connection, never
   * as part of a like check. A failure shows in Activity.
   */
  private auditRemote(): Promise<void> {
    return this.track(this.runAudit())
  }

  private async runAudit(): Promise<void> {
    const generation = this.remoteGeneration
    const controller = new AbortController()
    this.background.add(controller)
    try {
      const result = await auditRemote(this.deps, controller.signal)
      if (generation !== this.remoteGeneration) return
      if (result) {
        this.remoteListing = result.listing
        if (result.stale.length) this.markDirty()
      }
      this.sourceErrors.delete(REMOTE_AUDIT)
      this.clearPause('upload')
    } catch (error) {
      // Stopped, aborted by a folder change, or superseded: not a failure.
      if (controller.signal.aborted || generation !== this.remoteGeneration)
        return
      console.warn('[reconciler] remote audit', error)
      this.sourceErrors.set(
        REMOTE_AUDIT,
        error instanceof Error ? error.message : String(error)
      )
      // An unreachable remote pauses uploads; any other failure leaves each
      // track to fail on its own.
      if (isConnectivityError(error)) this.pauseLane('upload')
      else this.clearPause('upload')
    } finally {
      this.background.delete(controller)
      this.emitSoon()
    }
  }

  /** A lane lost its connection: wait, with growing delays, before trying again. */
  private pauseLane(lane: Lane): void {
    const current = this.pauses[lane]
    // Several uploads fail together; that is one outage.
    if (current && Date.now() < current.until) return
    const failures = (current?.failures ?? 0) + 1
    const { probeBackoffMs } = this.tuning
    this.pauses[lane] = {
      until:
        Date.now() +
        probeBackoffMs[Math.min(failures, probeBackoffMs.length) - 1],
      failures,
    }
    this.emitSoon()
  }

  private clearPause(lane: Lane): void {
    if (!this.pauses[lane]) return
    this.pauses[lane] = null
    this.wakeAll()
    this.emitSoon()
  }

  private async prepareLibrary(): Promise<void> {
    const settings = this.deps.settings()
    if (
      !settings.libraryFolder ||
      !(await readableDirectory(settings.libraryFolder))
    )
      return
    const inventory = {
      db: this.db,
      coversDir: coversDir(this.deps),
      now: this.deps.now,
    }
    try {
      await recoverOperations(inventory, settings.libraryFolder)
      await adoptFiles(inventory, settings.libraryFolder)
      claimAdoptedFiles(this.db, this.deps.now)
      this.refreshWantedStates()
      await detectOutsideEdits(inventory, settings.libraryFolder)
    } catch (error) {
      console.error('[reconciler] library preparation failed', error)
    }
    this.deps.onLibraryChanged(null)
    this.markDirty()
  }

  markDirty(): void {
    this.planDirty = true
    this.wakeAll()
    this.emitSoon()
  }

  /** Audits the Remote Library now, e.g. after it is turned on. */
  checkRemote(): Promise<void> {
    return this.auditRemote()
  }

  /** Checks liked songs (and due full-discography catalogs), then plans work. */
  check(options: { catalogs?: 'due' | 'all' | string[] } = {}): Promise<void> {
    return this.track(this.runCheck(options))
  }

  private async runCheck(options: {
    catalogs?: 'due' | 'all' | string[]
  }): Promise<void> {
    if (this.checking) {
      // Remember the request (e.g. a new Full Discography artist) and run it right after.
      this.queuedCheck = mergeCatalogRequests(
        this.queuedCheck,
        options.catalogs ?? 'due'
      )
      return
    }
    this.deps.matcher.resetCache?.()
    // A check is the normal pass: lookups that failed earlier are due again.
    this.deferred.clear()
    this.checking = true
    this.emitSoon()
    const accountId = this.deps.session.accountId()
    const generation = this.deps.session.generation()
    try {
      if (accountId) {
        try {
          const liked = await checkLikedSongs({
            db: this.db,
            catalog: this.deps.catalog,
            accountId,
            stillCurrent: () => this.deps.session.generation() === generation,
            now: this.deps.now,
          })
          this.deps.session.likedCountChanged?.(accountId, liked.total)
          this.sourceErrors.delete(likedSnapshotSource(accountId))
        } catch (error) {
          this.sourceErrors.set(
            likedSnapshotSource(accountId),
            error instanceof Error ? error.message : String(error)
          )
        }
      }
      const spotify = this.deps.spotify
      if (spotify?.session.refresh) await spotify.session.refresh()
      const spotifyAccountId = spotify?.session.accountId()
      if (spotify && spotifyAccountId) {
        this.sourceErrors.delete('spotify-session')
        const spotifyGeneration = spotify.session.generation()
        try {
          const liked = await checkSpotifyLikedSongs({
            db: this.db,
            library: spotify.library,
            accountId: spotifyAccountId,
            stillCurrent: () =>
              spotify.session.generation() === spotifyGeneration,
            now: this.deps.now,
          })
          spotify.session.likedCountChanged?.(spotifyAccountId, liked.total)
          this.sourceErrors.delete(spotifyLikedSnapshotSource(spotifyAccountId))
        } catch (error) {
          this.sourceErrors.set(
            spotifyLikedSnapshotSource(spotifyAccountId),
            error instanceof Error ? error.message : String(error)
          )
        }
      }
      if (spotify)
        for (const key of this.sourceErrors.keys()) {
          if (
            key.startsWith('spotify-liked:') &&
            key !==
              (spotifyAccountId
                ? spotifyLikedSnapshotSource(spotifyAccountId)
                : null)
          )
            this.sourceErrors.delete(key)
        }
      if (spotify && !spotifyAccountId) {
        const previous = this.db.get<{ n: number }>(
          sql`SELECT COUNT(*) AS n FROM contributions WHERE kind = 'spotify_liked'`
        )
        const message =
          spotify.session.message?.() ??
          (previous?.n
            ? 'Not signed in to Spotify. Sign in to check liked songs.'
            : null)
        if (message) this.sourceErrors.set('spotify-session', message)
        else this.sourceErrors.delete('spotify-session')
      }
      const fullDiscography = this.db
        .select()
        .from(artists)
        .where(eq(artists.fullDiscography, true))
        .all()
      const cutoff = this.deps.now().getTime() - CATALOG_INTERVAL_MS
      const due = fullDiscography.filter((artist) => {
        if (!artist.channelId) return false
        if (options.catalogs === 'all') return true
        if (Array.isArray(options.catalogs))
          return options.catalogs.includes(artist.id)
        return (
          !artist.catalogCheckedAt ||
          Date.parse(artist.catalogCheckedAt) < cutoff
        )
      })
      for (const artist of due) {
        if (canonicalArtist(this.db, artist.id)?.id !== artist.id) continue
        try {
          await checkArtistCatalog({
            db: this.db,
            catalog: this.deps.catalog,
            artistId: artist.id,
            channelId: artist.channelId!,
            now: this.deps.now,
          })
          const survivor = canonicalArtist(this.db, artist.id)
          if (survivor && survivor.id !== artist.id)
            void this.check({ catalogs: [survivor.id] })
          this.sourceErrors.delete(`catalog:${artist.id}`)
        } catch (error) {
          this.sourceErrors.set(
            `catalog:${artist.id}`,
            error instanceof Error ? error.message : String(error)
          )
        }
      }
      linkContributions(this.db, this.deps.now)
      claimAdoptedFiles(this.db, this.deps.now)
      this.refreshWantedStates()
    } finally {
      this.checking = false
      this.deps.onLibraryChanged(null)
      this.markDirty()
      const queued = this.queuedCheck
      this.queuedCheck = null
      if (queued && this.running) void this.check({ catalogs: queued })
    }
  }

  private refreshWantedStates(): void {
    const fullDiscography = this.db
      .select()
      .from(artists)
      .where(eq(artists.fullDiscography, true))
      .all()
      .filter((artist) => artist.channelId)
    updateWantedStates(this.db, {
      accountId: this.deps.session.accountId(),
      spotifyAccountId: this.deps.spotify?.session.accountId(),
      fullDiscographyArtistIds: fullDiscography.map((artist) => artist.id),
    })
  }

  setFullDiscography(artistId: string, enabled: boolean): void {
    artistId = canonicalArtist(this.db, artistId)?.id ?? artistId
    this.db
      .update(artists)
      .set({
        fullDiscography: enabled,
        suggested: false,
        fullDiscographyAt: enabled ? this.deps.now().toISOString() : null,
      })
      .where(eq(artists.id, artistId))
      .run()
    this.deps.onLibraryChanged(null)
    if (enabled) void this.check({ catalogs: [artistId] })
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
      ids = this.db
        .select({ id: tracks.id })
        .from(tracks)
        .where(
          and(eq(tracks.album, album), eq(tracks.albumArtist, albumArtist))
        )
        .all()
        .map((r) => r.id)
    } else if (scope.kind === 'artist') {
      ids = this.db
        .all<{ id: string }>(
          sql`SELECT track_id AS id FROM track_artists WHERE artist_id = ${scope.id}`
        )
        .map((r) => r.id)
      void this.check({ catalogs: [scope.id] })
    } else {
      ids = this.db
        .select({ id: tracks.id })
        .from(tracks)
        .all()
        .map((r) => r.id)
    }
    if (ids.length === 0) return
    invalidateReleaseCache()
    for (let i = 0; i < ids.length; i += 500) {
      this.db
        .update(tracks)
        .set({
          refreshRequested: true,
          state: 'pending',
          attempts: 0,
          nextAttemptAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            inArray(tracks.id, ids.slice(i, i + 500)),
            // Unwanted and released tracks are not the app's to rebuild.
            sql`state NOT IN ('no_longer_wanted', 'released')`
          )
        )
        .run()
    }
    this.deps.onLibraryChanged(ids.length > 500 ? null : ids)
    this.markDirty()
  }

  /** Manual retry only; completed lookups have no expiry. */
  recheckLyrics(): void {
    this.db
      .update(tracks)
      .set({ lyricsCheckedAt: null })
      .where(sql`${tracks.lyricsStatus} != 'synced'`)
      .run()
    this.deps.onLibraryChanged(null)
    this.markDirty()
  }

  /** Marks tracks without a genre for one Last.fm lookup; manual only, like lyrics. */
  recheckGenres(): void {
    this.db
      .update(tracks)
      .set({ genreRequested: true })
      .where(sql`${tracks.genre} IS NULL OR ${tracks.genre} = ''`)
      .run()
    this.deps.onLibraryChanged(null)
    this.markDirty()
  }

  retry(trackId: string): void {
    this.db
      .update(tracks)
      .set({
        state: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        lastErrorKind: null,
      })
      .where(
        and(
          eq(tracks.id, trackId),
          sql`state NOT IN ('no_longer_wanted', 'released')`
        )
      )
      .run()
    this.deps.onLibraryChanged([trackId])
    this.markDirty()
  }

  /** Retry every track that needs attention, and re-check failed sources. */
  retryAll(): void {
    const ids = this.db
      .update(tracks)
      .set({
        state: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        lastErrorKind: null,
      })
      .where(eq(tracks.state, 'needs_attention'))
      .returning({ id: tracks.id })
      .all()
      .map((row) => row.id)
    if (ids.length) this.deps.onLibraryChanged(ids.length > 500 ? null : ids)
    // The user asked to try again now, so a lane that is waiting tries at once.
    this.pauses.acquire = null
    this.pauses.upload = null
    this.markDirty()
    if (this.sourceErrors.has(REMOTE_AUDIT)) void this.auditRemote()
    if ([...this.sourceErrors.keys()].some((key) => key !== REMOTE_AUDIT))
      void this.check()
  }

  /** Outside Edit: restore the app's version of the file. */
  async rewrite(trackId: string): Promise<void> {
    const file = this.db
      .select()
      .from(files)
      .where(eq(files.trackId, trackId))
      .get()
    const state = this.db
      .select({ state: tracks.state })
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .get()?.state
    // Nothing will rebuild an unwanted track, so rewriting just accepts the edit.
    const inactive = state === 'no_longer_wanted' || state === 'released'
    const root = this.deps.settings().libraryFolder
    if (file?.outsideEdit && root) {
      const parts = JSON.parse(file.outsideEdit) as string[]
      if (parts.includes('deleted')) {
        this.db.delete(files).where(eq(files.trackId, trackId)).run()
      } else if (parts.includes('audio') && !inactive) {
        // Replace the edited file in place with a fresh download.
        this.db
          .update(files)
          .set({ outsideEdit: null, audioVideoId: REWRITE_AUDIO })
          .where(eq(files.trackId, trackId))
          .run()
      } else {
        // Accept the edited file as the new baseline; retagging then restores the app's tags.
        const absolute = path.join(root, file.relativePath)
        const info = await stat(absolute)
        const lrc = path.join(root, sidecarPath(file.relativePath))
        this.db
          .update(files)
          .set({
            outsideEdit: null,
            size: info.size,
            mtimeMs: info.mtimeMs,
            contentSha256: await sha256File(absolute),
            tagFields: JSON.stringify(readTags(absolute).fields),
            lrcSha256: existsSync(lrc) ? sha256(readFileSync(lrc)) : null,
          })
          .where(eq(files.trackId, trackId))
          .run()
      }
    }
    this.retry(trackId)
  }

  /**
   * Outside Edit: stop managing the file. It becomes an Unmanaged File and the
   * track is released, so later checks and restarts neither re-adopt nor
   * re-download it.
   */
  stopManaging(trackId: string): void {
    const at = this.deps.now().toISOString()
    // Abort its running step; a file it still manages to place is kept as Unmanaged.
    this.flights.get(trackId)?.controller.abort(new Error('stopped managing'))
    this.db.transaction((tx) => {
      const db = tx as unknown as Db
      const file = db
        .select()
        .from(files)
        .where(eq(files.trackId, trackId))
        .get()
      if (file) {
        for (const relativePath of [
          file.relativePath,
          ...(file.lrcSha256 ? [sidecarPath(file.relativePath)] : []),
        ]) {
          db.insert(unmanagedFiles)
            .values({
              relativePath,
              size: file.size,
              mtimeMs: file.mtimeMs,
              seenAt: at,
              released: true,
            })
            .onConflictDoUpdate({
              target: unmanagedFiles.relativePath,
              set: { released: true, seenAt: at },
            })
            .run()
        }
      }
      db.delete(files).where(eq(files.trackId, trackId)).run()
      db.delete(uploads).where(eq(uploads.trackId, trackId)).run()
      // Copies a merge meant to delete after this track's replacement stay too.
      cancelMergeCleanup(db, trackId, 'both')
      db.update(tracks)
        .set({ state: 'released', currentStep: null, updatedAt: at })
        .where(eq(tracks.id, trackId))
        .run()
    })
    this.deps.onLibraryChanged(null)
    this.markDirty()
  }

  delete(trackIds: string[], where: 'local' | 'remote' | 'both'): string[] {
    const deleted = deleteTracks(this.deps, trackIds, where)
    // A step still running on a deleted track must not outlive the delete.
    for (const trackId of deleted)
      this.flights.get(trackId)?.controller.abort(new Error('deleting'))
    this.deps.onLibraryChanged(null)
    this.markDirty()
    return deleted
  }

  // ------------------------------------------------------------ worker

  /** Sets state from facts for every track that is not paused or being worked on. */
  private plan(): void {
    this.planDirty = false
    const settings = this.deps.settings()
    const rows = this.db
      .select()
      .from(tracks)
      .where(inArray(tracks.state, ['pending', 'done', 'working']))
      .all()
    const fileRows = new Map(
      this.db
        .select()
        .from(files)
        .all()
        .map((row) => [row.trackId, row])
    )
    const uploadRows = new Map(
      this.db
        .select()
        .from(uploads)
        .all()
        .map((row) => [row.trackId, row])
    )
    const planned = new Map<string, StepKind>()
    const toPending: string[] = []
    const toDone: string[] = []
    for (const track of rows) {
      if (this.flights.has(track.id)) continue
      const step = nextStep(
        this.db,
        track,
        fileRows.get(track.id),
        uploadRows.get(track.id),
        settings,
        this.deferred
      )
      if (step) planned.set(track.id, step)
      if (step && track.state !== 'pending') toPending.push(track.id)
      if (!step && track.state !== 'done') toDone.push(track.id)
    }
    this.planned = planned
    const chunked = (ids: string[], state: 'pending' | 'done') => {
      for (let i = 0; i < ids.length; i += 500) {
        this.db
          .update(tracks)
          .set({ state })
          .where(inArray(tracks.id, ids.slice(i, i + 500)))
          .run()
      }
    }
    chunked(toPending, 'pending')
    chunked(toDone, 'done')
  }

  /** The next due, pending track for this lane that nothing is working on. */
  private nextTrack(lane: Lane): string | undefined {
    const now = this.deps.now().toISOString()
    const due = this.db
      .select({ id: tracks.id })
      .from(tracks)
      .where(
        and(
          eq(tracks.state, 'pending'),
          or(
            sql`${tracks.nextAttemptAt} IS NULL`,
            lte(tracks.nextAttemptAt, now)
          )
        )
      )
      .orderBy(...queueOrder())
      .all()
    return due.find(({ id }) => {
      if (this.flights.has(id)) return false
      // A track with no plan yet starts in the acquire lane, which hands it on.
      const step = this.planned.get(id)
      return (step ? laneOf(step) : 'acquire') === lane
    })?.id
  }

  /** One worker: takes the next track for its lane, runs it, repeats. */
  private async laneLoop(lane: Lane): Promise<void> {
    while (this.running) {
      if (this.folderChangePromise) await this.folderChangePromise
      const root = this.deps.settings().libraryFolder
      if (!root || !(await readableDirectory(root))) {
        // Nothing can be written until a folder is chosen and available (e.g. the
        // drive is mounted); wait instead of failing tracks.
        this.emitSoon()
        await this.idle(60_000)
        if (lane === 'acquire' && root && (await readableDirectory(root)))
          await this.prepareLibrary()
        continue
      }
      const pause = this.pauses[lane]
      if (pause) {
        const wait = pause.until - Date.now()
        if (wait > 0) {
          await this.idle(wait)
          continue
        }
        // The upload lane probes the VPS with an audit; the acquire lane
        // probes with its next step. A probe that neither renewed nor lifted
        // the pause (it was aborted) just ends it.
        if (lane === 'upload') {
          this.probing ??= this.auditRemote().finally(() => {
            this.probing = null
          })
          await this.probing
          const renewed = this.pauses.upload
          if (renewed && renewed.until <= Date.now()) this.clearPause('upload')
          else if (renewed) continue
        }
      }
      try {
        if (this.planDirty) this.plan()
        const trackId = this.nextTrack(lane)
        if (!trackId) {
          // Nothing is waiting, so a lost connection has nothing to retry.
          this.clearPause(lane)
          if (lane === 'acquire') await this.runTombstones()
          await this.idle(this.nextWakeDelay())
          continue
        }
        const flight: Flight = {
          trackId,
          lane,
          step: null,
          fraction: 0,
          row: null,
          controller: new AbortController(),
        }
        this.flights.set(trackId, flight)
        this.db
          .update(tracks)
          .set({ state: 'working' })
          .where(eq(tracks.id, trackId))
          .run()
        const work = this.work(flight)
        this.works.add(work)
        try {
          await work
        } finally {
          this.works.delete(work)
        }
      } catch (error) {
        console.error(`[reconciler] ${lane} lane`, error)
        await this.idle(5_000)
      }
    }
  }

  private async runTombstones(): Promise<void> {
    const controller = new AbortController()
    this.background.add(controller)
    try {
      await processTombstones(this.deps, controller.signal)
    } catch (error) {
      console.warn('[reconciler] tombstones', error)
    } finally {
      this.background.delete(controller)
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
    return Math.max(
      1_000,
      Math.min(60_000, Date.parse(next.at) - this.deps.now().getTime())
    )
  }

  private idle(ms: number): Promise<void> {
    // stop() may have run while the loop was between awaits; don't sleep then.
    if (!this.running) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.wakers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wakers.add(done)
    })
  }

  private activityRow(trackId: string): ActivityRow | null {
    return (
      this.db
        .select(ACTIVITY_COLUMNS)
        .from(tracks)
        .where(eq(tracks.id, trackId))
        .get() ?? null
    )
  }

  /** The track's next step belongs to the other lane: queue it there. */
  private handOff(flight: Flight, step: StepKind): void {
    this.db
      .update(tracks)
      .set({ state: 'pending', currentStep: null })
      .where(and(eq(tracks.id, flight.trackId), eq(tracks.state, 'working')))
      .run()
    this.planned.set(flight.trackId, step)
    this.wakeAll()
  }

  /** Runs a track's steps in this lane until it is done or its next step belongs elsewhere. */
  private async work(flight: Flight): Promise<void> {
    const signal = flight.controller.signal
    let worked = false
    try {
      for (let guard = 0; guard < 8 && this.running; guard += 1) {
        const trackId = flight.trackId
        const track = this.db
          .select()
          .from(tracks)
          .where(eq(tracks.id, trackId))
          .get()
        if (
          !track ||
          track.state === 'no_longer_wanted' ||
          track.state === 'released' ||
          signal.aborted
        )
          return
        const file = this.db
          .select()
          .from(files)
          .where(eq(files.trackId, trackId))
          .get()
        const upload = this.db
          .select()
          .from(uploads)
          .where(eq(uploads.trackId, trackId))
          .get()
        const step = nextStep(
          this.db,
          track,
          file,
          upload,
          this.deps.settings(),
          this.deferred
        )
        if (!step) {
          this.db
            .update(tracks)
            .set({
              state: 'done',
              currentStep: null,
              attempts: 0,
              nextAttemptAt: null,
              lastError: null,
              ...(worked ? { completedAt: this.deps.now().toISOString() } : {}),
            })
            .where(and(eq(tracks.id, trackId), eq(tracks.state, 'working')))
            .run()
          this.deps.onLibraryChanged([trackId])
          return
        }
        if (laneOf(step) !== flight.lane) {
          this.handOff(flight, step)
          return
        }
        flight.step = step
        flight.fraction = 0
        flight.row = this.activityRow(trackId)
        this.db
          .update(tracks)
          .set({ currentStep: step })
          .where(and(eq(tracks.id, trackId), eq(tracks.state, 'working')))
          .run()
        this.emitSoon()
        const run: StepRun = {
          signal,
          progress: (fraction: number) => {
            flight.fraction = fraction
            this.emitSoon(false)
          },
          remoteListing: this.remoteListing,
        }
        try {
          if (step === 'match') {
            const outcome = await runMatch(this.deps, track, run)
            if (outcome.trackId !== trackId) {
              // Merged into another track; carry on with the survivor, unless
              // another lane is already working it.
              if (this.flights.has(outcome.trackId)) {
                this.markDirty()
                return
              }
              this.flights.delete(trackId)
              flight.trackId = outcome.trackId
              this.flights.set(outcome.trackId, flight)
              this.db
                .update(tracks)
                .set({ state: 'working' })
                .where(eq(tracks.id, outcome.trackId))
                .run()
            }
          } else if (step === 'lyrics') {
            if (!(await runLyrics(this.deps, track, run)))
              this.deferred.add(`lyrics:${trackId}`)
          } else if (step === 'genre') {
            if (!(await runGenre(this.deps, track, run)))
              this.deferred.add(`genre:${trackId}`)
          } else if (step === 'acquire') {
            await runAcquire(this.deps, track, run)
          } else if (step === 'retag') await runRetag(this.deps, track, run)
          else if (step === 'move') await runMove(this.deps, track, run)
          else if (step === 'upload') await runUpload(this.deps, track, run)
          worked = true
          // Retries count consecutive failures; a step that worked (after a
          // wait, say) starts the count again.
          this.db
            .update(tracks)
            .set({ attempts: 0 })
            .where(
              and(eq(tracks.id, flight.trackId), sql`${tracks.attempts} > 0`)
            )
            .run()
          if (NETWORK_STEPS.has(step)) this.clearPause(flight.lane)
        } catch (error) {
          if (!this.running || signal.aborted) {
            this.db
              .update(tracks)
              .set({ state: 'pending', currentStep: null })
              .where(
                and(eq(tracks.id, flight.trackId), eq(tracks.state, 'working'))
              )
              .run()
            return
          }
          if (error instanceof OutsideEditError) {
            // The file changed outside the app: pause the track (shown in Needs Attention).
            this.db
              .update(tracks)
              .set({ state: 'done', currentStep: null })
              .where(
                and(eq(tracks.id, flight.trackId), eq(tracks.state, 'working'))
              )
              .run()
            this.deps.onLibraryChanged([flight.trackId])
            return
          }
          if (
            errorKindOf(error) !== 'permanent' &&
            isConnectivityError(error)
          ) {
            // Not this track's fault: it keeps its retries and the lane waits.
            this.db
              .update(tracks)
              .set({ state: 'pending', currentStep: null })
              .where(
                and(eq(tracks.id, flight.trackId), eq(tracks.state, 'working'))
              )
              .run()
            this.planned.set(flight.trackId, step)
            this.pauseLane(flight.lane)
            return
          }
          this.fail(flight.trackId, step, error)
          return
        }
      }
      this.db
        .update(tracks)
        .set({ state: 'pending', currentStep: null })
        .where(and(eq(tracks.id, flight.trackId), eq(tracks.state, 'working')))
        .run()
    } finally {
      if (this.flights.get(flight.trackId) === flight)
        this.flights.delete(flight.trackId)
      this.emitSoon()
    }
  }

  private fail(trackId: string, step: StepKind, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    // Wherever the retry happens, it starts at the step that failed.
    this.planned.set(trackId, step)
    if (error instanceof RetryLaterError) {
      // Not a failure, so never Needs Attention; but each wait doubles, up to
      // a few hours, so a delete that never finishes can't cause a lookup a minute.
      const waited =
        this.db
          .select({ attempts: tracks.attempts })
          .from(tracks)
          .where(eq(tracks.id, trackId))
          .get()?.attempts ?? 0
      this.db
        .update(tracks)
        .set({
          state: 'pending',
          currentStep: null,
          attempts: waited + 1,
          nextAttemptAt: new Date(
            this.deps.now().getTime() +
              Math.min(error.delayMs * 2 ** waited, MAX_WAIT_MS)
          ).toISOString(),
          lastError: message,
          lastErrorStep: step,
        })
        .where(and(eq(tracks.id, trackId), eq(tracks.state, 'working')))
        .run()
      return
    }
    const kind = errorKindOf(error)
    const track = this.db
      .select()
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .get()
    if (track?.state === 'no_longer_wanted') return
    const attempts = (track?.attempts ?? 0) + 1
    const giveUp = kind === 'permanent' || attempts > BACKOFF_MS.length
    console.warn(
      `[reconciler] ${step} failed for ${track?.title ?? trackId}: ${message}`
    )
    this.db
      .update(tracks)
      .set({
        state: giveUp ? 'needs_attention' : 'pending',
        currentStep: null,
        attempts,
        nextAttemptAt: giveUp
          ? null
          : new Date(
              this.deps.now().getTime() + BACKOFF_MS[attempts - 1]
            ).toISOString(),
        lastError: message,
        lastErrorKind: kind,
        lastErrorStep: step,
        // Giving up ends this run too; it shows among recent activity.
        ...(giveUp ? { completedAt: this.deps.now().toISOString() } : {}),
      })
      .where(eq(tracks.id, trackId))
      .run()
    this.deps.onLibraryChanged([trackId])
  }

  // ------------------------------------------------------------ activity

  /**
   * Schedules an update to the UI, at most one per 100 ms. Pass false for a
   * progress tick, which skips rebuilding the lists.
   */
  private emitSoon(listsChanged = true): void {
    if (listsChanged) this.listsDirty = true
    if (this.emitTimer || !this.running) return
    const wait = Math.max(0, 100 - (Date.now() - this.lastEmit))
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.lastEmit = Date.now()
      if (!this.listsDirty && this.deps.onProgress)
        this.deps.onProgress(this.liveView())
      else {
        const full = this.buildActivity(this.listsDirty)
        // Only a full emit pays the debt; a snapshot read (`activity()`) does not.
        this.listsDirty = false
        this.deps.onActivity(full)
      }
    }, wait)
  }

  activity(): ActivityView {
    return this.buildActivity(true)
  }

  private trackView(
    row: ActivityRow,
    extra: Partial<ActivityTrackView> = {}
  ): ActivityTrackView {
    return {
      id: row.id,
      title: row.title,
      artist: row.artist,
      coverUrl: this.deps.coverUrl(row.coverPath, row.coverUrl),
      stage: null,
      progress: 0,
      completedAt: row.completedAt,
      failed: row.state === 'needs_attention',
      ...extra,
    }
  }

  /** The tracks being worked on, with progress. */
  private liveView(): ActivityLive {
    let current: ActivityTrackView | null = null
    const uploading: ActivityTrackView[] = []
    for (const flight of this.flights.values()) {
      if (!flight.row || !flight.step) continue
      const stage = stageForStep(flight.step)
      const [base, weight] = STAGE_WEIGHTS[stage]
      const view = this.trackView(flight.row, {
        stage,
        progress: Math.min(1, base + weight * flight.fraction),
      })
      if (flight.lane === 'upload') uploading.push(view)
      else current = view
    }
    return { current, uploading }
  }

  private buildActivity(rebuildLists: boolean): ActivityView {
    if (rebuildLists || !this.lists) {
      this.lists = this.computeLists()
    }
    const lists = this.lists
    const live = this.liveView()
    return {
      working: this.flights.size > 0 || lists.upNextCount > 0,
      checking: this.checking,
      remoteUnreachable: this.pauses.upload !== null,
      offline: this.pauses.acquire !== null,
      ...live,
      ...lists,
      upNext: lists.upNext.filter((row) => !this.flights.has(row.id)),
    }
  }

  /** Reads only the columns Activity shows. */
  private computeLists(): ActivityLists {
    const cover = this.deps.coverUrl
    const now = this.deps.now()
    const pendingWhere = and(
      eq(tracks.state, 'pending'),
      or(
        sql`${tracks.nextAttemptAt} IS NULL`,
        lte(tracks.nextAttemptAt, now.toISOString())
      )
    )
    const upNext = this.db
      .select(ACTIVITY_COLUMNS)
      .from(tracks)
      .where(pendingWhere)
      .orderBy(...queueOrder())
      .limit(40)
      .all()
      .map((row) => this.trackView(row))
    const upNextCount =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(tracks)
        .where(pendingWhere)
        .get()?.n ?? 0
    const recent = this.db
      .select(ACTIVITY_COLUMNS)
      .from(tracks)
      .where(
        and(
          isNotNull(tracks.completedAt),
          // Tracks queued again belong to up-next, not to the finished list.
          inArray(tracks.state, ['done', 'needs_attention']),
          gte(
            tracks.completedAt,
            new Date(now.getTime() - RECENT_WINDOW_MS).toISOString()
          )
        )
      )
      .orderBy(desc(tracks.completedAt))
      .limit(400)
      .all()
      // Newest 400, shown oldest-first above the current row.
      .reverse()
      .map((row) => this.trackView(row))
    const attention: AttentionItemView[] = this.db
      .select({
        id: tracks.id,
        title: tracks.title,
        artist: tracks.artist,
        coverPath: tracks.coverPath,
        coverUrl: tracks.coverUrl,
        lastError: tracks.lastError,
        lastErrorStep: tracks.lastErrorStep,
      })
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
      .select({
        id: tracks.id,
        title: tracks.title,
        artist: tracks.artist,
        coverPath: tracks.coverPath,
        coverUrl: tracks.coverUrl,
        outsideEdit: files.outsideEdit,
      })
      .from(files)
      .innerJoin(tracks, eq(tracks.id, files.trackId))
      .where(isNotNull(files.outsideEdit))
      .limit(100)
      .all()
      .map((row) => ({
        id: row.id,
        kind: 'outside_edit' as const,
        title: row.title,
        subtitle: row.artist,
        reason: `Changed outside the app (${(JSON.parse(row.outsideEdit ?? '[]') as string[]).join(', ')}). Rewrite it or stop managing it.`,
        coverUrl: cover(row.coverPath, row.coverUrl),
      }))
    const sources = [...this.sourceErrors.entries()].map(
      ([source, message]) => ({
        id: source,
        kind: 'source' as const,
        title:
          source === REMOTE_AUDIT
            ? 'Remote Library check'
            : source.startsWith('spotify')
              ? 'Spotify liked songs check'
              : source.startsWith('liked:')
                ? 'Liked songs check'
                : 'Full Discography catalog',
        subtitle: null,
        reason: message,
        coverUrl: null,
      })
    )
    const accountId = this.deps.session.accountId()
    const sourceIds = [
      ...(accountId ? [likedSnapshotSource(accountId)] : []),
      ...(this.deps.spotify?.session.accountId()
        ? [spotifyLikedSnapshotSource(this.deps.spotify.session.accountId()!)]
        : []),
    ]
    const successes = sourceIds
      .map(
        (source) =>
          this.db
            .select({ at: sourceSnapshots.lastSuccessAt })
            .from(sourceSnapshots)
            .where(eq(sourceSnapshots.source, source))
            .get()?.at
      )
      .filter((at): at is string => Boolean(at))
    return {
      lastCheckedAt: successes.sort().at(-1) ?? null,
      upNext,
      upNextCount,
      recent,
      needsAttention: [...sources, ...edited, ...attention],
    }
  }
}

type CatalogRequest = 'due' | 'all' | string[]

function mergeCatalogRequests(
  a: CatalogRequest | null,
  b: CatalogRequest
): CatalogRequest {
  if (a === 'all' || b === 'all') return 'all'
  if (a === null) return b
  if (a === 'due') return b === 'due' ? 'due' : b
  if (b === 'due') return a
  return [...new Set([...a, ...b])]
}

/** Lyrics and genre-only work last; otherwise newest likes, then newest catalog releases. */
function queueOrder() {
  return [
    asc(sql`CASE WHEN ${tracks.match} IS NOT NULL
      AND (${tracks.lyricsCheckedAt} IS NULL OR ${tracks.genreRequested} = 1) AND ${tracks.refreshRequested} = 0
      AND EXISTS (SELECT 1 FROM files f WHERE f.track_id = ${tracks.id}
        AND (f.audio_video_id IS NULL OR f.audio_video_id = json_extract(${tracks.match}, '$.catalogVideoId')))
      THEN 1 ELSE 0 END`),
    desc(
      sql`(SELECT MIN(c.first_seen_at) FROM contributions c WHERE c.track_id = tracks.id AND c.kind IN ('liked', 'spotify_liked') AND c.active = 1)`
    ),
    asc(
      sql`(SELECT MIN(c.liked_position) FROM contributions c WHERE c.track_id = tracks.id AND c.kind IN ('liked', 'spotify_liked') AND c.active = 1)`
    ),
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

export function humanizeError(
  step: string | null,
  message: string | null
): string {
  const text = message ?? 'Unknown error'
  if (/Video unavailable|Private video|has been removed/i.test(text))
    return 'Video unavailable on YouTube. Nothing to download.'
  if (/Sign in to confirm your age/i.test(text))
    return 'YouTube requires age verification for this video.'
  if (step === 'upload') return `Upload to remote failed: ${text}`
  if (step === 'acquire') return `Download failed: ${text}`
  if (step === 'match') return `Could not match on YouTube Music: ${text}`
  return text
}
