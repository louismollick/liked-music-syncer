import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { File, type Mpeg4AppleTag, TagTypes } from 'node-taglib-sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adoptFiles } from '../../src/main/inventory/inventory'
import { artists, uploads } from '../../src/main/library/schema'
import {
  desiredFieldsFor,
  materialDiff,
  parseFields,
} from '../../src/main/reconcile/steps'
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

function legacyFile(
  h: Harness,
  relative: string,
  options: {
    source: string
    resolved?: string
    release?: string
    title?: string
    album?: string
    track?: number
    total?: number
    origin?: string
    lyrics?: string
  }
) {
  const absolute = path.join(h.library, relative)
  mkdirSync(path.dirname(absolute), { recursive: true })
  makeM4a(absolute)
  const title = options.title ?? options.source
  const current = readTags(absolute)
  writeTags(
    absolute,
    {
      ...current.fields,
      title,
      artist: credit.name,
      album: options.album ?? title,
      albumArtist: credit.name,
      trackNumber: options.track ?? 1,
      trackTotal: options.total ?? 1,
      lyrics: options.lyrics ?? null,
      language: options.lyrics ? 'en' : null,
      lms: {
        ...current.fields.lms,
        sourceVideoId: options.source,
        resolvedVideoId: options.resolved ?? options.source,
        releaseBrowseId: options.release ?? null,
        releaseTitle: options.release ? (options.album ?? title) : null,
        releaseKind: options.release ? 'album' : null,
        sourceOrigin: options.origin ?? null,
        resolutionMethod: options.release ? 'liked_album_exact' : 'standalone',
        artistCredits: [credit],
      },
    },
    null
  )
  const file = File.createFromPath(absolute)
  try {
    const apple = file.getTag(TagTypes.Apple, true) as Mpeg4AppleTag
    apple.setItunesStrings('com.apple.iTunes', 'LMS_TAG_SCHEMA_VERSION', '5')
    file.save()
  } finally {
    file.dispose()
  }
  return absolute
}

async function adopt(h: Harness) {
  return adoptFiles(
    { db: h.db, coversDir: path.join(h.userData, 'covers'), now: () => h.time },
    h.library
  )
}

