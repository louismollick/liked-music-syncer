import { eq } from 'drizzle-orm'
import { afterEach, expect, it } from 'vitest'
import {
  contributions,
  sourceSnapshots,
  tracks,
} from '../../src/main/library/schema'
import {
  checkSpotifyLikedSongs,
  linkContributions,
  updateWantedStates,
} from '../../src/main/reconcile/sources'
import type { SpotifyLikedTrack } from '../../src/main/spotify/library'
import { Harness } from './harness'

function spotifyTrack(trackId = 'spotify-one'): SpotifyLikedTrack {
  return {
    trackId,
    title: 'A Song',
    artists: [{ id: 'artist', name: 'Test Artist' }],
    album: { id: 'album', name: 'Test Album' },
    trackNumber: 1,
    durationMs: 1000,
    addedAt: '2026-09-01T12:00:00.000Z',
    position: 0,
  }
}
const open: Harness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})
function harness() {
  const h = new Harness()
  open.push(h)
  return h
}
function check(
  h: Harness,
  items: SpotifyLikedTrack[],
  declaredCount = items.length,
  stillCurrent = () => true
) {
  return checkSpotifyLikedSongs({
    db: h.db,
    accountId: 'spotify-account',
    library: { likedSongs: async () => ({ tracks: items, declaredCount }) },
    stillCurrent,
    now: () => h.time,
  })
}
it('commits Spotify Liked Dates, deactivates unlikes, and preserves the last snapshot on failure or account changes', async () => {
  const h = harness()
  await check(h, [spotifyTrack()])
  linkContributions(h.db)
  expect(h.contributions()[0]).toMatchObject({
    kind: 'spotify_liked',
    sourceVideoId: null,
    sourceKey: 'spotify-liked:spotify-account:spotify-one',
    firstSeenAt: spotifyTrack().addedAt,
    active: true,
  })
  await expect(check(h, [], 100)).rejects.toThrow('keeping the previous list')
  await expect(check(h, [], 0, () => false)).rejects.toThrow('Account changed')
  expect(h.contributions()[0].active).toBe(true)
  await check(h, [], 0)
  expect(h.contributions()[0].active).toBe(false)
})
it('requires every configured liked source before marking tracks No Longer Wanted', async () => {
  const h = harness()
  await check(h, [spotifyTrack()])
  linkContributions(h.db)
  h.db.update(contributions).set({ active: false }).run()
  const options = {
    accountId: 'youtube-account',
    spotifyAccountId: 'spotify-account',
    fullDiscographyArtistIds: [],
  }
  updateWantedStates(h.db, options)
  expect(h.rows()[0].state).toBe('pending')
  h.db
    .insert(sourceSnapshots)
    .values({
      source: 'liked:youtube-account',
      status: 'failed',
      startedAt: 'now',
    })
    .run()
  updateWantedStates(h.db, options)
  expect(h.rows()[0].state).toBe('pending')
  h.db
    .update(sourceSnapshots)
    .set({ lastSuccessAt: 'now' })
    .where(eq(sourceSnapshots.source, 'liked:youtube-account'))
    .run()
  updateWantedStates(h.db, options)
  expect(h.rows()[0].state).toBe('no_longer_wanted')
  h.db.update(contributions).set({ active: true }).run()
  updateWantedStates(h.db, {
    ...options,
    spotifyAccountId: 'unchecked-account',
  })
  expect(h.db.select().from(tracks).get()?.state).toBe('pending')
})

it('shows Spotify source errors in Activity while keeping its last-seen contributions active after sign-out', async () => {
  const h = harness()
  let accountId: string | null = 'spotify-account'
  let failure: Error | null = null
  h.deps.spotify = {
    session: { accountId: () => accountId, generation: () => 0 },
    library: {
      likedSongs: async () => {
        if (failure) throw failure
        return { tracks: [spotifyTrack()], declaredCount: 1 }
      },
    },
  }
  await h.reconciler.check()
  const checkedAt = h.reconciler.activity().lastCheckedAt
  expect(checkedAt).toBeTruthy()
  failure = new Error('Spotify changed its API: missing library tracks')
  await h.reconciler.check()
  expect(h.reconciler.activity().needsAttention).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        title: 'Spotify liked songs check',
        reason: failure.message,
      }),
    ])
  )
  expect(
    h.contributions().find((row) => row.kind === 'spotify_liked')?.active
  ).toBe(true)
  accountId = null
  await h.reconciler.check()
  const errors = h.reconciler
    .activity()
    .needsAttention.filter((item) => item.kind === 'source')
  expect(errors).toHaveLength(1)
  expect(errors[0].reason).toContain('Not signed in to Spotify')
  expect(
    h.contributions().find((row) => row.kind === 'spotify_liked')?.active
  ).toBe(true)
  accountId = 'spotify-account'
  failure = null
  await h.reconciler.check()
  expect(
    h.reconciler
      .activity()
      .needsAttention.filter((item) => item.kind === 'source')
  ).toEqual([])
})
