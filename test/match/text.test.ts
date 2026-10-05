import { describe, expect, it } from 'vitest'
import type { CatalogTrack } from '../../src/main/catalog/types'
import { sequenceMatcherRatio } from '../../src/main/match/sequence-matcher'
import {
  canonicalizeTrackTitle,
  identityScoresMatch,
  normalizeText,
  stripTitleAdornments,
  textSimilarity,
  titleVariants,
  versionCompatible,
  versionMarkers,
} from '../../src/main/match/text'
import golden from '../fixtures/match/text-golden.json'

const candidate = (title: string, artist: string): CatalogTrack => ({
  videoId: 'candidate',
  title,
  artists: [{ name: artist, channelId: null }],
  album: { name: 'Studio Album', browseId: 'album' },
  durationSeconds: 180,
  videoType: 'ATV',
  isExplicit: false,
  thumbnailUrl: null,
  trackNumber: null,
  discNumber: null,
  isAvailable: true,
})

describe('album version markers', () => {
  it.each([
    'Live Through This',
    'Demo Tapes',
    'Covers',
    'Edit',
    'The World We Live In',
  ])('ignores ordinary words in %s in both directions', (album) => {
    const studio = { title: 'Song', album: { name: album, browseId: null } }
    const single = { title: 'Song', album: { name: 'Single', browseId: null } }
    expect(versionCompatible(studio, single)).toBe(true)
    expect(versionCompatible(single, studio)).toBe(true)
  })
  it.each([
    ['Album (Live)', 'Live'],
    ['Album [Remixes]', 'Remix'],
    ['Album (Acoustic Version)', 'Acoustic'],
    ['Album [Covers]', 'Cover'],
    ['Album - Live', 'Live'],
    ['Live at Budokan', 'Live'],
    ['Live in Tokyo', 'Live'],
    ['Live from London', 'Live'],
    ['Live on Stage', 'Live'],
  ])('recognizes the version in %s symmetrically', (album, version) => {
    const versioned = { title: 'Song', album: { name: album, browseId: null } }
    const studio = { title: 'Song', album: null }
    expect(versionCompatible(versioned, studio)).toBe(false)
    expect(versionCompatible(studio, versioned)).toBe(false)
    expect(
      versionCompatible(versioned, { ...studio, title: `Song (${version})` })
    ).toBe(true)
    expect(
      versionCompatible({ ...studio, title: `Song (${version})` }, versioned)
    ).toBe(true)
  })
})
describe('Python text goldens', () => {
  it('matches 80 realistic titles and artists', () => {
    expect(golden).toHaveLength(80)
    for (const row of golden) {
      expect(normalizeText(row.title), row.title).toBe(row.normalize)
      expect(stripTitleAdornments(row.title), row.title).toBe(row.strip)
      expect(canonicalizeTrackTitle(row.title, [row.artist]), row.title).toBe(
        row.canonical
      )
      expect(
        [...titleVariants(row.title, [row.artist])].sort(),
        row.title
      ).toEqual(row.variants)
      expect(textSimilarity(row.title, row.compare), row.title).toBeCloseTo(
        row.similarity,
        9
      )
      expect(
        identityScoresMatch(
          textSimilarity(row.canonical, row.compare),
          textSimilarity(row.artist, row.artist)
        ),
        row.title
      ).toBe(row.identity)
      expect([...versionMarkers(row.title)].sort(), row.title).toEqual(
        row.markers
      )
      expect(
        versionCompatible(
          { title: row.title, album: null },
          candidate(row.compare, row.artist)
        ),
        row.title
      ).toBe(row.versionCompatible)
    }
  })
  it('reproduces difflib autojunk at 200 characters', () => {
    expect(
      sequenceMatcherRatio(`${'a'.repeat(199)}b`, `b${'a'.repeat(199)}`)
    ).toBeCloseTo(0.005, 9)
    expect(
      sequenceMatcherRatio(`x${'a'.repeat(210)}`, `y${'a'.repeat(210)}`)
    ).toBeCloseTo(0, 9)
  })
})
