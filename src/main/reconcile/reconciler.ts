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
  runLyrics,
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
const STOP_WAIT_MS = 5_000
const MAX_WAIT_MS = 6 * 60 * 60_000
const STAGE_WEIGHTS: Record<ActivityStage, [number, number]> = {
  matching: [0, 0.15],
  lyrics: [0.15, 0.7],
  downloading: [0.15, 0.7],
  uploading: [0.85, 0.15],
}

export interface SessionInfo {
  /** Selected YouTube Music Account ID, or null when signed out. */
  accountId(): string | null
  /** Bumped on every account switch or sign-out. */
  generation(): number
  /** Called with the account's liked-song count after each successful check. */
  likedCountChanged?(accountId: string, count: number): void
}

export interface ReconcilerDeps extends StepDeps {
  session: SessionInfo
  spotify?: { session: SessionInfo; library: SpotifyLibrary }
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
  private queuedCheck: CatalogRequest | null = null
  private planDirty = true
  private lastEmit = 0
  private emitTimer: NodeJS.Timeout | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private sourceErrors = new Map<string, string>()
  private loopPromise: Promise<void> | null = null
  private workPromise: Promise<void> | null = null
  private folderChangePromise: Promise<void> | null = null
  /** Checks and audits still touching the database; stop() waits for them. */
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(private readonly deps: ReconcilerDeps) {}

  private get db(): Db {
    return this.deps.db
  }

  /** Recovery, adoption, then the worker loop and the periodic check. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.prepareLibrary()
    // The remote may be slow or unreachable; don't hold up the worker for it.
    void this.auditRemote()
    this.loopPromise = this.loop()
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
    this.controller?.abort(new Error('stopping'))
    this.wake?.()
    await this.loopPromise?.catch(() => undefined)
    // Don't let a hung network request hold up quitting.
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS)
      }),
    ])
    clearTimeout(timer)
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
    this.markDirty()
  }

  /** Re-run inventory work after the library folder changes. */
  async libraryFolderChanged(): Promise<void> {
    if (this.folderChangePromise) await this.folderChangePromise
    const change = (async () => {
      this.controller?.abort(new Error('library folder changed'))
      await this.workPromise
      await this.prepareLibrary()
      await this.auditRemote()
      this.markDirty()
    })()
    this.folderChangePromise = change
    try {
      await change
    } finally {
      if (this.folderChangePromise === change) this.folderChangePromise = null
    }
  }

  private auditRemote(): Promise<void> {
    return this.track(this.runAudit())
  }

