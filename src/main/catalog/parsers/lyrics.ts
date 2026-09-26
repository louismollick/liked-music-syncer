import type { CatalogLyrics, TimedLyricLine } from '../types'
import { array, at, nav, string, text, walk } from './nav'

export function parseTimedLyrics(response: unknown): CatalogLyrics | null {
  let model: unknown
  walk(response, (node) => {
    if (!model && node.timedLyricsModel) model = node.timedLyricsModel
  })
  const data = array(nav(model, ['lyricsData', 'timedLyricsData']))
  if (!data) return null
  const timed: TimedLyricLine[] = data.flatMap((line) => {
    const start = Number(at(line, ['cueRange', 'startTimeMilliseconds']))
    const lyric = at(line, ['lyricLine'])
    if (
      !Number.isFinite(start) ||
      !at(line, ['cueRange', 'startTimeMilliseconds']) ||
      lyric === null
    )
      return []
    const rawEnd = at(line, ['cueRange', 'endTimeMilliseconds'])
    return [
      {
        startMs: start,
        endMs:
          rawEnd && Number.isFinite(Number(rawEnd)) ? Number(rawEnd) : null,
        text: lyric,
      },
    ]
  })
  return timed.length
    ? {
        timed,
        plain: null,
        source: string(nav(model, ['lyricsData', 'sourceMessage'])),
      }
    : null
}

export function parsePlainLyrics(response: unknown): CatalogLyrics | null {
  const shelf = nav(response, [
    'contents',
    'sectionListRenderer',
    'contents',
    0,
    'musicDescriptionShelfRenderer',
  ])
  const plain = text(nav(shelf, ['description']))
  if (!plain) return null
  return { timed: null, plain, source: text(nav(shelf, ['footer'])) }
}
