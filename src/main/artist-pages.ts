import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import {
  type CatalogArtist,
  CatalogShapeError,
  type YouTubeMusicCatalog,
} from './catalog/types'
import type { ArtistCredit } from './domain'
import {
  canonicalArtist,
  ensureArtist,
  recomputeArtistNames,
  releaseCredits,
} from './library/artists'
import type { Db } from './library/db'
import {
  artists,
  contributions,
  sourceSnapshots,
  trackArtists,
  tracks,
} from './library/schema'
import { HttpError } from './net/http'
import { parseMatch, trackCredits } from './reconcile/desired'
import { catalogSnapshotSource, catalogSourceKey } from './reconcile/sources'

/** Keeps track IDs and source desire intact when YouTube combines artist channels. */
function mergeArtists(db: Db, survivorId: string, aliasId: string): void {
  const survivor = canonicalArtist(db, survivorId)!
  const alias = db.select().from(artists).where(eq(artists.id, aliasId)).get()!
  for (const link of db
    .select()
    .from(trackArtists)
    .where(eq(trackArtists.artistId, aliasId))
    .all()) {
    const existing = db
      .select()
      .from(trackArtists)
      .where(
        and(
          eq(trackArtists.trackId, link.trackId),
          eq(trackArtists.artistId, survivorId)
        )
      )
      .get()
    db.insert(trackArtists)
      .values({ ...link, artistId: survivorId })
      .onConflictDoUpdate({
        target: [trackArtists.trackId, trackArtists.artistId],
        set: {
          position: Math.min(
            link.position,
            existing?.position ?? link.position
          ),
        },
      })
      .run()
  }
  db.delete(trackArtists).where(eq(trackArtists.artistId, aliasId)).run()
  for (const row of db.select().from(contributions).all()) {
    const raw = JSON.parse(row.raw) as { artistId?: string }
    if (row.artistId !== aliasId && raw.artistId !== aliasId) continue
    const rewritten =
      raw.artistId === aliasId
        ? JSON.stringify({ ...raw, artistId: survivorId })
        : row.raw
    if (row.artistId !== aliasId) {
      db.update(contributions)
        .set({ raw: rewritten })
        .where(eq(contributions.id, row.id))
        .run()
      continue
    }
    const key =
      row.kind === 'catalog'
        ? catalogSourceKey(survivorId, row.releaseId ?? '', row.sourceVideoId)
        : row.sourceKey
    const duplicate = db
      .select()
      .from(contributions)
      .where(eq(contributions.sourceKey, key))
      .get()
    if (duplicate && duplicate.id !== row.id) {
      db.update(contributions)
        .set({
          active: duplicate.active || row.active,
          trackId: duplicate.trackId ?? row.trackId,
          firstSeenAt: [duplicate.firstSeenAt, row.firstSeenAt].sort()[0],
          lastSeenAt: [duplicate.lastSeenAt, row.lastSeenAt].sort().at(-1)!,
        })
        .where(eq(contributions.id, duplicate.id))
        .run()
      db.delete(contributions).where(eq(contributions.id, row.id)).run()
    } else {
      db.update(contributions)
        .set({ artistId: survivorId, sourceKey: key, raw: rewritten })
        .where(eq(contributions.id, row.id))
        .run()
    }
  }
  const source = catalogSnapshotSource(aliasId)
  const snapshot = db
    .select()
    .from(sourceSnapshots)
    .where(eq(sourceSnapshots.source, source))
    .get()
  if (snapshot) {
    const target = catalogSnapshotSource(survivorId)
    const existing = db
      .select()
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.source, target))
      .get()
    const latest =
      existing && existing.startedAt > snapshot.startedAt ? existing : snapshot
    const merged = {
      ...latest,
      source: target,
      lastSuccessAt:
        [existing?.lastSuccessAt, snapshot.lastSuccessAt]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null,
    }
    db.insert(sourceSnapshots)
      .values(merged)
      .onConflictDoUpdate({ target: sourceSnapshots.source, set: merged })
      .run()
    db.delete(sourceSnapshots).where(eq(sourceSnapshots.source, source)).run()
  }
  db.update(artists)
    .set({
      fullDiscography: survivor.fullDiscography || alias.fullDiscography,
      fullDiscographyAt: survivor.fullDiscographyAt ?? alias.fullDiscographyAt,
      suggested: survivor.suggested || alias.suggested,
      catalogCheckedAt: survivor.catalogCheckedAt ?? alias.catalogCheckedAt,
      imagePath: survivor.imagePath ?? alias.imagePath,
      imageCheckedAt: survivor.imageCheckedAt ?? alias.imageCheckedAt,
    })
    .where(eq(artists.id, survivorId))
    .run()
  db.update(artists)
    .set({ aliasOf: survivorId })
    .where(eq(artists.aliasOf, aliasId))
    .run()
  db.update(artists)
    .set({
      aliasOf: survivorId,
      fullDiscography: false,
      fullDiscographyAt: null,
      suggested: false,
    })
    .where(eq(artists.id, aliasId))
    .run()
}

const fetching = new WeakMap<Db, Map<string, Promise<void>>>()

