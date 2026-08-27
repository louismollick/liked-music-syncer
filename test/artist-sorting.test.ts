import { describe, expect, it } from 'vitest'
import { sortArtistsByTrackCount } from '../src/renderer/src/hooks/useArtists'
import type { LikedArtistView } from '../src/shared/contracts'

function artist(name: string, likedTrackCount: number): LikedArtistView {
  return { name, likedTrackCount } as LikedArtistView
}

describe('artist sorting', () => {
  it('sorts by track count descending and name for equal counts', () => {
    const sorted = sortArtistsByTrackCount([
      artist('Zulu', 2),
      artist('Beta', 8),
      artist('Alpha', 8),
      artist('Gamma', 4),
    ])

    expect(
      sorted.map(({ name, likedTrackCount }) => [name, likedTrackCount])
    ).toEqual([
      ['Alpha', 8],
      ['Beta', 8],
      ['Gamma', 4],
      ['Zulu', 2],
    ])
  })
})
