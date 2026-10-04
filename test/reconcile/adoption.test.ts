import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { File, type Mpeg4AppleTag, TagTypes } from 'node-taglib-sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256File } from '../../src/main/inventory/files'
import {
  adoptFiles,
  detectOutsideEdits,
} from '../../src/main/inventory/inventory'
import {
  artists,
  files,
  tracks,
  unmanagedFiles,
  uploads,
} from '../../src/main/library/schema'
import type { Match } from '../../src/main/match/types'
import {
  checkArtistCatalog,
  checkLikedSongs,
  claimAdoptedFiles,
  linkContributions,
} from '../../src/main/reconcile/sources'
import { desiredFieldsFor, runRetag } from '../../src/main/reconcile/steps'
import { readTags, writeTags } from '../../src/main/tags/schema'
import { makeM4a } from '../helpers/audio'
import { credit, Harness, release, releaseMatch, song } from './harness'

const open: Harness[] = []
function harness() {
  const h = new Harness()
  open.push(h)
  return h
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

const ARTIST = 'channel:artist-1'
const album = release('album', song('c1', 'One'), song('c2', 'Two'))
const liked = song('lv', 'Two')
const loose = song('loose', 'Loose')

/** Sources: a Full Discography album, a like filed on its track 2, and a standalone like. */
function sources(h: Harness, options: { likes?: boolean } = {}) {
  h.catalog.releases.set(album.browseId, album)
  h.catalog.refs = [
    {
      browseId: album.browseId,
      title: album.title,
      shelf: 'albums',
      year: 2024,
      thumbnailUrl: null,
    },
  ]
  h.matcher.matches.set('lv', releaseMatch(liked, album, 'c2'))
  h.catalog.likes = options.likes === false ? [] : [liked, loose]
  h.db
    .insert(artists)
    .values({
      id: ARTIST,
      name: credit.name,
      channelId: credit.channelId,
      fullDiscography: true,
    })
    .onConflictDoUpdate({ target: artists.id, set: { fullDiscography: true } })
    .run()
}

/** Runs the real pipeline so the library holds files this app wrote. */
async function built(options: { remote?: boolean } = {}) {
  const h = harness()
  h.settings.remoteEnabled = options.remote ?? false
  sources(h)
  await h.start()
  await h.stop()
  return h
}

/** A second install that lost its database but kept the folder (and remote). */
function rebuiltFrom(source: Harness) {
  const h = harness()
  h.settings.remoteEnabled = source.settings.remoteEnabled
  cpSync(source.library, h.library, { recursive: true })
  cpSync(source.remote, h.remote, { recursive: true })
  return h
}

async function adopt(h: Harness) {
  return adoptFiles(
    { db: h.db, coversDir: path.join(h.userData, 'covers'), now: () => h.time },
    h.library
  )
}

function snapshot(h: Harness) {
  return h
    .rows()
    .map((row) => ({
      identityKey: row.identityKey,
      credits: JSON.parse(row.artistCredits),
      trackNumber: row.trackNumber,
      file: h.file(row.id)?.contentSha256,
      audio: h.file(row.id)?.audioVideoId,
    }))
    .sort((a, b) => String(a.identityKey).localeCompare(String(b.identityKey)))
}

function hashes(h: Harness) {
  return Object.fromEntries(
    h.db
      .select()
      .from(files)
      .all()
      .map((row) => [row.relativePath, row.contentSha256])
  )
}

function setFreeform(absolute: string, name: string, value: string) {
  const file = File.createFromPath(absolute)
  try {
    const apple = file.getTag(TagTypes.Apple, true) as Mpeg4AppleTag
    apple.setItunesStrings('com.apple.iTunes', name, value)
    file.save()
  } finally {
    file.dispose()
  }
}

/** A file the previous app wrote: LMS tags, no confirmation atom. */
function legacyFile(h: Harness, relative: string, schema: string) {
  const absolute = path.join(h.library, relative)
  mkdirSync(path.dirname(absolute), { recursive: true })
  makeM4a(absolute)
  const current = readTags(absolute)
  writeTags(
    absolute,
    {
      ...current.fields,
      title: 'Legacy',
      artist: credit.name,
      album: 'Legacy',
      albumArtist: credit.name,
      lms: {
        ...current.fields.lms,
        sourceVideoId: 'legacy',
        resolvedVideoId: 'legacy',
        resolutionMethod: 'standalone',
        artistCredits: [credit],
      },
    },
    null
  )
  setFreeform(absolute, 'LMS_TAG_SCHEMA_VERSION', schema)
  return absolute
}

describe('restoring the Library from files this app wrote', () => {
  it('restores release and standalone tracks without matching, downloading, or rewriting', async () => {
    const source = await built()
    expect(source.downloads.sort()).toEqual(['c1', 'c2', 'loose'])
    const h = rebuiltFrom(source)
    expect(await adopt(h)).toMatchObject({ adopted: 3, unmanaged: 0 })
    expect(
      h.rows().every((row) => row.lyricsCheckedAt === h.time.toISOString())
    ).toBe(true)
    const lyricsLookup = vi.spyOn(h.deps.lyrics, 'find')
    expect(snapshot(h)).toEqual(snapshot(source))
    expect(
      h.rows().some((row) => row.identityKey?.startsWith('adopted:'))
    ).toBe(false)
    const before = hashes(h)
    sources(h)
    await h.start()
    await h.stop()
    await h.start()
    expect(h.downloads).toEqual([])
    expect(h.matcher.calls).toBe(0)
    expect(lyricsLookup).not.toHaveBeenCalled()
    expect(hashes(h)).toEqual(before)
    expect(h.rows()).toHaveLength(3)
    expect(h.rows().every((row) => row.state === 'done')).toBe(true)
  })

  it('gives restored files to catalog tracks created before adoption', async () => {
    const source = await built()
    const h = rebuiltFrom(source)
    sources(h, { likes: false })
    await checkArtistCatalog({
      db: h.db,
      catalog: h.catalog,
      artistId: ARTIST,
      channelId: credit.channelId,
      now: () => h.time,
    })
    linkContributions(h.db, () => h.time)
    const pending = h.rows().map((row) => row.id)
    await adopt(h)
    expect(h.rows().map((row) => row.id)).toEqual(
      expect.arrayContaining(pending)
    )
    for (const id of pending) expect(h.file(id)).toBeDefined()
    sources(h)
    await h.start()
    expect(h.downloads).toEqual([])
    // The like claims the file it recorded, even though the catalog came first.
    expect(h.matcher.calls).toBe(0)
    expect(h.rows()).toHaveLength(3)
  })

  it('lets a like checked before adoption claim the file it records', async () => {
    const source = await built()
    const h = rebuiltFrom(source)
    sources(h)
    await checkLikedSongs({
      db: h.db,
      catalog: h.catalog,
      accountId: h.account!,
      stillCurrent: () => true,
      now: () => h.time,
    })
    linkContributions(h.db, () => h.time)
    await adopt(h)
    expect(claimAdoptedFiles(h.db, () => h.time)).toBe(2)
    await h.start()
    expect(h.downloads).toEqual([])
    expect(h.matcher.calls).toBe(0)
    expect(h.rows()).toHaveLength(3)
  })

  it('does not pick one of several files that record the same liked video', async () => {
    const source = await built()
    const h = rebuiltFrom(source)
    // A second confirmed file, on another release, recording the same like.
    const original = source.db
      .select()
      .from(files)
      .all()
      .find(
        (row) =>
          readTags(path.join(h.library, row.relativePath)).fields.lms
            .sourceVideoId === 'lv'
      )!
    const other = path.join(h.library, 'Other/Other/01 Two.m4a')
    mkdirSync(path.dirname(other), { recursive: true })
    copyFileSync(path.join(h.library, original.relativePath), other)
    const fields = readTags(other).fields
    writeTags(
      other,
      { ...fields, lms: { ...fields.lms, releaseBrowseId: 'other-release' } },
      null
    )
    h.catalog.likes = [liked]
    h.matcher.matches.set('lv', releaseMatch(liked, album, 'c2'))
    await checkLikedSongs({
      db: h.db,
      catalog: h.catalog,
      accountId: h.account!,
      stillCurrent: () => true,
      now: () => h.time,
    })
    linkContributions(h.db, () => h.time)
    await adopt(h)
    expect(claimAdoptedFiles(h.db, () => h.time)).toBe(0)
    await h.start()
    // The like was matched and merged into the Release Track it resolves to.
    const albumTrack = h.row('album:c2')!
    expect(
      h.contributions().find((row) => row.sourceVideoId === 'lv')?.trackId
    ).toBe(albumTrack.id)
    expect(h.row('other-release:c2')?.adopted).toBe(true)
    expect(h.downloads).toEqual([])
  })

  it('keeps one tracked copy of a Release Track and lists the others as Unmanaged', async () => {
    const source = await built()
    const h = rebuiltFrom(source)
    const first = source.db.select().from(files).all()[0].relativePath
    const extra = 'zzz/extra copy.m4a'
    mkdirSync(path.join(h.library, 'zzz'), { recursive: true })
    copyFileSync(path.join(h.library, first), path.join(h.library, extra))
    await adopt(h)
    await adopt(h)
    expect(h.rows()).toHaveLength(3)
    expect(
      h.db
        .select()
        .from(files)
        .all()
        .map((row) => row.relativePath)
    ).toContain(first)
    expect(
      h.db
        .select()
        .from(unmanagedFiles)
        .where(eq(unmanagedFiles.relativePath, extra))
        .get()?.released
    ).toBe(true)
    expect(existsSync(path.join(h.library, extra))).toBe(true)
  })

  it('leaves files without a confirmed Match as Unmanaged, untouched', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const v5 = legacyFile(h, 'Old/v5.m4a', '5')
    const v6 = legacyFile(h, 'Old/v6.m4a', '6')
    // Marked, but a Standalone Track cannot name a release.
    const malformed = legacyFile(h, 'Old/malformed.m4a', '6')
    setFreeform(malformed, 'LMS_MATCH_CONFIRMED', '1')
    setFreeform(malformed, 'LMS_CATALOG_RELEASE_BROWSE_ID', 'some-release')
    const bytes = [v5, v6, malformed].map((file) => readFileSync(file))
    expect(await adopt(h)).toMatchObject({ adopted: 0, unmanaged: 3 })
    h.catalog.likes = []
    await h.start()
    expect(h.rows()).toHaveLength(0)
    expect([v5, v6, malformed].map((file) => readFileSync(file))).toEqual(bytes)
  })

  it('never confirms an older saved Match by retagging', async () => {
    const source = await built()
    const track = source.rows()[0]
    const match = JSON.parse(track.match!) as Match
    delete match.confirmed
    source.db
      .update(tracks)
      .set({ match: JSON.stringify(match), lyricsText: 'changed' })
      .where(eq(tracks.id, track.id))
      .run()
    const row = source.rows().find((r) => r.id === track.id)!
    expect(desiredFieldsFor(source.db, row).lms.matchConfirmed).toBe(false)
    await runRetag(source.deps, row, {
      signal: new AbortController().signal,
      progress: () => {},
    })
    const file = source.file(track.id)!
    expect(
      readTags(path.join(source.library, file.relativePath)).fields.lms
        .matchConfirmed
    ).toBe(false)
    const h = rebuiltFrom(source)
    await adopt(h)
    expect(h.rows()).toHaveLength(2)
  })

  it('records an identical remote copy without uploading it', async () => {
    const source = await built({ remote: true })
    const h = rebuiltFrom(source)
    await adopt(h)
    sources(h)
    const upload = vi.spyOn(h.deps.rclone, 'upload')
    await h.start()
    expect(h.downloads).toEqual([])
    expect(upload).not.toHaveBeenCalled()
    expect(h.db.select().from(uploads).all()).toHaveLength(3)
  })
})

