import path, { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { AuthCoordinator } from './auth/auth-coordinator'
import { createDatabase } from './db/database'
import { registerIpcHandlers } from './ipc'
import { ArtistPhotoCache } from './services/artist-photo-cache'
import {
  buildAccountImageMediaUrl,
  registerArtworkProtocol,
  registerArtworkSchemePrivileges,
} from './services/artwork-protocol'
import { ArtworkService } from './services/artwork-service'
import { AuthService } from './services/auth-service'
import { resolveFfmpegPath } from './services/ffmpeg-path'
import { LibraryService } from './services/library-service'
import { LikedArtistsService } from './services/liked-artists-service'
import { logMain, setTempLogMirror } from './services/logger'
import { PoTokenService } from './services/po-token-service'
import { PythonWorkerService } from './services/python-worker'
import { SettingsService } from './services/settings-service'
import { SyncService } from './services/sync-service'
import {
  createTempLogMirror,
  type TempLogMirror,
} from './services/temp-log-file'

let mainWindow: BrowserWindow | null = null
let tempLogMirror: TempLogMirror | null = null

registerArtworkSchemePrivileges()

function getBundledFfmpegPath() {
  return resolveFfmpegPath({
    isDev: is.dev,
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
  })
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

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron')
  const mirror = createTempLogMirror(app.getPath('temp'))
  tempLogMirror = mirror
  setTempLogMirror(mirror)
  logMain({
    level: 'info',
    source: 'startup',
    message: 'Main process logging ready',
    context: {
      tempLogFile: mirror?.getLogFilePath() ?? null,
      artworkCacheDir: path.join(app.getPath('userData'), 'artwork-cache'),
    },
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const databaseFile = path.join(
    app.getPath('userData'),
    'liked-music-syncer.db'
  )
  const settingsFile = path.join(app.getPath('userData'), 'settings.json')
  const { db } = createDatabase(databaseFile)
  const settingsService = new SettingsService(db, settingsFile)
  const pythonWorkerService = new PythonWorkerService()
  const artworkCacheDirectory = path.join(
    app.getPath('userData'),
    'artwork-cache'
  )
  const artistPhotoCacheDirectory = path.join(
    app.getPath('userData'),
    'artist-photo-cache'
  )
  const accountImageCacheDirectory = path.join(
    app.getPath('userData'),
    'account-image-cache'
  )
  const artworkService = new ArtworkService(
    db,
    pythonWorkerService,
    artworkCacheDirectory
  )
  const artistPhotoCache = new ArtistPhotoCache(artistPhotoCacheDirectory)
  const accountImageCache = new ArtistPhotoCache(
    accountImageCacheDirectory,
    undefined,
    buildAccountImageMediaUrl
  )
  registerArtworkProtocol(
    artworkCacheDirectory,
    artistPhotoCacheDirectory,
    accountImageCacheDirectory
  )
  const libraryService = new LibraryService(
    db,
    settingsService,
    pythonWorkerService,
    artworkService
  )
  const likedArtistsService = new LikedArtistsService(
    db,
    settingsService,
    pythonWorkerService,
    artistPhotoCache
  )
  const poTokenService = new PoTokenService()
  const authService = new AuthService(settingsService, pythonWorkerService)
  const syncService = new SyncService(
    db,
    settingsService,
    pythonWorkerService,
    libraryService,
    likedArtistsService,
    poTokenService,
    getBundledFfmpegPath
  )
  const authCoordinator = new AuthCoordinator(
    settingsService,
    pythonWorkerService,
    () => syncService.hasQueuedOrRunningJobs(),
    async () => {
      if (process.platform !== 'darwin') return null
      try {
        return (
          await app.getApplicationInfoForProtocol('https://music.youtube.com')
        ).path
      } catch {
        return null
      }
    },
    accountImageCache
  )
  syncService.setAuthCoordinator(authCoordinator)
  likedArtistsService.setAuthCoordinator(authCoordinator)
  await syncService.recoverInterruptedJobs()
  authCoordinator.setSwitchingDisabled(
    await syncService.hasQueuedOrRunningJobs()
  )
  syncService.subscribe((snapshot) => {
    authCoordinator.setSwitchingDisabled(
      snapshot.jobs.some(
        (job) => job.status === 'queued' || job.status === 'running'
      )
    )
  })

  createWindow()
  registerIpcHandlers(
    mainWindow!,
    settingsService,
    authService,
    authCoordinator,
    syncService,
    libraryService,
    likedArtistsService,
    artworkService,
    getBundledFfmpegPath
  )
  authCoordinator.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('auth:snapshot', snapshot)
  })
  const authBootstrap = authCoordinator.bootstrap().catch((error) => {
    logMain({
      level: 'error',
      source: 'startup',
      message: 'Authentication bootstrap failed',
      context: {
        error: error instanceof Error ? error.message : String(error),
      },
    })
  })
  void authBootstrap
    .then(() => libraryService.reconcileLocalLibrary())
    .then(async (result) => {
      if (!result.ok) {
        logMain({
          level: 'error',
          source: 'startup',
          message: 'Startup library reconcile failed',
          context: { error: result.message },
        })
        return
      }
      await likedArtistsService.refreshArtists()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:artistsUpdated')
      }
      void likedArtistsService
        .refreshArtistImages()
        .then((result) => {
          logMain({
            level: result.ok ? 'info' : 'warn',
            source: 'startup',
            message: 'Startup artist image refresh complete',
            context: {
              ok: result.ok,
              message: result.message,
              details: result.details ?? null,
            },
          })
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('library:artistsUpdated')
          }
        })
        .catch((error) => {
          logMain({
            level: 'error',
            source: 'startup',
            message: 'Startup artist image refresh failed',
            context: {
              error: error instanceof Error ? error.message : String(error),
            },
          })
        })
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => {
    tempLogMirror?.dispose()
    tempLogMirror = null
    setTempLogMirror(null)
    poTokenService.dispose()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
