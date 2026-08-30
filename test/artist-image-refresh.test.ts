import { describe, expect, it } from 'vitest'
import {
  getArtistImageRefreshKey,
  shouldRequestArtistImageRefresh,
} from '../src/renderer/src/components/library/artist-image-refresh'

describe('shouldRequestArtistImageRefresh', () => {
  it('does not request an automatic refresh while signed out', () => {
    expect(
      shouldRequestArtistImageRefresh({
        candidateKey: 'artist_1',
        isAuthenticated: false,
        lastRequestedKey: null,
      })
    ).toBe(false)
  })

  it('does not count artists without a channel ID as refresh candidates', () => {
    expect(
      getArtistImageRefreshKey([
        { id: 'artist_1', channelId: null, photoUrl: null },
        {
          id: 'artist_2',
          channelId: 'channel_2',
          photoUrl: 'https://example.test/photo.jpg',
        },
      ])
    ).toBeNull()
  })

  it('requests only once for an unchanged candidate set', () => {
    const candidateKey = getArtistImageRefreshKey([
      { id: 'artist_1', channelId: 'channel_1', photoUrl: null },
    ])

    expect(
      shouldRequestArtistImageRefresh({
        candidateKey,
        isAuthenticated: true,
        lastRequestedKey: null,
      })
    ).toBe(true)

    expect(
      shouldRequestArtistImageRefresh({
        candidateKey,
        isAuthenticated: true,
        lastRequestedKey: candidateKey,
      })
    ).toBe(false)
  })
})
