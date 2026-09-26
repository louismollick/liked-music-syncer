import { type CatalogRelease, CatalogShapeError } from '../types'
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
import { artistRuns, parseListTrack } from './tracks'

const root = ['contents', 'twoColumnBrowseResultsRenderer'] as const

export function parseRelease(
  response: unknown,
  browseId: string
): CatalogRelease {
  const header = requiredObject(
    response,
    [
      ...root,
      'tabs',
      0,
      'tabRenderer',
      'content',
      'sectionListRenderer',
      'contents',
      0,
      'musicResponsiveHeaderRenderer',
    ],
    'release header'
  )
  const title = firstRun(header.title)
  if (!title) throw new CatalogShapeError('Missing release title')
  const subtitle = array(nav(header, ['subtitle', 'runs'])) ?? []
  const kindLabel = at(subtitle[0], ['text'])
  const releaseYear = year(at(subtitle[2], ['text']))
  const artists = artistRuns(nav(header, ['straplineTextOne', 'runs']))
  const second = firstRun(header.secondSubtitle)
  const countMatch = second?.match(/([\d,]+)\s+songs?/i)
  const trackCount = countMatch
    ? Number(countMatch[1].replaceAll(',', ''))
    : null
  const sections = requiredArray(
    response,
    [...root, 'secondaryContents', 'sectionListRenderer', 'contents'],
    'release sections'
  )
  const shelves = sections.flatMap((section) => {
    const shelf = nav(section, ['musicShelfRenderer'])
    return shelf ? [shelf] : []
  })
  if (!shelves.length) throw new CatalogShapeError('Missing release track list')
  const tracks: CatalogRelease['tracks'] = []
  let disc = 0
  for (const shelf of shelves) {
    const items = requiredArray(shelf, ['contents'], 'release tracks')
    const discNumber = shelves.length > 1 ? ++disc : null
    for (const item of items) {
      const track = parseListTrack(
        nav(item, ['musicResponsiveListItemRenderer'])
      )
      if (!track) continue
      track.album = { browseId, name: title }
      if (!track.artists.length) track.artists = artists
      track.trackNumber = tracks.length + 1
      track.discNumber = discNumber
      tracks.push(track)
    }
  }
  const buttons = array(header.buttons) ?? []
  const audioPlaylistId =
    buttons
      .map(
        (button) =>
          at(button, [
            'musicPlayButtonRenderer',
            'playNavigationEndpoint',
            'watchEndpoint',
            'playlistId',
          ]) ??
          at(button, [
            'musicPlayButtonRenderer',
            'playNavigationEndpoint',
            'watchPlaylistEndpoint',
            'playlistId',
          ])
      )
      .find((id) => id?.startsWith('OLAK')) ?? null
  return {
    browseId,
    title,
    kindLabel,
    artists,
    year: releaseYear,
    thumbnailUrl: thumbnail(header.thumbnail),
    audioPlaylistId,
    trackCount,
    tracks,
  }
}
