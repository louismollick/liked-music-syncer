import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { files, tracks } from '../../src/main/library/schema'
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

const mbGenre = (genre: string | null) => ({
  mbRecordingId: null,
  genre,
  isrc: null,
})
const run = () => ({ signal: new AbortController().signal, progress: () => {} })

describe('Last.fm genre fallback', () => {
  it('asks Last.fm for the primary artist only when MusicBrainz has no genre', async () => {
    const h = harness()
    h.catalog.likes = [song('empty', 'empty', 0), song('mb', 'mb', 1)]
    h.matcher.genres.set('Test Artist', 'j-rock; math rock')
    vi.spyOn(h.deps.matcher, 'enrich').mockImplementation(async (match) =>
      mbGenre(match.title === 'mb' ? 'shoegaze' : null)
    )
    await h.start()
    const byTitle = Object.fromEntries(h.rows().map((row) => [row.title, row]))
    expect(byTitle.empty.genre).toBe('j-rock; math rock')
    expect(byTitle.mb.genre).toBe('shoegaze')
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
    vi.spyOn(h.deps.matcher, 'enrich').mockResolvedValue(mbGenre(null))
    h.reconciler.refresh({ kind: 'all' })
    await h.idle()
    expect(h.rows()[0].genre).toBe('rock')
    expect(JSON.parse(h.rows()[0].enrichmentErrors).lastfm).toContain('29')
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

  it('keeps a genre MusicBrainz supplied meanwhile', async () => {
    const h = harness()
    h.catalog.likes = [song('track')]
    h.settings.lastfmApiKey = ''
    await h.start()
    h.settings.lastfmApiKey = 'key'
    h.matcher.genres.set('Test Artist', 'pop')
    h.db.update(tracks).set({ genreRequested: true }).run()
    const stale = h.rows()[0]
    h.db.update(tracks).set({ genre: 'jazz' }).run()
    await runGenre(h.deps, stale, run())
    expect(h.rows()[0]).toMatchObject({ genre: 'jazz', genreRequested: false })
  })
})
