import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
  },
}))
vi.mock('execa', () => ({
  execa: vi.fn(),
}))

import { createDatabase } from '../src/main/db/database'
import {
  libraryFilesTable,
  libraryRootsTable,
  libraryTracksTable,
  likedArtistsTable,
  metaTable,
  syncJobsTable,
  syncJobTracksTable,
} from '../src/main/db/schema'
import { LibraryService } from '../src/main/services/library-service'
import { LikedArtistsService } from '../src/main/services/liked-artists-service'
import { setTempLogMirror } from '../src/main/services/logger'
import {
  buildRemoteScannerSshArgs,
  normalizeExiftoolJson,
  parseRcloneSftpConfig,
  SyncService,
} from '../src/main/services/sync-service'
import { createTempLogMirror } from '../src/main/services/temp-log-file'
import { groupAlbums } from '../src/renderer/src/components/library/library-utils'

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-db-'))
  const databaseFile = path.join(dir, 'test.db')
  return {
    dir,
    ...createDatabase(databaseFile),
  }
}

function scannedFile(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    managed_by_app: true,
    tag_schema_version: 1,
    youtube_music_track_id: 'liked123',
    spotify_track_id: null,
    soundcloud_track_id: null,
    resolved_youtube_music_track_id: 'catalog456',
    title: 'Track Title',
    artist: 'Artist Name',
    album: 'Album Name',
    album_artist: 'Album Artist',
    track_number: 1,
    track_total: 10,
    disc_number: 1,
    disc_total: 1,
    year: 2024,
    date: '2024-03-01',
    genre: 'rock',
    language: 'en',
    isrc: 'USABC1234567',
    mb_track_id: 'mb-track',
    mb_album_id: 'mb-album',
    mb_releasegroup_id: 'mb-group',
    lyrics_status: 'synced',
    has_embedded_lyrics: true,
    has_sidecar_lyrics: false,
    cover_art_present: true,
    missing_fields: [],
    format: 'MP4',
    duration_seconds: 200,
    bitrate: 256000,
    embedded_lyrics_status: 'synced',
    sidecar_lyrics_status: 'missing',
    relative_path: 'Artist Name/Album Name/01 Track Title.m4a',
    absolute_path_snapshot: '/tmp/Artist Name/Album Name/01 Track Title.m4a',
    lrc_path: null,
    size_bytes: 12345,
    modified_at: '2026-05-18T00:00:00.000Z',
    sidecar_modified_at: null,
    audio_sha256: null,
    tag_fingerprint: 'fingerprint',
    last_scanned_at: '2026-05-18T00:00:00.000Z',
    identity_kind: 'lms_source',
    identity_value: 'youtube_music:liked123',
    discovered_via: 'lms_tags',
    ...overrides,
  }
}

function readyIndexStatus() {
  return {
    currentLocalRootUri: '/tmp/out',
    ready: true,
    inProgress: false,
    reason: 'ready' as const,
    lastScannedAt: '2026-05-18T00:00:00.000Z',
    lastScanStatus: 'ok',
    indexVersion: 1,
  }
}

function createMockChildProcess() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const child = {
    stdout,
    stderr,
    stdin: new PassThrough(),
    pid: undefined,
    kill: vi.fn().mockReturnValue(true),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler)
      return child
    }),
    emitExit: (code: number | null, signal: NodeJS.Signals | null = null) => {
      listeners.get('exit')?.(code, signal)
    },
    emitError: (error: Error) => {
      listeners.get('error')?.(error)
    },
  }
  return child
}

afterEach(() => {
  setTempLogMirror(null)
  vi.restoreAllMocks()
})

