import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  releaseTitlesMatch,
  sameReleasePosition,
} from '../catalog/release-match'
import type {
  CatalogRelease,
  CatalogTrack,
  LikedSong,
  ReleaseShelf,
  YouTubeMusicCatalog,
} from '../catalog/types'
import { CatalogShapeError } from '../catalog/types'
import { joinArtistNames } from '../domain'
import type { Db } from '../library/db'
import {
  artists,
  contributions,
  sourceSnapshots,
  tracks,
} from '../library/schema'
import { releaseIdentityKey } from '../match/types'

/**
 * Source checks stage a complete snapshot and commit it in one transaction.
 * A partial, malformed, or suspiciously small snapshot never deactivates
 * anything (plan: "Source snapshots").
 */

export class SuspiciousSnapshotError extends Error {
  readonly kind = 'permanent' as const
  constructor(message: string) {
    super(message)
    this.name = 'SuspiciousSnapshotError'
  }
}

export interface LikedRaw {
  kind: 'liked'
  song: LikedSong
}

export interface CatalogRaw {
  kind: 'catalog'
  artistId: string
  /** Artist page list the release came from. Missing on rows saved before it was recorded. */
  shelf?: ReleaseShelf
  release: Omit<CatalogRelease, 'tracks'>
  track: CatalogTrack
}

export function likedSourceKey(accountId: string, videoId: string): string {
  return `ytm-liked:${accountId}:${videoId}`
}

export function catalogSourceKey(
  artistId: string,
  releaseId: string,
  videoId: string
): string {
  return `catalog:${artistId}:${releaseId}:${videoId}`
}

function nowIso(now: () => Date): string {
  return now().toISOString()
}

export function likedSnapshotSource(accountId: string): string {
  return `liked:${accountId}`
}

export function catalogSnapshotSource(artistId: string): string {
  return `catalog:${artistId}`
}

function markSnapshot(
  db: Db,
  source: string,
  patch: Partial<typeof sourceSnapshots.$inferInsert>,
  startedAt: string
) {
  const existing = db
    .select()
    .from(sourceSnapshots)
    .where(eq(sourceSnapshots.source, source))
    .get()
  if (existing) {
    db.update(sourceSnapshots)
      .set(patch)
      .where(eq(sourceSnapshots.source, source))
      .run()
  } else {
    db.insert(sourceSnapshots)
      .values({ source, status: 'running', startedAt, ...patch })
      .run()
  }
}

export function validateLikedSnapshot(
  songs: LikedSong[],
  declaredCount: number | null,
  previousActive: number
): void {
  if (songs.length === 0 && declaredCount !== 0 && previousActive > 0) {
    throw new SuspiciousSnapshotError(
      'YouTube Music returned no liked songs; keeping the previous list.'
    )
  }
  if (
    declaredCount !== null &&
    declaredCount >= 20 &&
    songs.length < declaredCount * 0.8
  ) {
    // Paging stopped early: the header promises far more songs than arrived.
    // (Unavailable songs make the header count ~10% higher than what parses.)
    throw new SuspiciousSnapshotError(
      `Only ${songs.length} of ${declaredCount} liked songs arrived; keeping the previous list.`
    )
  }
  const confirmedByHeader =
    declaredCount !== null && songs.length >= Math.floor(declaredCount * 0.8)
  if (
    previousActive >= 20 &&
    songs.length < previousActive * 0.5 &&
    !confirmedByHeader
  ) {
    throw new SuspiciousSnapshotError(
      `Liked songs dropped from ${previousActive} to ${songs.length}; keeping the previous list.`
    )
  }
}

export interface LikedCheckResult {
  total: number
  added: number
  removed: number
}

