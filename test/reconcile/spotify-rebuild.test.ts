import { cpSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { adoptFiles } from '../../src/main/inventory/inventory'
import {
  checkSpotifyLikedSongs,
  claimAdoptedFiles,
  linkContributions,
} from '../../src/main/reconcile/sources'
import type { SpotifyLikedTrack } from '../../src/main/spotify/library'
import { readTags } from '../../src/main/tags/schema'
import { Harness, release, releaseMatch, song } from './harness'

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
  trackId: 'spotify-liked',
  title: 'A Song',
  artists: [{ id: 'artist', name: 'Test Artist' }],
  album: { id: 'spotify-album', name: 'Test Album' },
  durationMs: 1000,
  trackNumber: 1,
  addedAt: '2026-09-01T00:00:00Z',
  position: 0,
}
function spotifySource(h: Harness) {
  h.deps.spotify = {
    session: { accountId: () => 'spotify-account', generation: () => 0 },
    library: {
      likedSongs: async () => ({ tracks: [spotify], declaredCount: 1 }),
    },
  }
}
function tags(h: Harness) {
  const row = h.rows()[0]
  return readTags(path.join(h.library, h.file(row.id)!.relativePath)).fields.lms
}
async function spotifyBuilt() {
  const h = harness()
  h.account = null
  spotifySource(h)
  const album = release('album', song('audio', 'A Song'))
  h.matcher.matches.set(spotify.trackId, {
    ...releaseMatch(song('unused', 'A Song'), album, 'audio'),
    sourceVideoId: null,
    resolutionMethod: 'spotify_album',
  })
  await h.start()
  await h.stop()
  return h
}
it.each([
  false,
  true,
])('a Spotify like claims its confirmed restored file without matching or downloading, likes checked before adoption: %s', async (before) => {
  const source = await spotifyBuilt()
  expect(tags(source)).toMatchObject({
    schemaVersion: 8,
    sourceVideoId: null,
    spotifyTrackId: spotify.trackId,
    sourceOrigin: 'spotify_liked',
    matchConfirmed: true,
  })
  const h = harness()
  h.account = null
  cpSync(source.library, h.library, { recursive: true })
  spotifySource(h)
  if (before) {
    await checkSpotifyLikedSongs({
      db: h.db,
      accountId: 'spotify-account',
      library: h.deps.spotify!.library,
      stillCurrent: () => true,
    })
    linkContributions(h.db)
    await adoptFiles(
      {
        db: h.db,
        coversDir: path.join(h.userData, 'covers'),
        now: () => h.time,
      },
      h.library
    )
    expect(claimAdoptedFiles(h.db)).toBe(1)
  }
  await h.start()
  expect(h.rows()).toHaveLength(1)
  expect(h.rows()[0]).toMatchObject({
    identityKey: 'album:audio',
    adopted: false,
    state: 'done',
  })
  expect(h.matcher.calls).toBe(0)
  expect(h.downloads).toEqual([])
  expect(h.contributions()[0].trackId).toBe(h.rows()[0].id)
})
it('records both platform source IDs and lets both likes claim one restored Recording', async () => {
  const source = harness()
  const youtube = song('youtube-liked', 'A Song')
  const album = release('album', song('audio', 'A Song'))
  source.catalog.likes = [youtube]
  source.matcher.matches.set(
    youtube.videoId,
    releaseMatch(youtube, album, 'audio')
  )
  spotifySource(source)
  await source.start()
  await source.stop()
  expect(tags(source)).toMatchObject({
    sourceVideoId: 'youtube-liked',
    spotifyTrackId: spotify.trackId,
    sourceOrigin: 'youtube_music_and_spotify_liked',
  })
  const h = harness()
  cpSync(source.library, h.library, { recursive: true })
  h.catalog.likes = [youtube]
  spotifySource(h)
  await h.start()
  expect(h.rows()).toHaveLength(1)
  expect(h.contributions()).toHaveLength(2)
  expect(new Set(h.contributions().map((row) => row.trackId))).toEqual(
    new Set([h.rows()[0].id])
  )
  expect(h.matcher.calls).toBe(0)
  expect(h.downloads).toEqual([])
})
it('does not treat a lyrics-search Spotify ID as a liked source during rebuild', async () => {
  const source = harness()
  const youtube = song('youtube-liked', 'A Song')
  const album = release('album', song('audio', 'A Song'))
  source.catalog.likes = [youtube]
  source.matcher.matches.set(
    youtube.videoId,
    releaseMatch(youtube, album, 'audio')
  )
  source.deps.lyrics.find = async () => ({
    lyrics: null,
    spotifyTrackId: spotify.trackId,
    errors: {},
  })
  await source.start()
  await source.stop()
  expect(tags(source)).toMatchObject({
    spotifyTrackId: spotify.trackId,
    sourceOrigin: 'youtube_music_liked',
  })
  const h = harness()
  cpSync(source.library, h.library, { recursive: true })
  await adoptFiles(
    { db: h.db, coversDir: path.join(h.userData, 'covers'), now: () => h.time },
    h.library
  )
  spotifySource(h)
  await checkSpotifyLikedSongs({
    db: h.db,
    accountId: 'spotify-account',
    library: h.deps.spotify!.library,
    stillCurrent: () => true,
  })
  linkContributions(h.db)
  expect(claimAdoptedFiles(h.db)).toBe(0)
  expect(h.rows()).toHaveLength(2)
  expect(h.rows().find((row) => row.identityKey)?.adopted).toBe(true)
})
