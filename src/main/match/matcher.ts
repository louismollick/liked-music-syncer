import { createLastfmGenres } from './lastfm'
import { enrichMusicBrainz } from './musicbrainz'
import {
  catalogContribution,
  createSpotifyCache,
  likedContribution,
  spotifyContribution,
} from './resolve'
import type { Matcher, MatcherDeps } from './types'

export function createMatcher(deps: MatcherDeps): Matcher {
  const genreCache = new Map<string, string[]>()
  const spotify = createSpotifyCache()
  const lastfm = createLastfmGenres(deps.http)
  return {
    resetCache: () => {
      spotify.albums.clear()
      spotify.nativeNames.clear()
      spotify.originalTitles.clear()
      lastfm.clear()
    },
    async match(input, signal) {
      if (input.kind === 'spotify')
        return spotifyContribution(
          deps.catalog,
          deps.http,
          input.track,
          spotify,
          signal
        )
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
    genre: lastfm.lookup,
  }
}
