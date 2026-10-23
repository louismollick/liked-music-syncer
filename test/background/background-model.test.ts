import { describe, expect, it } from 'vitest'
import {
  menuLines,
  needsAwake,
  trayAppearance,
} from '../../src/main/background-model'
import type { ActivityTrackView, ActivityView } from '../../src/shared/ipc'
import { outageText, syncStatus } from '../../src/shared/status'

const now = Date.parse('2026-10-05T12:00:00.000Z')

function activity(patch: Partial<ActivityView> = {}): ActivityView {
  return {
    working: false,
    checking: false,
    paused: false,
    remoteUnreachable: false,
    offline: false,
    lastCheckedAt: new Date(now - 4 * 60_000).toISOString(),
    current: null,
    uploading: [],
    upNext: [],
    upNextCount: 0,
    recent: [],
    needsAttention: [],
    ...patch,
  }
}

function track(patch: Partial<ActivityTrackView> = {}): ActivityTrackView {
  return {
    id: 't1',
    title: 'Song',
    artist: 'Artist',
    coverUrl: null,
    stage: 'downloading',
    // Downloading spans 0.15 to 0.85 of the whole, so this is 62% of the stage.
    progress: 0.15 + 0.7 * 0.62,
    completedAt: null,
    failed: false,
    ...patch,
  }
}

describe('syncStatus', () => {
  it.each([
    ['signed out', activity({ paused: true }), false, 'Not signed in'],
    ['paused', activity({ paused: true, checking: true }), true, 'Paused'],
    ['checking', activity({ checking: true }), true, 'Checking likes…'],
    [
      'syncing',
      activity({ upNextCount: 11, current: track() }),
      true,
      'Syncing 12 songs',
    ],
    ['syncing one', activity({ upNextCount: 1 }), true, 'Syncing 1 song'],
    [
      'syncing uploads',
      activity({ upNextCount: 1, uploading: [track(), track({ id: 't2' })] }),
      true,
      'Syncing 3 songs',
    ],
    ['idle', activity(), true, 'Up to date'],
  ])('%s', (_name, view, signedIn, title) => {
    expect(syncStatus(view, signedIn, now).title).toBe(title)
  })

  it('describes when likes were last checked', () => {
    expect(syncStatus(activity(), true, now).detail).toBe('Checked 4 min ago')
    expect(syncStatus(activity({ checking: true }), true, now).detail).toBe(
      'Last checked 4 min ago'
    )
    expect(
      syncStatus(activity({ lastCheckedAt: null }), true, now).detail
    ).toBe('Not checked yet')
  })

  it('says when syncing is stuck, ahead of the check time', () => {
    expect(syncStatus(activity({ offline: true }), true, now).detail).toBe(
      'Offline'
    )
    expect(
      syncStatus(activity({ remoteUnreachable: true }), true, now).detail
    ).toBe("Can't reach the VPS")
    expect(
      syncStatus(
        activity({ offline: true, remoteUnreachable: true }),
        true,
        now
      ).detail
    ).toBe('Offline')
    expect(syncStatus(activity({ offline: true }), false, now).detail).toBe(
      'Sign in from Settings'
    )
    expect(outageText(activity())).toBeNull()
  })
})

describe('menuLines', () => {
  it('shows the current track and its stage', () => {
    expect(
      menuLines(activity({ current: track(), upNextCount: 3 }), true, now)
    ).toEqual({
      status: 'Syncing 4 songs',
      detail: 'Song · Downloading 62%',
    })
  })

  it('shows the first upload when nothing is in the acquire lane', () => {
    expect(
      menuLines(
        activity({
          uploading: [
            track({ title: 'Up', stage: 'uploading', progress: 0.85 }),
          ],
        }),
        true,
        now
      )
    ).toEqual({ status: 'Syncing 1 song', detail: 'Up · Uploading 0%' })
  })

  it('shows the outage when idle with work waiting', () => {
    expect(
      menuLines(activity({ offline: true, upNextCount: 2 }), true, now).detail
    ).toBe('Offline')
  })

  it('falls back to when likes were checked', () => {
    expect(menuLines(activity(), true, now).detail).toBe('Checked 4 min ago')
    expect(menuLines(activity({ lastCheckedAt: null }), true, now).detail).toBe(
      'Not checked yet'
    )
  })
})

describe('trayAppearance', () => {
  it.each([
    ['idle', 'note'],
    ['syncing', 'syncing'],
    ['checking', 'syncing'],
    ['paused', 'dim'],
    ['signed_out', 'dim'],
  ] as const)('%s uses the %s icon', (state, icon) => {
    expect(trayAppearance(state, 0).icon).toBe(icon)
  })

  it('shows the attention count next to the icon, and clears it at zero', () => {
    expect(trayAppearance('idle', 3).title).toBe(' 3')
    expect(trayAppearance('idle', 0).title).toBe('')
  })
})

describe('needsAwake', () => {
  it('holds only while there is work and not paused', () => {
    expect(needsAwake(activity())).toBe(false)
    expect(needsAwake(activity({ checking: true }))).toBe(true)
    expect(needsAwake(activity({ current: track() }))).toBe(true)
    expect(needsAwake(activity({ upNextCount: 2 }))).toBe(true)
    expect(needsAwake(activity({ upNextCount: 2, paused: true }))).toBe(false)
  })

  it('counts a running upload as work', () => {
    expect(needsAwake(activity({ uploading: [track()] }))).toBe(true)
  })

  it('does not hold while waiting out an outage', () => {
    expect(needsAwake(activity({ upNextCount: 2, offline: true }))).toBe(false)
    expect(needsAwake(activity({ checking: true, offline: true }))).toBe(false)
    // Queued tracks wait on the VPS, but a running download is still work.
    expect(
      needsAwake(activity({ upNextCount: 2, remoteUnreachable: true }))
    ).toBe(false)
    expect(
      needsAwake(activity({ current: track(), remoteUnreachable: true }))
    ).toBe(true)
    expect(
      needsAwake(activity({ uploading: [track()], remoteUnreachable: true }))
    ).toBe(true)
  })
})
