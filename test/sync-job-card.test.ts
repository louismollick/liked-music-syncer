import { describe, expect, it } from 'vitest'
import { canRetryFailedTracks } from '../src/renderer/src/components/sync/JobCard'

describe('sync job retry action', () => {
  it('is available only for finished jobs with failed tracks', () => {
    expect(
      canRetryFailedTracks({ status: 'completed', failedTracks: 82 })
    ).toBe(true)
    expect(canRetryFailedTracks({ status: 'cancelled', failedTracks: 1 })).toBe(
      true
    )
    expect(canRetryFailedTracks({ status: 'running', failedTracks: 82 })).toBe(
      false
    )
    expect(canRetryFailedTracks({ status: 'completed', failedTracks: 0 })).toBe(
      false
    )
  })
})
