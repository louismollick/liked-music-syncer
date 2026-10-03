import { releaseTitlesMatch } from '../release-match'
import { type CatalogRelease, CatalogShapeError } from '../types'
import { array, at, duration, nav, requiredArray } from './nav'

/** Restore substituted music videos using positions in the release's own audio playlist. */
export async function restoreReleaseAudio(
  response: unknown,
  release: CatalogRelease,
  readTitle?: (videoId: string) => Promise<string | null>
): Promise<CatalogRelease> {
  const sections = requiredArray(
    response,
    [
      'contents',
      'twoColumnBrowseResultsRenderer',
      'tabs',
      0,
      'tabRenderer',
      'content',
      'sectionListRenderer',
      'contents',
    ],
    'official audio playlist'
  )
  const items = sections.flatMap((section) =>
    requiredArray(
      section,
      ['itemSectionRenderer', 'contents'],
      'audio playlist items'
    )
  )
  if (
    !items.length ||
    items.length !== release.tracks.length ||
    (release.trackCount !== null && items.length !== release.trackCount)
  )
    throw new CatalogShapeError('Incomplete official audio playlist')

  const tracks: CatalogRelease['tracks'] = []
  for (const [index, item] of items.entries()) {
    const lockup = nav(item, ['lockupViewModel'])
    const endpoint = nav(lockup, [
      'rendererContext',
      'commandContext',
      'onTap',
      'innertubeCommand',
      'watchEndpoint',
    ])
    const videoId = at(lockup, ['contentId'])
    if (
      !videoId ||
      at(endpoint, ['videoId']) !== videoId ||
      at(endpoint, ['playlistId']) !== release.audioPlaylistId ||
      nav(endpoint, ['index']) !== index
    )
      throw new CatalogShapeError('Invalid official audio playlist position')
    const track = release.tracks[index]
    const title = at(lockup, [
      'metadata',
      'lockupMetadataViewModel',
      'title',
      'content',
    ])
    if (
      videoId !== track.videoId &&
      (!title || !releaseTitlesMatch(title, track.title))
    ) {
      // YouTube can truncate titles or omit their translated half. Check the
      // exact audio video's Music metadata before refusing the release.
      const fullTitle = readTitle ? await readTitle(videoId) : null
      if (!fullTitle || !releaseTitlesMatch(fullTitle, track.title))
        throw new CatalogShapeError(
          'Official audio playlist does not match the release track list'
        )
    }
    if (track.videoType !== 'OMV') {
      tracks.push(track)
      continue
    }
    const overlays =
      array(nav(lockup, ['contentImage', 'thumbnailViewModel', 'overlays'])) ??
      []
    const durations = overlays.flatMap((overlay) =>
      (array(nav(overlay, ['thumbnailBottomOverlayViewModel', 'badges'])) ?? [])
        .map((badge) =>
          duration(at(badge, ['thumbnailBadgeViewModel', 'text']))
        )
        .filter((value): value is number => value !== null)
    )
    tracks.push({
      ...track,
      videoId,
      videoType: 'ATV' as const,
      durationSeconds: durations[0] ?? null,
    })
  }
  return { ...release, tracks }
}
