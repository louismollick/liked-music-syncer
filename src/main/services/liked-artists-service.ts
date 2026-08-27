import { isLowResArtistPhotoUrl } from '@shared/artist-photo-url'
import type {
  ArtistPhotoUpdate,
  CommandResult,
  LikedArtistView,
} from '@shared/contracts'
import { asc, eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/database'
import { libraryTracksTable, likedArtistsTable } from '../db/schema'
import type { ArtistPhotoCache } from './artist-photo-cache'
import { logMain } from './logger'
import type { PythonWorkerService } from './python-worker'
import type { SettingsService } from './settings-service'
import { nowIso, runWithConcurrency } from './utils'

const ARTIST_IMAGE_FETCH_CONCURRENCY = 3
const MISSING_ARTIST_PHOTO_SENTINEL = 'app://artist-photo/not-found'

export { isLowResArtistPhotoUrl } from '@shared/artist-photo-url'

function decodeStoredArtistPhotoUrl(photoUrl: string | null): string | null {
  return photoUrl === MISSING_ARTIST_PHOTO_SENTINEL ? null : photoUrl
}

function isKnownMissingArtistPhoto(photoUrl: string | null): boolean {
  return photoUrl === MISSING_ARTIST_PHOTO_SENTINEL
}

function normalizeArtistName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function localArtistId(normalizedName: string): string {
  return `local_artist_${normalizedName.replace(/\s+/g, '_')}`
}

interface LocalArtist {
  id: string
  name: string
  normalizedName: string
  trackCount: number
}

interface WorkerAuthStatusResponse {
  ok: boolean
  is_authenticated: boolean
  message: string
  credential_json?: string
}

interface WorkerArtistImage {
  id: string
  channel_id: string | null
  photo_url: string
}

interface WorkerArtistImageResponse {
  ok: boolean
  message?: string
  artist: WorkerArtistImage | null
}

export class LikedArtistsService {
  private readonly photoUpdateListeners = new Set<
    (update: ArtistPhotoUpdate) => void
  >()
  private imageRefreshJob: Promise<CommandResult> | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly settingsService?: SettingsService,
    private readonly pythonWorker?: PythonWorkerService,
    private readonly artistPhotoCache?: ArtistPhotoCache
  ) {}

  subscribeArtistPhotoUpdates(listener: (update: ArtistPhotoUpdate) => void) {
    this.photoUpdateListeners.add(listener)
    return () => this.photoUpdateListeners.delete(listener)
  }

  private emitArtistPhotoUpdate(update: ArtistPhotoUpdate) {
    for (const listener of this.photoUpdateListeners) {
      listener(update)
    }
  }

  async listArtists(options?: {
    logSnapshot?: boolean
  }): Promise<LikedArtistView[]> {
    const rows = await this.db
      .select()
      .from(likedArtistsTable)
      .orderBy(asc(likedArtistsTable.name))
    const artists = rows.map((row) => ({
      id: row.id,
      channelId: row.channelId,
      name: row.name,
      normalizedName: row.normalizedName,
      photoUrl: this.resolveStoredArtistPhotoUrl(row.photoUrl),
      likedTrackCount: row.likedTrackCount,
      lastRefreshedAt: row.lastRefreshedAt,
      isFavorite: row.isFavorite,
      favoritedAt: row.favoritedAt,
      lastCatalogRefreshedAt: row.lastCatalogRefreshedAt,
      catalogTrackCount: row.catalogTrackCount,
    }))

    if (options?.logSnapshot) {
      const withPhoto = artists.filter((artist) =>
        Boolean(artist.photoUrl)
      ).length
      logMain({
        level: 'info',
        source: 'liked-artists',
        message: 'Artist catalog snapshot',
        context: {
          totalArtists: artists.length,
          withPhotoUrl: withPhoto,
          withoutPhotoUrl: artists.length - withPhoto,
        },
      })
    }

    return artists
  }

  private resolveStoredArtistPhotoUrl(photoUrl: string | null): string | null {
    const remoteUrl = decodeStoredArtistPhotoUrl(photoUrl)
    return remoteUrl && this.artistPhotoCache
      ? this.artistPhotoCache.resolvePhotoUrl(remoteUrl)
      : remoteUrl
  }

  private async cacheArtistPhoto(
    artist: { id: string; name: string },
    remoteUrl: string
  ): Promise<string> {
    if (!this.artistPhotoCache) return remoteUrl
    try {
      return await this.artistPhotoCache.cacheRemotePhoto(remoteUrl)
    } catch (error) {
      logMain({
        level: 'warn',
        source: 'liked-artists',
        message: 'Failed to cache artist photo locally',
        context: {
          artistId: artist.id,
          artistName: artist.name,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return remoteUrl
    }
  }

  async listArtistsByIds(ids: string[]): Promise<LikedArtistView[]> {
    const selected = new Set(ids)
    const artists = await this.listArtists()
    return artists.filter((artist) => selected.has(artist.id))
  }

  async listFavoriteArtists(ids?: string[]): Promise<LikedArtistView[]> {
    const artists = await this.listArtists()
    const selected = ids ? new Set(ids) : null
    return artists.filter(
      (artist) => artist.isFavorite && (!selected || selected.has(artist.id))
    )
  }

  async setArtistFavorite(
    artistId: string,
    isFavorite: boolean
  ): Promise<CommandResult> {
    logMain({
      level: 'debug',
      source: 'liked-artists',
      message: 'setArtistFavorite requested',
      context: { artistId, isFavorite },
    })
    const row = await this.db.query.likedArtistsTable.findFirst({
      where: eq(likedArtistsTable.id, artistId),
    })
    if (!row) {
      logMain({
        level: 'warn',
        source: 'liked-artists',
        message: 'setArtistFavorite artist not found',
        context: { artistId, isFavorite },
      })
      return {
        ok: false,
        message: 'Artist not found. Refresh library first.',
      }
    }

    const stamp = nowIso()
    const firstFavorite = isFavorite && !row.isFavorite
    await this.db
      .update(likedArtistsTable)
      .set({
        isFavorite,
        favoritedAt: firstFavorite ? stamp : row.favoritedAt,
        updatedAt: stamp,
      })
      .where(eq(likedArtistsTable.id, artistId))

    logMain({
      level: 'info',
      source: 'liked-artists',
      message: 'setArtistFavorite updated',
      context: {
        artistId,
        isFavorite,
        firstFavorite,
        priorFavorite: row.isFavorite,
        channelId: row.channelId,
      },
    })

    return {
      ok: true,
      message: isFavorite ? 'Artist saved as favorite.' : 'Artist unfavorited.',
      details: firstFavorite ? 'firstFavorite=true' : undefined,
    }
  }

  async updateFavoriteCatalogStats(
    countsByArtistId: Record<string, number>
  ): Promise<void> {
    const stamp = nowIso()
    for (const [artistId, count] of Object.entries(countsByArtistId)) {
      await this.db
        .update(likedArtistsTable)
        .set({
          lastCatalogRefreshedAt: stamp,
          catalogTrackCount: count,
          updatedAt: stamp,
        })
        .where(eq(likedArtistsTable.id, artistId))
    }
  }

  async refreshArtists(): Promise<CommandResult> {
    const stamp = nowIso()
    const tracks = await this.db.select().from(libraryTracksTable)
    const localArtistsByName = new Map<string, LocalArtist>()

    for (const track of tracks) {
      const name = track.artist?.trim()
      if (!name) continue

      const normalizedName = normalizeArtistName(name)
      if (!normalizedName) continue

      const existing = localArtistsByName.get(normalizedName)
      if (existing) {
        existing.trackCount += 1
        continue
      }

      localArtistsByName.set(normalizedName, {
        id: localArtistId(normalizedName),
        name,
        normalizedName,
        trackCount: 1,
      })
    }

    const existingRows = await this.db.select().from(likedArtistsTable)
    const existingById = new Map(existingRows.map((row) => [row.id, row]))
    const existingByNormalizedName = new Map(
      existingRows.map((row) => [row.normalizedName, row])
    )
    await this.db
      .delete(likedArtistsTable)
      .where(eq(likedArtistsTable.isFavorite, false))

    let preservedPhotoUrls = 0
    let migratedArtistIds = 0

    for (const artist of localArtistsByName.values()) {
      const existing =
        existingById.get(artist.id) ??
        existingByNormalizedName.get(artist.normalizedName)
      if (decodeStoredArtistPhotoUrl(existing?.photoUrl ?? null)) {
        preservedPhotoUrls++
      }
      if (existing && existing.id !== artist.id) migratedArtistIds++
      await this.db
        .insert(likedArtistsTable)
        .values({
          id: artist.id,
          channelId: existing?.channelId ?? null,
          name: artist.name,
          normalizedName: artist.normalizedName,
          photoUrl: existing?.photoUrl ?? null,
          likedTrackCount: artist.trackCount,
          lastRefreshedAt: stamp,
          isFavorite: existing?.isFavorite ?? false,
          favoritedAt: existing?.favoritedAt ?? null,
          lastCatalogRefreshedAt: existing?.lastCatalogRefreshedAt ?? null,
          catalogTrackCount: existing?.catalogTrackCount ?? null,
          createdAt: existing?.createdAt ?? stamp,
          updatedAt: stamp,
        })
        .onConflictDoUpdate({
          target: likedArtistsTable.id,
          set: {
            channelId: existing?.channelId ?? null,
            name: artist.name,
            normalizedName: artist.normalizedName,
            photoUrl: existing?.photoUrl ?? null,
            likedTrackCount: artist.trackCount,
            lastRefreshedAt: stamp,
            isFavorite: existing?.isFavorite ?? false,
            favoritedAt: existing?.favoritedAt ?? null,
            lastCatalogRefreshedAt: existing?.lastCatalogRefreshedAt ?? null,
            catalogTrackCount: existing?.catalogTrackCount ?? null,
            updatedAt: stamp,
          },
        })

      if (existing && existing.id !== artist.id) {
        await this.db
          .delete(likedArtistsTable)
          .where(eq(likedArtistsTable.id, existing.id))
      }
    }

    const rebuilt = await this.listArtists({ logSnapshot: true })
    logMain({
      level: 'info',
      source: 'liked-artists',
      message: 'Library artists rebuilt from tracks',
      context: {
        artistCount: rebuilt.length,
        trackDerivedCount: localArtistsByName.size,
        preservedPhotoUrls,
        migratedArtistIds,
      },
    })

    return {
      ok: true,
      message: `Rebuilt ${localArtistsByName.size} library artists.`,
    }
  }

  async refreshArtistImages(): Promise<CommandResult> {
    if (this.imageRefreshJob) {
      logMain({
        level: 'debug',
        source: 'liked-artists',
        message:
          'Artist image refresh already in progress (joined existing job)',
      })
      return this.imageRefreshJob
    }

    const job = this.runArtistImageRefresh()
    this.imageRefreshJob = job
    try {
      return await job
    } finally {
      this.imageRefreshJob = null
    }
  }

  private async runArtistImageRefresh(): Promise<CommandResult> {
    if (!this.settingsService || !this.pythonWorker) {
      logMain({
        level: 'warn',
        source: 'liked-artists',
        message: 'Artist image refresh unavailable (missing services)',
      })
      return { ok: false, message: 'Artist image refresh is unavailable.' }
    }

    const pythonWorker = this.pythonWorker
    const settingsService = this.settingsService

    const startedAt = Date.now()
    const catalog = await this.listArtists({ logSnapshot: true })
    const storedArtists = await this.db.select().from(likedArtistsTable)
    const artistsWithRemotePhotos = storedArtists.filter((artist) =>
      Boolean(decodeStoredArtistPhotoUrl(artist.photoUrl))
    )
    await runWithConcurrency(
      artistsWithRemotePhotos,
      ARTIST_IMAGE_FETCH_CONCURRENCY,
      async (artist) => {
        const remoteUrl = decodeStoredArtistPhotoUrl(artist.photoUrl)
        if (!remoteUrl) return
        const photoUrl = await this.cacheArtistPhoto(artist, remoteUrl)
        if (photoUrl !== remoteUrl) {
          this.emitArtistPhotoUpdate({
            artistId: artist.id,
            photoUrl,
            channelId: artist.channelId,
          })
        }
      }
    )
    const artists = storedArtists
      .filter(
        (artist) =>
          !isKnownMissingArtistPhoto(artist.photoUrl) &&
          isLowResArtistPhotoUrl(decodeStoredArtistPhotoUrl(artist.photoUrl))
      )
      .map((artist) => ({
        id: artist.id,
        channelId: artist.channelId,
        name: artist.name,
        normalizedName: artist.normalizedName,
        photoUrl: decodeStoredArtistPhotoUrl(artist.photoUrl),
        likedTrackCount: artist.likedTrackCount,
        lastRefreshedAt: artist.lastRefreshedAt,
        isFavorite: artist.isFavorite,
        favoritedAt: artist.favoritedAt,
        lastCatalogRefreshedAt: artist.lastCatalogRefreshedAt,
        catalogTrackCount: artist.catalogTrackCount,
      }))
    logMain({
      level: 'info',
      source: 'liked-artists',
      message: 'Artist image refresh started',
      context: {
        missingPhotoCount: artists.length,
        catalogSize: catalog.length,
      },
    })
    if (artists.length === 0) {
      logMain({
        level: 'info',
        source: 'liked-artists',
        message: 'Artist image refresh skipped (all artists have photo URLs)',
      })
      return { ok: true, message: 'Artist images already cached.' }
    }

    const settings = await settingsService.getRuntimeSettings()
    if (!settings.ytmusicBrowserAuth) {
      logMain({
        level: 'warn',
        source: 'liked-artists',
        message: 'Artist image refresh blocked (no YT Music auth)',
        context: { missingPhotoCount: artists.length },
      })
      return {
        ok: false,
        message: 'Pull YT Music auth to fetch artist images.',
      }
    }

    const authResult =
      await pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
        'auth-status',
        {
          browser_auth_input: settings.ytmusicBrowserAuth,
        }
      )
    if (!authResult.ok || !authResult.is_authenticated) {
      logMain({
        level: 'warn',
        source: 'liked-artists',
        message: 'Artist image refresh blocked (auth check failed)',
        context: {
          missingPhotoCount: artists.length,
          authMessage: authResult.message,
        },
      })
      return {
        ok: false,
        message: authResult.message || 'YT Music auth check failed.',
      }
    }

    const browserAuthInput =
      authResult.credential_json ?? settings.ytmusicBrowserAuth
    if (authResult.credential_json) {
      await settingsService.saveYtMusicBrowserAuth(authResult.credential_json)
    }

    const stats = { fetched: 0, notFound: 0, failed: 0 }
    let completed = 0

    logMain({
      level: 'info',
      source: 'liked-artists',
      message: 'Fetching artist images with concurrency',
      context: {
        pendingCount: artists.length,
        concurrency: ARTIST_IMAGE_FETCH_CONCURRENCY,
      },
    })

    await runWithConcurrency(
      artists,
      ARTIST_IMAGE_FETCH_CONCURRENCY,
      async (artist, index) => {
        const artistStartedAt = Date.now()
        logMain({
          level: 'debug',
          source: 'liked-artists',
          message: 'Fetching artist image',
          context: {
            artistId: artist.id,
            artistName: artist.name,
            progress: `${index + 1}/${artists.length}`,
          },
        })

        try {
          const payload =
            await pythonWorker.runJsonCommand<WorkerArtistImageResponse>(
              'artist-image',
              {
                ytmusic_browser_auth: browserAuthInput,
                artist: {
                  id: artist.id,
                  name: artist.name,
                  normalized_name: artist.normalizedName,
                },
              }
            )

          if (!payload.ok) {
            stats.failed++
            logMain({
              level: 'warn',
              source: 'liked-artists',
              message: 'Artist image worker returned not ok',
              context: {
                artistId: artist.id,
                artistName: artist.name,
                workerMessage: payload.message ?? null,
                durationMs: Date.now() - artistStartedAt,
              },
            })
            return
          }

          if (!payload.artist?.photo_url) {
            stats.notFound++
            await this.db
              .update(likedArtistsTable)
              .set({
                photoUrl: MISSING_ARTIST_PHOTO_SENTINEL,
                updatedAt: nowIso(),
              })
              .where(eq(likedArtistsTable.id, artist.id))
            logMain({
              level: 'debug',
              source: 'liked-artists',
              message: 'No artist image found',
              context: {
                artistId: artist.id,
                artistName: artist.name,
                workerMessage: payload.message ?? null,
                durationMs: Date.now() - artistStartedAt,
              },
            })
            return
          }

          const stamp = nowIso()
          await this.db
            .update(likedArtistsTable)
            .set({
              channelId: payload.artist.channel_id,
              photoUrl: payload.artist.photo_url,
              updatedAt: stamp,
            })
            .where(eq(likedArtistsTable.id, artist.id))

          const displayPhotoUrl = await this.cacheArtistPhoto(
            artist,
            payload.artist.photo_url
          )
          this.emitArtistPhotoUpdate({
            artistId: artist.id,
            photoUrl: displayPhotoUrl,
            channelId: payload.artist.channel_id,
          })
          stats.fetched++

          let photoUrlHost: string | null = null
          try {
            photoUrlHost = new URL(payload.artist.photo_url).host
          } catch {
            photoUrlHost = null
          }

          logMain({
            level: 'info',
            source: 'liked-artists',
            message: 'Artist image cached and published',
            context: {
              artistId: artist.id,
              artistName: artist.name,
              progress: `${index + 1}/${artists.length}`,
              photoUrlHost,
              durationMs: Date.now() - artistStartedAt,
            },
          })
        } catch (error) {
          stats.failed++
          logMain({
            level: 'warn',
            source: 'liked-artists',
            message: 'Artist image fetch failed',
            context: {
              artistId: artist.id,
              artistName: artist.name,
              progress: `${index + 1}/${artists.length}`,
              durationMs: Date.now() - artistStartedAt,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        } finally {
          completed++
          if (completed % 10 === 0 || completed === artists.length) {
            logMain({
              level: 'info',
              source: 'liked-artists',
              message: 'Artist image fetch progress',
              context: {
                completed,
                total: artists.length,
                fetched: stats.fetched,
                notFound: stats.notFound,
                failed: stats.failed,
              },
            })
          }
        }
      }
    )

    const { fetched, notFound, failed } = stats

    logMain({
      level: 'info',
      source: 'liked-artists',
      message: 'Artist image refresh finished',
      context: {
        requestedCount: artists.length,
        fetchedCount: fetched,
        notFoundCount: notFound,
        failedCount: failed,
        durationMs: Date.now() - startedAt,
      },
    })

    return {
      ok: true,
      message: `Cached ${fetched} artist images (${notFound} not found, ${failed} failed).`,
      details: JSON.stringify({ fetched, notFound, failed }),
    }
  }
}
