import { eq } from 'drizzle-orm'
import { type ArtistCredit, joinArtistNames } from '../domain'
import type { Match } from '../match/types'
import { parseMatch, trackCredits } from '../reconcile/desired'
import type { Db } from './db'
import { artists, type TrackRow, trackArtists, tracks } from './schema'

export function artistIdFor(credit: ArtistCredit): string {
  return credit.channelId
    ? `channel:${credit.channelId}`
    : `name:${credit.name.normalize('NFKC').toLowerCase().trim()}`
}

/** Alias pointers are always direct, including when the survivor changes. */
export function canonicalArtist(db: Db, id: string) {
  const row = db.select().from(artists).where(eq(artists.id, id)).get()
  return row?.aliasOf
    ? db.select().from(artists).where(eq(artists.id, row.aliasOf)).get()
    : row
}

export function ensureArtist(db: Db, credit: ArtistCredit) {
  const id = artistIdFor(credit)
  db.insert(artists)
    .values({ id, name: credit.name, channelId: credit.channelId })
    .onConflictDoNothing()
    .run()
  return canonicalArtist(db, id)!
}

/** Matching and adoption share this link path; credit text never renames a row. */
export function linkTrackArtists(
  db: Db,
  trackId: string,
  credits: ArtistCredit[]
): void {
  db.delete(trackArtists).where(eq(trackArtists.trackId, trackId)).run()
  credits.forEach((credit, position) => {
    const artist = ensureArtist(db, credit)
    db.insert(trackArtists)
      .values({ trackId, artistId: artist.id, position })
      .onConflictDoNothing()
      .run()
  })
}

export function releaseCredits(match: Match): ArtistCredit[] {
  return match.release?.artists.length ? match.release.artists : match.artists
}

export function canonicalNames(db: Db, credits: ArtistCredit[]): string {
  const seen = new Set<string>()
  return joinArtistNames(
    credits.flatMap((credit) => {
      const artist = credit.channelId
        ? canonicalArtist(db, artistIdFor(credit))
        : undefined
      const id =
        artist?.id ??
        (credit.channelId ? artistIdFor(credit) : `credit:${credit.name}`)
      if (seen.has(id)) return []
      seen.add(id)
      return [{ ...credit, name: artist?.name ?? credit.name }]
    })
  )
}

export function artistPagesReady(db: Db, credits: ArtistCredit[]): boolean {
  return credits.every(
    (credit) =>
      !credit.channelId ||
      Boolean(canonicalArtist(db, artistIdFor(credit))?.pageCheckedAt)
  )
}

/** Saved normalized track credits and release credits define the two tag roles. */
export function canonicalTrackNames(db: Db, track: TrackRow, match: Match) {
  const credits = trackCredits(track)
  const albumCredits = releaseCredits(match)
  if (!artistPagesReady(db, [...credits, ...albumCredits])) return null
  return {
    artist: canonicalNames(db, credits),
    albumArtist: canonicalNames(db, albumCredits),
  }
}

/** Replays saved credit roles after page caching, including after an interrupted pass. */
export function recomputeArtistNames(db: Db): number {
  let changed = 0
  db.transaction((tx) => {
    const store = tx as unknown as Db
    for (const track of store.select().from(tracks).all()) {
      const match = parseMatch(track)
      if (!match || track.state === 'released') continue
      const names = canonicalTrackNames(store, track, match)
      if (!names) continue
      const { artist, albumArtist } = names
      if (track.artist === artist && track.albumArtist === albumArtist) continue
      store
        .update(tracks)
        .set({ artist, albumArtist })
        .where(eq(tracks.id, track.id))
        .run()
      changed++
    }
  })
  return changed
}