/** Fetches the selected account's Liked Music and commits it as the active liked snapshot. */
export async function checkLikedSongs(options: {
  db: Db
  catalog: YouTubeMusicCatalog
  accountId: string
  /** Returns false when the session changed while fetching; the snapshot is then discarded. */
  stillCurrent: () => boolean
  now?: () => Date
  signal?: AbortSignal
}): Promise<LikedCheckResult> {
  const { db, accountId } = options
  const now = options.now ?? (() => new Date())
  const source = likedSnapshotSource(accountId)
  const startedAt = nowIso(now)
  markSnapshot(
    db,
    source,
    { status: 'running', startedAt, error: null },
    startedAt
  )
  try {
    const result = await options.catalog.likedSongs(options.signal)
    if (!options.stillCurrent())
      throw new Error('Account changed during the liked-songs check')
    const previousActive =
      db
        .select({ count: sql<number>`count(*)` })
        .from(contributions)
        .where(
          and(
            eq(contributions.kind, 'liked'),
            eq(contributions.accountId, accountId),
            eq(contributions.active, true)
          )
        )
        .get()?.count ?? 0
    const songs = result.tracks.filter((song) => song.videoId)
    validateLikedSnapshot(songs, result.declaredCount, previousActive)

    const committedAt = nowIso(now)
    let added = 0
    let removed = 0
    db.transaction((tx) => {
      const seen = new Set<string>()
      for (const song of songs) {
        const key = likedSourceKey(accountId, song.videoId)
        if (seen.has(key)) continue
        seen.add(key)
        const raw: LikedRaw = { kind: 'liked', song }
        const existing = tx
          .select()
          .from(contributions)
          .where(eq(contributions.sourceKey, key))
          .get()
        if (existing) {
          tx.update(contributions)
            .set({
              likedPosition: song.position,
              lastSeenAt: committedAt,
              active: true,
              raw: JSON.stringify(raw),
            })
            .where(eq(contributions.id, existing.id))
            .run()
          if (!existing.active) added += 1
        } else {
          tx.insert(contributions)
            .values({
              id: randomUUID(),
              sourceKey: key,
              kind: 'liked',
              accountId,
              sourceVideoId: song.videoId,
              likedPosition: song.position,
              firstSeenAt: committedAt,
              lastSeenAt: committedAt,
              active: true,
              raw: JSON.stringify(raw),
            })
            .run()
          added += 1
        }
      }
      const stale = tx
        .select({ id: contributions.id, sourceKey: contributions.sourceKey })
        .from(contributions)
        .where(
          and(eq(contributions.kind, 'liked'), eq(contributions.active, true))
        )
        .all()
        .filter((row) => !seen.has(row.sourceKey))
      if (stale.length) {
        removed = stale.length
        tx.update(contributions)
          .set({ active: false })
          .where(
            inArray(
              contributions.id,
              stale.map((row) => row.id)
            )
          )
          .run()
      }
      markSnapshot(
        tx as unknown as Db,
        source,
        {
          status: 'ok',
          completedAt: committedAt,
          itemCount: seen.size,
          error: null,
          lastSuccessAt: committedAt,
        },
        startedAt
      )
    })
    return { total: songs.length, added, removed }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    markSnapshot(
      db,
      source,
      { status: 'failed', completedAt: nowIso(now), error: message },
      startedAt
    )
    throw error
  }
}

/** Shelves that held active contributions of the artist's previous snapshot. */
function populatedShelves(db: Db, artistId: string): Set<ReleaseShelf> {
  const shelves = new Set<ReleaseShelf>()
  for (const row of db
    .select({ raw: contributions.raw })
    .from(contributions)
    .where(
      and(
        eq(contributions.kind, 'catalog'),
        eq(contributions.artistId, artistId),
        eq(contributions.active, true)
      )
    )
    .all()) {
    try {
      const shelf = (JSON.parse(row.raw) as Partial<CatalogRaw>).shelf
      if (shelf) shelves.add(shelf)
    } catch {
      // Unreadable raw: it can't say which shelf it came from.
    }
  }
  return shelves
}

