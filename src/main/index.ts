import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { createAudioDownloader } from './acquire/audio'
import { createPotProvider } from './acquire/pot-provider'
import { createYtDlpBinary } from './acquire/ytdlp-binary'
import { createArtistImages } from './artist-images'
import { createArtistPages } from './artist-pages'
import { createYouTubeMusicCatalog } from './catalog/catalog'
import { broadcast, chooseFolder, registerIpc, showInFinder } from './ipc'
import { openDatabase } from './library/db'
import { LibraryQueries } from './library/queries'
import { createLyricsFinder } from './lyrics/finder'
import { createMatcher } from './match/matcher'
import {
  artistImageUrlFor,
  coverUrlFor,
  handleMediaProtocol,
  registerMediaScheme,
} from './media-protocol'
import { createHttpClient } from './net/http'
import { killAllChildren } from './platform/process'
import { resolveToolPaths } from './platform/tools'
import { Reconciler } from './reconcile/reconciler'
import { createRclone } from './remote/rclone'
import { GoogleSession } from './session/google-session'
import { SettingsStore } from './settings'
import { runSmokeTest } from './smoke'

// Dev and verification runs can point the app at a separate data directory.
if (process.env.LMS_USER_DATA_DIR) {
  mkdirSync(process.env.LMS_USER_DATA_DIR, { recursive: true })
  app.setPath('userData', process.env.LMS_USER_DATA_DIR)
}

registerMediaScheme()

const isSmokeTest = process.argv.includes('--smoke-test')

const isPrimaryInstance = isSmokeTest || app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0b0c',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  })
  window.on('ready-to-show', () => window.show())
  // Dropped files or stray links must never navigate the app window away.
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
    if (!allowed || !url.startsWith(allowed)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return window
}