  private async runAudit(): Promise<void> {
    try {
      if ((await auditRemote(this.deps)).length) this.markDirty()
    } catch (error) {
      console.warn('[reconciler] remote audit', error)
    }
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
    this.wake?.()
    this.emitSoon()
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
      const spotifyAccountId = spotify?.session.accountId()
      if (spotify && spotifyAccountId) {
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
      await this.auditRemote()
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
    this.markDirty()
    if (this.sourceErrors.size) void this.check()
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
    if (this.current?.trackId === trackId)
      this.controller?.abort(new Error('stopped managing'))
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
    this.deps.onLibraryChanged(null)
    this.markDirty()
    return deleted
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
    const toPending: string[] = []
    const toDone: string[] = []
    for (const track of rows) {
      if (track.id === this.current?.trackId) continue
      const step = nextStep(
        this.db,
        track,
        fileRows.get(track.id),
        uploadRows.get(track.id),
        settings
      )
      if (step && track.state !== 'pending') toPending.push(track.id)
      if (!step && track.state !== 'done') toDone.push(track.id)
    }
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

  private nextTrack() {
    const now = this.deps.now().toISOString()
    return this.db
      .select()
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
      .limit(1)
      .get()
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.folderChangePromise) await this.folderChangePromise
      const root = this.deps.settings().libraryFolder
      if (!root || !(await readableDirectory(root))) {
        // Nothing can be written until a folder is chosen and available (e.g. the
        // drive is mounted); wait instead of failing tracks.
        this.current = null
        this.emitSoon()
        await this.idle(60_000)
        if (root && (await readableDirectory(root))) await this.prepareLibrary()
        continue
      }
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
      const work = this.work(track.id)
      this.workPromise = work
      try {
        await work
      } finally {
        if (this.workPromise === work) this.workPromise = null
      }
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
    this.db
      .update(tracks)
      .set({ state: 'working' })
      .where(eq(tracks.id, trackId))
      .run()
    let worked = false
    for (let guard = 0; guard < 8 && this.running; guard += 1) {
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
      ) {
        this.current = null
        return
      }
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
            ...(worked ? { completedAt: this.deps.now().toISOString() } : {}),
          })
          .where(and(eq(tracks.id, trackId), eq(tracks.state, 'working')))
          .run()
        this.current = null
        this.deps.onLibraryChanged([trackId])
        this.emitSoon()
        return
      }
      this.current = { trackId, step, fraction: 0 }
      this.db
        .update(tracks)
        .set({ currentStep: step })
        .where(and(eq(tracks.id, trackId), eq(tracks.state, 'working')))
        .run()
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
            this.db
              .update(tracks)
              .set({ state: 'working' })
              .where(eq(tracks.id, trackId))
              .run()
          }
        } else if (step === 'lyrics') {
          await runLyrics(this.deps, track, run)
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
          .where(and(eq(tracks.id, trackId), sql`${tracks.attempts} > 0`))
          .run()
      } catch (error) {
        if (!this.running || signal.aborted) {
          this.db
            .update(tracks)
            .set({ state: 'pending', currentStep: null })
            .where(and(eq(tracks.id, trackId), eq(tracks.state, 'working')))
            .run()
          this.current = null
          return
        }
        if (error instanceof OutsideEditError) {
          // The file changed outside the app: pause the track (shown in Needs Attention).
          this.db
            .update(tracks)
            .set({ state: 'done', currentStep: null })
            .where(and(eq(tracks.id, trackId), eq(tracks.state, 'working')))
            .run()
          this.current = null
          this.deps.onLibraryChanged([trackId])
          this.emitSoon()
          return
        }
        this.fail(trackId, step, error)
        return
      }
    }
    this.db
      .update(tracks)
      .set({ state: 'pending', currentStep: null })
      .where(and(eq(tracks.id, trackId), eq(tracks.state, 'working')))
      .run()
  }

  private fail(trackId: string, step: StepKind, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
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
      this.current = null
      this.emitSoon()
      return
    }
    const kind = errorKindOf(error)
    const track = this.db
      .select()
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .get()
    if (track?.state === 'no_longer_wanted') {
      this.current = null
      return
    }
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
    this.current = null
    this.deps.onLibraryChanged([trackId])
    this.emitSoon()
  }

  // ------------------------------------------------------------ activity

  private emitSoon(): void {
    if (this.emitTimer || !this.running) return
    const wait = Math.max(0, 100 - (Date.now() - this.lastEmit))
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.lastEmit = Date.now()
      this.deps.onActivity(this.activity())
    }, wait)
  }

  activity(): ActivityView {
    const cover = this.deps.coverUrl
    const toView = (
      row: typeof tracks.$inferSelect,
      extra: Partial<ActivityTrackView> = {}
    ): ActivityTrackView => ({
      id: row.id,
      title: row.title,
      artist: row.artist,
      coverUrl: cover(row.coverPath, row.coverUrl),
      stage: null,
      progress: 0,
      completedAt: row.completedAt,
      failed: row.state === 'needs_attention',
      ...extra,
    })
    let current: ActivityTrackView | null = null
    if (this.current) {
      const row = this.db
        .select()
        .from(tracks)
        .where(eq(tracks.id, this.current.trackId))
        .get()
      if (row) {
        const stage = stageForStep(this.current.step)
        const [base, weight] = STAGE_WEIGHTS[stage]
        current = toView(row, {
          stage,
          progress: Math.min(1, base + weight * this.current.fraction),
        })
      }
    }
    const now = this.deps.now()
    const pendingWhere = and(
      eq(tracks.state, 'pending'),
      or(
        sql`${tracks.nextAttemptAt} IS NULL`,
        lte(tracks.nextAttemptAt, now.toISOString())
      )
    )
    const upNextRows = this.db
      .select()
      .from(tracks)
      .where(pendingWhere)
      .orderBy(...queueOrder())
      .limit(40)
      .all()
    const upNextCount =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(tracks)
        .where(pendingWhere)
        .get()?.n ?? 0
    const recentRows = this.db
      .select()
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
    const sources = [...this.sourceErrors.entries()].map(
      ([source, message]) => ({
        id: source,
        kind: 'source' as const,
        title: source.startsWith('liked:')
          ? 'Liked songs check'
          : 'Full Discography catalog',
        subtitle: null,
        reason: message,
        coverUrl: null,
      })
    )
    const accountId = this.deps.session.accountId()
    const lastChecked = accountId
      ? (this.db
          .select()
          .from(sourceSnapshots)
          .where(eq(sourceSnapshots.source, likedSnapshotSource(accountId)))
          .get()?.lastSuccessAt ?? null)
      : null
    return {
      working: Boolean(current) || upNextCount > 0,
      checking: this.checking,
      lastCheckedAt: lastChecked,
      current,
      upNext: upNextRows
        .filter((row) => row.id !== current?.id)
        .map((row) => toView(row)),
      upNextCount: Math.max(0, upNextCount - (current ? 0 : 0)),
      recent: recentRows
        .filter((row) => row.id !== current?.id)
        .map((row) => toView(row)),
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

/** Lyrics-only work last; otherwise newest likes, then newest catalog releases. */
function queueOrder() {
  return [
    asc(sql`CASE WHEN ${tracks.match} IS NOT NULL
      AND ${tracks.lyricsCheckedAt} IS NULL AND ${tracks.refreshRequested} = 0
      AND EXISTS (SELECT 1 FROM files f WHERE f.track_id = ${tracks.id}
        AND (f.audio_video_id IS NULL OR f.audio_video_id = json_extract(${tracks.match}, '$.catalogVideoId')))
      THEN 1 ELSE 0 END`),
    desc(
      sql`(SELECT MAX(c.first_seen_at) FROM contributions c WHERE c.track_id = tracks.id AND c.kind = 'liked' AND c.active = 1)`
    ),
    asc(
      sql`(SELECT MIN(c.liked_position) FROM contributions c WHERE c.track_id = tracks.id AND c.kind = 'liked' AND c.active = 1)`
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
