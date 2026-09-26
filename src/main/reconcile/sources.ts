import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type {
  CatalogRelease,
  CatalogTrack,
  LikedSong,
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
  const confirmedByHeader =
    declaredCount !== null && songs.length >= Math.floor(declaredCount * 0.5)
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

/** Official Main Catalog release kinds (albums, singles, EPs). */
function isMainCatalogRelease(kindLabel: string | null): boolean {
  if (!kindLabel) return true
  return /album|single|ep/i.test(kindLabel)
}

/** Fetches one Favorite Artist's Official Main Catalog and commits it. */
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
    const refs = (
      await catalog.artistReleases(options.channelId, options.signal)
    ).filter((ref) => isMainCatalogRelease(ref.kindLabel))
    if (refs.length === 0) {
      throw new CatalogShapeError(
        'The artist page listed no albums or singles.'
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
        staged.push({ kind: 'catalog', artistId, release: releaseInfo, track })
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
        `Favorite Artist catalog dropped from ${previousActive} to ${newCount}; keeping the previous list.`
      )
    const committedAt = nowIso(now)
    db.transaction((tx) => {
      const seen = new Set<string>()
      for (const raw of staged) {
        const key = catalogSourceKey(
          artistId,
          raw.release.browseId,
          raw.track.videoId
        )
        if (seen.has(key)) continue
        seen.add(key)
        const existing = tx
          .select()
          .from(contributions)
          .where(eq(contributions.sourceKey, key))
          .get()
        if (existing) {
          tx.update(contributions)
            .set({
              lastSeenAt: committedAt,
              active: true,
              raw: JSON.stringify(raw),
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

/** Deactivates every catalog contribution of an artist (un-favorite). */
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
    // Adopted files record the liked video they were downloaded from; a like of
    // that same video claims the file right away (no download, no re-key yet).
    const adoptedBySource = new Map<string, string>()
    for (const candidate of tx
      .select({ id: tracks.id, match: tracks.match })
      .from(tracks)
      .where(eq(tracks.adopted, true))
      .all()) {
      try {
        const saved = JSON.parse(candidate.match ?? 'null') as {
          sourceVideoId?: string
        } | null
        if (saved?.sourceVideoId && !adoptedBySource.has(saved.sourceVideoId)) {
          adoptedBySource.set(saved.sourceVideoId, candidate.id)
        }
      } catch {
        // Unreadable saved match: leave the track unclaimed.
      }
    }
    for (const row of unlinked) {
      const raw = JSON.parse(row.raw) as LikedRaw | CatalogRaw
      if (raw.kind === 'catalog') {
        const key = releaseIdentityKey(raw.release.browseId, raw.track.videoId)
        const existing = tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(eq(tracks.identityKey, key))
          .get()
        const adopted = existing
          ? null
          : tx
              .select({ id: tracks.id })
              .from(tracks)
              .where(
                eq(
                  tracks.identityKey,
                  `adopted:${raw.release.browseId}:${raw.track.videoId}`
                )
              )
              .get()
        const targetId = existing?.id ?? adopted?.id
        if (targetId) {
          if (adopted) {
            tx.update(tracks)
              .set({
                identityKey: key,
                adopted: false,
                refreshRequested: true,
                updatedAt: at,
              })
              .where(eq(tracks.id, adopted.id))
              .run()
          }
          tx.update(contributions)
            .set({ trackId: targetId })
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
    const adopted = new Map<string, string>()
    for (const row of tx
      .select({ id: tracks.id, match: tracks.match })
      .from(tracks)
      .where(eq(tracks.adopted, true))
      .all()) {
      try {
        const saved = JSON.parse(row.match ?? 'null') as {
          sourceVideoId?: string
        } | null
        if (saved?.sourceVideoId && !adopted.has(saved.sourceVideoId))
          adopted.set(saved.sourceVideoId, row.id)
      } catch {
        // Unreadable saved match: leave unclaimed.
      }
    }
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
  options: { accountId: string | null; favoriteArtistIds: string[] }
): void {
  const required = [
    ...(options.accountId ? [likedSnapshotSource(options.accountId)] : []),
    ...options.favoriteArtistIds.map(catalogSnapshotSource),
  ]
  if (required.length === 0) return
  const done = db
    .select({ source: sourceSnapshots.source })
    .from(sourceSnapshots)
    .where(inArray(sourceSnapshots.source, required))
    .all()
    .filter(Boolean)
  const withSuccess = db
    .select()
    .from(sourceSnapshots)
    .where(inArray(sourceSnapshots.source, required))
    .all()
    .filter((row) => row.lastSuccessAt)
  if (withSuccess.length < required.length || done.length < required.length)
    return
  db.transaction((tx) => {
    tx.run(sql`
      UPDATE tracks SET state = 'no_longer_wanted', updated_at = ${new Date().toISOString()}
      WHERE state != 'no_longer_wanted'
        AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.track_id = tracks.id AND c.active = 1)
    `)
    tx.run(sql`
      UPDATE tracks SET state = 'pending', updated_at = ${new Date().toISOString()}
      WHERE state = 'no_longer_wanted'
        AND EXISTS (SELECT 1 FROM contributions c WHERE c.track_id = tracks.id AND c.active = 1)
    `)
  })
  void ne
}