describe('adoption of v5 managed files', () => {
  it('uses provisional keys, suffixes duplicates, and suggests credited artists', async () => {
    const h = harness()
    legacyFile(h, 'one.m4a', {
      source: 'source',
      resolved: 'resolved',
      release: 'release',
      title: 'Song',
      origin: 'favorite_artist_release',
    })
    legacyFile(h, 'two.m4a', {
      source: 'source',
      resolved: 'resolved',
      release: 'release',
      title: 'Song',
    })
    legacyFile(h, 'three.m4a', { source: 'loose', title: 'Loose' })
    expect(await adopt(h)).toMatchObject({ adopted: 3, suggestedArtists: 1 })
    expect(
      h
        .rows()
        .map((row) => row.identityKey)
        .sort()
    ).toEqual([
      'adopted:release:resolved',
      'adopted:release:resolved:2',
      'adopted:video:loose',
    ])
    expect(h.rows().every((row) => row.adopted && row.state === 'done')).toBe(
      true
    )
    expect(
      h.db
        .select()
        .from(artists)
        .where(eq(artists.id, 'channel:artist-1'))
        .get()
    ).toMatchObject({ suggested: true, favorite: false })
  })

  it('claims a release file for a like of its recorded source video, without downloading', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const original = legacyFile(h, 'Test Artist/Test Album/01 Song.m4a', {
      source: 'liked',
      resolved: 'catalog',
      release: 'release-1',
      title: 'Song',
      album: 'Test Album',
    })
    await adopt(h)
    const adoptedId = h.rows()[0].id
    const album = release('release-1', song('catalog', 'Song'))
    const liked = song('liked', 'Song')
    h.matcher.matches.set('liked', releaseMatch(liked, album, 'catalog'))
    h.catalog.likes = [liked]
    await h.start()
    const claimed = h.rows().find((row) => row.id === adoptedId)!
    expect(claimed.adopted).toBe(false)
    expect(claimed.identityKey).toBe('adopted:release-1:catalog')
    expect(h.rows()).toHaveLength(1)
    expect(h.downloads).toEqual([])
    expect(existsSync(original)).toBe(true)
    expect(h.file(adoptedId)?.audioVideoId).toBe('catalog')
  })

  it('claims by recorded source video even when the matcher now picks another release; Refresh re-keys and re-downloads', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    legacyFile(h, 'wrong.m4a', {
      source: 'liked',
      release: 'other-release',
      title: 'Song',
    })
    await adopt(h)
    const adoptedId = h.rows()[0].id
    const album = release('right-release', song('catalog', 'Song'))
    h.matcher.matches.set(
      'liked',
      releaseMatch(song('liked', 'Song'), album, 'catalog')
    )
    h.catalog.likes = [song('liked', 'Song')]
    await h.start()
    expect(h.rows()).toHaveLength(1)
    expect(h.downloads).toEqual([])
    h.reconciler.refresh({ kind: 'track', id: adoptedId })
    await h.idle()
    expect(h.row('right-release:catalog')?.id).toBe(adoptedId)
    expect(h.downloads).toEqual(['catalog'])
  })

  it('claims a standalone file by source video, retags an Unknown Album layout, and moves it', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const original = legacyFile(h, 'Test Artist/Unknown Album/Loose.m4a', {
      source: 'loose',
      title: 'Loose',
      album: 'Unknown Album',
      track: 17,
      total: 30,
    })
    await adopt(h)
    const adoptedId = h.rows()[0].id
    h.catalog.likes = [song('loose', 'Loose')]
    await h.start()
    const track = h.rows().find((row) => row.id === adoptedId)!
    expect(track.id).toBe(adoptedId)
    expect(h.downloads).toEqual([])
    expect(h.file(track.id)?.relativePath).toBe('Test Artist/Loose/Loose.m4a')
    expect(
      readTags(path.join(h.library, h.file(track.id)!.relativePath)).fields
    ).toMatchObject({ album: 'Loose', trackNumber: 1, trackTotal: 1 })
    expect(existsSync(original)).toBe(false)
  })

  it('keeps an adopted sidecar and does not rewrite a file whose only tag difference is schema version', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const relative = 'Test Artist/Lyrics/Lyrics.m4a'
    const absolute = legacyFile(h, relative, {
      source: 'lyrics',
      title: 'Lyrics',
      lyrics: '[00:01.00]Hello',
    })
    const sidecar = absolute.replace(/\.m4a$/, '.lrc')
    writeFileSync(sidecar, '[00:01.00]Hello\n')
    const before = readFileSync(absolute)
    const sidecarBefore = statSync(sidecar).mtimeMs
    await adopt(h)
    const adopted = h.rows()[0]
    expect(adopted.lyricsStatus).toBe('synced')
    expect(h.file(adopted.id)?.lrcSha256).toBeTruthy()
    h.catalog.likes = [song('lyrics', 'Lyrics')]
    h.lyricsText = '[00:01.00]Hello'
    await h.start()
    expect(h.downloads).toEqual([])
    expect(
      materialDiff(
        parseFields(h.file(adopted.id)!),
        desiredFieldsFor(h.db, h.rows()[0])
      )
    ).toEqual([])
    expect(readFileSync(absolute).equals(before)).toBe(true)
    expect(statSync(sidecar).mtimeMs).toBe(sidecarBefore)
    expect(readTags(absolute).fields.lms.schemaVersion).toBe(5)
  })

  it('does not rewrite an adopted Favorite Artist file before any source claims it', async () => {
    const h = harness()
    h.settings.remoteEnabled = false
    const absolute = legacyFile(h, 'Test Artist/Album/01 Fav.m4a', {
      source: 'fav',
      resolved: 'fav',
      release: 'fav-release',
      title: 'Fav',
      album: 'Album',
      origin: 'favorite_artist_release',
    })
    const before = readFileSync(absolute)
    await adopt(h)
    h.catalog.likes = []
    await h.start()
    expect(h.downloads).toEqual([])
    expect(readFileSync(absolute).equals(before)).toBe(true)
  })

  it('records an identical remote copy without uploading it', async () => {
    const h = harness()
    const relative = 'Test Artist/Remote/Remote.m4a'
    const absolute = legacyFile(h, relative, {
      source: 'remote',
      title: 'Remote',
    })
    const remote = path.join(h.remote, relative)
    mkdirSync(path.dirname(remote), { recursive: true })
    copyFileSync(absolute, remote)
    await adopt(h)
    h.catalog.likes = [song('remote', 'Remote')]
    const upload = vi.spyOn(h.deps.rclone, 'upload')
    await h.start()
    const track = h.rows()[0]
    expect(h.downloads).toEqual([])
    expect(upload).not.toHaveBeenCalled()
    expect(
      h.db.select().from(uploads).where(eq(uploads.trackId, track.id)).get()
        ?.remotePath
    ).toBe(relative)
  })
})
