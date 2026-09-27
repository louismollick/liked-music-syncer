import { CatalogShapeError, type CatalogTrack } from '../types'
import { array, firstRun, nav, requiredArray } from './nav'
import { continuationToken } from './playlist'
import { parseListTracks } from './tracks'

export function parseSearchPage(
  response: unknown,
  continuation: boolean
): { tracks: CatalogTrack[]; token: string | null } {
  if (continuation) {
    const actions =
      array(nav(response, ['onResponseReceivedCommands'])) ??
      array(nav(response, ['onResponseReceivedActions'])) ??
      []
    const append = actions
      .map((action) => nav(action, ['appendContinuationItemsAction']))
      .find(Boolean)
    const shelf =
      append ??
      nav(response, ['continuationContents', 'musicShelfContinuation'])
    const items = requiredArray(
      shelf,
      append ? ['continuationItems'] : ['contents'],
      'search continuation items'
    )
    return { tracks: parseListTracks(items), token: continuationToken(shelf) }
  }
  const sections = requiredArray(
    response,
    [
      'contents',
      'tabbedSearchResultsRenderer',
      'tabs',
      0,
      'tabRenderer',
      'content',
      'sectionListRenderer',
      'contents',
    ],
    'search sections'
  )
  const shelves = sections.flatMap((section) => {
    const shelf = nav(section, ['musicShelfRenderer'])
    return shelf ? [shelf] : []
  })
  const shelf = shelves.find(
    (entry) => firstRun(nav(entry, ['title'])) === 'Songs'
  )
  if (!shelf) throw new CatalogShapeError('Missing songs shelf')
  const items = requiredArray(shelf, ['contents'], 'songs shelf items')
  return {
    tracks: parseListTracks(items),
    token: continuationToken(shelf),
  }
}
