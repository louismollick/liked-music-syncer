import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  layoutPath,
  pathKey,
  resolveCollision,
  sanitizeSegment,
  sidecarPath,
} from '../../src/main/inventory/layout'

const golden = JSON.parse(
  readFileSync(
    path.join(__dirname, '../fixtures/inventory/sanitize-golden.json'),
    'utf8'
  )
) as {
  segments: Record<string, string>
  paths: Array<
    [
      { albumartist: string; album: string; track: number; title: string },
      string,
    ]
  >
}

describe('layout', () => {
  it('sanitizes segments exactly like the old Python templating', () => {
    for (const [input, expected] of Object.entries(golden.segments)) {
      // Deliberate difference: a leading dot would hide the file, so the app replaces it.
      if (input.startsWith('.')) {
        expect(sanitizeSegment(input)).toBe(`_${input.slice(1)}`)
        continue
      }
      expect(sanitizeSegment(input)).toBe(expected)
    }
  })

  it('builds the same release paths as the old default templates', () => {
    for (const [ctx, expected] of golden.paths) {
      expect(
        layoutPath({
          title: ctx.title,
          album: ctx.album,
          albumArtist: ctx.albumartist,
          trackNumber: ctx.track,
          hasRelease: true,
        })
      ).toBe(expected)
    }
  })

  it('files Standalone Tracks as their own single', () => {
    expect(
      layoutPath({
        title: 'Promise MV',
        album: 'Unknown Album',
        albumArtist: '-SKS- ZIGZAG',
        trackNumber: 3,
        hasRelease: false,
      })
    ).toBe('-SKS- ZIGZAG/Promise MV/Promise MV.m4a')
  })

  it('adds a stable identity suffix on collision and compares paths case-insensitively', async () => {
    const taken = new Set([pathKey('A/B/01 X.m4a')])
    const first = await resolveCollision('a/b/01 x.m4a', 'MPREb_1:vid', (p) =>
      taken.has(pathKey(p))
    )
    expect(first).toMatch(/^a\/b\/01 x \[[0-9a-f]{6}\]\.m4a$/)
    const again = await resolveCollision('a/b/01 x.m4a', 'MPREb_1:vid', (p) =>
      taken.has(pathKey(p))
    )
    expect(again).toBe(first)
    expect(sidecarPath(first)).toBe(first.replace(/\.m4a$/, '.lrc'))
  })
})
