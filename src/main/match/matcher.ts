import { enrichMusicBrainz } from './musicbrainz'
import { catalogContribution, likedContribution } from './resolve'
import type { Matcher, MatcherDeps } from './types'

export function createMatcher(deps: MatcherDeps): Matcher {
  const genreCache = new Map<string, string[]>()
  return {
    async match(input, signal) {
      if (input.kind === 'liked')
        return likedContribution(deps.catalog, deps.http, input.song, signal)
      let lyricsBrowseId: string | null = null
      try {
        lyricsBrowseId = (await deps.catalog.watch(input.track.videoId, signal))
          .lyricsBrowseId
      } catch (error) {
        if (signal?.aborted) throw error
        /* Lyrics lookup is optional for catalog contributions. */
      }
      return catalogContribution(input.release, input.track, lyricsBrowseId)
    },
    enrich(match, signal) {
      return enrichMusicBrainz(deps.http, match, signal, genreCache)
    },
  }
}
