import type { ArtistCredit } from '../../domain'
import type { CatalogTrack, VideoType } from '../types'
import { array, at, duration, firstRun, nav, object, thumbnail } from './nav'

export function videoType(value: unknown): VideoType | null {
  const raw = typeof value === 'string' ? value : null
  if (!raw) return null
  const suffix = raw.replace(/^MUSIC_VIDEO_TYPE_/, '')
  return suffix === 'ATV' ||
    suffix === 'OMV' ||
    suffix === 'UGC' ||
    suffix === 'OFFICIAL_SOURCE_MUSIC'
    ? suffix
    : 'OTHER'
}

export function artistRuns(value: unknown): ArtistCredit[] {
  const runs = array(value) ?? []
  return runs.flatMap((run) => {
    const name = at(run, ['text'])
    if (!name || /^\s*[•,&]\s*$/.test(name)) return []
    const channelId = at(run, [
      'navigationEndpoint',
      'browseEndpoint',
      'browseId',
    ])
    return [{ name, channelId: channelId?.startsWith('UC') ? channelId : null }]
  })
}

function flexRuns(item: unknown, index: number): unknown[] {
  return (
    array(
      nav(item, [
        'flexColumns',
        index,
        'musicResponsiveListItemFlexColumnRenderer',
        'text',
        'runs',
      ])
    ) ?? []
  )
}

export function parseListTrack(item: unknown): CatalogTrack | null {
  const data = object(item)
  if (!data) return null
  const play = nav(data, [
    'overlay',
    'musicItemThumbnailOverlayRenderer',
    'content',
    'musicPlayButtonRenderer',
    'playNavigationEndpoint',
    'watchEndpoint',
  ])
  const titleRun = flexRuns(data, 0)[0]
  const videoId =
    at(play, ['videoId']) ??
    at(data, ['playlistItemData', 'videoId']) ??
    at(titleRun, ['navigationEndpoint', 'watchEndpoint', 'videoId'])
  if (!videoId) return null
  const title = at(titleRun, ['text'])
  if (!title || title === 'Song deleted') return null
  let artists: ArtistCredit[] = []
  let album: CatalogTrack['album'] = null
  let durationSeconds: number | null = null
  for (let i = 1; i < (array(data.flexColumns)?.length ?? 0); i++) {
    for (const run of flexRuns(data, i)) {
      const name = at(run, ['text'])
      const id = at(run, ['navigationEndpoint', 'browseEndpoint', 'browseId'])
      if (id?.startsWith('MPRE') && name) album = { name, browseId: id }
      else if (id?.startsWith('UC') && name)
        artists.push({ name, channelId: id })
      else if (!id && name && durationSeconds === null)
        durationSeconds = duration(name)
    }
  }
  if (!artists.length) {
    const byline = flexRuns(data, 1)
    artists = artistRuns(
      byline.filter((run, index) => {
        const name = at(run, ['text'])
        const id = at(run, ['navigationEndpoint', 'browseEndpoint', 'browseId'])
        return (
          !!name &&
          !duration(name) &&
          !id?.startsWith('MPRE') &&
          !(index === 0 && ['Song', 'Video'].includes(name)) &&
          !/^\d[\d.,]*\s+(plays?|views?)$/i.test(name)
        )
      })
    )
  }
  const fixed = firstRun(
    nav(data, [
      'fixedColumns',
      0,
      'musicResponsiveListItemFixedColumnRenderer',
      'text',
    ])
  )
  durationSeconds = duration(fixed) ?? durationSeconds
  const rawType = at(play, [
    'watchEndpointMusicSupportedConfigs',
    'watchEndpointMusicConfig',
    'musicVideoType',
  ])
  const badges = array(data.badges) ?? []
  return {
    videoId,
    title,
    artists,
    album,
    durationSeconds,
    videoType: videoType(rawType),
    isExplicit: badges.some((badge) =>
      JSON.stringify(badge).includes('EXPLICIT')
    ),
    thumbnailUrl: thumbnail(data.thumbnail),
    trackNumber: null,
    discNumber: null,
    isAvailable:
      data.musicItemRendererDisplayPolicy !==
      'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT',
  }
}

export function parseListTracks(items: unknown[]): CatalogTrack[] {
  return items.flatMap((item) => {
    const track = parseListTrack(nav(item, ['musicResponsiveListItemRenderer']))
    return track ? [track] : []
  })
}
