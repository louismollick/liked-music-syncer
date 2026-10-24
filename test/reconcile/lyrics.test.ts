import { readFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stageForStep } from '../../src/main/domain'
import { artists, files, tracks } from '../../src/main/library/schema'
import { createLyricsFinder } from '../../src/main/lyrics/finder'
import { isConnectivityError } from '../../src/main/net/connectivity'
import { createHttpClient, HttpError } from '../../src/main/net/http'
import { nextStep, runLyrics, runMatch } from '../../src/main/reconcile/steps'
import { readTags } from '../../src/main/tags/schema'
import { Harness, song } from './harness'

const open: Harness[] = []
function harness() {
  const h = new Harness()
  h.settings.remoteEnabled = false
  open.push(h)
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})
const run = () => ({ signal: new AbortController().signal, progress: () => {} })

async function seed(h: Harness, id: string, status = 'none') {
  const match = {
    ...(await h.matcher.match({ kind: 'liked', song: song(id) })),
    confirmed: true as const,
    durationSeconds: null,
    lyricsBrowseId: 'MPLYlyrics',
  }
  h.db
    .insert(artists)
    .values({
      id: 'channel:artist-1',
      name: 'Test Artist',
      nativeName: '日本名',
      channelId: 'artist-1',
      pageCheckedAt: h.time.toISOString(),
    })
    .onConflictDoNothing()
    .run()
  h.db
    .insert(tracks)
    .values({
      id,
      identityKey: match.identityKey,
      title: match.title,
      artistCredits: JSON.stringify(match.artists),
      artist: 'Test Artist',
      album: match.album,
      albumArtist: match.albumArtist,
      durationSeconds: 123.5,
      match: JSON.stringify(match),
      lyricsStatus: status,
      lyricsText: status === 'none' ? null : 'Stored lyrics',
      lyricsSource: status === 'none' ? null : 'spotify',
      spotifyTrackId: 'saved',
      createdAt: h.time.toISOString(),
      updatedAt: h.time.toISOString(),
    })
    .run()
  return { match, track: h.row(match.identityKey)! }
}

function file(h: Harness, id: string) {
  h.db
    .insert(files)
    .values({
      trackId: id,
      relativePath: `${id}.m4a`,
      audioVideoId: id,
      size: 1,
      mtimeMs: 1,
      contentSha256: id,
      tagFields: '{}',
      writtenAt: h.time.toISOString(),
    })
    .run()
  return h.file(id)!
}

