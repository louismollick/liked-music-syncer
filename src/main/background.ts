import path from 'node:path'
import {
  app,
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type NativeImage,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  Tray,
} from 'electron'
import type { ActivityLive, ActivityView } from '../shared/ipc'
import { syncStatus } from '../shared/status'
import {
  menuLines,
  needsAwake,
  type TrayIcon,
  trayAppearance,
} from './background-model'
import { broadcast } from './ipc'
import type { Reconciler } from './reconcile/reconciler'
import type { SettingsStore } from './settings'

/**
 * Lets the app live in the menu bar: the tray icon and menu, the Dock icon
 * following the window, the login item, keeping the Mac awake while there is
 * work, and checking likes again after a wake.
 */

const TRAY_INTERVAL_MS = 1_000
// The network is often not back yet right after a wake.
const WAKE_DELAY_MS = 15_000

export interface Background {
  /** Feed every full Activity update; the icon updates at most once a second. */
  onActivity: (view: ActivityView) => void
  /** Feed progress ticks, which carry only the tracks being worked on. */
  onProgress: (live: ActivityLive) => void
  /** Redraw the icon after something Activity doesn't report, e.g. signing out. */
  refresh: () => void
}

export function startBackground(deps: {
  reconciler: Reconciler
  settings: SettingsStore
  isSignedIn: () => boolean
  createWindow: (route?: '/activity') => BrowserWindow
}): Background {
  const { reconciler, settings, isSignedIn } = deps

  // ------------------------------------------------------------ window and Dock

  let main: BrowserWindow | null = null
  const showWindow = (route?: '/activity') => {
    // The Dock icon only shows while a window is open.
    void app.dock?.show()
    app.focus({ steal: true })
    if (!main || main.isDestroyed()) {
      main = deps.createWindow(route)
      return
    }
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    if (route) broadcast('app:navigate', route)
  }
  app.on('activate', () => showWindow())
  app.on('second-instance', () => showWindow())
  app.on('window-all-closed', () => app.dock?.hide())

  // ------------------------------------------------------------ login item

  // wasOpenedAtLogin is the only detection left on macOS 13+: wasOpenedAsHidden
  // and restoreState are deprecated there and always false. Verified only
  // against the typings; a signed, packaged app is needed to see it fire.
  const openedAtLogin =
    app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin
  if (openedAtLogin) app.dock?.hide()
  else showWindow()

  // Dev runs must not register the Electron binary as a login item.
  const applyOpenAtLogin = (openAtLogin: boolean) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin })
  }
  let openAtLogin = settings.get().openAtLogin
  applyOpenAtLogin(openAtLogin)
  settings.subscribe((next) => {
    if (next.openAtLogin === openAtLogin) return
    openAtLogin = next.openAtLogin
    applyOpenAtLogin(openAtLogin)
  })

  // ------------------------------------------------------------ tray

  const iconDir = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(app.getAppPath(), 'resources', 'tray')
  // The Template suffix makes macOS tint the images for light and dark menu bars.
  const icons: Record<TrayIcon, NativeImage> = {
    note: nativeImage.createFromPath(path.join(iconDir, 'noteTemplate.png')),
    syncing: nativeImage.createFromPath(
      path.join(iconDir, 'syncingTemplate.png')
    ),
    dim: nativeImage.createFromPath(path.join(iconDir, 'dimTemplate.png')),
  }
  const tray = new Tray(icons.note)

  // The latest full view, kept current by full updates and progress ticks, so
  // the icon never rebuilds the Activity lists itself.
  let latest: ActivityView | null = null
  const refresh = () => {
    const view = latest ?? reconciler.activity()
    const { state } = syncStatus(view, isSignedIn())
    const { icon, title } = trayAppearance(state, view.needsAttention.length)
    tray.setImage(icons[icon])
    tray.setTitle(title)
  }

  // Built on every click so the relative time is fresh.
  const buildMenu = () => {
    const view = reconciler.activity()
    const signedIn = isSignedIn()
    const { status, detail } = menuLines(view, signedIn, Date.now())
    const attention = view.needsAttention.length
    const template: MenuItemConstructorOptions[] = [
      { label: status, enabled: false },
      { label: detail, enabled: false },
      { type: 'separator' },
      ...(attention > 0
        ? ([
            {
              label: `${attention} ${attention === 1 ? 'needs' : 'need'} attention`,
              click: () => showWindow('/activity'),
            },
            { label: 'Retry all', click: () => reconciler.retryAll() },
            { type: 'separator' },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      {
        label: 'Check likes now',
        enabled: signedIn && !view.paused,
        click: () => void reconciler.check(),
      },
      view.paused
        ? { label: 'Resume syncing', click: () => reconciler.resume() }
        : { label: 'Pause syncing', click: () => reconciler.pause() },
      { label: 'Open Liked Music', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: openAtLogin,
        enabled: app.isPackaged,
        click: (item) => void settings.update({ openAtLogin: item.checked }),
      },
      // Goes through before-quit, which shuts the reconciler down.
      { label: 'Quit Liked Music', click: () => app.quit() },
    ]
    return Menu.buildFromTemplate(template)
  }
  const popUp = () => tray.popUpContextMenu(buildMenu())
  tray.on('click', popUp)
  tray.on('right-click', popUp)
  refresh()

  // ------------------------------------------------------------ power

  let blocker: number | null = null
  const holdAwake = (awake: boolean) => {
    if (awake && blocker === null) {
      blocker = powerSaveBlocker.start('prevent-app-suspension')
    } else if (!awake && blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
    }
  }

  let wakeTimer: NodeJS.Timeout | null = null
  powerMonitor.on('resume', () => {
    if (wakeTimer) clearTimeout(wakeTimer)
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      if (!reconciler.paused) void reconciler.check()
    }, WAKE_DELAY_MS)
  })

  // Activity changes up to 10 times a second; the first change goes through
  // and later ones are folded into one redraw per interval.
  let lastRefresh = 0
  let refreshTimer: NodeJS.Timeout | null = null
  const update = (view: ActivityView) => {
    latest = view
    holdAwake(needsAwake(view))
    if (refreshTimer) return
    const wait = Math.max(0, TRAY_INTERVAL_MS - (Date.now() - lastRefresh))
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      lastRefresh = Date.now()
      refresh()
    }, wait)
  }
  return {
    onActivity: update,
    onProgress: (live) => {
      if (latest) update({ ...latest, ...live })
    },
    refresh,
  }
}
