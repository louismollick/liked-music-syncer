import { eq } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'
import { artists, contributions } from '../../src/main/library/schema'
import { SpotifyMatchError } from '../../src/main/match/resolve'
import {
  checkSpotifyLikedSongs,
  linkContributions,
} from '../../src/main/reconcile/sources'
import { runMatch } from '../../src/main/reconcile/steps'
import type { SpotifyLikedTrack } from '../../src/main/spotify/library'
import { credit, Harness, release, releaseMatch, song } from './harness'

const open: Harness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})
function harness() {
  const h = new Harness()
  h.settings.remoteEnabled = false
  open.push(h)
  return h
}
const spotify: SpotifyLikedTrack = {
  trackId: 'spotify',
  title: 'A Song',
  artists: [{ id: 'artist', name: credit.name }],
  album: { id: 'spotify-single', name: 'Spotify Single' },
  durationMs: 1000,
  trackNumber: 1,
  addedAt: '2026-09-01T00:00:00Z',
  position: 0,
}
async function addSpotify(h: Harness) {
  await checkSpotifyLikedSongs({
    db: h.db,
    accountId: 'spotify-account',
    library: {
      likedSongs: async () => ({ tracks: [spotify], declaredCount: 1 }),
    },
    stillCurrent: () => true,
  })
  linkContributions(h.db)
}
const run = () => ({ signal: new AbortController().signal, progress: () => {} })

it('joins a Spotify like to an existing YouTube-liked Recording on a different Release without another match or download', async () => {
  const h = harness()
  const like = song('youtube-like', 'A Song')
  const album = release('youtube-album', song('audio', 'A Song'))
  h.catalog.likes = [like]
  h.matcher.matches.set(like.videoId, releaseMatch(like, album, 'audio'))
  await h.start()
  await h.stop()
  const existing = h.rows()[0]
  await addSpotify(h)
  const lyrics = vi.spyOn(h.deps.lyrics, 'find')
  const provisional = h.rows().find((row) => !row.identityKey)!
  const calls = h.matcher.calls
  await runMatch(h.deps, provisional, run())
  expect(h.matcher.calls).toBe(calls)
  expect(h.rows()).toHaveLength(1)
  expect(h.rows()[0]).toMatchObject({
    id: existing.id,
    identityKey: 'youtube-album:audio',
    spotifyTrackId: 'spotify',
  })
  expect(new Set(h.contributions().map((row) => row.trackId))).toEqual(
    new Set([existing.id])
  )
  expect(lyrics.mock.calls[0][0]).toMatchObject({
    spotifyTrackId: 'spotify',
    spotifyLiked: true,
  })
  await h.start()
  expect(h.downloads).toEqual(['audio'])
})
it('applies the same Recording rule to YouTube likes while catalogs keep strict Release identities', async () => {
  const h = harness()
  const album = release('album', song('audio', 'A Song'))
  const single = {
    ...release('single', song('audio', 'A Song')),
    title: 'Single',
  }
  h.catalog.releases.set(album.browseId, album)
  h.catalog.releases.set(single.browseId, single)
  h.catalog.refs = [album, single].map((item) => ({
    browseId: item.browseId,
    title: item.title,
    shelf: 'albums' as const,
    year: 2024,
    thumbnailUrl: null,
  }))
  h.db
    .insert(artists)
    .values({
      id: 'channel:artist-1',
      name: credit.name,
      channelId: credit.channelId,
      fullDiscography: true,
    })
    .run()
  await h.start()
  expect(
    h
      .rows()
      .map((row) => row.identityKey)
      .sort()
  ).toEqual(['album:audio', 'single:audio'])
  h.catalog.likes = [song('liked-single', 'A Song')]
  h.matcher.matches.set(
    'liked-single',
    releaseMatch(
      h.catalog.likes[0],
      { ...single, browseId: 'another-single' },
      'audio'
    )
  )
  await h.check()
  expect(h.rows()).toHaveLength(2)
  const like = h.contributions().find((row) => row.kind === 'liked')!
  expect(h.rows().find((row) => row.id === like.trackId)?.identityKey).toBe(
    'album:audio'
  )
  expect(h.downloads).toHaveLength(2)
})
it('puts runner-up ambiguity in Needs Attention', async () => {
  const h = harness()
  h.deps.spotify = {
    session: { accountId: () => 'spotify-account', generation: () => 0 },
    library: {
      likedSongs: async () => ({ tracks: [spotify], declaredCount: 1 }),
    },
  }
  h.matcher.error = new SpotifyMatchError('ambiguous')
  await h.start()
  expect(h.rows()[0]).toMatchObject({
    state: 'needs_attention',
    lastErrorKind: 'permanent',
  })
  expect(h.reconciler.activity().needsAttention[0].reason).toContain(
    'Not found on YouTube Music (ambiguous'
  )
  expect(h.downloads).toEqual([])
})
it('Refresh chooses active catalog, YouTube like, Spotify like, then inactive sources in the same order', async () => {
  const h = harness()
  const like = song('youtube', 'A Song')
  const album = release('album', song('audio', 'A Song'))
  h.catalog.likes = [like]
  h.catalog.releases.set(album.browseId, album)
  h.matcher.matches.set('youtube', releaseMatch(like, album, 'audio'))
  await h.start()
  await h.stop()
  const track = h.rows()[0]
  await addSpotify(h)
  await runMatch(h.deps, h.rows().find((row) => !row.identityKey)!, run())
  h.db
    .insert(contributions)
    .values({
      id: 'catalog',
      sourceKey: 'catalog:artist:album:audio',
      kind: 'catalog',
      trackId: track.id,
      sourceVideoId: 'audio',
      releaseId: album.browseId,
      firstSeenAt: 'now',
      lastSeenAt: 'now',
      raw: JSON.stringify({
        kind: 'catalog',
        artistId: 'artist',
        release: album,
        track: album.tracks[0],
      }),
    })
    .run()
  const chosen: string[] = []
  h.matcher.during = (input) => {
    chosen.push(input.kind)
  }
  await runMatch(h.deps, h.rows()[0], run())
  h.db
    .update(contributions)
    .set({ active: false })
    .where(eq(contributions.kind, 'catalog'))
    .run()
  await runMatch(h.deps, h.rows()[0], run())
  h.db
    .update(contributions)
    .set({ active: false })
    .where(eq(contributions.kind, 'liked'))
    .run()
  h.matcher.matches.set('spotify', releaseMatch(like, album, 'audio'))
  await runMatch(h.deps, h.rows()[0], run())
  h.db.update(contributions).set({ active: false }).run()
  await runMatch(h.deps, h.rows()[0], run())
  expect(chosen).toEqual(['catalog', 'liked', 'spotify', 'catalog'])
})

it('Spotify-only Refresh looks up its Match again instead of accepting its own saved Match', async () => {
  const h = harness()
  const album = release('album', song('audio', 'A Song'))
  const replacement = release('replacement', song('new-audio', 'A Song'))
  h.matcher.matches.set('spotify', {
    ...releaseMatch(song('source', 'A Song'), album, 'audio'),
    sourceVideoId: null,
  })
  await addSpotify(h)
  await h.start()
  await h.stop()
  const before = h.matcher.calls
  h.matcher.matches.set('spotify', {
    ...releaseMatch(song('source', 'A Song'), replacement, 'new-audio'),
    sourceVideoId: null,
  })
  h.reconciler.refresh({ kind: 'track', id: h.rows()[0].id })
  await h.start()
  expect(h.matcher.calls).toBe(before + 1)
  expect(h.rows()[0].identityKey).toBe('replacement:new-audio')
})
