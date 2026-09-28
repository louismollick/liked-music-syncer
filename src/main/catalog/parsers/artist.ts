import {
  type CatalogArtist,
  type CatalogReleaseRef,
  CatalogShapeError,
  type ReleaseShelf,
} from '../types'
import {
  array,
  at,
  firstRun,
  nav,
  requiredArray,
  requiredObject,
  thumbnail,
  year,
} from './nav'
import { continuationToken } from './playlist'

/** Items a release shelf or grid may hold besides release cards. */
const NON_RELEASE_ITEMS = ['continuationItemRenderer']

/**
 * Reads one card of the Albums or Singles & EPs list. The shelf decides the
 * category: album cards often show only a year where singles show "Single".
 */
function releaseRef(
  value: unknown,
  shelf: ReleaseShelf
): CatalogReleaseRef | null {
  const item = nav(value, ['musicTwoRowItemRenderer'])
  if (!item) {
    if (NON_RELEASE_ITEMS.some((key) => nav(value, [key]))) return null
    throw new CatalogShapeError(`Unexpected item in the ${shelf} list`)
  }
  const browseId =
    at(item, ['navigationEndpoint', 'browseEndpoint', 'browseId']) ??
    at(item, [
      'title',
      'runs',
      0,
      'navigationEndpoint',
      'browseEndpoint',
      'browseId',
    ])
  const title = firstRun(nav(item, ['title']))
  if (!browseId?.startsWith('MPRE') || !title)
    throw new CatalogShapeError(`Unreadable release card in the ${shelf} list`)
  const subtitle = array(nav(item, ['subtitle', 'runs'])) ?? []
  return {
    browseId,
    title,
    shelf,
    year: year(at(subtitle[2], ['text']) ?? at(subtitle[0], ['text'])),
    thumbnailUrl: thumbnail(nav(item, ['thumbnailRenderer'])),
  }
}

function releaseRefs(items: unknown[], shelf: ReleaseShelf) {
  return items.flatMap((item) => {
    const ref = releaseRef(item, shelf)
    return ref ? [ref] : []
  })
}

export function parseArtist(
  response: unknown,
  channelId: string
): CatalogArtist {
  const header = requiredObject(
    response,
    ['header', 'musicImmersiveHeaderRenderer'],
    'artist header'
  )
  const name = firstRun(header.title)
  if (!name) throw new CatalogShapeError('Missing artist name')
  const sections = requiredArray(
    response,
    [
      'contents',
      'singleColumnBrowseResultsRenderer',
      'tabs',
      0,
      'tabRenderer',
      'content',
      'sectionListRenderer',
      'contents',
    ],
    'artist sections'
  )
  const result: CatalogArtist = {
    channelId,
    name,
    thumbnailUrl: thumbnail(header.thumbnail),
    albums: [],
    singles: [],
    albumsMore: null,
    singlesMore: null,
  }
  for (const section of sections) {
    const shelf = nav(section, ['musicCarouselShelfRenderer'])
    if (!shelf) continue
    const title = firstRun(
      nav(shelf, ['header', 'musicCarouselShelfBasicHeaderRenderer', 'title'])
    )
    const category =
      title === 'Albums'
        ? 'albums'
        : title?.startsWith('Singles')
          ? 'singles'
          : null
    if (!category) continue
    result[category] = releaseRefs(
      requiredArray(shelf, ['contents'], `${category} shelf items`),
      category
    )
    const endpoint =
      nav(shelf, [
        'header',
        'musicCarouselShelfBasicHeaderRenderer',
        'moreContentButton',
        'buttonRenderer',
        'navigationEndpoint',
        'browseEndpoint',
      ]) ??
      nav(shelf, [
        'header',
        'musicCarouselShelfBasicHeaderRenderer',
        'title',
        'runs',
        0,
        'navigationEndpoint',
        'browseEndpoint',
      ])
    const browseId = at(endpoint, ['browseId'])
    result[`${category}More`] = browseId
      ? { browseId, params: at(endpoint, ['params']) }
      : null
  }
  return result
}

export function parseArtistReleasesPage(
  response: unknown,
  continuation: boolean,
  shelf: ReleaseShelf
): { releases: CatalogReleaseRef[]; token: string | null } {
  const actions = array(nav(response, ['onResponseReceivedActions'])) ?? []
  const append = actions
    .map((action) => nav(action, ['appendContinuationItemsAction']))
    .find(Boolean)
  const grid = continuation
    ? (append ??
      requiredObject(
        response,
        ['continuationContents', 'gridContinuation'],
        'artist releases continuation'
      ))
    : requiredObject(
        response,
        [
          'contents',
          'singleColumnBrowseResultsRenderer',
          'tabs',
          0,
          'tabRenderer',
          'content',
          'sectionListRenderer',
          'contents',
          0,
          'gridRenderer',
        ],
        'artist releases grid'
      )
  const items = requiredArray(
    grid,
    continuation && append ? ['continuationItems'] : ['items'],
    'artist release items'
  )
  const releases = releaseRefs(items, shelf)
  const token = continuationToken(grid)
  return { releases, token }
}
