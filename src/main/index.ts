import { existsSync } from 'node:fs'
import path, { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { createDatabase } from './db/database'
import { registerIpcHandlers } from './ipc'
import { OAuthService } from './services/oauth-service'
import { PoTokenService } from './services/po-token-service'
import { PythonWorkerService } from './services/python-worker'
import { SettingsService } from './services/settings-service'
import { SyncService } from './services/sync-service'

let mainWindow: BrowserWindow | null = null

function getBundledFfmpegPath() {
  const candidate = is.dev
    ? path.join(process.cwd(), 'resources/bin', 'ffmpeg')
    : path.join(process.resourcesPath, 'bin', 'ffmpeg')

  return existsSync(candidate) ? candidate : 'ffmpeg'
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const databaseFile = path.join(
    app.getPath('userData'),
    'liked-music-syncer.db'
  )
  const { db } = createDatabase(databaseFile)
  const settingsService = new SettingsService(db)
  const pythonWorkerService = new PythonWorkerService()
  const poTokenService = new PoTokenService()
  const oauthService = new OAuthService(
    db,
    settingsService,
    pythonWorkerService
  )
  const syncService = new SyncService(
    db,
    settingsService,
    pythonWorkerService,
    poTokenService,
    getBundledFfmpegPath
  )

  createWindow()
  registerIpcHandlers(
    mainWindow!,
    settingsService,
    oauthService,
    syncService,
    getBundledFfmpegPath
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => {
    poTokenService.dispose()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