describe('lyrics-only work', () => {
  it.each([
    'miss',
    'error',
    'throw',
    'instrumental',
  ])('records %s and lets retag continue', async (outcome) => {
    const h = harness()
    const { track } = await seed(h, 'track')
    if (outcome === 'instrumental') {
      const match = { ...JSON.parse(track.match!), title: 'Track（Inst.）' }
      h.db
        .update(tracks)
        .set({ title: match.title, match: JSON.stringify(match) })
        .where(eq(tracks.id, track.id))
        .run()
    }
    h.db
      .update(tracks)
      .set({
        enrichmentErrors: JSON.stringify({
          cover: 'keep',
          'lyrics:spotify': 'old',
        }),
      })
      .where(eq(tracks.id, track.id))
      .run()
    const find = vi
      .spyOn(h.deps.lyrics, 'find')
      .mockImplementation(async () => {
        if (outcome === 'throw') throw new Error('unexpected failure')
        return {
          lyrics: null,
          spotifyTrackId: null,
          errors: outcome === 'error' ? { spotify: 'unavailable' } : {},
        }
      })
    const current = h.rows()[0]
    const f = file(h, track.id)
    expect(nextStep(h.db, current, f, undefined, h.settings)).toBe('lyrics')
    const failed = outcome === 'error' || outcome === 'throw'
    expect(await runLyrics(h.deps, current, run())).toBe(!failed)
    const after = h.rows()[0]
    // A provider failure with nothing found stays unchecked for the next pass.
    expect(after.lyricsCheckedAt).toBe(failed ? null : h.time.toISOString())
    const deferred = new Set([`lyrics:${track.id}`])
    expect(nextStep(h.db, after, f, undefined, h.settings, deferred)).toBe(
      'retag'
    )
    expect(nextStep(h.db, after, f, undefined, h.settings)).toBe(
      failed ? 'lyrics' : 'retag'
    )
    expect(JSON.parse(after.enrichmentErrors)).toEqual({
      cover: 'keep',
      ...(outcome === 'error'
        ? { 'lyrics:spotify': 'unavailable' }
        : outcome === 'throw'
          ? { 'lyrics:lookup': 'unexpected failure' }
          : {}),
    })
    if (outcome === 'instrumental') expect(find).not.toHaveBeenCalled()
    else
      expect(find.mock.calls[0][0]).toMatchObject({
        durationSeconds: 123.5,
        artistVariants: ['Test Artist', '日本名'],
      })
    expect(stageForStep('lyrics')).toBe('lyrics')
  })

  it('preserves synced lyrics when every provider fails or misses', async () => {
    const h = harness()
    const { track } = await seed(h, 'track', 'synced')
    vi.spyOn(h.deps.catalog, 'lyrics').mockResolvedValue({
      timed: null,
      plain: 'YouTube plain',
      source: null,
    })
    const http = createHttpClient(
      async (raw) => {
        const url = new URL(raw)
        if (url.hostname === 'lyrics.example')
          throw new HttpError('unauthorized', 'permanent', 401)
        if (url.hostname === 'lrclib.net') {
          if (url.pathname.endsWith('/get'))
            throw new HttpError('missing', 'permanent', 404)
          return Response.json([])
        }
        return new Response(
          '<response><status>00000000</status><songs/></response>'
        )
      },
      Date.now,
      async () => {}
    )
    h.settings.lyricsServerUrl = 'https://lyrics.example/'
    h.deps.lyrics = createLyricsFinder({ http, catalog: h.catalog })
    await runMatch(h.deps, track, run())
    expect(h.rows()[0]).toMatchObject({
      lyricsText: 'Stored lyrics',
      lyricsStatus: 'synced',
      lyricsSource: 'spotify',
      lyricsCheckedAt: null,
    })
    expect(
      JSON.parse(h.rows()[0].enrichmentErrors)['lyrics:spotify']
    ).toContain('unauthorized')
  })

  it('clears recording-specific lyrics and saved Spotify ID before looking up a new recording', async () => {
    const h = harness()
    const { track, match } = await seed(h, 'old', 'synced')
    h.matcher.matches.set('old', {
      ...match,
      catalogVideoId: 'new',
      identityKey: 'video:new',
      durationSeconds: 200,
    })
    const find = vi.spyOn(h.deps.lyrics, 'find')
    await runMatch(h.deps, track, run())
    expect(find.mock.calls[0][0]).toMatchObject({
      spotifyTrackId: null,
      durationSeconds: 200,
    })
    expect(h.rows()[0]).toMatchObject({
      lyricsText: null,
      lyricsStatus: 'none',
      lyricsSource: null,
      spotifyTrackId: null,
    })
  })

  it('clears old lyrics even when lyrics are disabled during Refresh', async () => {
    const h = harness()
    const { track, match } = await seed(h, 'old', 'synced')
    h.settings.lyricsEnabled = false
    h.matcher.matches.set('old', {
      ...match,
      catalogVideoId: 'new',
      identityKey: 'video:new',
    })
    await runMatch(h.deps, track, run())
    expect(h.rows()[0]).toMatchObject({
      lyricsText: null,
      lyricsStatus: 'none',
      spotifyTrackId: null,
      lyricsCheckedAt: null,
    })
  })

  it('compares with the merge survivor and preserves its synced lyrics', async () => {
    const h = harness()
    const { track: source } = await seed(h, 'source', 'plain')
    const { match: target } = await seed(h, 'target', 'synced')
    h.matcher.matches.set('source', { ...target, sourceVideoId: 'source' })
    await runMatch(h.deps, source, run())
    expect(h.rows()).toHaveLength(1)
    expect(h.rows()[0]).toMatchObject({
      id: 'target',
      lyricsStatus: 'synced',
      lyricsText: 'Stored lyrics',
    })
  })

  it('Recheck clears only non-synced checkpoints and preserves unrelated failures', async () => {
    const h = harness()
    for (const [id, status] of [
      ['synced', 'synced'],
      ['plain', 'plain'],
      ['none', 'none'],
      ['edited', 'none'],
      ['released', 'none'],
      ['unwanted', 'none'],
    ]) {
      await seed(h, id, status)
      h.db
        .update(tracks)
        .set({
          state:
            id === 'released'
              ? 'released'
              : id === 'unwanted'
                ? 'no_longer_wanted'
                : 'needs_attention',
          attempts: 5,
          lastError: 'failure',
          lastErrorKind: 'permanent',
          nextAttemptAt: 'later',
          lyricsCheckedAt: 'checked',
        })
        .where(eq(tracks.id, id))
        .run()
    }
    file(h, 'edited')
    h.db
      .update(files)
      .set({ outsideEdit: '{}' })
      .where(eq(files.trackId, 'edited'))
      .run()
    const dirty = vi.spyOn(h.reconciler, 'markDirty')
    h.reconciler.recheckLyrics()
    expect(dirty).toHaveBeenCalled()
    expect(h.rows().find((row) => row.id === 'synced')).toMatchObject({
      state: 'needs_attention',
      attempts: 5,
      lyricsCheckedAt: 'checked',
    })
    for (const id of ['plain', 'none'])
      expect(h.rows().find((row) => row.id === id)).toMatchObject({
        lyricsCheckedAt: null,
        state: 'needs_attention',
        attempts: 5,
        lastError: 'failure',
        lastErrorKind: 'permanent',
        nextAttemptAt: 'later',
      })
    for (const [id, state] of [
      ['edited', 'needs_attention'],
      ['released', 'released'],
      ['unwanted', 'no_longer_wanted'],
    ])
      expect(h.rows().find((row) => row.id === id)).toMatchObject({
        lyricsCheckedAt: null,
        state,
        attempts: 5,
      })
  })

  it('picks pending match and acquire work before lyrics-only work', async () => {
    const h = harness()
    h.settings.lyricsEnabled = false
    h.catalog.likes = [
      song('lyrics-only', 'lyrics-only', 0),
      song('match', 'match', 1),
      song('acquire', 'acquire', 2),
    ]
    await h.start()
    const ids = Object.fromEntries(h.rows().map((row) => [row.title, row.id]))
    h.db.update(tracks).set({ state: 'pending' }).run()
    h.db
      .update(tracks)
      .set({ match: null })
      .where(eq(tracks.id, ids.match))
      .run()
    h.db.delete(files).where(eq(files.trackId, ids.acquire)).run()
    h.settings.lyricsEnabled = true
    expect(h.reconciler.activity().upNext.map((row) => row.title)).toEqual([
      'match',
      'acquire',
      'lyrics-only',
    ])
    const work: string[] = []
    h.matcher.during = () => {
      work.push('match')
    }
    const download = h.deps.downloader.download
    vi.spyOn(h.deps.downloader, 'download').mockImplementation((...args) => {
      work.push('acquire')
      return download(...args)
    })
    const find = h.deps.lyrics.find
    vi.spyOn(h.deps.lyrics, 'find').mockImplementation((...args) => {
      if (args[0].title === 'lyrics-only') work.push('lyrics-only')
      return find(...args)
    })
    h.reconciler.markDirty()
    await h.idle()
    expect(work).toEqual(['match', 'acquire', 'lyrics-only'])
  })

  it('looks up unchecked acquired tracks, retags, and uploads without rematching or downloading', async () => {
    const h = harness()
    h.settings.remoteEnabled = true
    h.settings.lyricsEnabled = false
    h.catalog.likes = [song('track')]
    await h.start()
    const before = h.rows()[0]
    expect(before.lyricsCheckedAt).toBeNull()
    const matches = h.matcher.calls
    const find = vi.spyOn(h.deps.lyrics, 'find')
    h.lyricsText = '[00:01.00]New lyrics'
    h.settings.lyricsEnabled = true
    h.reconciler.markDirty()
    await h.idle()
    const after = h.rows()[0]
    expect(find).toHaveBeenCalledTimes(1)
    expect(find.mock.calls[0][0].durationSeconds).toBe(before.durationSeconds)
    expect(h.matcher.calls).toBe(matches)
    expect(h.downloads).toEqual(['track'])
    expect(after).toMatchObject({
      state: 'done',
      lyricsStatus: 'synced',
      lyricsCheckedAt: h.time.toISOString(),
    })
    const relative = h.file(after.id)!.relativePath
    const sidecar = relative.replace(/\.m4a$/, '.lrc')
    for (const root of [h.library, h.remote]) {
      expect(readTags(path.join(root, relative)).fields.lyrics).toBe(
        h.lyricsText
      )
      expect(readFileSync(path.join(root, sidecar), 'utf8')).toBe(
        `${h.lyricsText}\n`
      )
    }
  })

  it('does not schedule checked tracks automatically or when lyrics are disabled', async () => {
    const h = harness()
    const { track } = await seed(h, 'track')
    const f = file(h, track.id)
    h.settings.lyricsEnabled = false
    expect(nextStep(h.db, track, f, undefined, h.settings)).toBe('retag')
    h.settings.lyricsEnabled = true
    expect(
      nextStep(
        h.db,
        { ...track, lyricsCheckedAt: '2000-01-01' },
        f,
        undefined,
        h.settings
      )
    ).toBe('retag')
  })
})

