import type { CatalogTrack, WatchInfo } from '../types'
import {
  array,
  at,
  duration,
  firstRun,
  nav,
  object,
  thumbnail,
  walk,
} from './nav'
import { artistRuns, videoType } from './tracks'

function panelTrack(value: unknown): CatalogTrack | null {
  const data = object(value)
  if (!data || data.unplayableText) return null
  const videoId = at(data, ['videoId'])
  const title = firstRun(data.title)
  if (!videoId || !title) return null
  const byline = array(nav(data, ['longBylineText', 'runs'])) ?? []
  const artists = artistRuns(
    byline.filter((run) =>
      at(run, ['navigationEndpoint', 'browseEndpoint', 'browseId'])?.startsWith(
        'UC'
      )
    )
  )
  const albumRun = byline.find((run) =>
    at(run, ['navigationEndpoint', 'browseEndpoint', 'browseId'])?.startsWith(
      'MPRE'
    )
  )
  const albumName = at(albumRun, ['text'])
  return {
    videoId,
    title,
    artists,
    album: albumName
      ? {
          name: albumName,
          browseId: at(albumRun, [
            'navigationEndpoint',
            'browseEndpoint',
            'browseId',
          ]),
        }
      : null,
    durationSeconds: duration(firstRun(data.lengthText)),
    videoType: videoType(
      at(data, [
        'navigationEndpoint',
        'watchEndpoint',
        'watchEndpointMusicSupportedConfigs',
        'watchEndpointMusicConfig',
        'musicVideoType',
      ])
    ),
    isExplicit: false,
    thumbnailUrl: thumbnail(data.thumbnail),
    trackNumber: null,
    discNumber: null,
    isAvailable: true,
  }
}

export function parseWatch(
  response: unknown,
  requestedVideoId: string
): WatchInfo {
  let lyricsBrowseId: string | null = null
  const tracks: CatalogTrack[] = []
  walk(response, (node) => {
    const browseId = at(node, ['browseEndpoint', 'browseId'])
    if (!lyricsBrowseId && browseId?.startsWith('MPLY'))
      lyricsBrowseId = browseId
    const panel = object(node.playlistPanelVideoRenderer)
    if (panel) {
      const track = panelTrack(panel)
      if (track) tracks.push(track)
    }
  })
  return {
    lyricsBrowseId,
    track: tracks.find((track) => track.videoId === requestedVideoId) ?? null,
  }
}