describe('library service', () => {
  it('groups local and remote managed copies into one track with two files', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const pythonWorker = {
      runJsonCommand: vi
        .fn()
        .mockResolvedValueOnce({
          scanned_at: '2026-05-18T00:00:00.000Z',
          files: [
            scannedFile({
              relative_path: 'Artist/Album/local.m4a',
              absolute_path_snapshot: '/local/Artist/Album/local.m4a',
            }),
          ],
        })
        .mockResolvedValueOnce({
          scanned_at: '2026-05-18T00:01:00.000Z',
          files: [
            scannedFile({
              relative_path: 'Artist/Album/remote.m4a',
              absolute_path_snapshot: '/remote/Artist/Album/remote.m4a',
            }),
          ],
        }),
    }
    const service = new LibraryService(db, {} as never, pythonWorker as never)
    ;(service as { resolveRoots: () => Promise<unknown> }).resolveRoots =
      async () =>
        [
          {
            id: 'local-root',
            kind: 'local',
            transport: 'filesystem',
            label: 'Local',
            uri: '/local',
            writable: true,
            managedOutput: true,
          },
          {
            id: 'remote-root',
            kind: 'remote',
            transport: 'filesystem',
            label: 'Remote',
            uri: '/remote',
            writable: true,
            managedOutput: true,
          },
        ] as unknown as Promise<unknown>

    await service.scanRoots()

    const tracks = await service.listTracks()
    expect(tracks).toHaveLength(1)
    expect(tracks[0]?.identityKind).toBe('lms_source')

    const track = await service.getTrack(tracks[0]!.id)
    expect(track?.files).toHaveLength(2)

    const drift = await service.getDriftSummary()
    expect(drift).toEqual({
      totalManagedTracks: 1,
      inSyncTracks: 1,
      localOnlyTracks: 0,
      remoteOnlyTracks: 0,
      missingEverywhereTracks: 0,
    })

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('exposes local and remote presence flags on library tracks', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const service = new LibraryService(db, {} as never, {} as never)
    const stamp = '2026-05-18T00:00:00.000Z'

    await db.insert(libraryRootsTable).values([
      {
        id: 'root_local',
        kind: 'local',
        transport: 'filesystem',
        label: 'Local',
        uri: '/local',
        writable: true,
        managedOutput: true,
        createdAt: stamp,
        updatedAt: stamp,
        lastScannedAt: stamp,
        lastScanStatus: 'ok',
      },
      {
        id: 'root_remote',
        kind: 'remote',
        transport: 'rclone',
        label: 'Remote',
        uri: 'seedbox:/music',
        writable: true,
        managedOutput: true,
        createdAt: stamp,
        updatedAt: stamp,
        lastScannedAt: stamp,
        lastScanStatus: 'ok',
      },
    ])
    await db.insert(libraryTracksTable).values([
      {
        id: 'track_local',
        identityKind: 'lms_source',
        identityValue: 'youtube_music:local',
        managedByApp: true,
        tagSchemaVersion: 1,
        youtubeMusicTrackId: 'local',
        resolvedYoutubeMusicTrackId: 'local',
        title: 'Local',
        artist: 'Artist',
        album: 'Album',
        albumArtist: 'Artist',
        lyricsStatus: 'synced',
        hasEmbeddedLyrics: true,
        hasSidecarLyrics: false,
        coverArtPresent: true,
        missingFieldsJson: '[]',
        preferredFileId: 'file_local',
        firstSeenAt: stamp,
        lastSeenAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'track_remote',
        identityKind: 'lms_source',
        identityValue: 'youtube_music:remote',
        managedByApp: true,
        tagSchemaVersion: 1,
        youtubeMusicTrackId: 'remote',
        resolvedYoutubeMusicTrackId: 'remote',
        title: 'Remote',
        artist: 'Artist',
        album: 'Album',
        albumArtist: 'Artist',
        lyricsStatus: 'plain',
        hasEmbeddedLyrics: false,
        hasSidecarLyrics: true,
        coverArtPresent: false,
        missingFieldsJson: '[]',
        preferredFileId: 'file_remote',
        firstSeenAt: stamp,
        lastSeenAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'track_both',
        identityKind: 'lms_source',
        identityValue: 'youtube_music:both',
        managedByApp: true,
        tagSchemaVersion: 1,
        youtubeMusicTrackId: 'both',
        resolvedYoutubeMusicTrackId: 'both',
        title: 'Both',
        artist: 'Artist',
        album: 'Album',
        albumArtist: 'Artist',
        lyricsStatus: 'missing',
        hasEmbeddedLyrics: false,
        hasSidecarLyrics: false,
        coverArtPresent: false,
        missingFieldsJson: '[]',
        preferredFileId: 'file_both_local',
        firstSeenAt: stamp,
        lastSeenAt: stamp,
        updatedAt: stamp,
      },
    ])
    await db.insert(libraryFilesTable).values([
      {
        id: 'file_local',
        trackId: 'track_local',
        rootId: 'root_local',
        relativePath: 'local.m4a',
        absolutePathSnapshot: '/local/local.m4a',
        lrcPath: null,
        format: 'm4a',
        sizeBytes: 1,
        durationSeconds: 1,
        bitrate: 1,
        modifiedAt: null,
        sidecarModifiedAt: null,
        audioSha256: null,
        tagFingerprint: null,
        embeddedLyricsStatus: 'synced',
        sidecarLyricsStatus: 'missing',
        missingFieldsJson: '[]',
        discoveredVia: 'lms_tags',
        lastScannedAt: stamp,
        firstSeenAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'file_remote',
        trackId: 'track_remote',
        rootId: 'root_remote',
        relativePath: 'remote.m4a',
        absolutePathSnapshot: 'seedbox:/music/remote.m4a',
        lrcPath: null,
        format: 'm4a',
        sizeBytes: 1,
        durationSeconds: 1,
        bitrate: 1,
        modifiedAt: null,
        sidecarModifiedAt: null,
        audioSha256: null,
        tagFingerprint: null,
        embeddedLyricsStatus: 'missing',
        sidecarLyricsStatus: 'plain',
        missingFieldsJson: '[]',
        discoveredVia: 'lms_tags',
        lastScannedAt: stamp,
        firstSeenAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'file_both_local',
        trackId: 'track_both',
        rootId: 'root_local',
        relativePath: 'both-local.m4a',
        absolutePathSnapshot: '/local/both-local.m4a',
        lrcPath: null,
        format: 'm4a',
        sizeBytes: 1,
        durationSeconds: 1,
        bitrate: 1,
        modifiedAt: null,
        sidecarModifiedAt: null,
        audioSha256: null,
        tagFingerprint: null,
        embeddedLyricsStatus: 'missing',
        sidecarLyricsStatus: 'missing',
        missingFieldsJson: '[]',
        discoveredVia: 'lms_tags',
        lastScannedAt: stamp,
        firstSeenAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'file_both_remote',
        trackId: 'track_both',
        rootId: 'root_remote',
        relativePath: 'both-remote.m4a',
        absolutePathSnapshot: 'seedbox:/music/both-remote.m4a',
        lrcPath: null,
        format: 'm4a',
        sizeBytes: 1,
        durationSeconds: 1,
        bitrate: 1,
        modifiedAt: null,
        sidecarModifiedAt: null,
        audioSha256: null,
        tagFingerprint: null,
        embeddedLyricsStatus: 'missing',
        sidecarLyricsStatus: 'missing',
        missingFieldsJson: '[]',
        discoveredVia: 'lms_tags',
        lastScannedAt: stamp,
        firstSeenAt: stamp,
        updatedAt: stamp,
      },
    ])

    const tracks = await service.listTracks()
    expect(tracks.find((track) => track.id === 'track_local')).toMatchObject({
      hasLocalFile: true,
      hasRemoteFile: false,
    })
    expect(tracks.find((track) => track.id === 'track_remote')).toMatchObject({
      hasLocalFile: false,
      hasRemoteFile: true,
    })
    expect(tracks.find((track) => track.id === 'track_both')).toMatchObject({
      hasLocalFile: true,
      hasRemoteFile: true,
    })

    expect(await service.getTrack('track_both')).toMatchObject({
      hasLocalFile: true,
      hasRemoteFile: true,
    })

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('uses mb, heuristic, and path identities for unmanaged files', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const pythonWorker = {
      runJsonCommand: vi.fn().mockResolvedValue({
        scanned_at: '2026-05-18T00:00:00.000Z',
        files: [
          scannedFile({
            managed_by_app: false,
            tag_schema_version: null,
            youtube_music_track_id: null,
            resolved_youtube_music_track_id: null,
            identity_kind: 'mb_track',
            identity_value: 'mb-track-1',
            discovered_via: 'mb_track',
            mb_track_id: 'mb-track-1',
            relative_path: 'one.m4a',
          }),
          scannedFile({
            managed_by_app: false,
            tag_schema_version: null,
            youtube_music_track_id: null,
            resolved_youtube_music_track_id: null,
            mb_track_id: null,
            isrc: null,
            identity_kind: 'heuristic',
            identity_value: 'artist|title|album|1|1',
            discovered_via: 'heuristic',
            relative_path: 'two.m4a',
          }),
          scannedFile({
            managed_by_app: false,
            tag_schema_version: null,
            youtube_music_track_id: null,
            resolved_youtube_music_track_id: null,
            mb_track_id: null,
            isrc: null,
            album: null,
            identity_kind: 'path',
            identity_value: '/library:three.m4a',
            discovered_via: 'path',
            relative_path: 'three.m4a',
            missing_fields: ['album', 'lyrics'],
            lyrics_status: 'missing',
          }),
        ],
      }),
    }
    const service = new LibraryService(db, {} as never, pythonWorker as never)
    ;(service as { resolveRoots: () => Promise<unknown> }).resolveRoots =
      async () =>
        [
          {
            id: 'library-root',
            kind: 'local',
            transport: 'filesystem',
            label: 'Library',
            uri: '/library',
            writable: true,
            managedOutput: false,
          },
        ] as unknown as Promise<unknown>

    await service.scanRoots()

    const tracks = await service.listTracks()
    expect(tracks.map((track) => track.identityKind).sort()).toEqual([
      'heuristic',
      'mb_track',
      'path',
    ])

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not require language when aggregated lyrics are missing', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const pythonWorker = {
      runJsonCommand: vi.fn().mockResolvedValue({
        scanned_at: '2026-05-18T00:00:00.000Z',
        files: [
          scannedFile({
            language: null,
            lyrics_status: 'missing',
            has_embedded_lyrics: false,
            has_sidecar_lyrics: false,
            missing_fields: ['lyrics'],
          }),
        ],
      }),
    }
    const service = new LibraryService(db, {} as never, pythonWorker as never)
    ;(service as { resolveRoots: () => Promise<unknown> }).resolveRoots =
      async () =>
        [
          {
            id: 'library-root',
            kind: 'local',
            transport: 'filesystem',
            label: 'Library',
            uri: '/library',
            writable: true,
            managedOutput: true,
          },
        ] as unknown as Promise<unknown>

    await service.scanRoots()

    const [track] = await service.listTracks()
    expect(track?.missingFields).toContain('lyrics')
    expect(track?.missingFields).not.toContain('language')

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('requires language when aggregated lyrics exist but tag is absent', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const pythonWorker = {
      runJsonCommand: vi.fn().mockResolvedValue({
        scanned_at: '2026-05-18T00:00:00.000Z',
        files: [
          scannedFile({
            language: null,
            lyrics_status: 'plain',
            has_embedded_lyrics: true,
            missing_fields: ['language'],
          }),
        ],
      }),
    }
    const service = new LibraryService(db, {} as never, pythonWorker as never)
    ;(service as { resolveRoots: () => Promise<unknown> }).resolveRoots =
      async () =>
        [
          {
            id: 'library-root',
            kind: 'local',
            transport: 'filesystem',
            label: 'Library',
            uri: '/library',
            writable: true,
            managedOutput: true,
          },
        ] as unknown as Promise<unknown>

    await service.scanRoots()

    const [track] = await service.listTracks()
    expect(track?.missingFields).toContain('language')
    expect(track?.missingFields).not.toContain('lyrics')

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rebuilds the same managed identities after db wipe and rescan', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const pythonWorker = {
      runJsonCommand: vi.fn().mockResolvedValue({
        scanned_at: '2026-05-18T00:00:00.000Z',
        files: [scannedFile()],
      }),
    }
    const service = new LibraryService(db, {} as never, pythonWorker as never)
    ;(service as { resolveRoots: () => Promise<unknown> }).resolveRoots =
      async () =>
        [
          {
            id: 'library-root',
            kind: 'local',
            transport: 'filesystem',
            label: 'Library',
            uri: '/library',
            writable: true,
            managedOutput: true,
          },
        ] as unknown as Promise<unknown>

    await service.scanRoots()
    const firstIdentity = (await service.listTracks()).map((track) => ({
      kind: track.identityKind,
      value: track.identityValue,
    }))

    await db.delete(libraryFilesTable)
    await db.delete(libraryTracksTable)
    await db.delete(libraryRootsTable)

    await service.scanRoots()
    const secondIdentity = (await service.listTracks()).map((track) => ({
      kind: track.identityKind,
      value: track.identityValue,
    }))

    expect(secondIdentity).toEqual(firstIdentity)

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes legacy unknown albums on read', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const pythonWorker = {
      runJsonCommand: vi.fn().mockResolvedValue({
        scanned_at: '2026-05-18T00:00:00.000Z',
        files: [
          scannedFile({
            album: '_Singles',
            relative_path: 'Artist/_Singles/01 Track Title.m4a',
          }),
        ],
      }),
    }
    const service = new LibraryService(db, {} as never, pythonWorker as never)
    ;(service as { resolveRoots: () => Promise<unknown> }).resolveRoots =
      async () =>
        [
          {
            id: 'library-root',
            kind: 'local',
            transport: 'filesystem',
            label: 'Library',
            uri: '/library',
            writable: true,
            managedOutput: true,
          },
        ] as unknown as Promise<unknown>

    await service.scanRoots()

    const [track] = await service.listTracks()
    expect(track?.album).toBe('Unknown Album')

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports local index readiness from root scan state and meta', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const service = new LibraryService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '/library',
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
        }),
      } as never,
      {} as never
    )

    expect((await service.getIndexStatus()).reason).toBe('never_scanned')

    await db.insert(libraryRootsTable).values({
      id: 'root_local_/library',
      kind: 'local',
      transport: 'filesystem',
      label: 'Local output',
      uri: '/library',
      writable: true,
      managedOutput: true,
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      lastScannedAt: '2026-05-18T00:00:00.000Z',
      lastScanStatus: 'ok',
    })

    expect((await service.getIndexStatus()).reason).toBe('stale_version')

    await db.insert(metaTable).values([
      { key: 'library_index_version', value: '1' },
      { key: 'library_index_local_root_uri', value: '/library' },
    ])

    expect(await service.getIndexStatus()).toMatchObject({
      currentLocalRootUri: '/library',
      ready: true,
      inProgress: false,
      reason: 'ready',
      lastScanStatus: 'ok',
      indexVersion: 1,
    })

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refreshIndex performs incremental reconcile when index is ready', async () => {
    const { db, sqlite, dir } = makeTempDb()
    await db.insert(libraryRootsTable).values({
      id: 'root_local_/library',
      kind: 'local',
      transport: 'filesystem',
      label: 'Local output',
      uri: '/library',
      writable: true,
      managedOutput: true,
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      lastScannedAt: '2026-05-18T00:00:00.000Z',
      lastScanStatus: 'ok',
    })
    await db.insert(metaTable).values([
      { key: 'library_index_version', value: '1' },
      { key: 'library_index_local_root_uri', value: '/library' },
    ])
    await db.insert(libraryTracksTable).values([
      {
        id: 'track_keep',
        identityKind: 'lms_source',
        identityValue: 'youtube_music:liked123',
        managedByApp: true,
        tagSchemaVersion: 1,
        youtubeMusicTrackId: 'liked123',
        resolvedYoutubeMusicTrackId: 'catalog456',
        title: 'Track Title',
        artist: 'Artist Name',
        album: 'Album Name',
        albumArtist: 'Artist Name',
        lyricsStatus: 'synced',
        hasEmbeddedLyrics: true,
        hasSidecarLyrics: false,
        coverArtPresent: true,
        missingFieldsJson: '[]',
        preferredFileId: 'file_keep',
        firstSeenAt: '2026-05-18T00:00:00.000Z',
        lastSeenAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
      {
        id: 'track_delete',
        identityKind: 'path',
        identityValue: '/library:gone.m4a',
        managedByApp: false,
        title: 'Gone',
        artist: 'Ghost',
        album: 'Lost',
        albumArtist: 'Ghost',
        lyricsStatus: 'missing',
        hasEmbeddedLyrics: false,
        hasSidecarLyrics: false,
        coverArtPresent: false,
        missingFieldsJson: '[]',
        preferredFileId: 'file_delete',
        firstSeenAt: '2026-05-18T00:00:00.000Z',
        lastSeenAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
    ])
    await db.insert(libraryFilesTable).values([
      {
        id: 'file_keep',
        trackId: 'track_keep',
        rootId: 'root_local_/library',
        relativePath: 'keep.m4a',
        absolutePathSnapshot: '/library/keep.m4a',
        lrcPath: null,
        format: 'm4a',
        sizeBytes: 123,
        durationSeconds: 120,
        bitrate: 256000,
        modifiedAt: '2026-05-18T00:00:00.000Z',
        sidecarModifiedAt: null,
        audioSha256: null,
        tagFingerprint: 'fingerprint',
        embeddedLyricsStatus: 'synced',
        sidecarLyricsStatus: 'missing',
        missingFieldsJson: '[]',
        discoveredVia: 'lms_tags',
        lastScannedAt: '2026-05-18T00:00:00.000Z',
        firstSeenAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
      {
        id: 'file_delete',
        trackId: 'track_delete',
        rootId: 'root_local_/library',
        relativePath: 'gone.m4a',
        absolutePathSnapshot: '/library/gone.m4a',
        lrcPath: null,
        format: 'm4a',
        sizeBytes: 77,
        durationSeconds: 90,
        bitrate: 256000,
        modifiedAt: '2026-05-18T00:00:00.000Z',
        sidecarModifiedAt: null,
        audioSha256: null,
        tagFingerprint: 'gone',
        embeddedLyricsStatus: 'missing',
        sidecarLyricsStatus: 'missing',
        missingFieldsJson: '[]',
        discoveredVia: 'path',
        lastScannedAt: '2026-05-18T00:00:00.000Z',
        firstSeenAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
    ])

    const pythonWorker = {
      runJsonCommand: vi.fn().mockResolvedValue({
        scanned_at: '2026-05-19T00:00:00.000Z',
        files: [
          scannedFile({
            relative_path: 'keep.m4a',
            absolute_path_snapshot: '/library/keep.m4a',
            lrc_path: '/library/keep.lrc',
            size_bytes: 456,
            modified_at: '2026-05-19T00:00:00.000Z',
            sidecar_modified_at: '2026-05-19T00:00:01.000Z',
          }),
        ],
        deleted_relative_paths: ['gone.m4a'],
      }),
    }
    const service = new LibraryService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '/library',
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
        }),
      } as never,
      pythonWorker as never
    )

    const result = await service.refreshIndex()
    expect(result.ok).toBe(true)
    expect(vi.mocked(pythonWorker.runJsonCommand)).toHaveBeenCalledWith(
      'library-reconcile-local-root',
      expect.objectContaining({
        uri: '/library',
      })
    )

    const files = await db.select().from(libraryFilesTable)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      relativePath: 'keep.m4a',
      sidecarModifiedAt: '2026-05-19T00:00:01.000Z',
    })

    const tracks = await db.select().from(libraryTracksTable)
    expect(tracks).toHaveLength(1)
    expect((await service.getIndexStatus()).ready).toBe(true)

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('album grouping', () => {
  it('collapses unknown albums across artists into one Various Artists card', () => {
    const albums = groupAlbums([
      {
        id: '1',
        identityKind: 'lms_source',
        identityValue: 'one',
        managedByApp: true,
        tagSchemaVersion: 2,
        youtubeMusicTrackId: 'yt1',
        spotifyTrackId: null,
        soundcloudTrackId: null,
        resolvedYoutubeMusicTrackId: 'yt1',
        sourceOrigin: null,
        catalogReleaseBrowseId: null,
        catalogReleaseTitle: null,
        catalogReleaseKind: null,
        title: 'Track One',
        artist: 'Artist One',
        album: 'Unknown Album',
        albumArtist: 'Artist One',
        trackNumber: 1,
        trackTotal: 1,
        discNumber: 1,
        discTotal: 1,
        year: 2024,
        date: null,
        genre: null,
        language: null,
        isrc: null,
        mbTrackId: null,
        mbAlbumId: null,
        mbReleaseGroupId: null,
        lyricsStatus: 'missing',
        hasEmbeddedLyrics: false,
        hasSidecarLyrics: false,
        coverArtPresent: false,
        hasLocalFile: true,
        hasRemoteFile: false,
        missingFields: [],
        preferredFileId: null,
        firstSeenAt: '2026-05-18T00:00:00.000Z',
        lastSeenAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
      {
        id: '2',
        identityKind: 'lms_source',
        identityValue: 'two',
        managedByApp: true,
        tagSchemaVersion: 2,
        youtubeMusicTrackId: 'yt2',
        spotifyTrackId: null,
        soundcloudTrackId: null,
        resolvedYoutubeMusicTrackId: 'yt2',
        sourceOrigin: null,
        catalogReleaseBrowseId: null,
        catalogReleaseTitle: null,
        catalogReleaseKind: null,
        title: 'Track Two',
        artist: 'Artist Two',
        album: '_Singles',
        albumArtist: 'Artist Two',
        trackNumber: 1,
        trackTotal: 1,
        discNumber: 1,
        discTotal: 1,
        year: 2025,
        date: null,
        genre: null,
        language: null,
        isrc: null,
        mbTrackId: null,
        mbAlbumId: null,
        mbReleaseGroupId: null,
        lyricsStatus: 'missing',
        hasEmbeddedLyrics: false,
        hasSidecarLyrics: false,
        coverArtPresent: false,
        hasLocalFile: true,
        hasRemoteFile: false,
        missingFields: [],
        preferredFileId: null,
        firstSeenAt: '2026-05-18T00:00:00.000Z',
        lastSeenAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
    ])

    expect(albums).toHaveLength(1)
    expect(albums[0]).toMatchObject({
      album: 'Unknown Album',
      albumArtist: 'Various Artists',
      trackCount: 2,
    })
  })
})

describe('sync job track contract', () => {
  it('persists and exposes the widened job track fields', async () => {
    const { db, sqlite, dir } = makeTempDb()
    await db.insert(syncJobsTable).values({
      id: 'job_1',
      kind: 'liked_songs_sync',
      scope: null,
      label: 'Liked Songs Sync',
      status: 'running',
      queueBucket: 'queue',
      startedAt: '2026-05-18T00:00:00.000Z',
      endedAt: null,
      plannedCount: 0,
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    })

    const service = new SyncService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () => 'ffmpeg'
    )

    await (
      service as unknown as {
        upsertJobTrack: (
          jobId: string,
          item: Record<string, unknown>
        ) => Promise<void>
      }
    ).upsertJobTrack('job_1', {
      id: 'item_1',
      youtube_music_track_id: 'liked123',
      spotify_track_id: null,
      soundcloud_track_id: null,
      resolved_youtube_music_track_id: 'catalog456',
      title: 'Track Title',
      artist: 'Artist Name',
      album: 'Album Name',
      album_artist: 'Album Artist',
      source_url: 'https://music.youtube.com/watch?v=liked123',
      status: 'completed',
      stage: 'finalize',
      source_kind: 'liked_song',
      resolution_method: 'search_song_exact',
      track_number: 1,
      track_total: 10,
      disc_number: 1,
      disc_total: 1,
      year: 2024,
      date: '2024-03-01',
      genre: 'rock',
      language: 'en',
      isrc: 'USABC1234567',
      mb_track_id: 'mb-track',
      mb_album_id: 'mb-album',
      mb_releasegroup_id: 'mb-group',
      lyrics_status: 'synced',
      output_path: '/tmp/track.m4a',
      lrc_path: '/tmp/track.lrc',
    })

    const [track] = await db.select().from(syncJobTracksTable)
    expect(track).toMatchObject({
      youtubeMusicTrackId: 'liked123',
      resolvedYoutubeMusicTrackId: 'catalog456',
      discNumber: 1,
      discTotal: 1,
      genre: 'rock',
      language: 'en',
      isrc: 'USABC1234567',
      mbTrackId: 'mb-track',
      mbAlbumId: 'mb-album',
      mbReleaseGroupId: 'mb-group',
      lyricsStatus: 'synced',
    })

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('liked artists service', () => {
  it('refreshes artists from local library tracks and preserves favorite fields', async () => {
    const { db, sqlite, dir } = makeTempDb()
    await db.insert(likedArtistsTable).values({
      id: 'artist_channel_1',
      channelId: 'channel_1',
      name: 'Old Name',
      normalizedName: 'artist name',
      photoUrl: null,
      likedTrackCount: 1,
      lastRefreshedAt: '2026-05-18T00:00:00.000Z',
      isFavorite: true,
      favoritedAt: '2026-05-18T00:01:00.000Z',
      lastCatalogRefreshedAt: '2026-05-18T00:02:00.000Z',
      catalogTrackCount: 42,
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    })
    await db.insert(libraryTracksTable).values([
      {
        id: 'track_1',
        identityKind: 'lms_source',
        identityValue: 'youtube_music:track_1',
        managedByApp: true,
        artist: 'Artist Name',
        title: 'Track 1',
        album: 'Album',
        albumArtist: 'Artist Name',
        lyricsStatus: 'missing',
        hasEmbeddedLyrics: false,
        hasSidecarLyrics: false,
        coverArtPresent: false,
        firstSeenAt: '2026-05-18T00:00:00.000Z',
        lastSeenAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
      {
        id: 'track_2',
        identityKind: 'lms_source',
        identityValue: 'youtube_music:track_2',
        managedByApp: true,
        artist: 'Artist Name',
        title: 'Track 2',
        album: 'Album',
        albumArtist: 'Artist Name',
        lyricsStatus: 'missing',
        hasEmbeddedLyrics: false,
        hasSidecarLyrics: false,
        coverArtPresent: false,
        firstSeenAt: '2026-05-18T00:00:00.000Z',
        lastSeenAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
    ])

    const service = new LikedArtistsService(db)

    await service.refreshArtists()

    const artists = await service.listArtists()
    expect(artists.map((artist) => artist.id)).toEqual([
      'local_artist_artist_name',
    ])
    const [artist] = artists
    expect(artist).toMatchObject({
      id: 'local_artist_artist_name',
      name: 'Artist Name',
      likedTrackCount: 2,
      isFavorite: true,
      favoritedAt: '2026-05-18T00:01:00.000Z',
      lastCatalogRefreshedAt: '2026-05-18T00:02:00.000Z',
      catalogTrackCount: 42,
    })

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps unfound favorite artists after library refresh', async () => {
    const { db, sqlite, dir } = makeTempDb()
    await db.insert(likedArtistsTable).values([
      {
        id: 'favorite_missing',
        channelId: 'channel_1',
        name: 'Favorite Missing',
        normalizedName: 'favorite missing',
        photoUrl: null,
        likedTrackCount: 1,
        lastRefreshedAt: '2026-05-18T00:00:00.000Z',
        isFavorite: true,
        favoritedAt: '2026-05-18T00:01:00.000Z',
        lastCatalogRefreshedAt: null,
        catalogTrackCount: null,
        createdAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
      {
        id: 'nonfavorite_missing',
        channelId: 'channel_2',
        name: 'Nonfavorite Missing',
        normalizedName: 'nonfavorite missing',
        photoUrl: null,
        likedTrackCount: 1,
        lastRefreshedAt: '2026-05-18T00:00:00.000Z',
        isFavorite: false,
        favoritedAt: null,
        lastCatalogRefreshedAt: null,
        catalogTrackCount: null,
        createdAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
    ])
    const service = new LikedArtistsService(db)

    await service.refreshArtists()

    const artists = await service.listArtists()
    expect(artists.map((artist) => artist.id)).toEqual(['favorite_missing'])

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stamps favoritedAt only the first time', async () => {
    const { db, sqlite, dir } = makeTempDb()
    await db.insert(likedArtistsTable).values({
      id: 'artist_1',
      channelId: 'channel_1',
      name: 'Artist',
      normalizedName: 'artist',
      photoUrl: null,
      likedTrackCount: 1,
      lastRefreshedAt: '2026-05-18T00:00:00.000Z',
      isFavorite: false,
      favoritedAt: null,
      lastCatalogRefreshedAt: null,
      catalogTrackCount: null,
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    })
    const service = new LikedArtistsService(db)

    await service.setArtistFavorite('artist_1', true)
    const [first] = await service.listArtists()
    await service.setArtistFavorite('artist_1', true)
    const [second] = await service.listArtists()

    expect(first?.favoritedAt).toBeTruthy()
    expect(second?.favoritedAt).toBe(first?.favoritedAt)

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('caches artist images without blocking local artist refresh', async () => {
    const { db, sqlite, dir } = makeTempDb()
    await db.insert(likedArtistsTable).values({
      id: 'local_artist_artist',
      channelId: null,
      name: 'Artist',
      normalizedName: 'artist',
      photoUrl: null,
      likedTrackCount: 1,
      lastRefreshedAt: '2026-05-18T00:00:00.000Z',
      isFavorite: false,
      favoritedAt: null,
      lastCatalogRefreshedAt: null,
      catalogTrackCount: null,
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    })
    const service = new LikedArtistsService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          ytmusicBrowserAuth: 'auth',
        }),
        saveYtMusicBrowserAuth: vi.fn(),
      } as never,
      {
        runJsonCommand: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            is_authenticated: true,
            message: 'ok',
          })
          .mockResolvedValueOnce({
            ok: true,
            artist: {
              id: 'local_artist_artist',
              channel_id: 'channel_1',
              photo_url: 'https://example.test/artist.jpg',
            },
          }),
      } as never
    )

    const result = await service.refreshArtistImages()

    expect(result.ok).toBe(true)
    const [artist] = await service.listArtists()
    expect(artist).toMatchObject({
      channelId: 'channel_1',
      photoUrl: 'https://example.test/artist.jpg',
    })

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('publishes artist photo updates as each image is cached', async () => {
    const { db, sqlite, dir } = makeTempDb()
    await db.insert(likedArtistsTable).values({
      id: 'local_artist_artist',
      channelId: null,
      name: 'Artist',
      normalizedName: 'artist',
      photoUrl: null,
      likedTrackCount: 1,
      lastRefreshedAt: '2026-05-18T00:00:00.000Z',
      isFavorite: false,
      favoritedAt: null,
      lastCatalogRefreshedAt: null,
      catalogTrackCount: null,
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    })
    const service = new LikedArtistsService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          ytmusicBrowserAuth: 'auth',
        }),
        saveYtMusicBrowserAuth: vi.fn(),
      } as never,
      {
        runJsonCommand: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            is_authenticated: true,
            message: 'ok',
          })
          .mockResolvedValueOnce({
            ok: true,
            artist: {
              id: 'local_artist_artist',
              channel_id: 'channel_1',
              photo_url: 'https://example.test/artist.jpg',
            },
          }),
      } as never
    )

    const updates: Array<{ artistId: string; photoUrl: string }> = []
    const unsub = service.subscribeArtistPhotoUpdates((update) => {
      updates.push({ artistId: update.artistId, photoUrl: update.photoUrl })
    })

    await service.refreshArtistImages()
    unsub()

    expect(updates).toEqual([
      {
        artistId: 'local_artist_artist',
        photoUrl: 'https://example.test/artist.jpg',
      },
    ])

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('favorite artist catalog sync', () => {
  it('rejects when no favorites are selected', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const service = new SyncService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {
        listFavoriteArtists: vi.fn().mockResolvedValue([]),
      } as never,
      {} as never,
      () => 'ffmpeg'
    )

    const result = await service.refreshFavoriteArtists(['artist_1'])

    expect(result.ok).toBe(false)
    expect(result.message).toContain('favorite artist')

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('starts favorite catalog runs with catalog payload and trigger mode', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = {
      stdout,
      stderr,
      on: vi.fn(),
    }
    const spawnNdjsonCommand = vi.fn().mockReturnValue(child)
    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '/tmp/out',
          dryRun: false,
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
          lyricsApiBaseUrl: '',
          ytmusicBrowserAuth: 'auth',
          ytDlpCookiesBrowser: 'firefox',
          folderTemplate: '{albumartist}/{album}',
          fileTemplate: '{track:02d} {title}',
          embedUnsyncedLyrics: true,
          writeLrcSidecar: true,
        }),
        saveYtMusicBrowserAuth: vi.fn(),
      } as never,
      {
        runJsonCommand: vi.fn().mockResolvedValue({
          ok: true,
          is_authenticated: true,
          message: 'ok',
        }),
        spawnNdjsonCommand,
      } as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue(readyIndexStatus()),
        getIndexNotReadyResult: vi.fn(),
        getManagedLocalSignatures: vi.fn().mockResolvedValue({
          sourceIds: new Set(['liked_existing']),
          resolvedIds: new Set(['resolved_existing']),
          trackSignatures: [],
          releaseSignatures: [],
        }),
      } as never,
      {
        listFavoriteArtists: vi.fn().mockResolvedValue([
          {
            id: 'artist_1',
            channelId: 'channel_1',
            name: 'Artist One',
            normalizedName: 'artist one',
            photoUrl: null,
            likedTrackCount: 5,
            lastRefreshedAt: '2026-05-18T00:00:00.000Z',
            isFavorite: true,
            favoritedAt: '2026-05-18T00:01:00.000Z',
            lastCatalogRefreshedAt: null,
            catalogTrackCount: null,
          },
        ]),
      } as never,
      {
        ensureReady: vi.fn().mockResolvedValue(undefined),
        getBundleStatus: vi.fn().mockReturnValue({
          pluginDirectory: '/tmp/plugins',
          baseUrl: 'http://127.0.0.1:4416',
        }),
      } as never,
      () => 'ffmpeg'
    )

    const result = await service.refreshFavoriteArtists(['artist_1'])

    expect(result.ok).toBe(true)
    expect(spawnNdjsonCommand).toHaveBeenCalledWith(
      'sync-job',
      expect.objectContaining({
        job_id: expect.any(String),
        favorite_artist_catalogs: [
          {
            id: 'artist_1',
            channel_id: 'channel_1',
            name: 'Artist One',
            normalized_name: 'artist one',
          },
        ],
        force_reprocess: false,
      })
    )
    const [job] = await db.select().from(syncJobsTable)
    expect(job?.kind).toBe('favorite_artist_catalog_refresh')

    stdout.destroy()
    stderr.destroy()
    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('forwards child stderr to terminal and temp mirror unchanged', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = {
      stdout,
      stderr,
      on: vi.fn(),
    }
    const spawnNdjsonCommand = vi.fn().mockReturnValue(child)
    const tempLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-log-'))
    const mirror = createTempLogMirror(tempLogDir)
    setTempLogMirror(mirror)
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true as never)

    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '/tmp/out',
          dryRun: false,
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
          lyricsApiBaseUrl: '',
          ytmusicBrowserAuth: 'auth',
          ytDlpCookiesBrowser: 'firefox',
          folderTemplate: '{albumartist}/{album}',
          fileTemplate: '{track:02d} {title}',
          embedUnsyncedLyrics: true,
          writeLrcSidecar: true,
        }),
        saveYtMusicBrowserAuth: vi.fn(),
      } as never,
      {
        runJsonCommand: vi.fn().mockResolvedValue({
          ok: true,
          is_authenticated: true,
          message: 'ok',
        }),
        spawnNdjsonCommand,
      } as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue(readyIndexStatus()),
        getIndexNotReadyResult: vi.fn(),
        getManagedLocalSignatures: vi.fn().mockResolvedValue({
          sourceIds: new Set(['liked_existing']),
          resolvedIds: new Set(['resolved_existing']),
          trackSignatures: [],
          releaseSignatures: [],
        }),
      } as never,
      {
        listFavoriteArtists: vi.fn().mockResolvedValue([
          {
            id: 'artist_1',
            channelId: 'channel_1',
            name: 'Artist One',
            normalizedName: 'artist one',
            photoUrl: null,
            likedTrackCount: 5,
            lastRefreshedAt: '2026-05-18T00:00:00.000Z',
            isFavorite: true,
            favoritedAt: '2026-05-18T00:01:00.000Z',
            lastCatalogRefreshedAt: null,
            catalogTrackCount: null,
          },
        ]),
      } as never,
      {
        ensureReady: vi.fn().mockResolvedValue(undefined),
        getBundleStatus: vi.fn().mockReturnValue({
          pluginDirectory: '/tmp/plugins',
          baseUrl: 'http://127.0.0.1:4416',
        }),
      } as never,
      () => 'ffmpeg'
    )

    await service.refreshFavoriteArtists(['artist_1'])

    stderr.write('yt-dlp: ERROR one\nsecond line\n')
    mirror?.dispose()

    expect(stderrWrite).toHaveBeenCalledWith('yt-dlp: ERROR one\nsecond line\n')
    expect(fs.readFileSync(mirror!.getLogFilePath(), 'utf8')).toContain(
      '[stderr] yt-dlp: ERROR one\n[stderr] second line\n'
    )

    stdout.destroy()
    stderr.destroy()
    sqlite.close()
    fs.rmSync(tempLogDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('mirrors parsed worker log events to terminal and temp mirror as pretty lines', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = {
      stdout,
      stderr,
      on: vi.fn(),
    }
    const spawnNdjsonCommand = vi.fn().mockReturnValue(child)
    const tempLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-log-'))
    const mirror = createTempLogMirror(tempLogDir)
    setTempLogMirror(mirror)
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true as never)

    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '/tmp/out',
          dryRun: false,
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
          lyricsApiBaseUrl: '',
          ytmusicBrowserAuth: 'auth',
          ytDlpCookiesBrowser: 'firefox',
          folderTemplate: '{albumartist}/{album}',
          fileTemplate: '{track:02d} {title}',
          embedUnsyncedLyrics: true,
          writeLrcSidecar: true,
        }),
        saveYtMusicBrowserAuth: vi.fn(),
      } as never,
      {
        runJsonCommand: vi.fn().mockResolvedValue({
          ok: true,
          is_authenticated: true,
          message: 'ok',
        }),
        spawnNdjsonCommand,
      } as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue(readyIndexStatus()),
        getIndexNotReadyResult: vi.fn(),
        getManagedLocalSignatures: vi.fn().mockResolvedValue({
          sourceIds: new Set(['liked_existing']),
          resolvedIds: new Set(['resolved_existing']),
          trackSignatures: [],
          releaseSignatures: [],
        }),
      } as never,
      {
        listFavoriteArtists: vi.fn().mockResolvedValue([
          {
            id: 'artist_1',
            channelId: 'channel_1',
            name: 'Artist One',
            normalizedName: 'artist one',
            photoUrl: null,
            likedTrackCount: 5,
            lastRefreshedAt: '2026-05-18T00:00:00.000Z',
            isFavorite: true,
            favoritedAt: '2026-05-18T00:01:00.000Z',
            lastCatalogRefreshedAt: null,
            catalogTrackCount: null,
          },
        ]),
      } as never,
      {
        ensureReady: vi.fn().mockResolvedValue(undefined),
        getBundleStatus: vi.fn().mockReturnValue({
          pluginDirectory: '/tmp/plugins',
          baseUrl: 'http://127.0.0.1:4416',
        }),
      } as never,
      () => 'ffmpeg'
    )

    await service.refreshFavoriteArtists(['artist_1'])

    const line = `${JSON.stringify({
      type: 'log',
      job_id: 'job_test',
      item_id: 'item_test',
      youtube_music_track_id: 'ytm_test',
      timestamp: '2026-05-23T23:45:00.000Z',
      level: 'info',
      stage: 'download',
      event: 'worker-progress',
      message: 'downloaded chunk',
      context: { bytes: 1234 },
    })}\n`
    stdout.write(line)
    await new Promise((resolve) => setImmediate(resolve))
    mirror?.dispose()

    expect(stdoutWrite).toHaveBeenCalledWith(
      '[2026-05-23T23:45:00.000Z] [info] [worker][job_test][item_test] [download] worker-progress downloaded chunk | bytes=1234\n'
    )
    expect(fs.readFileSync(mirror!.getLogFilePath(), 'utf8')).not.toContain(
      `[stdout] ${line}`
    )
    expect(fs.readFileSync(mirror!.getLogFilePath(), 'utf8')).toContain(
      '[stdout] [2026-05-23T23:45:00.000Z] [info] [worker][job_test][item_test] [download] worker-progress downloaded chunk | bytes=1234\n'
    )

    stdout.destroy()
    stderr.destroy()
    sqlite.close()
    fs.rmSync(tempLogDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('logs pre-worker setup blockers before returning', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true as never)
    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '',
          dryRun: false,
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
          lyricsApiBaseUrl: '',
          ytmusicBrowserAuth: 'auth',
          ytDlpCookiesBrowser: 'firefox',
          folderTemplate: '{albumartist}/{album}',
          fileTemplate: '{track:02d} {title}',
          embedUnsyncedLyrics: true,
          writeLrcSidecar: true,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listFavoriteArtists: vi.fn().mockResolvedValue([
          {
            id: 'artist_1',
            channelId: null,
            name: 'Artist One',
            normalizedName: 'artist one',
            photoUrl: null,
            likedTrackCount: 5,
            lastRefreshedAt: '2026-05-18T00:00:00.000Z',
            isFavorite: true,
            favoritedAt: '2026-05-18T00:01:00.000Z',
            lastCatalogRefreshedAt: null,
            catalogTrackCount: null,
          },
        ]),
      } as never,
      {} as never,
      () => 'ffmpeg'
    )

    const result = await service.refreshFavoriteArtists(['artist_1'])

    expect(result.ok).toBe(false)
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('startRun setup started')
    )
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('startRun blocked: missing output directory')
    )

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('clear failures', () => {
  it('removes only failure-bucket jobs and related rows', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const stamp = '2026-05-18T00:00:00.000Z'
    const service = new SyncService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () => 'ffmpeg'
    )

    await db.insert(syncJobsTable).values([
      {
        id: 'job_failed',
        kind: 'liked_songs_sync',
        scope: null,
        label: 'Failed Job',
        status: 'failed',
        queueBucket: 'failures',
        startedAt: stamp,
        endedAt: stamp,
        plannedCount: 1,
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'job_queue',
        kind: 'liked_songs_sync',
        scope: null,
        label: 'Queued Job',
        status: 'queued',
        queueBucket: 'queue',
        startedAt: stamp,
        endedAt: null,
        plannedCount: 1,
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'job_completed',
        kind: 'liked_songs_sync',
        scope: null,
        label: 'Completed Job',
        status: 'completed',
        queueBucket: 'completed',
        startedAt: stamp,
        endedAt: stamp,
        plannedCount: 1,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ])
    await db.insert(syncJobTracksTable).values([
      {
        id: 'track_failed',
        jobId: 'job_failed',
        libraryTrackId: null,
        youtubeMusicTrackId: 'yt_failed',
        spotifyTrackId: null,
        soundcloudTrackId: null,
        resolvedYoutubeMusicTrackId: null,
        title: 'Failed',
        artist: 'Artist',
        album: 'Album',
        albumArtist: 'Artist',
        sourceUrl: 'https://example.com/failed',
        coverArtUrl: null,
        status: 'failed_terminal',
        stage: 'finalize',
        reasonCode: 'boom',
        reasonDetail: 'boom',
        sourceKind: 'liked_song',
        sourceOrigin: null,
        catalogReleaseBrowseId: null,
        catalogReleaseTitle: null,
        catalogReleaseKind: null,
        videoType: null,
        resolutionMethod: 'exact',
        trackNumber: null,
        trackTotal: null,
        discNumber: null,
        discTotal: null,
        year: null,
        date: null,
        genre: null,
        language: null,
        isrc: null,
        mbTrackId: null,
        mbAlbumId: null,
        mbReleaseGroupId: null,
        lyricsStatus: 'missing',
        audioCodec: null,
        metadataMatched: false,
        musicBrainzMatched: false,
        lyricsMatched: false,
        lyricsSource: null,
        selectedSourceUrl: null,
        visible: true,
        terminalOutcome: 'failed',
        sortIndex: 0,
        remoteTarget: null,
        jobPhase: null,
        currentOutputPath: null,
        outputPath: null,
        lrcPath: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'track_queue',
        jobId: 'job_queue',
        libraryTrackId: null,
        youtubeMusicTrackId: 'yt_queue',
        spotifyTrackId: null,
        soundcloudTrackId: null,
        resolvedYoutubeMusicTrackId: null,
        title: 'Queued',
        artist: 'Artist',
        album: 'Album',
        albumArtist: 'Artist',
        sourceUrl: 'https://example.com/queue',
        coverArtUrl: null,
        status: 'pending',
        stage: 'idle',
        reasonCode: '',
        reasonDetail: '',
        sourceKind: 'liked_song',
        sourceOrigin: null,
        catalogReleaseBrowseId: null,
        catalogReleaseTitle: null,
        catalogReleaseKind: null,
        videoType: null,
        resolutionMethod: 'exact',
        trackNumber: null,
        trackTotal: null,
        discNumber: null,
        discTotal: null,
        year: null,
        date: null,
        genre: null,
        language: null,
        isrc: null,
        mbTrackId: null,
        mbAlbumId: null,
        mbReleaseGroupId: null,
        lyricsStatus: 'missing',
        audioCodec: null,
        metadataMatched: false,
        musicBrainzMatched: false,
        lyricsMatched: false,
        lyricsSource: null,
        selectedSourceUrl: null,
        visible: true,
        terminalOutcome: null,
        sortIndex: 0,
        remoteTarget: null,
        jobPhase: null,
        currentOutputPath: null,
        outputPath: null,
        lrcPath: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ])
    await expect(service.clearFailures()).resolves.toMatchObject({ ok: true })

    const jobs = await db.select().from(syncJobsTable)
    const tracks = await db.select().from(syncJobTracksTable)
    expect(jobs.map((job) => job.id).sort()).toEqual([
      'job_completed',
      'job_queue',
    ])
    expect(tracks.map((track) => track.id)).toEqual(['track_queue'])

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('remote shell scanner helpers', () => {
  it('parses rclone SFTP config', () => {
    expect(
      parseRcloneSftpConfig(
        'type = sftp\nhost = 168.138.74.194\nuser = ubuntu\nkey_file = /tmp/key\n'
      )
    ).toEqual({
      type: 'sftp',
      host: '168.138.74.194',
      user: 'ubuntu',
      keyFile: '/tmp/key',
    })
  })

  it('builds SSH scanner command from rclone config', () => {
    const args = buildRemoteScannerSshArgs({
      config: {
        type: 'sftp',
        host: '168.138.74.194',
        user: 'ubuntu',
        keyFile: '/tmp/key',
      },
      remoteMusicRoot: 'louismollick-server/music',
    })

    expect(args.slice(0, 7)).toEqual([
      '-i',
      '/tmp/key',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      'ubuntu@168.138.74.194',
    ])
    expect(args[7]).toContain("cd '/home/ubuntu/louismollick-server/music'")
    expect(args[7]).toContain('exiftool')
  })

  it('normalizes exiftool JSON', () => {
    expect(
      normalizeExiftoolJson(
        '[{"SourceFile":"./A/B.m4a","LMS_YOUTUBE_MUSIC_TRACK_ID":"source","LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID":"resolved"}]',
        '2026-05-20T00:00:00.000Z'
      )
    ).toEqual({
      scannedAt: '2026-05-20T00:00:00.000Z',
      filesScanned: 1,
      identities: [
        {
          relativePath: 'A/B.m4a',
          youtubeMusicTrackId: 'source',
          resolvedYoutubeMusicTrackId: 'resolved',
        },
      ],
    })
  })
})

describe('library reprocess candidates', () => {
  it('persists streamed preview batches before reprocess preview exits', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const child = createMockChildProcess()
    const spawnNdjsonCommand = vi.fn().mockReturnValue(child)
    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '/tmp/out',
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
          lyricsApiBaseUrl: '',
          ytmusicBrowserAuth: 'auth',
          ytDlpCookiesBrowser: 'firefox',
          folderTemplate: '{albumartist}/{album}',
          fileTemplate: '{track:02d} {title}',
          embedUnsyncedLyrics: true,
          writeLrcSidecar: true,
        }),
        saveYtMusicBrowserAuth: vi.fn(),
      } as never,
      {
        runJsonCommand: vi.fn().mockResolvedValue({
          ok: true,
          is_authenticated: true,
          message: 'ok',
        }),
        spawnNdjsonCommand,
      } as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue(readyIndexStatus()),
        getIndexNotReadyResult: vi.fn(),
      } as never,
      {} as never,
      {
        ensureReady: vi.fn().mockResolvedValue(undefined),
        getBundleStatus: vi.fn().mockReturnValue({
          pluginDirectory: '/tmp/plugins',
          baseUrl: 'http://127.0.0.1:4416',
        }),
      } as never,
      () => 'ffmpeg'
    )

    ;(
      service as unknown as {
        buildReprocessCandidates: () => Promise<Array<Record<string, unknown>>>
      }
    ).buildReprocessCandidates = vi.fn().mockResolvedValue([
      {
        track_work_id: 'track_work_1',
        library_track_id: 'library_track_1',
        youtube_music_track_id: 'liked123',
        spotify_track_id: null,
        soundcloud_track_id: null,
        resolved_youtube_music_track_id: 'resolved123',
        source_origin: null,
        catalog_release_browse_id: null,
        catalog_release_title: null,
        catalog_release_kind: null,
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        album_artist: 'Artist',
        track_number: 1,
        track_total: 1,
        disc_number: 1,
        disc_total: 1,
        year: 2026,
        date: null,
        genre: null,
        language: null,
        isrc: null,
        mb_track_id: null,
        mb_album_id: null,
        mb_releasegroup_id: null,
        lyrics_status: 'missing',
        current_output_path: '/tmp/out/Artist/Album/01 Song.m4a',
        current_lrc_path: null,
        cover_art_present: false,
      } as never,
    ])

    const startPromise = service.startLibraryReprocess()
    await new Promise((resolve) => setTimeout(resolve, 0))

    child.stdout.write(
      `${JSON.stringify({
        type: 'track',
        event: 'upsert',
        job_id: 'ignored',
        item: {
          id: 'track_work_1',
          youtube_music_track_id: 'liked123',
          resolved_youtube_music_track_id: 'resolved123',
          title: 'Song (Remastered)',
          artist: 'Artist',
          album: 'Album',
          album_artist: 'Artist',
          source_url: 'https://music.youtube.com/watch?v=liked123',
          status: 'processing',
          stage: 'tagging',
          reason_code: '',
          reason_detail: '',
          resolution_method: 'exact',
          lyrics_status: 'missing',
        },
      })}\n`
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(await db.select().from(syncJobTracksTable)).toHaveLength(1)
    child.emitExit(0, null)

    await expect(startPromise).resolves.toMatchObject({
      ok: true,
      message: 'Reprocess started.',
    })

    const [job] = await db.select().from(syncJobsTable)
    expect(['running', 'completed']).toContain(job?.status)
    expect(spawnNdjsonCommand).toHaveBeenCalledWith(
      'reprocess-job',
      expect.any(Object)
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('runs reprocess as a direct worker job', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const child = createMockChildProcess()
    const spawnNdjsonCommand = vi.fn().mockReturnValue(child)
    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '/tmp/out',
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
          lyricsApiBaseUrl: '',
          ytmusicBrowserAuth: 'auth',
          ytDlpCookiesBrowser: 'firefox',
          folderTemplate: '{albumartist}/{album}',
          fileTemplate: '{track:02d} {title}',
          embedUnsyncedLyrics: true,
          writeLrcSidecar: true,
        }),
        saveYtMusicBrowserAuth: vi.fn(),
      } as never,
      {
        runJsonCommand: vi.fn().mockResolvedValue({
          ok: true,
          is_authenticated: true,
          message: 'ok',
        }),
        spawnNdjsonCommand,
      } as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue(readyIndexStatus()),
        getIndexNotReadyResult: vi.fn(),
        upsertLocalOutputs: vi.fn().mockResolvedValue(undefined),
        upsertRemoteCopyFromLocalPath: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        refreshArtists: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        ensureReady: vi.fn().mockResolvedValue(undefined),
        getBundleStatus: vi.fn().mockReturnValue({
          pluginDirectory: '/tmp/plugins',
          baseUrl: 'http://127.0.0.1:4416',
        }),
      } as never,
      () => 'ffmpeg'
    )

    ;(
      service as unknown as {
        buildReprocessCandidates: () => Promise<Array<Record<string, unknown>>>
      }
    ).buildReprocessCandidates = vi.fn().mockResolvedValue([
      {
        track_work_id: 'track_work_1',
        library_track_id: 'library_track_1',
        youtube_music_track_id: 'liked123',
        spotify_track_id: null,
        soundcloud_track_id: null,
        resolved_youtube_music_track_id: 'resolved123',
        source_origin: null,
        catalog_release_browse_id: null,
        catalog_release_title: null,
        catalog_release_kind: null,
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        album_artist: 'Artist',
        track_number: 1,
        track_total: 1,
        disc_number: 1,
        disc_total: 1,
        year: 2026,
        date: null,
        genre: null,
        language: null,
        isrc: null,
        mb_track_id: null,
        mb_album_id: null,
        mb_releasegroup_id: null,
        lyrics_status: 'missing',
        current_output_path: '/tmp/out/Artist/Album/01 Song.m4a',
        current_lrc_path: null,
        cover_art_present: false,
      } as never,
    ])

    await expect(service.startLibraryReprocess()).resolves.toMatchObject({
      ok: true,
      message: 'Reprocess started.',
    })

    expect(spawnNdjsonCommand).toHaveBeenCalledWith(
      'reprocess-job',
      expect.objectContaining({
        items: expect.any(Array),
      })
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'track',
        event: 'upsert',
        job_id: 'ignored',
        item: {
          id: 'track_work_1',
          youtube_music_track_id: 'liked123',
          resolved_youtube_music_track_id: 'resolved123',
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
          album_artist: 'Artist',
          source_url: 'https://music.youtube.com/watch?v=liked123',
          status: 'completed',
          stage: 'finalize',
          reason_code: 'reprocess_updated',
          reason_detail: 'Reprocess applied without redownloading audio.',
          source_kind: 'reprocess',
          resolution_method: 'exact',
          lyrics_status: 'missing',
          output_path: '/tmp/out/Artist/Album/01 Song.m4a',
          lrc_path: null,
        },
      })}\n`
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'job',
        event: 'completed',
        job_id: 'ignored',
        stage: 'finalize',
        total_count: 1,
        message: 'Reprocess complete.',
      })}\n`
    )
    child.emitExit(0, null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const [job] = await db.select().from(syncJobsTable)
    const [track] = await db.select().from(syncJobTracksTable)
    expect(job?.status).toBe('completed')
    expect(job?.queueBucket).toBe('completed')
    expect(track?.terminalOutcome).toBe('updated')

    await new Promise((resolve) => setTimeout(resolve, 10))
    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('queues no-approval reprocess behind an active worker job', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const child = createMockChildProcess()
    const spawnNdjsonCommand = vi.fn().mockReturnValue(child)
    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '/tmp/out',
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
          lyricsApiBaseUrl: '',
          ytmusicBrowserAuth: 'auth',
          ytDlpCookiesBrowser: 'firefox',
          folderTemplate: '{albumartist}/{album}',
          fileTemplate: '{track:02d} {title}',
          embedUnsyncedLyrics: true,
          writeLrcSidecar: true,
        }),
        saveYtMusicBrowserAuth: vi.fn(),
      } as never,
      {
        runJsonCommand: vi.fn().mockResolvedValue({
          ok: true,
          is_authenticated: true,
          message: 'ok',
        }),
        spawnNdjsonCommand,
      } as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue(readyIndexStatus()),
        getIndexNotReadyResult: vi.fn(),
        upsertLocalOutputs: vi.fn().mockResolvedValue(undefined),
        upsertRemoteCopyFromLocalPath: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        refreshArtists: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        ensureReady: vi.fn().mockResolvedValue(undefined),
        getBundleStatus: vi.fn().mockReturnValue({
          pluginDirectory: '/tmp/plugins',
          baseUrl: 'http://127.0.0.1:4416',
        }),
      } as never,
      () => 'ffmpeg'
    )

    ;(
      service as unknown as {
        buildReprocessCandidates: () => Promise<Array<Record<string, unknown>>>
        activeJobId: string | null
        runScheduler: () => Promise<void>
      }
    ).buildReprocessCandidates = vi.fn().mockResolvedValue([
      {
        track_work_id: 'track_work_1',
        library_track_id: 'library_track_1',
        youtube_music_track_id: 'liked123',
        resolved_youtube_music_track_id: 'resolved123',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        album_artist: 'Artist',
        lyrics_status: 'missing',
        current_output_path: '/tmp/out/Artist/Album/01 Song.m4a',
        current_lrc_path: null,
        cover_art_present: false,
      } as never,
    ])

    ;(service as unknown as { activeJobId: string | null }).activeJobId = 'busy'
    await expect(service.startLibraryReprocess()).resolves.toMatchObject({
      ok: true,
      message: 'Reprocess queued.',
    })
    expect(spawnNdjsonCommand).not.toHaveBeenCalled()

    ;(service as unknown as { activeJobId: string | null }).activeJobId = null
    await (
      service as unknown as { runScheduler: () => Promise<void> }
    ).runScheduler()
    expect(spawnNdjsonCommand).toHaveBeenCalledWith(
      'reprocess-job',
      expect.any(Object)
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'track',
        event: 'upsert',
        job_id: 'ignored',
        item: {
          id: 'track_work_1',
          youtube_music_track_id: 'liked123',
          resolved_youtube_music_track_id: 'resolved123',
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
          album_artist: 'Artist',
          source_url: 'https://music.youtube.com/watch?v=liked123',
          status: 'completed',
          stage: 'finalize',
          reason_code: 'reprocess_no_changes',
          reason_detail: 'No changes found during reprocess.',
          source_kind: 'reprocess',
          resolution_method: 'exact',
          lyrics_status: 'missing',
          output_path: '/tmp/out/Artist/Album/01 Song.m4a',
          lrc_path: null,
        },
      })}\n`
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'job',
        event: 'completed',
        job_id: 'ignored',
        stage: 'finalize',
        total_count: 1,
        message: 'Reprocess complete.',
      })}\n`
    )
    child.emitExit(0, null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const [job] = await db.select().from(syncJobsTable)
    expect(job?.status).toBe('completed')
    expect(job?.queueBucket).toBe('completed')

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('includes managed liked-song tracks without source_origin tags', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-reprocess-'))
    const audioPath = path.join(localDir, 'Artist', 'Album', '01 Song.m4a')
    fs.mkdirSync(path.dirname(audioPath), { recursive: true })
    fs.writeFileSync(audioPath, 'audio')

    await db.insert(libraryRootsTable).values({
      id: `root_local_${localDir}`,
      kind: 'local',
      transport: 'filesystem',
      label: 'Local output',
      uri: localDir,
      writable: true,
      managedOutput: true,
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
      lastScannedAt: null,
      lastScanStatus: null,
    })

    await db.insert(libraryTracksTable).values({
      id: 'liked-track',
      identityKind: 'lms_source',
      identityValue: 'youtube_music:liked123',
      managedByApp: true,
      tagSchemaVersion: 1,
      youtubeMusicTrackId: 'liked123',
      spotifyTrackId: null,
      soundcloudTrackId: null,
      resolvedYoutubeMusicTrackId: 'resolved123',
      sourceOrigin: null,
      catalogReleaseBrowseId: null,
      catalogReleaseTitle: null,
      catalogReleaseKind: null,
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      albumArtist: 'Artist',
      trackNumber: 1,
      trackTotal: 1,
      discNumber: 1,
      discTotal: 1,
      year: 2026,
      date: null,
      genre: null,
      language: null,
      isrc: null,
      mbTrackId: null,
      mbAlbumId: null,
      mbReleaseGroupId: null,
      lyricsStatus: 'synced',
      hasEmbeddedLyrics: true,
      hasSidecarLyrics: false,
      coverArtPresent: true,
      missingFieldsJson: '[]',
      preferredFileId: 'file_local_audio',
      firstSeenAt: '2026-05-20T00:00:00.000Z',
      lastSeenAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
    })

    const [localRoot] = await db.select().from(libraryRootsTable)
    await db.insert(libraryFilesTable).values({
      id: 'file_local_audio',
      trackId: 'liked-track',
      rootId: localRoot.id,
      relativePath: 'Artist/Album/01 Song.m4a',
      absolutePathSnapshot: audioPath,
      lrcPath: null,
      format: 'm4a',
      sizeBytes: 5,
      durationSeconds: 200,
      bitrate: 256000,
      modifiedAt: '2026-05-20T00:00:00.000Z',
      sidecarModifiedAt: null,
      audioSha256: null,
      tagFingerprint: null,
      embeddedLyricsStatus: 'synced',
      sidecarLyricsStatus: 'missing',
      missingFieldsJson: '[]',
      discoveredVia: 'lms_tags',
      lastScannedAt: '2026-05-20T00:00:00.000Z',
      firstSeenAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
    })

    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: localDir,
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () => 'ffmpeg'
    )

    const candidates = await (
      service as unknown as {
        buildReprocessCandidates: (
          selectedArtists: []
        ) => Promise<Array<{ library_track_id: string }>>
      }
    ).buildReprocessCandidates([])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.library_track_id).toBe('liked-track')

    sqlite.close()
    fs.rmSync(localDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('includes legacy liked-song files indexed without managedByApp', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const localDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lms-reprocess-legacy-')
    )
    const audioPath = path.join(localDir, 'Artist', 'Album', '01 Legacy.m4a')
    fs.mkdirSync(path.dirname(audioPath), { recursive: true })
    fs.writeFileSync(audioPath, 'audio')

    await db.insert(libraryRootsTable).values({
      id: `root_local_${localDir}`,
      kind: 'local',
      transport: 'filesystem',
      label: 'Local output',
      uri: localDir,
      writable: true,
      managedOutput: true,
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
      lastScannedAt: null,
      lastScanStatus: null,
    })

    await db.insert(libraryTracksTable).values({
      id: 'legacy-liked-track',
      identityKind: 'lms_source',
      identityValue: 'youtube_music:legacy123',
      managedByApp: false,
      tagSchemaVersion: null,
      youtubeMusicTrackId: 'legacy123',
      spotifyTrackId: null,
      soundcloudTrackId: null,
      resolvedYoutubeMusicTrackId: 'legacy123',
      sourceOrigin: null,
      catalogReleaseBrowseId: null,
      catalogReleaseTitle: null,
      catalogReleaseKind: null,
      title: 'Legacy Song',
      artist: 'Artist',
      album: 'Album',
      albumArtist: 'Artist',
      trackNumber: 1,
      trackTotal: 1,
      discNumber: 1,
      discTotal: 1,
      year: 2020,
      date: null,
      genre: null,
      language: null,
      isrc: null,
      mbTrackId: null,
      mbAlbumId: null,
      mbReleaseGroupId: null,
      lyricsStatus: 'missing',
      hasEmbeddedLyrics: false,
      hasSidecarLyrics: false,
      coverArtPresent: false,
      missingFieldsJson: '[]',
      preferredFileId: 'file_legacy_audio',
      firstSeenAt: '2026-05-20T00:00:00.000Z',
      lastSeenAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
    })

    const [localRoot] = await db.select().from(libraryRootsTable)
    await db.insert(libraryFilesTable).values({
      id: 'file_legacy_audio',
      trackId: 'legacy-liked-track',
      rootId: localRoot.id,
      relativePath: 'Artist/Album/01 Legacy.m4a',
      absolutePathSnapshot: audioPath,
      lrcPath: null,
      format: 'm4a',
      sizeBytes: 5,
      durationSeconds: 200,
      bitrate: 256000,
      modifiedAt: '2026-05-20T00:00:00.000Z',
      sidecarModifiedAt: null,
      audioSha256: null,
      tagFingerprint: null,
      embeddedLyricsStatus: 'missing',
      sidecarLyricsStatus: 'missing',
      missingFieldsJson: '[]',
      discoveredVia: 'lms_tags',
      lastScannedAt: '2026-05-20T00:00:00.000Z',
      firstSeenAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
    })

    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: localDir,
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () => 'ffmpeg'
    )

    const candidates = await (
      service as unknown as {
        buildReprocessCandidates: (
          selectedArtists: []
        ) => Promise<Array<{ library_track_id: string }>>
      }
    ).buildReprocessCandidates([])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.library_track_id).toBe('legacy-liked-track')

    sqlite.close()
    fs.rmSync(localDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to existing indexed file when preferred snapshot is stale', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const localDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lms-reprocess-stale-')
    )
    const stalePath = path.join(localDir, 'Artist', 'Album', '01 Missing.m4a')
    const validPath = path.join(localDir, 'Artist', 'Album', '01 Song.m4a')
    fs.mkdirSync(path.dirname(validPath), { recursive: true })
    fs.writeFileSync(validPath, 'audio')

    await db.insert(libraryRootsTable).values({
      id: `root_local_${localDir}`,
      kind: 'local',
      transport: 'filesystem',
      label: 'Local output',
      uri: localDir,
      writable: true,
      managedOutput: true,
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
      lastScannedAt: null,
      lastScanStatus: null,
    })

    await db.insert(libraryTracksTable).values({
      id: 'stale-track',
      identityKind: 'lms_source',
      identityValue: 'youtube_music:stale123',
      managedByApp: true,
      tagSchemaVersion: 1,
      youtubeMusicTrackId: 'stale123',
      spotifyTrackId: null,
      soundcloudTrackId: null,
      resolvedYoutubeMusicTrackId: 'resolved123',
      sourceOrigin: null,
      catalogReleaseBrowseId: null,
      catalogReleaseTitle: null,
      catalogReleaseKind: null,
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      albumArtist: 'Artist',
      trackNumber: 1,
      trackTotal: 1,
      discNumber: 1,
      discTotal: 1,
      year: 2026,
      date: null,
      genre: null,
      language: null,
      isrc: null,
      mbTrackId: null,
      mbAlbumId: null,
      mbReleaseGroupId: null,
      lyricsStatus: 'synced',
      hasEmbeddedLyrics: true,
      hasSidecarLyrics: false,
      coverArtPresent: true,
      missingFieldsJson: '[]',
      preferredFileId: 'file_stale',
      firstSeenAt: '2026-05-20T00:00:00.000Z',
      lastSeenAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
    })

    const [localRoot] = await db.select().from(libraryRootsTable)
    await db.insert(libraryFilesTable).values([
      {
        id: 'file_stale',
        trackId: 'stale-track',
        rootId: localRoot.id,
        relativePath: 'Artist/Album/01 Missing.m4a',
        absolutePathSnapshot: stalePath,
        lrcPath: null,
        format: 'm4a',
        sizeBytes: 0,
        durationSeconds: null,
        bitrate: null,
        modifiedAt: null,
        sidecarModifiedAt: null,
        audioSha256: null,
        tagFingerprint: null,
        embeddedLyricsStatus: 'missing',
        sidecarLyricsStatus: 'missing',
        missingFieldsJson: '[]',
        discoveredVia: 'lms_tags',
        lastScannedAt: '2026-05-20T00:00:00.000Z',
        firstSeenAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
      },
      {
        id: 'file_valid',
        trackId: 'stale-track',
        rootId: localRoot.id,
        relativePath: 'Artist/Album/01 Song.m4a',
        absolutePathSnapshot: validPath,
        lrcPath: null,
        format: 'm4a',
        sizeBytes: 5,
        durationSeconds: 200,
        bitrate: 256000,
        modifiedAt: null,
        sidecarModifiedAt: null,
        audioSha256: null,
        tagFingerprint: null,
        embeddedLyricsStatus: 'synced',
        sidecarLyricsStatus: 'missing',
        missingFieldsJson: '[]',
        discoveredVia: 'lms_tags',
        lastScannedAt: '2026-05-20T00:00:00.000Z',
        firstSeenAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
      },
    ])

    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: localDir,
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () => 'ffmpeg'
    )

    const candidates = await (
      service as unknown as {
        buildReprocessCandidates: (
          selectedArtists: []
        ) => Promise<Array<{ current_output_path: string }>>
      }
    ).buildReprocessCandidates([])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.current_output_path).toBe(validPath)

    sqlite.close()
    fs.rmSync(localDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('sync missing to remote', () => {
  it('copies missing local tracks and sidecar lrc to remote', async () => {
    vi.mocked(execa).mockClear()
    const { db, sqlite, dir } = makeTempDb()
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-local-'))
    const audioPath = path.join(localDir, 'Artist', 'Album', '01 Song.m4a')
    const lrcPath = path.join(localDir, 'Artist', 'Album', '01 Song.lrc')
    fs.mkdirSync(path.dirname(audioPath), { recursive: true })
    fs.writeFileSync(audioPath, 'audio')
    fs.writeFileSync(lrcPath, '[00:01.00]line\n')

    await db.insert(libraryRootsTable).values([
      {
        id: `root_local_${localDir}`,
        kind: 'local',
        transport: 'filesystem',
        label: 'Local output',
        uri: localDir,
        writable: true,
        managedOutput: true,
        createdAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
        lastScannedAt: null,
        lastScanStatus: null,
      },
      {
        id: 'root_remote_seedbox:/music',
        kind: 'remote',
        transport: 'rclone',
        label: 'Remote',
        uri: 'seedbox:/music',
        writable: true,
        managedOutput: true,
        createdAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
        lastScannedAt: null,
        lastScanStatus: null,
      },
    ])

    await db.insert(libraryTracksTable).values([
      {
        id: 'local-track',
        identityKind: 'lms_source',
        identityValue: 'youtube_music:liked123',
        managedByApp: true,
        tagSchemaVersion: 1,
        youtubeMusicTrackId: 'liked123',
        spotifyTrackId: null,
        soundcloudTrackId: null,
        resolvedYoutubeMusicTrackId: 'resolved123',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        albumArtist: 'Artist',
        trackNumber: 1,
        trackTotal: 1,
        discNumber: 1,
        discTotal: 1,
        year: 2026,
        date: null,
        genre: null,
        language: null,
        isrc: null,
        mbTrackId: null,
        mbAlbumId: null,
        mbReleaseGroupId: null,
        lyricsStatus: 'synced',
        hasEmbeddedLyrics: true,
        hasSidecarLyrics: true,
        coverArtPresent: true,
        missingFieldsJson: '[]',
        preferredFileId: 'file_local_audio',
        firstSeenAt: '2026-05-20T00:00:00.000Z',
        lastSeenAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
      },
    ])

    await db.insert(libraryFilesTable).values([
      {
        id: 'file_local_audio',
        trackId: 'local-track',
        rootId: `root_local_${localDir}`,
        relativePath: 'Artist/Album/01 Song.m4a',
        absolutePathSnapshot: audioPath,
        lrcPath,
        format: 'm4a',
        sizeBytes: 100,
        durationSeconds: 120,
        bitrate: 256000,
        modifiedAt: null,
        audioSha256: null,
        tagFingerprint: null,
        embeddedLyricsStatus: 'synced',
        sidecarLyricsStatus: 'synced',
        missingFieldsJson: '[]',
        discoveredVia: 'lms_tags',
        lastScannedAt: '2026-05-20T00:00:00.000Z',
        firstSeenAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
      },
    ])

    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
        stdout:
          'type = sftp\nhost = 168.138.74.194\nuser = ubuntu\nkey_file = /tmp/key\n',
      } as never)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
        stdout: '[]',
      } as never)
      .mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: '',
      } as never)

    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: localDir,
          dryRun: false,
          remoteCopyEnabled: true,
          rcloneRemote: 'seedbox',
          remoteMusicRoot: '/music',
        }),
      } as never,
      {} as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue({
          ...readyIndexStatus(),
          currentLocalRootUri: localDir,
        }),
        getIndexNotReadyResult: vi.fn(),
        upsertRemoteCopyFromLocalPath: vi.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      {} as never,
      () => 'ffmpeg'
    )
    const snapshots: Awaited<ReturnType<typeof service.getSnapshot>>[] = []
    service.subscribe((snapshot) => snapshots.push(snapshot))

    const result = await service.syncMissingToRemote()
    expect(result.ok).toBe(true)
    expect(result.details).toContain('Copied 1')
    expect(
      snapshots.some((snapshot) =>
        snapshot.jobs.some((job) => job.kind === 'sync_missing_to_remote')
      )
    ).toBe(true)
    const [job] = await db.select().from(syncJobsTable)
    expect(job?.kind).toBe('sync_missing_to_remote')
    const tracks = await db.select().from(syncJobTracksTable)
    expect(tracks[0]?.stage).toBe('finalize')
    expect(tracks[0]?.status).toBe('completed')
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(4)
    expect(vi.mocked(execa).mock.calls[2]?.[1]).toEqual([
      'copyto',
      audioPath,
      'seedbox:/music/Artist/Album/01 Song.m4a',
    ])
    expect(vi.mocked(execa).mock.calls[3]?.[1]).toEqual([
      'copyto',
      lrcPath,
      'seedbox:/music/Artist/Album/01 Song.lrc',
    ])

    sqlite.close()
    fs.rmSync(localDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('skips track when remote already has matching source or resolved id', async () => {
    vi.mocked(execa).mockClear()
    const { db, sqlite, dir } = makeTempDb()
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-local-'))

    await db.insert(libraryRootsTable).values([
      {
        id: `root_local_${localDir}`,
        kind: 'local',
        transport: 'filesystem',
        label: 'Local output',
        uri: localDir,
        writable: true,
        managedOutput: true,
        createdAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
        lastScannedAt: null,
        lastScanStatus: null,
      },
      {
        id: 'root_remote_seedbox:/music',
        kind: 'remote',
        transport: 'rclone',
        label: 'Remote',
        uri: 'seedbox:/music',
        writable: true,
        managedOutput: true,
        createdAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
        lastScannedAt: null,
        lastScanStatus: null,
      },
    ])

    await db.insert(libraryTracksTable).values([
      {
        id: 'track_local',
        identityKind: 'lms_source',
        identityValue: 'youtube_music:liked123',
        managedByApp: true,
        tagSchemaVersion: 1,
        youtubeMusicTrackId: 'liked123',
        spotifyTrackId: null,
        soundcloudTrackId: null,
        resolvedYoutubeMusicTrackId: 'resolved123',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        albumArtist: 'Artist',
        trackNumber: 1,
        trackTotal: 1,
        discNumber: 1,
        discTotal: 1,
        year: 2026,
        date: null,
        genre: null,
        language: null,
        isrc: null,
        mbTrackId: null,
        mbAlbumId: null,
        mbReleaseGroupId: null,
        lyricsStatus: 'missing',
        hasEmbeddedLyrics: false,
        hasSidecarLyrics: false,
        coverArtPresent: true,
        missingFieldsJson: '[]',
        preferredFileId: null,
        firstSeenAt: '2026-05-20T00:00:00.000Z',
        lastSeenAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
      },
      {
        id: 'track_remote',
        identityKind: 'lms_source',
        identityValue: 'youtube_music:remote-liked123',
        managedByApp: true,
        tagSchemaVersion: 1,
        youtubeMusicTrackId: 'liked123',
        spotifyTrackId: null,
        soundcloudTrackId: null,
        resolvedYoutubeMusicTrackId: 'resolved123',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        albumArtist: 'Artist',
        trackNumber: 1,
        trackTotal: 1,
        discNumber: 1,
        discTotal: 1,
        year: 2026,
        date: null,
        genre: null,
        language: null,
        isrc: null,
        mbTrackId: null,
        mbAlbumId: null,
        mbReleaseGroupId: null,
        lyricsStatus: 'missing',
        hasEmbeddedLyrics: false,
        hasSidecarLyrics: false,
        coverArtPresent: true,
        missingFieldsJson: '[]',
        preferredFileId: null,
        firstSeenAt: '2026-05-20T00:00:00.000Z',
        lastSeenAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
      },
    ])

    await db.insert(libraryFilesTable).values([
      {
        id: 'remote_file',
        trackId: 'track_remote',
        rootId: 'root_remote_seedbox:/music',
        relativePath: 'Artist/Album/01 Song.m4a',
        absolutePathSnapshot: null,
        lrcPath: null,
        format: 'm4a',
        sizeBytes: 100,
        durationSeconds: 120,
        bitrate: 256000,
        modifiedAt: null,
        audioSha256: null,
        tagFingerprint: null,
        embeddedLyricsStatus: 'missing',
        sidecarLyricsStatus: 'missing',
        missingFieldsJson: '[]',
        discoveredVia: 'lms_tags',
        lastScannedAt: '2026-05-20T00:00:00.000Z',
        firstSeenAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
      },
    ])

    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
        stdout:
          'type = sftp\nhost = 168.138.74.194\nuser = ubuntu\nkey_file = /tmp/key\n',
      } as never)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
        stdout:
          '[{"SourceFile":"./Artist/Album/01 Song.m4a","LMS_YOUTUBE_MUSIC_TRACK_ID":"liked123","LMS_RESOLVED_YOUTUBE_MUSIC_TRACK_ID":"resolved123"}]',
      } as never)

    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: localDir,
          dryRun: false,
          remoteCopyEnabled: true,
          rcloneRemote: 'seedbox',
          remoteMusicRoot: '/music',
        }),
      } as never,
      {} as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue({
          ...readyIndexStatus(),
          currentLocalRootUri: localDir,
        }),
        getIndexNotReadyResult: vi.fn(),
        upsertRemoteCopyFromLocalPath: vi.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      {} as never,
      () => 'ffmpeg'
    )

    const result = await service.syncMissingToRemote()
    expect(result.ok).toBe(true)
    expect(result.details).toContain('skipped existing 2')
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2)

    sqlite.close()
    fs.rmSync(localDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('blocks when remote config is incomplete', async () => {
    const { db, sqlite, dir } = makeTempDb()
    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: '/tmp/out',
          dryRun: false,
          remoteCopyEnabled: false,
          rcloneRemote: '',
          remoteMusicRoot: '',
        }),
      } as never,
      {} as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue(readyIndexStatus()),
        getIndexNotReadyResult: vi.fn(),
      } as never,
      {} as never,
      {} as never,
      () => 'ffmpeg'
    )

    const result = await service.syncMissingToRemote()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Remote copy settings are incomplete')

    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('surfaces missing remote exiftool error', async () => {
    vi.mocked(execa).mockClear()
    const { db, sqlite, dir } = makeTempDb()
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-local-'))

    await db.insert(libraryRootsTable).values({
      id: `root_local_${localDir}`,
      kind: 'local',
      transport: 'filesystem',
      label: 'Local output',
      uri: localDir,
      writable: true,
      managedOutput: true,
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
      lastScannedAt: null,
      lastScanStatus: null,
    })

    vi.mocked(execa)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
        stdout:
          'type = sftp\nhost = 168.138.74.194\nuser = ubuntu\nkey_file = /tmp/key\n',
      } as never)
      .mockResolvedValueOnce({
        exitCode: 45,
        stderr: '__LMS_EXIFTOOL_MISSING__',
        stdout: '',
      } as never)

    const service = new SyncService(
      db,
      {
        getRuntimeSettings: vi.fn().mockResolvedValue({
          outputDirectory: localDir,
          dryRun: false,
          remoteCopyEnabled: true,
          rcloneRemote: 'seedbox',
          remoteMusicRoot: '/music',
        }),
      } as never,
      {} as never,
      {
        ensureLocalIndexReady: vi.fn().mockResolvedValue({
          ...readyIndexStatus(),
          currentLocalRootUri: localDir,
        }),
        getIndexNotReadyResult: vi.fn(),
      } as never,
      {} as never,
      {} as never,
      () => 'ffmpeg'
    )

    const result = await service.syncMissingToRemote()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Install libimage-exiftool-perl')

    sqlite.close()
    fs.rmSync(localDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
