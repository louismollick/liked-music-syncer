import { describe, expect, it } from 'vitest'
import { hasSignedInAccount } from '../../src/renderer/src/lib/accounts'

describe('liked-music account gate', () => {
  const states = [null, 'signed_out', 'checking', 'error', 'signed_in'] as const

  it.each(
    states.flatMap((youtube) =>
      states.map((spotify) => [youtube, spotify] as const)
    )
  )('allows sync and setup with YouTube %s and Spotify %s', (youtube, spotify) => {
    expect(
      hasSignedInAccount(
        youtube ? { state: youtube } : null,
        spotify ? { state: spotify } : null
      )
    ).toBe(youtube === 'signed_in' || spotify === 'signed_in')
  })
})