describe('failed lyrics lookups', () => {
  it('upload without lyrics, stay unchecked, and retry on the next check', async () => {
    const h = harness()
    h.settings.remoteEnabled = true
    h.catalog.likes = [song('track')]
    const find = vi.spyOn(h.deps.lyrics, 'find').mockResolvedValue({
      lyrics: null,
      spotifyTrackId: null,
      errors: { spotify: 'unavailable' },
    })
    await h.start()
    const failed = h.rows()[0]
    // One lookup in the match step, one retry in the lyrics step, then no loop.
    expect(find.mock.calls.length).toBeLessThanOrEqual(2)
    expect(failed).toMatchObject({ state: 'done', lyricsCheckedAt: null })
    expect(h.upload(failed.id)).toBeDefined()
    const calls = find.mock.calls.length
    await h.check()
    expect(find.mock.calls.length).toBe(calls + 1)
    find.mockResolvedValue({
      lyrics: {
        text: '[00:01.00]Found',
        synced: true,
        source: 'lrclib',
        language: null,
      },
      spotifyTrackId: null,
      errors: {},
    })
    await h.check()
    expect(h.rows()[0]).toMatchObject({
      lyricsStatus: 'synced',
      lyricsCheckedAt: h.time.toISOString(),
    })
    expect(h.upload(failed.id)?.lrcHash).not.toBeNull()
  })

  it('waits for the network instead of counting a lost connection as a miss', async () => {
    const h = new Harness({ probeBackoffMs: [30, 30] })
    open.push(h)
    h.settings.remoteEnabled = false
    h.catalog.likes = [song('track')]
    let online = false
    const find = vi
      .spyOn(h.deps.lyrics, 'find')
      .mockImplementation(async () => ({
        lyrics: online
          ? {
              text: '[00:01.00]Found',
              synced: true,
              source: 'lrclib' as const,
              language: null,
            }
          : null,
        spotifyTrackId: null,
        errors: online
          ? {}
          : {
              lrclib: 'lrclib: fetch failed (ENOTFOUND)',
              netease: 'netease: fetch failed (ENOTFOUND)',
            },
      }))
    await h.reconciler.start()
    const end = Date.now() + 10_000
    while (!h.reconciler.activity().offline || find.mock.calls.length < 3) {
      if (Date.now() > end) throw new Error('Timed out waiting for offline')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // The lane waits and probes; the track keeps its retries and stays unchecked.
    expect(h.rows()[0]).toMatchObject({
      state: 'pending',
      attempts: 0,
      lyricsCheckedAt: null,
    })
    online = true
    await h.idle()
    expect(h.reconciler.activity().offline).toBe(false)
    expect(h.rows()[0]).toMatchObject({
      state: 'done',
      lyricsStatus: 'synced',
      lyricsCheckedAt: h.time.toISOString(),
    })
  })

  it('treats a mix of a lost connection and a clean miss as a retry, not an outage', async () => {
    const h = harness()
    const { track } = await seed(h, 'track')
    file(h, track.id)
    vi.spyOn(h.deps.lyrics, 'find').mockResolvedValue({
      lyrics: null,
      spotifyTrackId: null,
      errors: {
        netease: 'netease: fetch failed (ENOTFOUND)',
        lrclib: 'HTTP 500',
      },
    })
    expect(await runLyrics(h.deps, h.rows()[0], run())).toBe(false)
    expect(h.rows()[0].lyricsCheckedAt).toBeNull()
  })

  it('does not pause the lane when one optional provider is unreachable but the others answered', async () => {
    const h = harness()
    const { track } = await seed(h, 'track')
    file(h, track.id)
    vi.spyOn(h.deps.lyrics, 'find').mockResolvedValue({
      lyrics: null,
      spotifyTrackId: null,
      // YouTube Music, LRCLIB and PetitLyrics cleanly missed; NetEase is down.
      errors: { netease: 'netease: fetch failed (ENOTFOUND)' },
      attempted: ['youtube-music', 'lrclib', 'petitlyrics', 'netease'],
    })
    expect(await runLyrics(h.deps, h.rows()[0], run())).toBe(false)
    expect(h.rows()[0].lyricsCheckedAt).toBeNull()
    expect(JSON.parse(h.rows()[0].enrichmentErrors)).toMatchObject({
      'lyrics:netease': expect.stringContaining('ENOTFOUND'),
    })
  })

  it('throws a connectivity error when every provider is unreachable', async () => {
    const h = harness()
    const { track } = await seed(h, 'track')
    file(h, track.id)
    vi.spyOn(h.deps.lyrics, 'find').mockResolvedValue({
      lyrics: null,
      spotifyTrackId: null,
      errors: {
        lrclib: 'lrclib: fetch failed (ENOTFOUND)',
        netease: 'netease: fetch failed (ENOTFOUND)',
      },
      attempted: ['lrclib', 'netease'],
    })
    await expect(runLyrics(h.deps, h.rows()[0], run())).rejects.toSatisfy(
      isConnectivityError
    )
    expect(h.rows()[0].lyricsCheckedAt).toBeNull()
  })
})
