import { CatalogShapeError, type CatalogTrack } from '../types'
import {
  array,
  at,
  nav,
  object,
  requiredArray,
  requiredObject,
  walk,
} from './nav'
import { parseListTrack } from './tracks'

const shelfPath = [
  'contents',
  'twoColumnBrowseResultsRenderer',
  'secondaryContents',
  'sectionListRenderer',
  'contents',
  0,
  'musicPlaylistShelfRenderer',
] as const

export function playlistHeaderCount(response: unknown): number | null {
  const runs =
    array(
      nav(response, [
        'contents',
        'twoColumnBrowseResultsRenderer',
        'tabs',
        0,
        'tabRenderer',
        'content',
        'sectionListRenderer',
        'contents',
        0,
        'musicResponsiveHeaderRenderer',
        'secondSubtitle',
        'runs',
      ])
    ) ?? []
  for (const run of runs) {
    const match = at(run, ['text'])?.match(/([\d,]+)\s+songs?/i)
    if (match) return Number(match[1].replaceAll(',', ''))
  }
  return null
}

export function continuationToken(value: unknown): string | null {
  let token: string | null = null
  walk(value, (node) => {
    if (token) return
    token =
      at(node, ['nextContinuationData', 'continuation']) ??
      at(node, ['continuationCommand', 'token'])
  })
  return token
}

export function parsePlaylistPage(
  response: unknown,
  first: boolean
): {
  tracks: { track: CatalogTrack; index: number }[]
  token: string | null
  itemCount: number
} {
  let items: unknown[]
  let source: unknown
  if (first) {
    source = requiredObject(response, shelfPath, 'playlist shelf')
    items = requiredArray(source, ['contents'], 'playlist items')
  } else {
    const actions = array(nav(response, ['onResponseReceivedActions'])) ?? []
    const append = actions
      .map((action) => nav(action, ['appendContinuationItemsAction']))
      .find((entry) => object(entry))
    source =
      append ??
      nav(response, ['continuationContents', 'musicPlaylistShelfContinuation'])
    if (!object(source))
      throw new CatalogShapeError('Missing playlist continuation')
    items = requiredArray(
      source,
      append ? ['continuationItems'] : ['contents'],
      'playlist continuation items'
    )
  }
  const tracks: { track: CatalogTrack; index: number }[] = []
  let itemCount = 0
  for (const item of items) {
    const renderer = nav(item, ['musicResponsiveListItemRenderer'])
    if (!object(renderer)) continue
    const track = parseListTrack(renderer)
    if (track) tracks.push({ track, index: itemCount })
    itemCount++
  }
  return {
    tracks,
    token: continuationToken(source),
    itemCount,
  }
}