/** Fetches one full-discography artist's Official Main Catalog and commits it. */
export async function checkArtistCatalog(options: {
  db: Db
  catalog: YouTubeMusicCatalog
  artistId: string
  channelId: string
  now?: () => Date
  signal?: AbortSignal
}): Promise<{ total: number }> {
  const { db, catalog, artistId } = options
  const now = options.now ?? (() => new Date())
  const source = catalogSnapshotSource(artistId)
  const startedAt = nowIso(now)
  markSnapshot(
    db,
    source,
    { status: 'running', startedAt, error: null },
    startedAt
  )
  try {
    // Every release on the Albums and Singles & EPs shelves is Official Main Catalog.
    const refs = await catalog.artistReleases(options.channelId, options.signal)
    if (refs.length === 0) {
      throw new CatalogShapeError(
        'The artist page listed no albums or singles.'
      )
    }
    const shelves = new Set(refs.map((ref) => ref.shelf))
    for (const shelf of populatedShelves(db, artistId)) {
      if (!shelves.has(shelf))
        throw new SuspiciousSnapshotError(
          `The artist page no longer lists any ${shelf === 'albums' ? 'albums' : 'singles or EPs'}; keeping the previous catalog. If that is right, turn Full Discography off and on again.`
        )
    }
    const staged: CatalogRaw[] = []
    for (const ref of refs) {
      const release = await catalog.release(ref.browseId, options.signal)
      const available = release.tracks.filter(
        (track) => track.videoId && track.isAvailable
      )
      if (release.tracks.length === 0) {
        throw new CatalogShapeError(`Release ${ref.title} returned no tracks.`)
      }
      const { tracks: _tracks, ...releaseInfo } = release
      for (const track of available) {
        staged.push({
          kind: 'catalog',
          artistId,
          shelf: ref.shelf,
          release: releaseInfo,
          track,
        })
      }
    }
    const previousActive =
      db
        .select({ count: sql<number>`count(*)` })
        .from(contributions)
        .where(
          and(
            eq(contributions.kind, 'catalog'),
            eq(contributions.artistId, artistId),
            eq(contributions.active, true)
          )
        )
        .get()?.count ?? 0
    const newCount = new Set(
      staged.map((raw) =>
        catalogSourceKey(artistId, raw.release.browseId, raw.track.videoId)
      )
    ).size
    if (previousActive >= 20 && newCount < previousActive * 0.5)
      throw new SuspiciousSnapshotError(
        `Full Discography catalog dropped from ${previousActive} to ${newCount}; keeping the previous list.`
      )
    const committedAt = nowIso(now)
    db.transaction((tx) => {
      // The user may have turned off Full Discography for the artist while the catalog loaded.
      const stillWanted = tx
        .select({ fullDiscography: artists.fullDiscography })
        .from(artists)
        .where(eq(artists.id, artistId))
        .get()?.fullDiscography
      if (!stillWanted) {
        markSnapshot(
          tx as unknown as Db,
          source,
          {
            status: 'failed',
            completedAt: committedAt,
            error: 'No longer a Full Discography artist',
          },
          startedAt
        )
        return
      }
      const seen = new Set<string>()
      for (const raw of staged) {
        const key = catalogSourceKey(
          artistId,
          raw.release.browseId,
          raw.track.videoId
        )
        if (seen.has(key)) continue
        seen.add(key)
        let existing = tx
          .select()
          .from(contributions)
          .where(eq(contributions.sourceKey, key))
          .get()
        let restoredAudio = false
        if (!existing && raw.track.videoType === 'ATV') {
          const previous = tx
            .select()
            .from(contributions)
            .where(
              and(
                eq(contributions.kind, 'catalog'),
                eq(contributions.artistId, artistId),
                eq(contributions.releaseId, raw.release.browseId)
              )
            )
            .all()
            .filter((row) => {
              try {
                const saved = JSON.parse(row.raw) as CatalogRaw
                return (
                  saved.track.videoType === 'OMV' &&
                  sameReleasePosition(saved.track, raw.track)
                )
              } catch {
                return false
              }
            })
          if (previous.length === 1) {
            existing = previous[0]
            restoredAudio = true
          }
        }
        if (existing) {
          // While inactive, its track may have been re-keyed to another
          // Release Track (e.g. by a like's Refresh): link it afresh.
          const linked = existing.trackId
            ? tx
                .select({
                  identityKey: tracks.identityKey,
                  state: tracks.state,
                  refreshRequested: tracks.refreshRequested,
                  releaseId: tracks.releaseId,
                  trackNumber: tracks.trackNumber,
                  discNumber: tracks.discNumber,
                  title: tracks.title,
                })
                .from(tracks)
                .where(eq(tracks.id, existing.trackId))
                .get()
            : undefined
          const stillItsTrack =
            linked?.identityKey ===
            releaseIdentityKey(raw.release.browseId, raw.track.videoId)
          const canRestore =
            restoredAudio &&
            linked?.identityKey ===
              releaseIdentityKey(raw.release.browseId, existing.sourceVideoId)
          const keepPosition =
            (linked?.state === 'released' || linked?.refreshRequested) &&
            linked.releaseId === raw.release.browseId &&
            linked.trackNumber === raw.track.trackNumber &&
            linked.discNumber === raw.track.discNumber &&
            releaseTitlesMatch(linked.title, raw.track.title)
          if (canRestore && existing.trackId) {
            tx.update(tracks)
              .set({
                refreshRequested: true,
                state:
                  linked?.state === 'no_longer_wanted'
                    ? 'no_longer_wanted'
                    : 'pending',
                attempts: 0,
                nextAttemptAt: null,
                lastError: null,
                updatedAt: committedAt,
              })
              .where(
                and(
                  eq(tracks.id, existing.trackId),
                  sql`${tracks.state} != 'released'`
                )
              )
              .run()
          }
          tx.update(contributions)
            .set({
              sourceKey: key,
              sourceVideoId: raw.track.videoId,
              lastSeenAt: committedAt,
              active: true,
              raw: JSON.stringify(raw),
              ...(stillItsTrack || canRestore || keepPosition
                ? {}
                : { trackId: null }),
            })
            .where(eq(contributions.id, existing.id))
            .run()
        } else {
          tx.insert(contributions)
            .values({
              id: randomUUID(),
              sourceKey: key,
              kind: 'catalog',
              artistId,
              sourceVideoId: raw.track.videoId,
              releaseId: raw.release.browseId,
              firstSeenAt: committedAt,
              lastSeenAt: committedAt,
              active: true,
              raw: JSON.stringify(raw),
            })
            .run()
        }
      }
      const stale = tx
        .select({ id: contributions.id, sourceKey: contributions.sourceKey })
        .from(contributions)
        .where(
          and(
            eq(contributions.kind, 'catalog'),
            eq(contributions.artistId, artistId),
            eq(contributions.active, true)
          )
        )
        .all()
        .filter((row) => !seen.has(row.sourceKey))
      if (stale.length) {
        tx.update(contributions)
          .set({ active: false })
          .where(
            inArray(
              contributions.id,
              stale.map((row) => row.id)
            )
          )
          .run()
      }
      tx.update(artists)
        .set({ catalogCheckedAt: committedAt })
        .where(eq(artists.id, artistId))
        .run()
      markSnapshot(
        tx as unknown as Db,
        source,
        {
          status: 'ok',
          completedAt: committedAt,
          itemCount: seen.size,
          error: null,
          lastSuccessAt: committedAt,
        },
        startedAt
      )
    })
    return { total: staged.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    markSnapshot(
      db,
      source,
      { status: 'failed', completedAt: nowIso(now), error: message },
      startedAt
    )
    throw error
  }
}

/** Deactivates every catalog contribution of an artist (Full Discography turned off). */
export function deactivateArtistCatalog(db: Db, artistId: string): void {
  db.update(contributions)
    .set({ active: false })
    .where(
      and(
        eq(contributions.kind, 'catalog'),
        eq(contributions.artistId, artistId)
      )
    )
    .run()
}

/**
 * Restored files not yet claimed by a like, by the liked video each
 * records. A video recorded by several files maps to none of them: the like is
 * matched normally and merges by Release Track identity instead.
 */
function unclaimedRestoredBySource(db: Db): Map<string, string> {
  const bySource = new Map<string, string[]>()
  for (const row of db
    .select({ id: tracks.id, match: tracks.match })
    .from(tracks)
    .where(
      and(
        eq(tracks.adopted, true),
        // Not a track the user stopped managing, or is still deleting.
        sql`${tracks.state} != 'released'`,
        sql`NOT EXISTS (SELECT 1 FROM tombstones tb WHERE tb.track_id = ${tracks.id} AND tb.done_at IS NULL)`
      )
    )
    .all()) {
    try {
      const saved = JSON.parse(row.match ?? 'null') as {
        sourceVideoId?: string
        resolutionMethod?: string
      } | null
      // A catalog wrote this file; its video was never a liked source.
      if (saved?.resolutionMethod === 'favorite_artist_release_exact') continue
      if (saved?.sourceVideoId)
        bySource.set(saved.sourceVideoId, [
          ...(bySource.get(saved.sourceVideoId) ?? []),
          row.id,
        ])
    } catch {
      // Unreadable saved match: leave the track unclaimed.
    }
  }
  const unique = new Map<string, string>()
  for (const [videoId, ids] of bySource)
    if (ids.length === 1) unique.set(videoId, ids[0])
  return unique
}

/**
 * Gives every active contribution a track. Catalog contributions know their
 * identity; liked contributions get a provisional track (no identity key)
 * that the match step re-keys or merges.
 */
export function linkContributions(
  db: Db,
  now: () => Date = () => new Date()
): string[] {
  const created: string[] = []
  const at = nowIso(now)
  db.transaction((tx) => {
    const unlinked = tx
      .select()
      .from(contributions)
      .where(and(eq(contributions.active, true), isNull(contributions.trackId)))
      .all()
    // Restored files record the liked video they were downloaded from; a like of
    // that same video claims the file right away (no match, no download).
    const adoptedBySource = unclaimedRestoredBySource(tx as unknown as Db)
    for (const row of unlinked) {
      const raw = JSON.parse(row.raw) as LikedRaw | CatalogRaw
      if (raw.kind === 'catalog') {
        const key = releaseIdentityKey(raw.release.browseId, raw.track.videoId)
        const existing = tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(eq(tracks.identityKey, key))
          .get()
        if (existing) {
          // A restored file stays claimable by the like it records.
          tx.update(contributions)
            .set({ trackId: existing.id })
            .where(eq(contributions.id, row.id))
            .run()
          continue
        }
        const id = randomUUID()
        tx.insert(tracks)
          .values({
            id,
            identityKey: key,
            title: raw.track.title,
            artistCredits: JSON.stringify(raw.track.artists),
            artist: joinArtistNames(raw.track.artists),
            album: raw.release.title,
            albumArtist:
              joinArtistNames(raw.release.artists) ||
              joinArtistNames(raw.track.artists),
            releaseId: raw.release.browseId,
            trackNumber: raw.track.trackNumber,
            durationSeconds: raw.track.durationSeconds,
            year: raw.release.year,
            coverUrl: raw.release.thumbnailUrl ?? raw.track.thumbnailUrl,
            state: 'pending',
            createdAt: at,
            updatedAt: at,
          })
          .run()
        tx.update(contributions)
          .set({ trackId: id })
          .where(eq(contributions.id, row.id))
          .run()
        created.push(id)
      } else {
        const song = raw.song
        const adoptedId = adoptedBySource.get(song.videoId)
        if (adoptedId) {
          adoptedBySource.delete(song.videoId)
          tx.update(tracks)
            .set({ adopted: false, updatedAt: at })
            .where(eq(tracks.id, adoptedId))
            .run()
          tx.update(contributions)
            .set({ trackId: adoptedId })
            .where(eq(contributions.id, row.id))
            .run()
          continue
        }
        const id = randomUUID()
        tx.insert(tracks)
          .values({
            id,
            identityKey: null,
            title: song.title,
            artistCredits: JSON.stringify(song.artists),
            artist: joinArtistNames(song.artists),
            album: song.album?.name ?? '',
            albumArtist: joinArtistNames(song.artists.slice(0, 1)),
            durationSeconds: song.durationSeconds,
            coverUrl: song.thumbnailUrl,
            state: 'pending',
            createdAt: at,
            updatedAt: at,
          })
          .run()
        tx.update(contributions)
          .set({ trackId: id })
          .where(eq(contributions.id, row.id))
          .run()
        created.push(id)
      }
    }
  })
  return created
}

/**
 * Moves likes from untouched provisional tracks onto adopted files that record
 * the same liked video. Covers the order where liked songs were checked before
 * the library folder was chosen (so linkContributions ran before adoption).
 */
export function claimAdoptedFiles(
  db: Db,
  now: () => Date = () => new Date()
): number {
  const at = nowIso(now)
  let claimed = 0
  db.transaction((tx) => {
    const adopted = unclaimedRestoredBySource(tx as unknown as Db)
    if (adopted.size === 0) return
    const candidates = tx.all<{
      id: string
      track_id: string
      source_video_id: string
    }>(sql`
      SELECT c.id, c.track_id, c.source_video_id FROM contributions c
      JOIN tracks t ON t.id = c.track_id
      WHERE c.kind = 'liked' AND c.active = 1 AND t.identity_key IS NULL
        AND NOT EXISTS (SELECT 1 FROM files f WHERE f.track_id = t.id)
    `)
    for (const row of candidates) {
      const target = adopted.get(row.source_video_id)
      if (!target) continue
      adopted.delete(row.source_video_id)
      tx.update(contributions)
        .set({ trackId: target })
        .where(eq(contributions.id, row.id))
        .run()
      tx.update(tracks)
        .set({ adopted: false, state: 'pending', updatedAt: at })
        .where(eq(tracks.id, target))
        .run()
      const remaining = tx
        .select({ id: contributions.id })
        .from(contributions)
        .where(eq(contributions.trackId, row.track_id))
        .get()
      if (!remaining) {
        tx.run(sql`DELETE FROM track_artists WHERE track_id = ${row.track_id}`)
        tx.delete(tracks).where(eq(tracks.id, row.track_id)).run()
      }
      claimed += 1
    }
  })
  return claimed
}

/**
 * Marks tracks with no active contribution as No Longer Wanted, and brings
 * back tracks that regained one. Only runs once every configured source has
 * completed a full check since the database was created.
 */
export function updateWantedStates(
  db: Db,
  options: { accountId: string | null; fullDiscographyArtistIds: string[] }
): void {
  const at = new Date().toISOString()
  // A track that regained a source is always wanted again, whatever else failed.
  db.run(sql`
    UPDATE tracks SET state = 'pending', updated_at = ${at}
    WHERE state = 'no_longer_wanted'
      AND EXISTS (SELECT 1 FROM contributions c WHERE c.track_id = tracks.id AND c.active = 1)
      -- A delete the user asked for finishes first; the track comes back after.
      AND NOT EXISTS (SELECT 1 FROM tombstones tb WHERE tb.track_id = tracks.id AND tb.done_at IS NULL)
  `)
  // Marking tracks unwanted waits for the liked-songs source to have completed a
  // full check (or, without an account, every full-discography catalog), so a
  // fresh database or a failing catalog can't flag the library.
  const required = options.accountId
    ? [likedSnapshotSource(options.accountId)]
    : options.fullDiscographyArtistIds.map(catalogSnapshotSource)
  if (required.length === 0) return
  const succeeded = db
    .select()
    .from(sourceSnapshots)
    .where(inArray(sourceSnapshots.source, required))
    .all()
    .filter((row) => row.lastSuccessAt)
  if (succeeded.length < required.length) return
  db.run(sql`
    UPDATE tracks SET state = 'no_longer_wanted', updated_at = ${at}
    WHERE state NOT IN ('no_longer_wanted', 'released')
      AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.track_id = tracks.id AND c.active = 1)
  `)
}
