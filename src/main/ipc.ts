import type {
  BinaryStatus,
  SettingsSaveResult,
  SyncSnapshot,
} from '@shared/contracts'
import type { BrowserWindow } from 'electron'
import { dialog, ipcMain } from 'electron'
import type { OAuthService } from './services/oauth-service'
import type { SettingsService } from './services/settings-service'
import type { SyncService } from './services/sync-service'

export function registerIpcHandlers(
  window: BrowserWindow,
  settingsService: SettingsService,
  oauthService: OAuthService,
  syncService: SyncService,
  getBundledFfmpegPath: () => string
) {
  const eventChannel = 'sync:snapshot'

  syncService.subscribe((snapshot: SyncSnapshot) => {
    if (!window.isDestroyed()) {
      window.webContents.send(eventChannel, snapshot)
    }
  })

  ipcMain.handle('auth:getStatus', () => oauthService.getStatus())
  ipcMain.handle('auth:startDeviceAuth', () => oauthService.startDeviceAuth())
  ipcMain.handle('auth:finishDeviceAuth', () => oauthService.finishDeviceAuth())
  ipcMain.handle('auth:disconnect', () => oauthService.disconnect())

  ipcMain.handle('settings:get', () => settingsService.getView())
  ipcMain.handle(
    'settings:save',
    async (_event, input): Promise<SettingsSaveResult> => {
      const previousSettings = await settingsService.getView()
      const saveResult = await settingsService.save(input)
      const shouldValidateAuth =
        input.ytmusicAuthMode === 'browser_headers' &&
        (Boolean(input.ytmusicBrowserAuth?.trim()) ||
          previousSettings.ytmusicAuthMode !== 'browser_headers')

      if (!shouldValidateAuth) {
        return saveResult
      }

      const authStatus = await oauthService.getStatus({
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
  ipcMain.handle('sync:cancel', (_event, runId: string) =>
    syncService.cancel(runId)
  )
  ipcMain.handle('sync:doctor', () => syncService.doctor())
  ipcMain.handle('sync:listRuns', () => syncService.listRuns())
  ipcMain.handle('sync:getRun', (_event, runId: string) =>
    syncService.getRun(runId)
  )
  ipcMain.handle('sync:getSnapshot', () => syncService.getSnapshot())
  ipcMain.handle('sync:getRunLogs', (_event, runId: string) =>
    syncService.getRunLogs(runId)
  )
  ipcMain.handle(
    'sync:getSongLogs',
    (_event, input: { runId: string; sourceVideoId: string }) =>
      syncService.getSongLogs(input.runId, input.sourceVideoId)
  )

  return {
    eventChannel,
  }
}
