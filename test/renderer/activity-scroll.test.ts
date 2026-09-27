import { describe, expect, it } from 'vitest'
import {
  isRowVisible,
  shouldRecenter,
} from '../../src/renderer/src/lib/activity-scroll'

describe('Activity scroll rules', () => {
  const base = {
    previousId: 'a',
    currentId: 'b',
    wasVisible: true,
    lastUserScrollAt: 0,
    now: 10_000,
  }

  it('re-centres when the current track changes, was visible, and the user is idle', () => {
    expect(shouldRecenter(base)).toBe(true)
  })

  it('keeps the scroll position when the user scrolled recently', () => {
    expect(shouldRecenter({ ...base, lastUserScrollAt: 9_000 })).toBe(false)
  })

  it('keeps the scroll position when the current row was off screen', () => {
    expect(shouldRecenter({ ...base, wasVisible: false })).toBe(false)
  })

  it('does nothing while the same track keeps progressing', () => {
    expect(shouldRecenter({ ...base, currentId: 'a' })).toBe(false)
    expect(shouldRecenter({ ...base, currentId: null })).toBe(false)
  })

  it('treats partially visible rows as visible', () => {
    expect(
      isRowVisible({ top: 90, bottom: 150 }, { top: 100, bottom: 500 })
    ).toBe(true)
    expect(
      isRowVisible({ top: 510, bottom: 560 }, { top: 100, bottom: 500 })
    ).toBe(false)
  })
})