/** Cache both languages together; unavailable pages keep their credit name. */
export async function fetchArtistPage(
  db: Db,
  catalog: YouTubeMusicCatalog,
  credit: ArtistCredit,
  signal?: AbortSignal,
  now: () => Date = () => new Date()
): Promise<void> {
  if (!credit.channelId) return
  const artist = ensureArtist(db, credit)
  if (artist.pageCheckedAt) return
  let pending = fetching.get(db)
  if (!pending) {
    pending = new Map()
    fetching.set(db, pending)
  }
  const active = pending.get(artist.id)
  if (active) {
    await active
    signal?.throwIfAborted()
    return
  }
  const load = async () => {
    let page: CatalogArtist
    let native: CatalogArtist
    try {
      page = await catalog.artist(credit.channelId!, signal, 'en')
      native = await catalog.artist(credit.channelId!, signal, 'ja')
    } catch (error) {
      signal?.throwIfAborted()
      if (
        !(error instanceof CatalogShapeError) &&
        !(error instanceof HttpError && [404, 410].includes(error.status ?? 0))
      )
        throw error
      db.update(artists)
        .set({
          pageCheckedAt: now().toISOString(),
          primaryChannelId: credit.channelId,
          nativeName: null,
        })
        .where(eq(artists.id, artist.id))
        .run()
      console.error(`[artist-pages] ${artist.id}: keeping credit name`, error)
      return
    }
    signal?.throwIfAborted()
    db.transaction((tx) => {
      const store = tx as unknown as Db
      const canonical = canonicalArtist(store, artist.id)!
      const metadata = {
        name: page.name,
        nativeName: native.name === page.name ? null : native.name,
        primaryChannelId: page.primaryChannelId,
        pageCheckedAt: now().toISOString(),
      }
      store.update(artists).set(metadata).where(eq(artists.id, artist.id)).run()
      if (canonical.id !== artist.id && !canonical.pageCheckedAt)
        store
          .update(artists)
          .set(metadata)
          .where(eq(artists.id, canonical.id))
          .run()
      const candidates = store
        .select()
        .from(artists)
        .where(
          or(
            eq(artists.primaryChannelId, page.primaryChannelId),
            eq(artists.channelId, page.primaryChannelId)
          )
        )
        .all()
      const group = [
        ...new Map(
          candidates.map((row) => {
            const target = canonicalArtist(store, row.id)!
            return [target.id, target] as const
          })
        ).values(),
      ]
      const count = (id: string) =>
        store
          .select({ count: sql<number>`count(*)` })
          .from(trackArtists)
          .where(eq(trackArtists.artistId, id))
          .get()!.count
      group.sort(
        (a, b) =>
          Number(b.fullDiscography) - Number(a.fullDiscography) ||
          count(b.id) - count(a.id) ||
          a.id.localeCompare(b.id)
      )
      const survivor = group[0]
      if (!survivor) return
      for (const row of group.slice(1)) mergeArtists(store, survivor.id, row.id)
      if (!survivor.pageCheckedAt)
        store
          .update(artists)
          .set(metadata)
          .where(eq(artists.id, survivor.id))
          .run()
    })
  }
  const promise = load()
  pending.set(artist.id, promise)
  try {
    await promise
  } finally {
    pending.delete(artist.id)
  }
}

/** Nullable migration columns are the checkpoint; completed page reads survive restarts. */
export function createArtistPages(deps: {
  db: Db
  catalog: YouTubeMusicCatalog
  onUpdated: () => void
}) {
  let running: Promise<boolean> | null = null
  const controller = new AbortController()
  return {
    run(): Promise<boolean> {
      if (running) return running
      const work = async () => {
        // Release-only credits may have no track_artists link yet.
        for (const track of deps.db.select().from(tracks).all()) {
          const match = parseMatch(track)
          if (!match || track.state === 'released') continue
          for (const credit of [
            ...trackCredits(track),
            ...releaseCredits(match),
          ])
            ensureArtist(deps.db, credit)
        }
        const todo = deps.db
          .select()
          .from(artists)
          .where(
            and(
              isNotNull(artists.channelId),
              isNull(artists.pageCheckedAt),
              isNull(artists.aliasOf)
            )
          )
          .all()
        for (const artist of todo) {
          if (controller.signal.aborted) return false
          try {
            await fetchArtistPage(
              deps.db,
              deps.catalog,
              { name: artist.name, channelId: artist.channelId },
              controller.signal
            )
          } catch (error) {
            if (controller.signal.aborted) return false
            console.error(`[artist-pages] ${artist.id}`, error)
          }
        }
        const changed = recomputeArtistNames(deps.db)
        if (todo.length || changed) deps.onUpdated()
        return Boolean(
          deps.db
            .select({ id: artists.id })
            .from(artists)
            .where(
              and(
                isNotNull(artists.channelId),
                isNull(artists.pageCheckedAt),
                isNull(artists.aliasOf)
              )
            )
            .get()
        )
      }
      running = work().finally(() => {
        running = null
      })
      return running
    },
    async stop(): Promise<void> {
      controller.abort()
      await running
    },
  }
}
