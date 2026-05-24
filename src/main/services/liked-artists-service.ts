import type { CommandResult, LikedArtistView } from '@shared/contracts'
import { asc, eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/database'
import { libraryTracksTable, likedArtistsTable } from '../db/schema'
import { logMain } from './logger'
import type { PythonWorkerService } from './python-worker'
import type { SettingsService } from './settings-service'
import { nowIso } from './utils'

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

export class LikedArtistsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settingsService?: SettingsService,
    private readonly pythonWorker?: PythonWorkerService
  ) {}

  async listArtists(): Promise<LikedArtistView[]> {
    const rows = await this.db
      .select()
      .from(likedArtistsTable)
      .orderBy(asc(likedArtistsTable.name))
    return rows.map((row) => ({
      id: row.id,
      channelId: row.channelId,
      name: row.name,
      normalizedName: row.normalizedName,
      photoUrl: row.photoUrl,
      likedTrackCount: row.likedTrackCount,
      lastRefreshedAt: row.lastRefreshedAt,
      isFavorite: row.isFavorite,
      favoritedAt: row.favoritedAt,
      lastCatalogRefreshedAt: row.lastCatalogRefreshedAt,
      catalogTrackCount: row.catalogTrackCount,
    }))
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

    for (const artist of localArtistsByName.values()) {
      const existing =
        existingById.get(artist.id) ??
        existingByNormalizedName.get(artist.normalizedName)
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

    return {
      ok: true,
      message: `Rebuilt ${localArtistsByName.size} library artists.`,
    }
  }

  async refreshArtistImages(): Promise<CommandResult> {
    if (!this.settingsService || !this.pythonWorker) {
      return { ok: false, message: 'Artist image refresh is unavailable.' }
    }

    const artists = (await this.listArtists()).filter(
      (artist) => !artist.photoUrl
    )
    if (artists.length === 0) {
      return { ok: true, message: 'Artist images already cached.' }
    }

    const settings = await this.settingsService.getRuntimeSettings()
    if (!settings.ytmusicBrowserAuth) {
      return {
        ok: false,
        message: 'Pull YT Music auth to fetch artist images.',
      }
    }

    const authResult =
      await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
        'auth-status',
        {
          browser_auth_input: settings.ytmusicBrowserAuth,
        }
      )
    if (!authResult.ok || !authResult.is_authenticated) {
      return {
        ok: false,
        message: authResult.message || 'YT Music auth check failed.',
      }
    }

    const browserAuthInput =
      authResult.credential_json ?? settings.ytmusicBrowserAuth
    if (authResult.credential_json) {
      await this.settingsService.saveYtMusicBrowserAuth(
        authResult.credential_json
      )
    }

    const payload = await this.pythonWorker.runJsonCommand<{
      artists: WorkerArtistImage[]
    }>('artist-images', {
      ytmusic_browser_auth: browserAuthInput,
      artists: artists.map((artist) => ({
        id: artist.id,
        name: artist.name,
        normalized_name: artist.normalizedName,
      })),
    })

    const stamp = nowIso()
    for (const artist of payload.artists) {
      await this.db
        .update(likedArtistsTable)
        .set({
          channelId: artist.channel_id,
          photoUrl: artist.photo_url,
          updatedAt: stamp,
        })
        .where(eq(likedArtistsTable.id, artist.id))
    }

    return {
      ok: true,
      message: `Cached ${payload.artists.length} artist images.`,
    }
  }
}
