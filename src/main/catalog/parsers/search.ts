import {
  type CatalogAlbumSearchResult,
  CatalogShapeError,
  type CatalogTrack,
} from '../types'
import { array, at, firstRun, nav, requiredArray, text } from './nav'
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
  if (!shelf) {
    // A valid empty search has a message instead of a Songs shelf. Keep
    // rejecting unknown shapes so a broken response cannot become a match.
    const noResults = sections.some((section) =>
      (array(nav(section, ['itemSectionRenderer', 'contents'])) ?? []).some(
        (item) =>
          nav(item, ['messageRenderer', 'icon', 'iconType']) === 'SEARCH' &&
          text(nav(item, ['messageRenderer', 'text']))?.startsWith(
            'No results for '
          )
      )
    )
    if (noResults) return { tracks: [], token: null }
    throw new CatalogShapeError('Missing songs shelf')
  }
  const items = requiredArray(shelf, ['contents'], 'songs shelf items')
  return {
    tracks: parseListTracks(items),
    token: continuationToken(shelf),
  }
}

/** Albums-filter results are release rows, not song rows. */
export function parseAlbumSearch(
  response: unknown
): CatalogAlbumSearchResult[] {
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
    'album search sections'
  )
  const shelves = sections.flatMap((section) => {
    const shelf = nav(section, ['musicShelfRenderer'])
    return shelf ? [shelf] : []
  })
  const shelf = shelves.find(
    (entry) => firstRun(nav(entry, ['title'])) === 'Albums'
  )
  if (!shelf) {
    const empty = sections.some((section) =>
      (array(nav(section, ['itemSectionRenderer', 'contents'])) ?? []).some(
        (item) =>
          nav(item, ['messageRenderer', 'icon', 'iconType']) === 'SEARCH' &&
          text(nav(item, ['messageRenderer', 'text']))?.startsWith(
            'No results for '
          )
      )
    )
    if (empty) return []
    throw new CatalogShapeError('Missing albums shelf')
  }
  return requiredArray(shelf, ['contents'], 'album search items').flatMap(
    (value) => {
      if (nav(value, ['continuationItemRenderer'])) return []
      const item = nav(value, ['musicResponsiveListItemRenderer'])
      const columns = array(nav(item, ['flexColumns'])) ?? []
      const titleRun = nav(columns[0], [
        'musicResponsiveListItemFlexColumnRenderer',
        'text',
        'runs',
        0,
      ])
      const browseId =
        at(item, ['navigationEndpoint', 'browseEndpoint', 'browseId']) ??
        at(titleRun, ['navigationEndpoint', 'browseEndpoint', 'browseId'])
      const title = at(titleRun, ['text'])
      if (!browseId?.startsWith('MPRE') || !title)
        throw new CatalogShapeError('Unreadable album search result')
      const credits =
        array(
          nav(columns[1], [
            'musicResponsiveListItemFlexColumnRenderer',
            'text',
            'runs',
          ])
        ) ?? []
      const artists = credits.flatMap((run) => {
        const channelId = at(run, [
          'navigationEndpoint',
          'browseEndpoint',
          'browseId',
        ])
        const name = at(run, ['text'])
        return channelId?.startsWith('UC') && name ? [{ name, channelId }] : []
      })
      return [{ browseId, title, artists }]
    }
  )
}
