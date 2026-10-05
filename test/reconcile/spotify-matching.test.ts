import { eq } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'
import { artists, contributions, tracks } from '../../src/main/library/schema'
import { SpotifyMatchError } from '../../src/main/match/resolve'
import {
  checkLikedSongs,
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
async function addSpotify(h: Harness, track = spotify) {
  await checkSpotifyLikedSongs({
    db: h.db,
    accountId: 'spotify-account',
    library: {
      likedSongs: async () => ({ tracks: [track], declaredCount: 1 }),
    },
    stillCurrent: () => true,
  })
  linkContributions(h.db)
}
const run = () => ({ signal: new AbortController().signal, progress: () => {} })

it('enriches the YouTube Music Match for a Spotify-only track', async () => {
  const h = harness()
  const album = release('album', song('audio', 'A Song'))
  const match = {
    ...releaseMatch(song('source', 'A Song'), album, 'audio'),
    sourceVideoId: null,
  }
  h.matcher.matches.set('spotify', match)
  const enrich = vi.spyOn(h.deps.matcher, 'enrich').mockResolvedValue({
    genre: 'Rock',
    isrc: 'USABC2600001',
    mbRecordingId: 'recording',
  })
  await addSpotify(h)
  await runMatch(h.deps, h.rows()[0], run())
  expect(enrich.mock.calls[0][0]).toEqual(match)
  expect(h.rows()[0]).toMatchObject({
    genre: 'Rock',
    isrc: 'USABC2600001',
    mbRecordingId: 'recording',
  })
})

it('joins the exact requested album among compatible existing Library matches', async () => {
  const h = harness()
  const other = song('other-like', 'A Song')
  const preferred = song('preferred-like', 'A Song')
  const otherAlbum = {
    ...release('other-album', song('other-audio', 'A Song')),
    title: `${spotify.album.name} Plus`,
  }
  const preferredAlbum = {
    ...release('preferred-album', song('preferred-audio', 'A Song')),
    title: spotify.album.name,
  }
  otherAlbum.tracks[0].durationSeconds = 1
  preferredAlbum.tracks[0].durationSeconds = 4
  h.catalog.likes = [other, preferred]
  h.matcher.matches.set(
    other.videoId,
    releaseMatch(other, otherAlbum, 'other-audio')
  )
  h.matcher.matches.set(
    preferred.videoId,
    releaseMatch(preferred, preferredAlbum, 'preferred-audio')
  )
  await h.start()
  await h.stop()
  const expected = h
    .rows()
    .find((row) => row.identityKey === 'preferred-album:preferred-audio')!
  h.db
    .update(tracks)
    .set({ durationSeconds: preferredAlbum.tracks[0].durationSeconds })
    .where(eq(tracks.id, expected.id))
    .run()
  h.db
    .update(tracks)
    .set({ durationSeconds: otherAlbum.tracks[0].durationSeconds })
    .where(eq(tracks.identityKey, 'other-album:other-audio'))
    .run()
  const calls = h.matcher.calls
  await addSpotify(h)
  await runMatch(h.deps, h.rows().find((row) => !row.identityKey)!, run())
  expect(h.matcher.calls).toBe(calls)
  expect(
    h.contributions().find((row) => row.kind === 'spotify_liked')?.trackId
  ).toBe(expected.id)
  expect(h.rows()).toHaveLength(2)
  expect(h.downloads).toHaveLength(2)
})

it('searches the catalog when different saved Recordings are equally plausible, then deduplicates by the proven video', async () => {
  const h = harness()
  const first = song('first', 'A Song')
  const second = song('second', 'A Song')
  const firstAlbum = {
    ...release('first-album', first),
    title: spotify.album.name,
  }
  const secondAlbum = {
    ...release('second-album', second),
    title: spotify.album.name,
  }
  h.catalog.likes = [first, second]
  h.matcher.matches.set('first', releaseMatch(first, firstAlbum))
  h.matcher.matches.set('second', releaseMatch(second, secondAlbum))
  await h.start()
  await h.stop()
  const expected = h
    .rows()
    .find((row) => row.identityKey === 'second-album:second')!
  const calls = h.matcher.calls
  h.matcher.matches.set('spotify', {
    ...releaseMatch(second, secondAlbum),
    sourceVideoId: null,
  })
  await addSpotify(h)
  await runMatch(h.deps, h.rows().find((row) => !row.identityKey)!, run())
  expect(h.matcher.calls).toBe(calls + 1)
  expect(
    h.contributions().find((row) => row.kind === 'spotify_liked')?.trackId
  ).toBe(expected.id)
  await h.start()
  expect(h.rows()).toHaveLength(2)
  expect(h.downloads).toHaveLength(2)
})

it.each([
  ['Home', 'Home Again'],
  ['Interlude', 'Interlude II'],
  ['Stay', 'Stay With Me'],
  ['Love', 'Love Song'],
  ['春', '春の歌'],
  ['A Song', 'A Song (Theme Music From Somewhere)'],
])('looks up %s instead of assigning its Spotify source ID to the saved song %s', async (title, other) => {
  const h = harness()
  const wrong = song('wrong', other)
  const album = { ...release('album', wrong), title: spotify.album.name }
  h.catalog.likes = [wrong]
  h.matcher.matches.set('wrong', releaseMatch(wrong, album))
  await h.start()
  await h.stop()
  const existing = h.rows()[0]
  const correct = song('correct', title)
  h.matcher.matches.set('spotify', {
    ...releaseMatch(correct, release('correct-album', correct)),
    sourceVideoId: null,
  })
  const calls = h.matcher.calls
  await addSpotify(h, { ...spotify, title })
  await runMatch(h.deps, h.rows().find((row) => !row.identityKey)!, run())
  expect(h.matcher.calls).toBe(calls + 1)
  expect(
    h.contributions().find((row) => row.kind === 'spotify_liked')?.trackId
  ).not.toBe(existing.id)
  expect(
    h.rows().find((row) => row.id === existing.id)?.spotifyTrackId
  ).toBeNull()
})

it('looks up Recording targets without parsing unrelated or unconfirmed Matches', async () => {
  const h = harness()
  const like = song('youtube-like', 'A Song')
  const targetAlbum = release('target-album', song('audio', 'A Song'))
  const target = {
    ...releaseMatch(like, targetAlbum, 'audio'),
    confirmed: true,
  }
  const unrelated = JSON.stringify({
    ...target,
    catalogVideoId: 'unrelated-audio',
    identityKey: 'unrelated:unrelated-audio',
  })
  const unconfirmed = JSON.stringify({
    ...target,
    confirmed: false,
    identityKey: 'unconfirmed:audio',
  })
  for (const [id, match] of [
    ['unrelated', unrelated],
    ['unconfirmed', unconfirmed],
    ['target', JSON.stringify(target)],
  ])
    h.db
      .insert(tracks)
      .values({
        id,
        title: 'A Song',
        match,
        createdAt: 'now',
        updatedAt: 'now',
        identityKey: id === 'target' ? target.identityKey : null,
      })
      .run()
  h.catalog.likes = [like]
  await checkLikedSongs({
    db: h.db,
    catalog: h.catalog,
    accountId: 'account-a',
    stillCurrent: () => true,
  })
  linkContributions(h.db)
  const provisional = h
    .rows()
    .find((row) => !['unrelated', 'unconfirmed', 'target'].includes(row.id))!
  const single = release('single', song('audio', 'A Song'))
  h.matcher.matches.set(like.videoId, releaseMatch(like, single, 'audio'))
  const parse = vi.spyOn(JSON, 'parse')
  try {
    await runMatch(h.deps, provisional, run())
    expect(
      parse.mock.calls.some(
        ([value]) => value === unrelated || value === unconfirmed
      )
    ).toBe(false)
  } finally {
    parse.mockRestore()
  }
  expect(h.contributions()[0].trackId).toBe('target')
  expect(h.rows().find((row) => row.id === 'target')?.identityKey).toBe(
    target.identityKey
  )
})

it.each([
  ['Live Through This', 'Single'],
  ['Single', 'Live Through This'],
])('joins a Spotify studio like across Releases named %s and %s', async (youtubeAlbum, spotifyAlbum) => {
  const h = harness()
  const like = song('youtube-like', 'A Song')
  const album = {
    ...release('youtube-album', song('audio', 'A Song')),
    title: youtubeAlbum,
  }
  h.catalog.likes = [like]
  h.matcher.matches.set(like.videoId, releaseMatch(like, album, 'audio'))
  await h.start()
  await h.stop()
  const calls = h.matcher.calls
  await addSpotify(h, {
    ...spotify,
    album: { ...spotify.album, name: spotifyAlbum },
  })
  await runMatch(h.deps, h.rows().find((row) => !row.identityKey)!, run())
  expect(h.matcher.calls).toBe(calls)
  expect(h.rows()).toHaveLength(1)
  expect(h.downloads).toEqual(['audio'])
})

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

it('joins an existing liked recording through its stored native artist name without matching or downloading again', async () => {
  const h = harness()
  const like = {
    ...song('youtube-like', 'Reverb'),
    artists: [{ ...credit, name: 'Suichu Spica' }],
  }
  const audio = { ...song('audio', 'Reverb'), artists: like.artists }
  const album = { ...release('youtube-album', audio), artists: like.artists }
  h.catalog.likes = [like]
  h.matcher.matches.set(like.videoId, releaseMatch(like, album, 'audio'))
  await h.start()
  await h.stop()
  h.db
    .update(artists)
    .set({ nativeName: '水中スピカ' })
    .where(eq(artists.channelId, credit.channelId!))
    .run()
  const calls = h.matcher.calls
  await addSpotify(h, {
    ...spotify,
    title: 'Reverb',
    artists: [{ id: 'artist', name: '水中スピカ' }],
  })
  await runMatch(h.deps, h.rows().find((row) => !row.identityKey)!, run())
  expect(h.matcher.calls).toBe(calls)
  expect(h.rows()).toHaveLength(1)
  expect(h.downloads).toEqual(['audio'])
  expect(new Set(h.contributions().map((row) => row.trackId)).size).toBe(1)
})

it.each([
  false,
  true,
])('upgrades an existing Standalone Recording while respecting a released exact identity: %s', async (released) => {
  const h = harness()
  const like = song('audio', 'A Song')
  h.catalog.likes = [like]
  await h.start()
  await h.stop()
  const existing = h.rows()[0]
  expect(JSON.parse(existing.match!).release).toBeNull()
  const album = release('album', like)
  const match = { ...releaseMatch(like, album, 'audio'), sourceVideoId: null }
  if (released)
    h.db
      .insert(tracks)
      .values({
        id: 'released',
        title: 'A Song',
        identityKey: match.identityKey,
        match: JSON.stringify({ ...match, confirmed: true }),
        state: 'released',
        createdAt: 'now',
        updatedAt: 'now',
      })
      .run()
  h.matcher.matches.set('spotify', match)
  await addSpotify(h)
  const outcome = await runMatch(
    h.deps,
    h.rows().find((row) => !row.identityKey)!,
    run()
  )
  if (released) {
    expect(h.rows().find((row) => row.id === 'released')?.state).toBe(
      'released'
    )
    expect(
      h.contributions().find((row) => row.kind === 'spotify_liked')?.trackId
    ).toBe('released')
    expect(h.rows().find((row) => row.id === existing.id)?.identityKey).toBe(
      existing.identityKey
    )
    expect(h.downloads).toEqual(['audio'])
    return
  }
  expect(outcome.trackId).toBe(existing.id)
  expect(h.rows()).toHaveLength(1)
  expect(h.rows()[0]).toMatchObject({
    id: existing.id,
    identityKey: match.identityKey,
    album: album.title,
    releaseId: album.browseId,
    trackNumber: 1,
  })
  expect(JSON.parse(h.rows()[0].match!)).toMatchObject({
    release: { browseId: album.browseId },
    confirmed: true,
  })
  expect(new Set(h.contributions().map((row) => row.trackId))).toEqual(
    new Set([existing.id])
  )
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
    'Several compatible YouTube Music Release Tracks found'
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

it('an inactive Spotify contribution does not force its old ID onto a refreshed catalog Recording', async () => {
  const h = harness()
  h.account = null
  const original = release('original', song('old-audio', 'A Song'))
  h.matcher.matches.set('spotify', {
    ...releaseMatch(song('source', 'A Song'), original, 'old-audio'),
    sourceVideoId: null,
  })
  await addSpotify(h)
  await h.start()
  await h.stop()
  const track = h.rows()[0]
  h.db
    .update(contributions)
    .set({ active: false })
    .where(eq(contributions.kind, 'spotify_liked'))
    .run()
  const replacement = release(
    'new-release',
    song('new-audio', 'Another Recording')
  )
  h.catalog.releases.set(replacement.browseId, replacement)
  h.db
    .insert(contributions)
    .values({
      id: 'catalog',
      sourceKey: 'catalog:artist:new-release:new-audio',
      kind: 'catalog',
      trackId: track.id,
      sourceVideoId: 'new-audio',
      releaseId: replacement.browseId,
      firstSeenAt: 'now',
      lastSeenAt: 'now',
      raw: JSON.stringify({
        kind: 'catalog',
        artistId: 'artist',
        release: replacement,
        track: replacement.tracks[0],
      }),
    })
    .run()
  const lyrics = vi.spyOn(h.deps.lyrics, 'find').mockResolvedValue({
    lyrics: null,
    spotifyTrackId: 'new-lyrics-guess',
    errors: {},
  })
  await runMatch(h.deps, h.rows()[0], run())
  expect(lyrics.mock.calls[0][0]).toMatchObject({
    spotifyTrackId: null,
    spotifyLiked: false,
  })
  expect(h.rows()[0].spotifyTrackId).toBe('new-lyrics-guess')
})
