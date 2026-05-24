import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
  },
  protocol: {
    handle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
  },
  net: {
    fetch: vi.fn(),
  },
}))

import { createDatabase } from '../src/main/db/database'
import {
  libraryFilesTable,
  libraryRootsTable,
  libraryTracksTable,
} from '../src/main/db/schema'
import {
  ARTWORK_FILENAME_PATTERN,
  buildArtworkMediaUrl,
  resolveArtworkCacheFileName,
} from '../src/main/services/artwork-protocol'
import {
  ArtworkService,
  artworkCacheFileName,
  buildArtworkCacheKey,
} from '../src/main/services/artwork-service'
import { buildAlbumKey, parseAlbumKey } from '../src/shared/album-key'

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-artwork-db-'))
  const databaseFile = path.join(dir, 'test.db')
  return {
    dir,
    ...createDatabase(databaseFile),
  }
}

describe('album key helpers', () => {
  it('builds and parses stable album keys', () => {
    const key = buildAlbumKey('In Rainbows', 'Radiohead')
    expect(key).toBe('In Rainbows|||Radiohead')
    expect(parseAlbumKey(key)).toEqual({
      album: 'In Rainbows',
      albumArtist: 'Radiohead',
    })
  })
})

describe('artwork cache keying', () => {
  it('changes when file fingerprint inputs change', () => {
    const base = {
      fileId: 'file_1',
      tagFingerprint: 'fp-a',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      sizeBytes: 100,
    }
    const first = buildArtworkCacheKey(base)
    const second = buildArtworkCacheKey({
      ...base,
      tagFingerprint: 'fp-b',
    })
    expect(first).not.toBe(second)
    expect(artworkCacheFileName(first)).toMatch(ARTWORK_FILENAME_PATTERN)
  })
})

describe('app-media protocol path validation', () => {
  const cacheDir = path.join(os.tmpdir(), 'lms-artwork-cache-test')

  it('accepts only hashed cache filenames under the artwork host', () => {
    const cacheKey = buildArtworkCacheKey({
      fileId: 'file_1',
      tagFingerprint: 'fp',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      sizeBytes: 42,
    })
    const fileName = artworkCacheFileName(cacheKey)
    const url = buildArtworkMediaUrl(fileName)
    expect(resolveArtworkCacheFileName(url, cacheDir)).toBe(fileName)
  })

  it('rejects traversal and unexpected filenames', () => {
    expect(
      resolveArtworkCacheFileName('app-media://artwork/../secret.jpg', cacheDir)
    ).toBeNull()
    expect(
      resolveArtworkCacheFileName('app-media://other/abc.jpg', cacheDir)
    ).toBeNull()
    expect(
      resolveArtworkCacheFileName('file:///etc/passwd', cacheDir)
    ).toBeNull()
  })
})

describe('ArtworkService', () => {
  const cacheDirs: string[] = []

  afterEach(() => {
    for (const dir of cacheDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns cached media URL without calling the worker on cache hit', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lms-artwork-cache-')
    )
    cacheDirs.push(cacheDir)
    cacheDirs.push(dir)

    const rootId = 'root_local'
    const trackId = 'track_1'
    const fileId = 'file_1'
    const modifiedAt = '2026-05-18T00:00:00.000Z'
    const tagFingerprint = 'fp-1'
    const audioPath = path.join(dir, 'album-track.m4a')
    fs.writeFileSync(audioPath, Buffer.from('fake-audio'))

    await db.insert(libraryRootsTable).values({
      id: rootId,
      kind: 'local',
      transport: 'filesystem',
      label: 'Local',
      uri: dir,
      writable: true,
      managedOutput: true,
      createdAt: modifiedAt,
      updatedAt: modifiedAt,
      lastScannedAt: modifiedAt,
      lastScanStatus: 'ok',
    })
    await db.insert(libraryTracksTable).values({
      id: trackId,
      identityKind: 'lms_source',
      identityValue: 'youtube_music:test',
      managedByApp: true,
      tagSchemaVersion: 1,
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      albumArtist: 'Album Artist',
      lyricsStatus: 'missing',
      hasEmbeddedLyrics: false,
      hasSidecarLyrics: false,
      coverArtPresent: true,
      missingFieldsJson: '[]',
      preferredFileId: fileId,
      firstSeenAt: modifiedAt,
      lastSeenAt: modifiedAt,
      updatedAt: modifiedAt,
    })
    await db.insert(libraryFilesTable).values({
      id: fileId,
      trackId,
      rootId,
      relativePath: 'album-track.m4a',
      absolutePathSnapshot: audioPath,
      lrcPath: null,
      format: 'MP4',
      sizeBytes: 100,
      durationSeconds: null,
      bitrate: null,
      modifiedAt,
      sidecarModifiedAt: null,
      audioSha256: null,
      tagFingerprint,
      embeddedLyricsStatus: 'missing',
      sidecarLyricsStatus: 'missing',
      missingFieldsJson: '[]',
      discoveredVia: 'lms_tags',
      lastScannedAt: modifiedAt,
      firstSeenAt: modifiedAt,
      updatedAt: modifiedAt,
    })

    const cacheKey = buildArtworkCacheKey({
      fileId,
      tagFingerprint,
      modifiedAt,
      sizeBytes: 100,
    })
    const cacheFileName = artworkCacheFileName(cacheKey)
    fs.writeFileSync(path.join(cacheDir, cacheFileName), Buffer.from('cached'))

    const runJsonCommand = vi.fn()
    const service = new ArtworkService(
      db,
      { runJsonCommand } as never,
      cacheDir
    )
    const albumKey = buildAlbumKey('Album', 'Album Artist')
    const [entry] = await service.getAlbumArtwork([albumKey])

    expect(entry).toEqual({
      albumKey,
      artworkUrl: buildArtworkMediaUrl(cacheFileName),
    })
    expect(runJsonCommand).not.toHaveBeenCalled()
    sqlite.close()
  })

  it('falls back to null artwork when no local source exists', async () => {
    const { db, sqlite, dir } = makeTempDb()
    cacheDirs.push(dir)
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lms-artwork-cache-')
    )
    cacheDirs.push(cacheDir)

    const service = new ArtworkService(
      db,
      { runJsonCommand: vi.fn() } as never,
      cacheDir
    )
    const albumKey = buildAlbumKey('Missing', 'Artist')
    const [entry] = await service.getAlbumArtwork([albumKey])
    expect(entry).toEqual({ albumKey, artworkUrl: null })
    sqlite.close()
  })
})
