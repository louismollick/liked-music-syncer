import type { CommandResult, LikedArtistView } from '@shared/contracts'
import { asc } from 'drizzle-orm'
import type { AppDatabase } from '../db/database'
import { likedArtistsTable } from '../db/schema'
import type { PythonWorkerService } from './python-worker'
import type { SettingsService } from './settings-service'
import { nowIso } from './utils'

interface WorkerArtist {
  id: string
  channel_id: string | null
  name: string
  normalized_name: string
  photo_url: string | null
  liked_track_count: number
}

interface WorkerAuthStatusResponse {
  ok: boolean
  is_authenticated: boolean
  message: string
  credential_json?: string
}

export class LikedArtistsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settingsService: SettingsService,
    private readonly pythonWorker: PythonWorkerService
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
    }))
  }

  async listArtistsByIds(ids: string[]): Promise<LikedArtistView[]> {
    const selected = new Set(ids)
    const artists = await this.listArtists()
    return artists.filter((artist) => selected.has(artist.id))
  }

  async refreshArtists(): Promise<CommandResult> {
    const settings = await this.settingsService.getRuntimeSettings()
    if (!settings.ytmusicBrowserAuth) {
      return {
        ok: false,
        message: 'Pull YT Music auth from your browser first.',
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
      artists: WorkerArtist[]
    }>('liked-artists', {
      ytmusic_browser_auth: browserAuthInput,
    })

    const stamp = nowIso()
    await this.db.delete(likedArtistsTable)
    if (payload.artists.length > 0) {
      await this.db.insert(likedArtistsTable).values(
        payload.artists.map((artist) => ({
          id: artist.id,
          channelId: artist.channel_id,
          name: artist.name,
          normalizedName: artist.normalized_name,
          photoUrl: artist.photo_url,
          likedTrackCount: artist.liked_track_count,
          lastRefreshedAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
        }))
      )
    }

    return {
      ok: true,
      message: `Refreshed ${payload.artists.length} liked artists.`,
    }
  }
}