async function main() {
  await app.whenReady()
  const userData = app.getPath('userData')
  const tools = resolveToolPaths({
    userData,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    execPath: process.execPath,
  })

  if (isSmokeTest) {
    const code = await runSmokeTest(tools, async () => {
      // The packaged renderer must load with its preload bridge.
      const probe = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          sandbox: true,
          contextIsolation: true,
        },
      })
      await probe.loadFile(path.join(__dirname, '../renderer/index.html'))
      const bridge =
        await probe.webContents.executeJavaScript('typeof window.lms')
      probe.destroy()
      if (bridge !== 'object')
        throw new Error(`preload bridge missing (${bridge})`)
    })
    app.exit(code)
    return
  }

  handleMediaProtocol(userData)
  const db = openDatabase(path.join(userData, 'library.db'))
  const settings = new SettingsStore(db)
  const http = createHttpClient()
  let reconcilerRef: Reconciler | null = null
  const session = new GoogleSession({
    http,
    settings,
    isPackaged: app.isPackaged,
    onChange: (view) => broadcast('session:changed', view),
    onRecovered: () => void reconcilerRef?.check(),
  })
  const catalog = createYouTubeMusicCatalog(session.transport)
  const matcher = createMatcher({ catalog, http })
  const lyrics = createLyricsFinder({ http, catalog })
  const pot = createPotProvider(tools)
  const downloader = createAudioDownloader({
    tools,
    ytdlp: createYtDlpBinary({ userData, http }),
    pot,
  })
  const rclone = createRclone(tools.rclone)
  const queries = new LibraryQueries(db, coverUrlFor, artistImageUrlFor, () =>
    settings.get()
  )
  const artistPages = createArtistPages({
    db,
    catalog,
    onUpdated: () => {
      reconcilerRef?.markDirty()
      broadcast('library:changed', { trackIds: null })
    },
  })
  let pagesTimer: NodeJS.Timeout | null = null
  let stoppingPages = false
  const scheduleArtistPages = (delay = 3_000) => {
    if (stoppingPages) return
    if (pagesTimer) clearTimeout(pagesTimer)
    pagesTimer = setTimeout(() => {
      pagesTimer = null
      void artistPages
        .run()
        .then((pending) => {
          if (pending) scheduleArtistPages(60_000)
        })
        .catch((error) => {
          console.error('[artist-pages] backfill failed', error)
          scheduleArtistPages(60_000)
        })
    }, delay)
  }
  const artistImages = createArtistImages({
    db,
    catalog,
    http,
    dir: path.join(userData, 'artists'),
    onUpdated: () => broadcast('library:changed', { trackIds: null }),
  })

  // New artists appear as tracks are adopted or matched; fetch their photos shortly after.
  let imagesTimer: NodeJS.Timeout | null = null
  const scheduleArtistImages = () => {
    if (imagesTimer) clearTimeout(imagesTimer)
    imagesTimer = setTimeout(() => void artistImages.run(), 3_000)
  }

  const reconciler: Reconciler = new Reconciler({
    db,
    tools,
    catalog,
    matcher,
    lyrics,
    downloader,
    rclone,
    http,
    settings: () => settings.get(),
    now: () => new Date(),
    session: {
      accountId: () => session.accountId(),
      generation: () => session.generation(),
      likedCountChanged: (accountId, count) =>
        session.setLikedCount(accountId, count),
    },
    coverUrl: coverUrlFor,
    onActivity: (view) => broadcast('activity:changed', view),
    onLibraryChanged: (trackIds) => {
      broadcast('library:changed', { trackIds })
      scheduleArtistImages()
      scheduleArtistPages()
    },
  })

  reconcilerRef = reconciler
  settings.subscribe((next) => broadcast('settings:changed', next))

  const busy = () => {
    const view = reconciler.activity()
    return view.checking || view.current !== null
  }

  registerIpc({
    'settings:get': () => settings.get(),
    'settings:update': async (patch) => {
      const before = settings.get()
      const next = settings.update(patch)
      const targetOf = (value: typeof before) =>
        `${value.rcloneRemote.trim().replace(/:$/, '')}|${value.remoteFolder.trim().replace(/\/+$/, '')}`
      if (targetOf(before) !== targetOf(next)) reconciler.remoteTargetChanged()
      // Which songs count as in the library depends on whether the remote is on.
      const remoteOn = (value: typeof before) =>
        Boolean(
          value.remoteEnabled &&
            value.rcloneRemote.trim() &&
            value.remoteFolder.trim()
        )
      if (remoteOn(before) !== remoteOn(next))
        broadcast('library:changed', { trackIds: null })
      if (
        patch.libraryFolder !== undefined &&
        patch.libraryFolder !== before.libraryFolder
      ) {
        await reconciler.libraryFolderChanged()
      } else {
        reconciler.markDirty()
      }
      return next
    },
    'settings:recheckLyrics': () => reconciler.recheckLyrics(),
    'settings:chooseFolder': () => chooseFolder(),
    'session:get': () => session.view(),
    'session:signIn': async () => {
      const view = await session.openSignIn()
      void reconciler.check()
      return view
    },
    'session:signOut': () => session.signOut(),
    'session:selectAccount': async (id) => {
      if (busy())
        throw new Error(
          'Wait for the current work to finish before switching accounts.'
        )
      const view = await session.selectAccount(id)
      void reconciler.check()
      return view
    },
    'activity:get': () => reconciler.activity(),
    'activity:check': () => {
      void reconciler.check()
    },
    'activity:refreshCatalogs': () => {
      void reconciler.check({ catalogs: 'all' })
    },
    'activity:retry': (id) => reconciler.retry(id),
    'activity:retryAll': () => reconciler.retryAll(),
    'activity:rewrite': (id) => reconciler.rewrite(id),
    'activity:stopManaging': (id) => reconciler.stopManaging(id),
    'library:counts': () => queries.counts(),
    'library:songs': (query) => queries.songs(query),
    'library:artists': (query) => queries.artists(query),
    'library:albums': (query) => queries.albums(query),
    'library:artist': (id) => queries.artist(id),
    'library:album': (key) => queries.album(key),
    'library:track': (id) => queries.track(id),
    'library:search': (text) => queries.search(text),
    'library:setFullDiscography': ({ artistId, fullDiscography }) => {
      reconciler.setFullDiscography(artistId, fullDiscography)
      broadcast('library:changed', { trackIds: null })
    },
    'library:refresh': (scope) => reconciler.refresh(scope),
    'library:delete': ({ trackIds, where }) =>
      reconciler.delete(trackIds, where),
    'library:unmanaged': () => queries.unmanaged(),
    'app:showInFinder': (absolutePath) => showInFinder(absolutePath),
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    } else {
      createWindow()
    }
  })

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void (async () => {
      stoppingPages = true
      if (pagesTimer) clearTimeout(pagesTimer)
      if (imagesTimer) clearTimeout(imagesTimer)
      await Promise.all([
        artistPages.stop().catch(() => undefined),
        reconciler.stop().catch(() => undefined),
      ])
      pot.dispose()
      killAllChildren()
      db.$client.close()
      app.exit(0)
    })()
  })

  await session.init()
  await reconciler.start()
  void artistImages.run()
  scheduleArtistPages(0)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// A second instance must not touch the database or the staging folder.
if (isPrimaryInstance) {
  void main().catch((error) => {
    console.error('[main] fatal', error)
    app.exit(1)
  })
}
