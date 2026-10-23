import { plural, timeAgo } from './format'
import type { ActivityStage, ActivityTrackView, ActivityView } from './ipc'

/** Where each stage sits in a track's overall progress: [start, share]. */
export const STAGE_WEIGHTS: Record<ActivityStage, [number, number]> = {
  matching: [0, 0.15],
  lyrics: [0.15, 0.7],
  genres: [0.15, 0.7],
  downloading: [0.15, 0.7],
  uploading: [0.85, 0.15],
}

export const STAGE_LABEL: Record<ActivityStage, string> = {
  matching: 'Matching',
  lyrics: 'Finding lyrics',
  genres: 'Finding genres',
  downloading: 'Downloading',
  uploading: 'Uploading',
}

/** Progress within the current stage, 0..1. */
export function stageFraction(current: ActivityTrackView | null): number {
  if (!current?.stage) return 0
  const [base, weight] = STAGE_WEIGHTS[current.stage]
  return Math.max(0, Math.min(1, (current.progress - base) / weight))
}

/** The current track's stage with its percentage, e.g. `Downloading 62%`. */
export function stageText(current: ActivityTrackView): string {
  if (!current.stage) return 'Working'
  const label = STAGE_LABEL[current.stage]
  return current.stage === 'matching'
    ? label
    : `${label} ${Math.round(stageFraction(current) * 100)}%`
}

export type SyncState =
  | 'signed_out'
  | 'paused'
  | 'checking'
  | 'syncing'
  | 'idle'

/** Why syncing is stuck right now, if a lane lost its connection. */
export function outageText(activity: ActivityView | null): string | null {
  if (activity?.offline) return 'Offline'
  if (activity?.remoteUnreachable) return "Can't reach the VPS"
  return null
}

/** The one-line sync status shown in the Sidebar and the menu bar. */
export function syncStatus(
  activity: ActivityView | null,
  signedIn: boolean,
  now = Date.now()
): { state: SyncState; title: string; detail: string } {
  const remaining =
    (activity?.upNextCount ?? 0) +
    (activity?.current ? 1 : 0) +
    (activity?.uploading.length ?? 0)
  const checked = activity?.lastCheckedAt ?? null
  const state: SyncState = !signedIn
    ? 'signed_out'
    : activity?.paused
      ? 'paused'
      : activity?.checking
        ? 'checking'
        : remaining > 0
          ? 'syncing'
          : 'idle'
  const title = {
    signed_out: 'Not signed in',
    paused: 'Paused',
    checking: 'Checking likes…',
    syncing: `Syncing ${plural(remaining, 'song')}`,
    idle: 'Up to date',
  }[state]
  const detail =
    state === 'signed_out'
      ? 'Sign in from Settings'
      : (outageText(activity) ??
        (!checked
          ? 'Not checked yet'
          : `${state === 'checking' ? 'Last checked' : 'Checked'} ${timeAgo(checked, now)}`))
  return { state, title, detail }
}
