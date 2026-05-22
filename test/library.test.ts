import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  syncRunsTable,
} from '../src/main/db/schema'
import { LibraryService } from '../src/main/services/library-service'
import {
  buildRemoteScannerSshArgs,
  normalizeExiftoolJson,
  parseRcloneSftpConfig,
  SyncService,
} from '../src/main/services/sync-service'

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
    audio_sha256: null,
    tag_fingerprint: 'fingerprint',
    last_scanned_at: '2026-05-18T00:00:00.000Z',
    identity_kind: 'lms_source',
    identity_value: 'youtube_music:liked123',
    discovered_via: 'lms_tags',
    ...overrides,
  }
}

afterEach(() => {
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
})

describe('sync run item contract', () => {
  it('persists and exposes the widened run item fields', async () => {
    const { db, sqlite, dir } = makeTempDb()
    await db.insert(syncRunsTable).values({
      id: 'run_1',
      triggerMode: 'manual',
      status: 'running',
      startedAt: '2026-05-18T00:00:00.000Z',
      endedAt: null,
      logDirectory: '/tmp/run_1',
      plannedCount: 0,
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
        upsertRunItem: (
          runId: string,
          item: Record<string, unknown>
        ) => Promise<void>
      }
    ).upsertRunItem('run_1', {
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

    const run = await service.getRun('run_1')
    expect(run?.items[0]).toMatchObject({
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
        scanLocalRoots: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
        scanRoots: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
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
      snapshots.some(
        (snapshot) => snapshot.activeRun?.triggerMode === 'remote_backfill'
      )
    ).toBe(true)
    const runs = await service.listRuns()
    expect(runs[0]?.triggerMode).toBe('remote_backfill')
    expect(runs[0]?.processedCount).toBe(1)
    expect(runs[0]?.completedCount).toBe(1)
    const run = runs[0] ? await service.getRun(runs[0].id) : null
    expect(run?.items[0]?.stage).toBe('remote_copy')
    expect(run?.items[0]?.status).toBe('completed')
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
        scanLocalRoots: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
        scanRoots: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
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
      { scanRoots: vi.fn() } as never,
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
        scanLocalRoots: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
        scanRoots: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
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