describe('Outside Edits on records saved before match confirmation existed', () => {
  it('reports an audio-only edit as audio', async () => {
    const h = await built()
    const file = h.db.select().from(files).all()[0]
    const absolute = path.join(h.library, file.relativePath)
    // A file and record written before the confirmation field existed.
    const before = readTags(absolute)
    writeTags(
      absolute,
      {
        ...before.fields,
        lms: { ...before.fields.lms, matchConfirmed: false },
      },
      before.cover
    )
    const stored = readTags(absolute).fields as unknown as {
      lms: Record<string, unknown>
    }
    delete stored.lms.matchConfirmed
    const info = statSync(absolute)
    h.db
      .update(files)
      .set({
        tagFields: JSON.stringify(stored),
        contentSha256: await sha256File(absolute),
        size: info.size,
        mtimeMs: info.mtimeMs,
      })
      .where(eq(files.trackId, file.trackId))
      .run()
    const tags = readTags(absolute)
    makeM4a(absolute, 0.4, 880)
    writeTags(absolute, tags.fields, tags.cover)
    await detectOutsideEdits(
      {
        db: h.db,
        coversDir: path.join(h.userData, 'covers'),
        now: () => h.time,
      },
      h.library
    )
    expect(h.file(file.trackId)?.outsideEdit).toBe(JSON.stringify(['audio']))
  })
})
