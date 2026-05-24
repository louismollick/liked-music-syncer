import { describe, expect, it } from 'vitest'
import { isLowResArtistPhotoUrl } from '../src/shared/artist-photo-url'

describe('isLowResArtistPhotoUrl', () => {
  it('treats missing urls as needing refresh', () => {
    expect(isLowResArtistPhotoUrl(null)).toBe(true)
  })

  it('flags small google CDN size tokens', () => {
    expect(
      isLowResArtistPhotoUrl(
        'https://lh3.googleusercontent.com/x=s88-c-k-no-rj'
      )
    ).toBe(true)
    expect(
      isLowResArtistPhotoUrl(
        'https://lh3.googleusercontent.com/x=s544-c-k-no-rj'
      )
    ).toBe(false)
  })
})
