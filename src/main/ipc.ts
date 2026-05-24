import type {
  BinaryStatus,
  SettingsSaveResult,
  SyncSnapshot,
} from '@shared/contracts'
import type { BrowserWindow } from 'electron'
import { dialog, ipcMain } from 'electron'
import type { AuthService } from './services/auth-service'
import type { LibraryService } from './services/library-service'
import type { LikedArtistsService } from './services/liked-artists-service'
import type { SettingsService } from './services/settings-service'
import type { SyncService } from './services/sync-service'

export function registerIpcHandlers(
  window: BrowserWindow,
  settingsService: SettingsService,
  authService: AuthService,
  syncService: SyncService,
  libraryService: LibraryService,
  likedArtistsService: LikedArtistsService,
  getBundledFfmpegPath: () => string
) {
  const eventChannel = 'sync:snapshot'

  syncService.subscribe((snapshot: SyncSnapshot) => {
    if (!window.isDestroyed()) {
      window.webContents.send(eventChannel, snapshot)
    }
  })
  libraryService.subscribeIndexStatus(() => {
    if (!window.isDestroyed()) {
      window.webContents.send('library:indexStatusUpdated')
    }
  })

  ipcMain.handle('auth:getStatus', () => authService.getStatus())
  ipcMain.handle('auth:captureBrowserAuth', (_event, browser) =>
    authService.captureBrowserAuth(browser)
  )
  ipcMain.handle('auth:disconnect', () => authService.disconnect())

  ipcMain.handle('settings:get', () => settingsService.getView())
  ipcMain.handle(
    'settings:save',
    async (_event, input): Promise<SettingsSaveResult> => {
      const saveResult = await settingsService.save(input)
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

  ipcMain.handle('sync:start', (_event, input) => syncService.start(input))
  ipcMain.handle('sync:reprocessArtists', (_event, artistIds: string[]) =>
    syncService.reprocessArtists(artistIds)
  )
  ipcMain.handle(
    'sync:refreshFavoriteArtists',
    (_event, artistIds?: string[]) =>
      syncService.refreshFavoriteArtists(artistIds)
  )
  ipcMain.handle('sync:cancel', (_event, runId: string) =>
    syncService.cancel(runId)
  )
  ipcMain.handle('sync:clearSyncData', () => syncService.clearSyncData())
  ipcMain.handle('sync:syncMissingToRemote', () =>
    syncService.syncMissingToRemote()
  )
  ipcMain.handle('sync:doctor', () => syncService.doctor())
  ipcMain.handle('sync:listRuns', () => syncService.listRuns())
  ipcMain.handle('sync:getRun', (_event, runId: string) =>
    syncService.getRun(runId)
  )
  ipcMain.handle('sync:getSnapshot', () => syncService.getSnapshot())
  ipcMain.handle('library:scanRoots', () => libraryService.scanRoots())
  ipcMain.handle('library:getIndexStatus', () =>
    libraryService.getIndexStatus()
  )
  const refreshLibrary = async () => {
    const scanResult = await libraryService.refreshIndex()
    if (!scanResult.ok) return scanResult

    const refreshResult = await likedArtistsService.refreshArtists()
    if (!window.isDestroyed()) {
      window.webContents.send('library:artistsUpdated')
    }
    void likedArtistsService
      .refreshArtistImages()
      .then(() => {
        if (!window.isDestroyed()) {
          window.webContents.send('library:artistsUpdated')
        }
      })
      .catch(() => undefined)
    return {
      ...refreshResult,
      message: `${scanResult.message} ${refreshResult.message}`,
    }
  }
  ipcMain.handle('library:refreshIndex', refreshLibrary)
  ipcMain.handle('library:refreshArtists', refreshLibrary)
  ipcMain.handle('library:listArtists', () => likedArtistsService.listArtists())
  ipcMain.handle(
    'library:setArtistFavorite',
    (_event, artistId: string, isFavorite: boolean) =>
      likedArtistsService.setArtistFavorite(artistId, isFavorite)
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

  return {
    eventChannel,
  }
}
