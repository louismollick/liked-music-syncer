import type { ActivityView } from '../shared/ipc'
import { type SyncState, stageText, syncStatus } from '../shared/status'

/** The pure decisions behind the menu bar; background.ts applies them. */

export type TrayIcon = 'note' | 'syncing' | 'dim'

/**
 * The icon follows the sync state. Template images can't be colored, so the
 * Needs Attention count rides next to the icon as the tray title.
 */
export function trayAppearance(
  state: SyncState,
  attention: number
): { icon: TrayIcon; title: string } {
  const icon: TrayIcon =
    state === 'signed_out' || state === 'paused'
      ? 'dim'
      : state === 'idle'
        ? 'note'
        : 'syncing'
  return { icon, title: attention > 0 ? ` ${attention}` : '' }
}

/** The two disabled lines at the top of the menu. */
export function menuLines(
  activity: ActivityView,
  signedIn: boolean,
  now: number
): { status: string; detail: string } {
  const { title, detail } = syncStatus(activity, signedIn, now)
  // Uploads can run while nothing downloads; show one of them then.
  const current = activity.current ?? activity.uploading[0] ?? null
  return {
    status: title,
    detail: current ? `${current.title} · ${stageText(current)}` : detail,
  }
}

/**
 * The Mac must stay awake only while work can actually run: a step or check is
 * in flight, or queued work is not blocked by an outage, a missing library
 * folder or a missing remote (the reconciler decides, as `runnable`).
 */
export function needsAwake(activity: ActivityView): boolean {
  return !activity.paused && activity.runnable
}
