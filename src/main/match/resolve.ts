import type {
  CatalogRelease,
  CatalogTrack,
  LikedSong,
  YouTubeMusicCatalog,
} from '../catalog/types'
import { joinArtistNames } from '../domain'
import type { HttpClient } from '../net/http'
import { youtubeOriginalTitle } from './oembed'
import {
  artistTitleIdentities,
  cleanChannelArtist,
  identityScoresMatch,
  normalizeText,
  textSimilarity,
  versionCompatible,
} from './text'
import {
  type Match,
  type ResolutionMethod,
  releaseIdentityKey,
  standaloneIdentityKey,
} from './types'

const SEARCH_RESULT_LIMIT = 20
const SEARCH_QUERY_LIMIT = 6
const ORIGINAL_TITLE_LOOKUP_LIMIT = 3

type Id = { title: string; artist: string; method: string }
function normalizedThumbnail(url: string | null): string | null {
  if (!url) return null
  if (!url.includes('googleusercontent.com')) return url
  return url.replace(/=w\d+-h\d+(?:-[a-z0-9]+)*(?=$|[?&])/iu, '=w544-h544')
}
function kindFromLabel(label: string | null): 'album' | 'single' | 'ep' | null {
  const kind = label?.trim().toLowerCase()
  return kind === 'album' || kind === 'single' || kind === 'ep' ? kind : null
}
function releaseTrack(
  release: CatalogRelease,
  track: CatalogTrack,
  sourceVideoId: string,
  method: ResolutionMethod,
  lyricsBrowseId: string | null
): Match {
  const index = release.tracks.findIndex(
    (entry) => entry.videoId === track.videoId
  )
  if (index < 0)
    throw new Error(
      `Track ${track.videoId} is absent from release ${release.browseId}`
    )
  const discNumbers = [
    ...new Set(
      release.tracks
        .map((entry) => entry.discNumber)
        .filter((number): number is number => number !== null)
    ),
  ]
  const discNumber = track.discNumber
  const trackNumber =
    track.trackNumber ??
    (discNumber === null
      ? index + 1
      : release.tracks
          .slice(0, index + 1)
          .filter((entry) => entry.discNumber === discNumber).length)
  const trackTotal =
    discNumber === null
      ? release.tracks.length
      : release.tracks.filter((entry) => entry.discNumber === discNumber).length
  const artists = track.artists.length ? track.artists : release.artists
  return {
    version: 1,
    sourceVideoId,
    catalogVideoId: track.videoId,
    identityKey: releaseIdentityKey(release.browseId, track.videoId),
    release: {
      browseId: release.browseId,
      title: release.title,
      kind: kindFromLabel(release.kindLabel),
      artists: release.artists,
      year: release.year,
      date: release.year === null ? null : String(release.year),
      trackNumber,
      trackTotal,
      discNumber,
      discTotal: discNumbers.length ? discNumbers.length : null,
      thumbnailUrl: normalizedThumbnail(release.thumbnailUrl),
    },
    title: track.title,
    artists,
    album: release.title,
    albumArtist: joinArtistNames(
      release.artists.length ? release.artists : artists
    ),
    durationSeconds: track.durationSeconds,
    coverUrl: normalizedThumbnail(release.thumbnailUrl ?? track.thumbnailUrl),
    lyricsBrowseId,
    resolutionMethod: method,
  }
}
export function catalogContribution(
  release: CatalogRelease,
  track: CatalogTrack,
  lyricsBrowseId: string | null
): Match {
  return releaseTrack(
    release,
    release.tracks.find((entry) => entry.videoId === track.videoId) ?? track,
    track.videoId,
    'favorite_artist_release_exact',
    lyricsBrowseId
  )
}
function findReleaseTrack(
  release: CatalogRelease,
  preferredIds: string[],
  fallbackTitle: string,
  fallbackArtists: CatalogTrack['artists'] = []
): CatalogTrack | null {
  for (const videoId of preferredIds) {
    const track = release.tracks.find((entry) => entry.videoId === videoId)
    if (track) return track
  }
  if (
    release.tracks.length === 1 &&
    textSimilarity(release.tracks[0].title, fallbackTitle) >= 0.96
  )
    return release.tracks[0]
  if (fallbackArtists.length) {
    const possible = release.tracks.filter(
      (entry) =>
        textSimilarity(entry.title, fallbackTitle) >= 0.96 &&
        entry.artists.some((credited) =>
          fallbackArtists.some(
            (fallback) =>
              (credited.channelId &&
                credited.channelId === fallback.channelId) ||
              textSimilarity(credited.name, fallback.name) >= 0.88
          )
        )
    )
    if (possible.length === 1) return possible[0]
  }
  return null
}
function standalone(
  song: LikedSong,
  watchTrack: CatalogTrack | null,
  lyricsBrowseId: string | null
): Match {
  const track = watchTrack ?? song
  const artists = track.artists.length ? track.artists : song.artists
  const cleanedArtists =
    track.videoType === 'UGC' || song.videoType === 'UGC'
      ? artists.map((artist) => ({
          ...artist,
          name: cleanChannelArtist(artist.name),
        }))
      : artists
  const title = track.title || song.title
  return {
    version: 1,
    sourceVideoId: song.videoId,
    catalogVideoId: song.videoId,
    identityKey: standaloneIdentityKey(song.videoId),
    release: null,
    title,
    artists: cleanedArtists,
    album: title,
    albumArtist: cleanedArtists[0]?.name ?? 'Unknown Artist',
    durationSeconds: track.durationSeconds ?? song.durationSeconds,
    coverUrl: normalizedThumbnail(track.thumbnailUrl ?? song.thumbnailUrl),
    lyricsBrowseId,
    resolutionMethod: 'standalone',
  }
}
function tupleCompare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
async function searchCandidate(
  catalog: YouTubeMusicCatalog,
  http: HttpClient,
  song: LikedSong,
  primary: CatalogTrack,
  signal?: AbortSignal
): Promise<CatalogTrack | null> {
  const title = primary.title || song.title
  const artists = primary.artists.length ? primary.artists : song.artists
  const artistName = joinArtistNames(artists) || 'Unknown Artist'
  const identities: Id[] = artistTitleIdentities(
    title,
    artistName,
    primary.artists.map((a) => a.name)
  )
  if (!identities.length)
    identities.push({
      title,
      artist: artistName.split(',')[0].trim(),
      method: 'fallback',
    })
  const queries: string[] = []
  const seen = new Set<string>()
  for (const identity of identities) {
    const query = `${identity.title} ${identity.artist}`.trim()
    const key = normalizeText(query)
    if (key && !seen.has(key)) {
      seen.add(key)
      queries.push(query)
    }
    if (queries.length >= SEARCH_QUERY_LIMIT) break
  }
  const candidates = new Map<string, CatalogTrack>()
  for (const query of queries) {
    for (const candidate of await catalog.searchSongs(
      query,
      { ignoreSpelling: false, limit: SEARCH_RESULT_LIMIT },
      signal
    )) {
      if (candidate.videoId) candidates.set(candidate.videoId, candidate)
    }
  }
  const originalDuration = primary.durationSeconds ?? song.durationSeconds
  const tolerance = (primary.videoType ?? song.videoType) === 'OMV' ? 60 : 45
  const ranked: { track: CatalogTrack; score: number[] }[] = []
  let originalLookups = 0
  for (const candidate of candidates.values()) {
    const candidateDuration = candidate.durationSeconds
    const durationDiff =
      originalDuration !== null && candidateDuration !== null
        ? Math.abs(candidateDuration - originalDuration)
        : 0
    const durationMatches =
      originalDuration === null ||
      candidateDuration === null ||
      durationDiff <= tolerance
    const artistIdMatch = artists.some(
      (a) =>
        a.channelId &&
        candidate.artists.some((b) => b.channelId === a.channelId)
    )
    let scores = [0, 0, 0]
    for (const identity of identities) {
      const titleScore = textSimilarity(candidate.title, identity.title)
      const artistScore = Math.max(
        0,
        ...candidate.artists.map((a) => textSimilarity(a.name, identity.artist))
      )
      const next = [titleScore + artistScore, titleScore, artistScore]
      if (tupleCompare(next, scores) > 0) scores = next
    }
    let [, titleScore, artistScore] = scores
    if (artistIdMatch) artistScore = 1
    const versionMatches = versionCompatible(title, artistName, candidate)
    if (
      !identityScoresMatch(titleScore, artistScore) &&
      candidate.album?.browseId &&
      artistScore >= 0.88 &&
      durationMatches &&
      versionMatches &&
      originalLookups < ORIGINAL_TITLE_LOOKUP_LIMIT
    ) {
      originalLookups++
      const originalTitle = await youtubeOriginalTitle(
        http,
        candidate.videoId,
        signal
      )
      for (const identity of identities) {
        const altTitle = textSimilarity(originalTitle, identity.title)
        const altArtist = Math.max(
          0,
          ...candidate.artists.map((a) =>
            textSimilarity(a.name, identity.artist)
          )
        )
        const next = [altTitle + altArtist, altTitle, altArtist]
        if (tupleCompare(next, scores) > 0) scores = next
      }
      ;[, titleScore, artistScore] = scores
      if (artistIdMatch) artistScore = 1
    }
    if (
      !candidate.album?.browseId ||
      !identityScoresMatch(titleScore, artistScore) ||
      !durationMatches ||
      !versionMatches
    )
      continue
    ranked.push({
      track: candidate,
      score: [
        titleScore >= 0.96 ? 1 : 0,
        artistIdMatch ? 1 : artistScore,
        titleScore,
        candidate.videoType === 'ATV' ? 1 : 0,
        -durationDiff,
        candidate.videoId === song.videoId ? 0 : 1,
      ],
    })
  }
  ranked.sort((a, b) => tupleCompare(b.score, a.score))
  if (
    ranked.length > 1 &&
    ranked[0].score[0] === 0 &&
    tupleCompare(ranked[0].score.slice(0, 3), ranked[1].score.slice(0, 3)) === 0
  )
    return null
  return ranked[0]?.track ?? null
}
export async function likedContribution(
  catalog: YouTubeMusicCatalog,
  http: HttpClient,
  song: LikedSong,
  signal?: AbortSignal
): Promise<Match> {
  const watch = await catalog.watch(song.videoId, signal)
  const primary = watch.track ?? song
  const directReleaseId = primary.album?.browseId
  if (directReleaseId) {
    const release = await catalog.release(directReleaseId, signal)
    const track = findReleaseTrack(release, [song.videoId], primary.title)
    if (track)
      return releaseTrack(
        release,
        track,
        song.videoId,
        'liked_album_exact',
        watch.lyricsBrowseId
      )
  }
  const candidate = await searchCandidate(catalog, http, song, primary, signal)
  if (candidate?.album?.browseId) {
    const candidateWatch = await catalog.watch(candidate.videoId, signal)
    const candidateReleaseId =
      candidateWatch.track?.album?.browseId ?? candidate.album.browseId
    const release = await catalog.release(candidateReleaseId, signal)
    const track = findReleaseTrack(
      release,
      [candidate.videoId, song.videoId],
      candidate.title,
      candidate.artists
    )
    if (track)
      return releaseTrack(
        release,
        track,
        song.videoId,
        'search_song_exact',
        candidateWatch.lyricsBrowseId
      )
  }
  return standalone(song, watch.track, watch.lyricsBrowseId)
}
