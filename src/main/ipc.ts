import type {
  BinaryStatus,
  SettingsSaveResult,
  SyncSnapshot,
} from '@shared/contracts'
import type { BrowserWindow } from 'electron'
import { dialog, ipcMain } from 'electron'
import type { AuthCoordinator } from './auth/auth-coordinator'
import type { ArtworkService } from './services/artwork-service'
import type { AuthService } from './services/auth-service'
import type { LibraryService } from './services/library-service'
import type { LikedArtistsService } from './services/liked-artists-service'
import { logMain } from './services/logger'
import type { SettingsService } from './services/settings-service'
import type { SyncService } from './services/sync-service'

export function registerIpcHandlers(
  window: BrowserWindow,
  settingsService: SettingsService,
  authService: AuthService,
  authCoordinator: AuthCoordinator,
  syncService: SyncService,
  libraryService: LibraryService,
  likedArtistsService: LikedArtistsService,
  artworkService: ArtworkService,
  getBundledFfmpegPath: () => string
) {
  const eventChannel = 'sync:snapshot'

  syncService.subscribe((snapshot: SyncSnapshot) => {
    if (!window.isDestroyed()) {
      window.webContents.send(eventChannel, snapshot)
    }
  })
  libraryService.subscribeInventory(() => {
    if (!window.isDestroyed()) {
      window.webContents.send('library:inventoryUpdated')
    }
  })
  likedArtistsService.subscribeArtistPhotoUpdates((update) => {
    if (!window.isDestroyed()) {
      window.webContents.send('library:artistPhotoUpdated', update)
    }
  })

  ipcMain.handle('auth:getStatus', () => authService.getStatus())
  ipcMain.handle('auth:getSnapshot', () => authCoordinator.getSnapshot())
  ipcMain.handle('auth:refresh', (_event, scope, reason) => {
    if (!['selected', 'all'].includes(scope))
      throw new Error('Invalid auth refresh scope.')
    return authCoordinator.refresh(scope, reason)
  })
  ipcMain.handle('auth:selectSource', (_event, sourceId) => {
    if (typeof sourceId !== 'string') throw new Error('Invalid auth source.')
    return authCoordinator.selectSource(sourceId)
  })
  ipcMain.handle('auth:selectAccount', (_event, accountKey) =>
    authCoordinator.selectAccount(accountKey)
  )
  ipcMain.handle('auth:loadAccountCounts', () =>
    authCoordinator.loadAccountCounts()
  )
  ipcMain.handle('auth:openSignIn', async () => {
    await authCoordinator.openSignIn()
    window.once('focus', () => {
      void authCoordinator
        .refresh('selected', 'focus_return')
        .catch((error) => {
          logMain({
            level: 'error',
            source: 'auth',
            message: 'Authentication refresh after browser focus failed',
            context: {
              error: error instanceof Error ? error.message : String(error),
            },
          })
        })
    })
  })
  ipcMain.handle('auth:captureBrowserAuth', (_event, browser) =>
    authService.captureBrowserAuth(browser)
  )
  ipcMain.handle('auth:disconnect', () => authService.disconnect())

  ipcMain.handle('settings:get', () => settingsService.getView())
  ipcMain.handle('settings:update', async (_event, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Invalid settings update.')
    return settingsService.update(input)
  })
  ipcMain.handle(
    'settings:save',
    async (_event, input): Promise<SettingsSaveResult> => {
      const previous = await settingsService.getRuntimeSettings()
      const saveResult = await settingsService.save(input)
      if (previous.outputDirectory !== input.outputDirectory.trim()) {
        void libraryService.reconcileLocalLibrary()
      }
      const shouldValidateAuth = Boolean(input.ytmusicBrowserAuth?.trim())

      if (!shouldValidateAuth) {
        return saveResult
      }

      const authStatus = await authService.getStatus({
        persistFailureSource: 'settings_save',
      })

      return {
        ...saveResult,
        details: authStatus.lastError
          ? `YT Music auth invalid. ${authStatus.lastError}`
          : saveResult.details,
        authStatus,
      }
    }
  )
  ipcMain.handle(
    'settings:testBinaries',
    async (): Promise<BinaryStatus> =>
      settingsService.testBinaries(getBundledFfmpegPath)
  )
  ipcMain.handle('settings:testRemote', () => settingsService.testRemote())
  ipcMain.handle('settings:pickOutputDirectory', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('sync:startLikedSongsSync', () =>
    syncService.startLikedSongsSync()
  )
  ipcMain.handle('sync:startLibraryReprocess', () =>
    syncService.startLibraryReprocess()
  )
  ipcMain.handle('sync:reprocessArtists', (_event, artistIds: string[]) =>
    syncService.reprocessArtists(artistIds)
  )
  ipcMain.handle(
    'sync:refreshFavoriteArtists',
    (_event, artistIds?: string[]) =>
      syncService.refreshFavoriteArtists(artistIds)
  )
  ipcMain.handle('sync:retryFailedTracks', (_event, jobId: string) =>
    syncService.retryFailedTracks(jobId)
  )
  ipcMain.handle('sync:clearFailures', () => syncService.clearFailures())
  ipcMain.handle('sync:cancel', (_event, jobId: string) =>
    syncService.cancel(jobId)
  )
  ipcMain.handle('sync:clearSyncData', () => syncService.clearSyncData())
  ipcMain.handle('sync:syncMissingToRemote', () =>
    syncService.syncMissingToRemote()
  )
  ipcMain.handle('sync:doctor', () => syncService.doctor())
  ipcMain.handle('sync:getSnapshot', () => syncService.getSnapshot())
  const refreshLibrary = async () => {
    const scanResult = await libraryService.reconcileLocalLibrary()
    if (!scanResult.ok) return scanResult

    const refreshResult = await likedArtistsService.refreshArtists()
    if (!window.isDestroyed()) {
      window.webContents.send('library:artistsUpdated')
    }
    void likedArtistsService
      .refreshArtistImages()
      .then((imageResult) => {
        logMain({
          level: imageResult.ok ? 'info' : 'warn',
          source: 'ipc',
          message: 'library refresh artist image pass complete',
          context: {
            ok: imageResult.ok,
            message: imageResult.message,
            details: imageResult.details ?? null,
          },
        })
      })
      .catch((error) => {
        logMain({
          level: 'error',
          source: 'ipc',
          message: 'library refresh artist image pass failed',
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        })
      })
    return {
      ...refreshResult,
      message: `${scanResult.message} ${refreshResult.message}`,
    }
  }
  ipcMain.handle('library:refreshIndex', refreshLibrary)
  ipcMain.handle('library:refreshArtists', refreshLibrary)
  ipcMain.handle('library:listArtists', () => likedArtistsService.listArtists())
  ipcMain.handle('library:refreshArtistImages', () =>
    likedArtistsService.refreshArtistImages()
  )
  ipcMain.handle('library:clearArtistImageCache', async () => {
    const result = await likedArtistsService.clearArtistImageCache()
    if (result.ok && !window.isDestroyed()) {
      window.webContents.send('library:artistsUpdated')
    }
    return result
  })
  ipcMain.handle(
    'library:setArtistFavorite',
    async (_event, artistId: string, isFavorite: boolean) => {
      const result = await likedArtistsService.setArtistFavorite(
        artistId,
        isFavorite
      )
      if (result.ok && !window.isDestroyed()) {
        window.webContents.send('library:artistsUpdated')
      }
      return result
    }
  )
  ipcMain.handle('library:listTracks', (_event, filter) =>
    libraryService.listTracks(filter)
  )
  ipcMain.handle('library:getTrack', (_event, trackId: string) =>
    libraryService.getTrack(trackId)
  )
  ipcMain.handle('library:getDriftSummary', () =>
    libraryService.getDriftSummary()
  )
  ipcMain.handle('library:listRoots', () => libraryService.listRoots())
  ipcMain.handle(
    'library:getAlbumArtwork',
    async (_event, albumKeys: string[]) => {
      const startedAt = Date.now()
      const keys = Array.isArray(albumKeys) ? albumKeys : []
      logMain({
        level: 'debug',
        source: 'ipc',
        message: 'library:getAlbumArtwork invoked',
        context: { albumCount: keys.length },
      })
      try {
        const entries = await artworkService.getAlbumArtwork(keys, {
          onEntry: (entry) => {
            if (!window.isDestroyed()) {
              window.webContents.send('library:albumArtworkUpdated', entry)
            }
          },
        })
        logMain({
          level: 'debug',
          source: 'ipc',
          message: 'library:getAlbumArtwork completed',
          context: {
            albumCount: keys.length,
            resolvedCount: entries.filter((entry) => entry.artworkUrl != null)
              .length,
            durationMs: Date.now() - startedAt,
          },
        })
        return { entries }
      } catch (error) {
        logMain({
          level: 'error',
          source: 'ipc',
          message: 'library:getAlbumArtwork failed',
          context: {
            albumCount: keys.length,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        throw error
      }
    }
  )

  return {
    eventChannel,
  }
}
