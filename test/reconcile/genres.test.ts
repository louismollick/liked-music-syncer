import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { artists, files, tracks } from '../../src/main/library/schema'
import { nextStep, runGenre } from '../../src/main/reconcile/steps'
import { readTags } from '../../src/main/tags/schema'
import { Harness, song } from './harness'

const open: Harness[] = []
function harness() {
  const h = new Harness()
  h.settings.lyricsEnabled = false
  h.settings.lastfmApiKey = 'key'
  open.push(h)
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

const run = () => ({ signal: new AbortController().signal, progress: () => {} })

describe('Last.fm genres', () => {
  it('asks Last.fm for the primary artist when a track is acquired', async () => {
    const h = harness()
    h.catalog.likes = [song('track')]
    h.matcher.genres.set('Test Artist', 'j-rock; math rock')
    await h.start()
    expect(h.rows()[0].genre).toBe('j-rock; math rock')
    expect(h.matcher.genreCalls).toEqual(['Test Artist'])
  })

  it('stays off without a key and keeps an existing genre when Last.fm fails', async () => {
    const h = harness()
    h.settings.lastfmApiKey = ''
    h.catalog.likes = [song('track')]
    await h.start()
    expect(h.matcher.genreCalls).toEqual([])
    expect(h.rows()[0].genre).toBeNull()

    h.settings.lastfmApiKey = 'key'
    h.matcher.genreError = new Error('Last.fm error 29')
    h.db.update(tracks).set({ genre: 'rock' }).run()
    h.reconciler.refresh({ kind: 'all' })
    await h.idle()
    expect(h.rows()[0].genre).toBe('rock')
    expect(JSON.parse(h.rows()[0].enrichmentErrors).lastfm).toContain('29')
  })
})

describe('Last.fm artist identity', () => {
  it('passes the trusted artist ID along with the name', async () => {
    const h = harness()
    h.catalog.likes = [song('track')]
    const genre = vi.spyOn(h.matcher, 'genre')
    await h.start()
    expect(genre).toHaveBeenCalledWith(
      { id: 'channel:artist-1', name: 'Test Artist' },
      'key',
      expect.anything()
    )
  })

  it('skips an Unidentified Artist, which has a name but no trusted ID', async () => {
    const h = harness()
    h.matcher.genres.set('Nameless', 'rock')
    h.catalog.likes = [
      {
        ...song('track'),
        artists: [{ name: 'Nameless', channelId: null }],
      },
    ]
    await h.start()
    expect(h.matcher.genreCalls).toEqual([])
    expect(h.rows()[0].genre).toBeNull()
  })

  it('skips a name that two different artists share in the library', async () => {
    const h = harness()
    h.matcher.genres.set('Test Artist', 'rock')
    // Another artist with the same name, up to case, already in the library.
    h.db
      .insert(artists)
      .values({
        id: 'channel:artist-2',
        name: 'TEST ARTIST',
        channelId: 'artist-2',
      })
      .run()
    h.catalog.likes = [song('track')]
    await h.start()
    expect(h.matcher.genreCalls).toEqual([])
    expect(h.rows()[0].genre).toBeNull()
  })
})

describe('Look up missing genres', () => {
  it('marks only tracks with an empty genre', async () => {
    const h = harness()
    h.settings.lastfmApiKey = ''
    h.catalog.likes = [song('a', 'a', 0), song('b', 'b', 1), song('c', 'c', 2)]
    await h.start()
    const [a, b, c] = ['a', 'b', 'c'].map(
      (title) => h.rows().find((row) => row.title === title)!.id
    )
    h.db.update(tracks).set({ genre: 'rock' }).where(eq(tracks.id, a)).run()
    h.db.update(tracks).set({ genre: '' }).where(eq(tracks.id, b)).run()
    h.reconciler.recheckGenres()
    const marked = (id: string) =>
      h.rows().find((row) => row.id === id)?.genreRequested
    expect([marked(a), marked(b), marked(c)]).toEqual([false, true, true])
  })

  it('looks up a genre before the track is retagged and uploaded', async () => {
    const h = harness()
    h.settings.remoteEnabled = true
    h.catalog.likes = [song('track')]
    h.settings.lastfmApiKey = ''
    await h.start()
    const before = h.rows()[0]
    expect(before.genre).toBeNull()
    const uploaded = h.upload(before.id)!

    // The planner puts the genre step ahead of the rewrite and the upload.
    // A stale file would need a rewrite and a new upload either way.
    h.db.update(files).set({ tagFields: '{}' }).run()
    h.settings.lastfmApiKey = 'key'
    h.matcher.genres.set('Test Artist', 'indie rock')
    h.reconciler.recheckGenres()
    const marked = h.rows()[0]
    expect(
      nextStep(h.db, marked, h.file(marked.id), uploaded, h.settings)
    ).toBe('genre')
    expect(
      nextStep(
        h.db,
        marked,
        h.file(marked.id),
        uploaded,
        h.settings,
        new Set([`genre:${marked.id}`])
      )
    ).toBe('retag')

    await h.idle()
    const after = h.rows()[0]
    expect(after).toMatchObject({ genre: 'indie rock', genreRequested: false })
    expect(h.matcher.genreCalls).toEqual(['Test Artist'])
    const relative = h.file(after.id)!.relativePath
    for (const root of [h.library, h.remote])
      expect(readTags(path.join(root, relative)).fields.genre).toBe(
        'indie rock'
      )
    expect(h.upload(after.id)?.localSha256).toBe(
      h.file(after.id)?.contentSha256
    )
    // One request per run, and no repeat once answered.
    await h.check()
    expect(h.matcher.genreCalls).toHaveLength(1)
  })

  it('does not mark a clean miss for another try, but retries a failure on the next check', async () => {
    const h = harness()
    h.catalog.likes = [song('track')]
    h.settings.lastfmApiKey = ''
    await h.start()
    h.settings.lastfmApiKey = 'key'
    h.matcher.genreError = new Error('down')
    h.reconciler.recheckGenres()
    await h.idle()
    expect(h.matcher.genreCalls).toHaveLength(1)
    expect(h.rows()[0].genreRequested).toBe(true)
    expect(JSON.parse(h.rows()[0].enrichmentErrors).lastfm).toBe('down')

    h.matcher.genreError = null
    await h.check()
    expect(h.matcher.genreCalls).toHaveLength(2)
    expect(h.rows()[0]).toMatchObject({ genre: null, genreRequested: false })
    expect(JSON.parse(h.rows()[0].enrichmentErrors).lastfm).toBeUndefined()
  })

  it('waits for the network instead of failing the lookup, then asks once it is back', async () => {
    const h = new Harness({ probeBackoffMs: [30, 30] })
    open.push(h)
    h.settings.lyricsEnabled = false
    h.settings.lastfmApiKey = ''
    h.catalog.likes = [song('track')]
    await h.start()
    h.settings.lastfmApiKey = 'key'
    h.matcher.genres.set('Test Artist', 'indie rock')
    h.matcher.genreError = new Error('lastfm: fetch failed (ENOTFOUND)')
    h.reconciler.recheckGenres()
    const end = Date.now() + 10_000
    while (
      !h.reconciler.activity().offline ||
      h.matcher.genreCalls.length < 2
    ) {
      if (Date.now() > end) throw new Error('Timed out waiting for offline')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // The lane waits; the track keeps its retries and its mark.
    expect(h.rows()[0]).toMatchObject({
      state: 'pending',
      attempts: 0,
      genreRequested: true,
    })
    expect(JSON.parse(h.rows()[0].enrichmentErrors).lastfm).toBeUndefined()

    h.matcher.genreError = null
    await h.idle()
    expect(h.reconciler.activity().offline).toBe(false)
    expect(h.rows()[0]).toMatchObject({
      genre: 'indie rock',
      genreRequested: false,
    })
  })

  it('replaces an existing genre after a successful lookup, and clears it on a clean miss', async () => {
    const h = harness()
    h.catalog.likes = [song('track')]
    h.settings.lastfmApiKey = ''
    await h.start()
    h.settings.lastfmApiKey = 'key'
    h.matcher.genres.set('Test Artist', 'pop')
    h.db.update(tracks).set({ genre: 'jazz', genreRequested: true }).run()
    await runGenre(h.deps, h.rows()[0], run())
    expect(h.rows()[0]).toMatchObject({ genre: 'pop', genreRequested: false })

    h.matcher.genres.clear()
    h.db.update(tracks).set({ genreRequested: true }).run()
    await runGenre(h.deps, h.rows()[0], run())
    expect(h.rows()[0]).toMatchObject({ genre: null, genreRequested: false })
  })

  it('keeps an existing genre when the lookup fails', async () => {
    const h = harness()
    h.catalog.likes = [song('track')]
    h.settings.lastfmApiKey = ''
    await h.start()
    h.settings.lastfmApiKey = 'key'
    h.matcher.genreError = new Error('down')
    h.db.update(tracks).set({ genre: 'jazz', genreRequested: true }).run()
    expect(await runGenre(h.deps, h.rows()[0], run())).toBe(false)
    expect(h.rows()[0]).toMatchObject({ genre: 'jazz', genreRequested: true })
  })
})

describe('retiring MusicBrainz tags', () => {
  it('retags a file whose record still has an ISRC or MusicBrainz ID, but not one with nulls', async () => {
    const h = harness()
    h.catalog.likes = [song('track')]
    await h.start()
    const track = h.rows()[0]
    const file = h.file(track.id)!
    const stepFor = (extra: Record<string, unknown>) =>
      nextStep(
        h.db,
        track,
        {
          ...file,
          tagFields: JSON.stringify({
            ...JSON.parse(file.tagFields),
            ...extra,
          }),
        },
        h.upload(track.id),
        h.settings
      )
    expect(stepFor({})).toBeNull()
    expect(stepFor({ isrc: null, mbRecordingId: null })).toBeNull()
    expect(stepFor({ isrc: 'USABC2600001' })).toBe('retag')
    expect(stepFor({ mbRecordingId: 'recording' })).toBe('retag')
  })
})
