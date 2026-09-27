import { parseAccount } from './parsers/account'
import { parseArtist, parseArtistReleasesPage } from './parsers/artist'
import { parsePlainLyrics, parseTimedLyrics } from './parsers/lyrics'
import { parsePlaylistPage, playlistHeaderCount } from './parsers/playlist'
import { parseRelease } from './parsers/release'
import { parseSearchPage } from './parsers/search'
import { parseWatch } from './parsers/watch'
import {
  type CatalogReleaseRef,
  CatalogShapeError,
  type CatalogTrack,
  type InnertubeTransport,
  type LikedSong,
  type YouTubeMusicCatalog,
} from './types'

const SONG_PARAMS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D'
const SONG_PARAMS_IGNORE_SPELLING = 'EgWKAQIIAUICCAFqChAJEAUQChADEAQ%3D'

export function createYouTubeMusicCatalog(
  transport: InnertubeTransport
): YouTubeMusicCatalog {
  const readArtist: YouTubeMusicCatalog['artist'] = async (
    channelId,
    signal
  ) => {
    const response = await transport.call({
      endpoint: 'browse',
      body: { browseId: channelId },
      authenticated: false,
      signal,
    })
    return parseArtist(response, channelId)
  }
  return {
    async likedSongs(signal) {
      let response = await transport.call({
        endpoint: 'browse',
        body: { browseId: 'VLLM' },
        authenticated: true,
        signal,
      })
      const declaredCount = playlistHeaderCount(response)
      const tracks: LikedSong[] = []
      let pageCount = 0
      let position = 0
      const seen = new Set<string>()
      while (true) {
        const page = parsePlaylistPage(response, pageCount === 0)
        pageCount++
        for (const entry of page.tracks)
          tracks.push({ ...entry.track, position: position + entry.index })
        position += page.itemCount
        if (!page.token) break
        if (seen.has(page.token))
          throw new CatalogShapeError('Repeated liked songs continuation')
        seen.add(page.token)
        response = await transport.call({
          endpoint: 'browse',
          body: { continuation: page.token },
          authenticated: true,
          signal,
        })
      }
      return { tracks, declaredCount, pageCount }
    },
    async release(browseId, signal) {
      const response = await transport.call({
        endpoint: 'browse',
        body: { browseId },
        authenticated: false,
        signal,
      })
      return parseRelease(response, browseId)
    },
    artist: readArtist,
    async artistReleases(channelId, signal) {
      const artist = await readArtist(channelId, signal)
      const all: CatalogReleaseRef[] = []
      for (const category of ['albums', 'singles'] as const) {
        const more =
          category === 'albums' ? artist.albumsMore : artist.singlesMore
        if (!more) {
          all.push(...artist[category])
          continue
        }
        let response = await transport.call({
          endpoint: 'browse',
          body: {
            browseId: more.browseId,
            ...(more.params ? { params: more.params } : {}),
          },
          authenticated: false,
          signal,
        })
        let continuation = false
        const seen = new Set<string>()
        while (true) {
          const page = parseArtistReleasesPage(response, continuation)
          all.push(...page.releases)
          if (!page.token) break
          if (seen.has(page.token))
            throw new CatalogShapeError('Repeated artist releases continuation')
          seen.add(page.token)
          response = await transport.call({
            endpoint: 'browse',
            body: { continuation: page.token },
            authenticated: false,
            signal,
          })
          continuation = true
        }
      }
      return [
        ...new Map(all.map((release) => [release.browseId, release])).values(),
      ]
    },
    async searchSongs(query, options, signal) {
      const limit = Math.max(0, options?.limit ?? 20)
      if (!limit) return []
      let response = await transport.call({
        endpoint: 'search',
        body: {
          query,
          params: options?.ignoreSpelling
            ? SONG_PARAMS_IGNORE_SPELLING
            : SONG_PARAMS,
        },
        authenticated: false,
        signal,
      })
      let continuation = false
      const tracks: CatalogTrack[] = []
      const seen = new Set<string>()
      while (true) {
        const page = parseSearchPage(response, continuation)
        tracks.push(...page.tracks)
        if (tracks.length >= limit || !page.token) break
        if (seen.has(page.token))
          throw new CatalogShapeError('Repeated search continuation')
        seen.add(page.token)
        response = await transport.call({
          endpoint: 'search',
          body: { continuation: page.token },
          authenticated: false,
          signal,
        })
        continuation = true
      }
      return tracks.slice(0, limit)
    },
    async watch(videoId, signal) {
      const response = await transport.call({
        endpoint: 'next',
        body: {
          videoId,
          isAudioOnly: true,
          enablePersistentPlaylistPanel: true,
        },
        authenticated: false,
        signal,
      })
      return parseWatch(response, videoId)
    },
    async lyrics(browseId, signal) {
      const timedResponse = await transport.call({
        endpoint: 'browse',
        body: { browseId },
        authenticated: false,
        client: 'ANDROID_MUSIC',
        signal,
      })
      const timed = parseTimedLyrics(timedResponse)
      if (timed) return timed
      const plainResponse = await transport.call({
        endpoint: 'browse',
        body: { browseId },
        authenticated: false,
        signal,
      })
      return parsePlainLyrics(plainResponse)
    },
    async account(signal) {
      const response = await transport.call({
        endpoint: 'account/account_menu',
        body: {},
        authenticated: true,
        signal,
      })
      return parseAccount(response)
    },
  }
}
