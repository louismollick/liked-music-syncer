import { describe, expect, it } from 'vitest'
import {
  buildAlbumArtworkSignature,
  filterArtworkState,
  normalizeAlbumArtworkKeys,
  readAlbumArtworkCache,
  writeAlbumArtworkCache,
} from '../src/renderer/src/hooks/album-artwork-store'

describe('album artwork store helpers', () => {
  it('normalizes keys into a stable unique order', () => {
    expect(
      normalizeAlbumArtworkKeys(['beta', '', 'alpha', 'beta', 'alpha'])
    ).toEqual(['alpha', 'beta'])
  })

  it('builds a stable signature for normalized keys', () => {
    expect(buildAlbumArtworkSignature(['alpha', 'beta'])).toBe(
      'alpha\u0001beta'
    )
  })

  it('reads and filters cached artwork by requested keys', () => {
    writeAlbumArtworkCache([
      { albumKey: 'alpha', artworkUrl: 'app-media://alpha.jpg' },
      { albumKey: 'beta', artworkUrl: null },
    ])

    expect(readAlbumArtworkCache(['alpha', 'missing'])).toEqual({
      alpha: 'app-media://alpha.jpg',
    })
    expect(
      filterArtworkState(
        {
          alpha: 'app-media://alpha.jpg',
          beta: null,
          gamma: 'app-media://gamma.jpg',
        },
        ['beta', 'gamma']
      )
    ).toEqual({
      beta: null,
      gamma: 'app-media://gamma.jpg',
    })
  })
})
