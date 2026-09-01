import { isLowResArtistPhotoUrl } from '@shared/artist-photo-url'
import type {
  ArtistPhotoUpdate,
  CommandResult,
  LikedArtistView,
} from '@shared/contracts'
import { asc, eq } from 'drizzle-orm'
import {
  artistCreditId,
  normalizeArtistName,
  parseArtistCreditsJson,
} from '../../shared/artist-credit'
import type { AuthCoordinator } from '../auth/auth-coordinator'
import type { AppDatabase } from '../db/database'
import {
  libraryTrackArtistsTable,
  libraryTracksTable,
  likedArtistsTable,
} from '../db/schema'
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

interface LocalArtist {
  id: string
  channelId: string | null
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
  error_type?: string
  error_message?: string
  attempts?: number
}

export class LikedArtistsService {
  private readonly photoUpdateListeners = new Set<
    (update: ArtistPhotoUpdate) => void
  >()
  private imageRefreshJob: Promise<CommandResult> | null = null
  private imageCacheQueue: Promise<void> = Promise.resolve()
  private authCoordinator: AuthCoordinator | null = null

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

  setAuthCoordinator(authCoordinator: AuthCoordinator) {
    this.authCoordinator = authCoordinator
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

    const trackArtistLinks: Array<{
      trackId: string
      artistKey: string
      position: number
    }> = []
    for (const track of tracks) {
      const credits = parseArtistCreditsJson(track.artistCreditsJson)
      const effectiveCredits =
        credits.length > 0
          ? credits
          : track.artist?.trim()
            ? [{ name: track.artist.trim(), channelId: null }]
            : []
      for (const [position, credit] of effectiveCredits.entries()) {
        const normalizedName = normalizeArtistName(credit.name)
        if (!normalizedName) continue
        const artistKey = credit.channelId
          ? `channel:${credit.channelId}`
          : `name:${normalizedName}`
        const existing = localArtistsByName.get(artistKey)
        if (existing) {
          existing.trackCount += 1
        } else {
          localArtistsByName.set(artistKey, {
            id: credit.channelId
              ? `artist_channel_${credit.channelId}`
              : artistCreditId(credit),
            channelId: credit.channelId,
            name: credit.name,
            normalizedName,
            trackCount: 1,
          })
        }
        trackArtistLinks.push({ trackId: track.id, artistKey, position })
      }
    }

    const existingRows = await this.db.select().from(likedArtistsTable)
    const existingById = new Map(existingRows.map((row) => [row.id, row]))
    const existingByChannelId = new Map(
      existingRows
        .filter((row) => row.channelId)
        .map((row) => [row.channelId as string, row])
    )
    await this.db.delete(libraryTrackArtistsTable)
    await this.db
      .delete(likedArtistsTable)
      .where(eq(likedArtistsTable.isFavorite, false))

    let preservedPhotoUrls = 0
    let migratedArtistIds = 0

    const persistedArtistIdByKey = new Map<string, string>()
    for (const [artistKey, artist] of localArtistsByName) {
      const existing =
        existingById.get(artist.id) ??
        (artist.channelId ? existingByChannelId.get(artist.channelId) : null)
      const persistedId = artist.id
      persistedArtistIdByKey.set(artistKey, persistedId)
      if (decodeStoredArtistPhotoUrl(existing?.photoUrl ?? null)) {
        preservedPhotoUrls++
      }
      if (existing && existing.id !== artist.id) migratedArtistIds++
      await this.db
        .insert(likedArtistsTable)
        .values({
          id: persistedId,
          channelId: artist.channelId,
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
            channelId: artist.channelId,
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

      if (existing && existing.id !== persistedId) {
        await this.db
          .delete(likedArtistsTable)
          .where(eq(likedArtistsTable.id, existing.id))
      }
    }

    if (trackArtistLinks.length > 0) {
      await this.db.insert(libraryTrackArtistsTable).values(
        trackArtistLinks.map((link) => ({
          trackId: link.trackId,
          artistId: persistedArtistIdByKey.get(link.artistKey) as string,
          position: link.position,
        }))
      )
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

    const job = this.imageCacheQueue.then(() => this.runArtistImageRefresh())
    this.imageCacheQueue = job.then(
      () => undefined,
      () => undefined
    )
    this.imageRefreshJob = job
    try {
      return await job
    } finally {
      this.imageRefreshJob = null
    }
  }

  async clearArtistImageCache(): Promise<CommandResult> {
    if (!this.artistPhotoCache) {
      return { ok: false, message: 'Artist image cache is unavailable.' }
    }
    const clear = this.imageCacheQueue.then(async () => {
      const artists = await this.db.select().from(likedArtistsTable)
      const clearedArtists = artists.filter((artist) => artist.photoUrl).length
      await this.db.update(likedArtistsTable).set({
        photoUrl: null,
        updatedAt: nowIso(),
      })
      const clearedFiles = await this.artistPhotoCache!.clear()
      return {
        ok: true,
        message: 'Artist image cache cleared.',
        details: JSON.stringify({ clearedArtists, clearedFiles }),
      }
    })
    this.imageCacheQueue = clear.then(
      () => undefined,
      () => undefined
    )
    return clear
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
    const catalog = await this.listArtists()
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
          Boolean(artist.channelId) &&
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
    if (artists.length === 0) {
      return { ok: true, message: 'Artist images already cached.' }
    }

    logMain({
      level: 'info',
      source: 'liked-artists',
      message: 'Artist image refresh started',
      context: {
        missingPhotoCount: artists.length,
        catalogSize: catalog.length,
      },
    })

    const settings = await settingsService.getRuntimeSettings()
    if (!settings.ytmusicBrowserAuth && !this.authCoordinator) {
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

    let browserAuthInput: string
    try {
      if (this.authCoordinator) {
        browserAuthInput = await this.authCoordinator.getValidatedCredential()
      } else {
        const authResult =
          await pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
            'auth-status',
            { browser_auth_input: settings.ytmusicBrowserAuth }
          )
        if (!authResult.ok || !authResult.is_authenticated) {
          throw new Error(authResult.message || 'YT Music auth check failed.')
        }
        browserAuthInput =
          authResult.credential_json ?? settings.ytmusicBrowserAuth
        if (authResult.credential_json) {
          await settingsService.saveYtMusicBrowserAuth(
            authResult.credential_json
          )
        }
      }
    } catch (error) {
      logMain({
        level: 'warn',
        source: 'liked-artists',
        message: 'Artist image refresh blocked (auth check failed)',
        context: {
          missingPhotoCount: artists.length,
          authMessage: error instanceof Error ? error.message : String(error),
        },
      })
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
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
                  channel_id: artist.channelId,
                  name: artist.name,
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
                channelId: artist.channelId,
                workerMessage: payload.message ?? null,
                errorType: payload.error_type ?? null,
                errorMessage: payload.error_message ?? null,
                attempts: payload.attempts ?? null,
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
              message: 'Artist page returned no usable image',
              context: {
                artistId: artist.id,
                artistName: artist.name,
                channelId: artist.channelId,
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
