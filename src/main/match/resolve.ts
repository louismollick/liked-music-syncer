import {
  releaseTitlesMatch,
  sameReleasePosition,
} from '../catalog/release-match'
import type {
  CatalogRelease,
  CatalogTrack,
  LikedSong,
  YouTubeMusicCatalog,
} from '../catalog/types'
import { joinArtistNames } from '../domain'
import type { HttpClient } from '../net/http'
import type { SpotifyLikedTrack } from '../spotify/library'
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
  sourceVideoId: string | null,
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
    release.tracks.find((entry) => entry.videoId === track.videoId) ??
      release.tracks.find((entry) => sameReleasePosition(track, entry)) ??
      findReleaseTrack(release, [track.videoId], track.title, track.artists) ??
      track,
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
    releaseTitlesMatch(release.tracks[0].title, fallbackTitle)
  )
    return release.tracks[0]
  if (fallbackArtists.length) {
    const possible = release.tracks.filter(
      (entry) =>
        releaseTitlesMatch(entry.title, fallbackTitle) &&
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
  const candidates = await searchTracks(catalog, queries, signal)
  const originalDuration = primary.durationSeconds ?? song.durationSeconds
  const tolerance = (primary.videoType ?? song.videoType) === 'OMV' ? 60 : 45
  const ranked: { track: CatalogTrack; score: number[] }[] = []
  let originalLookups = 0
  for (const candidate of candidates) {
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
    const versionMatches = versionCompatible(
      `${title} ${primary.album?.name ?? song.album?.name ?? ''}`,
      artistName,
      candidate
    )
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
  const directReleaseId = primary.album?.browseId ?? song.album?.browseId
  if (directReleaseId) {
    const release = await catalog.release(directReleaseId, signal)
    const track = findReleaseTrack(
      release,
      [song.videoId],
      primary.title,
      primary.artists
    )
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
    if (
      track &&
      versionCompatible(
        `${primary.title} ${primary.album?.name ?? song.album?.name ?? ''}`,
        joinArtistNames(primary.artists),
        {
          title: track.title,
          album: { name: release.title, browseId: release.browseId },
        }
      )
    )
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

export class SpotifyMatchError extends Error {
  readonly kind = 'permanent' as const
  constructor(readonly reason: 'no_match' | 'ambiguous') {
    super(
      `Not found on YouTube Music (${reason === 'ambiguous' ? 'ambiguous Recording match' : 'no compatible Release Track'})`
    )
  }
}

/** Strip catalog/credit decorations only. Recording version text stays in every query. */
function spotifySearchTitle(title: string): string {
  return title
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]/giu, '')
    .replace(
      /\s*[([](?:\d{4}\s+)?(?:remaster(?:ed)?|deluxe(?: edition)?|explicit|clean)(?:\s+\d{4})?[)\]]/giu,
      ''
    )
    .replace(
      /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|deluxe(?: edition)?|explicit|clean)(?:\s+\d{4})?$/giu,
      ''
    )
    .trim()
}

type SpotifyCandidate = { match: Match; score: number; albumScore: number }

/** Hard Recording gates shared by catalog candidates and existing Library tracks. */
export function spotifyCandidateScore(
  source: SpotifyLikedTrack,
  candidate: Pick<Match, 'title' | 'artists' | 'album' | 'durationSeconds'>
): { score: number; albumScore: number } | null {
  if (candidate.durationSeconds === null) return null
  const delta = Math.abs(source.durationMs / 1000 - candidate.durationSeconds)
  const titleScore = textSimilarity(
    spotifySearchTitle(source.title),
    spotifySearchTitle(candidate.title)
  )
  const artistScore = Math.max(
    0,
    ...candidate.artists.map((artist) =>
      textSimilarity(source.artists[0]?.name, artist.name)
    )
  )
  if (
    delta > 5 ||
    titleScore < 0.9 ||
    artistScore < 0.88 ||
    !versionCompatible(
      `${source.title} ${source.album.name}`,
      source.artists[0]?.name ?? '',
      {
        title: candidate.title,
        album: { name: candidate.album, browseId: null },
      }
    )
  )
    return null
  const albumScore =
    source.album.name && candidate.album
      ? textSimilarity(
          spotifySearchTitle(source.album.name),
          spotifySearchTitle(candidate.album)
        )
      : 0.5
  return {
    score:
      0.45 * titleScore +
      0.3 * artistScore +
      0.15 * albumScore +
      0.1 * Math.max(0, 1 - delta / 10),
    albumScore,
  }
}

/** Different Release appearances of a catalog video are one Recording for likes. */
export function selectSpotifyCandidate(
  candidates: SpotifyCandidate[]
): Match | null {
  const recordings = new Map<string, SpotifyCandidate>()
  for (const candidate of candidates) {
    const previous = recordings.get(candidate.match.catalogVideoId)
    if (
      !previous ||
      candidate.albumScore > previous.albumScore ||
      (candidate.albumScore === previous.albumScore &&
        candidate.score > previous.score)
    )
      recordings.set(candidate.match.catalogVideoId, candidate)
  }
  const ranked = [...recordings.values()].sort((a, b) => b.score - a.score)
  if (!ranked.length) return null
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.04 - Number.EPSILON)
    throw new SpotifyMatchError('ambiguous')
  return ranked[0].match
}

export async function spotifyContribution(
  catalog: YouTubeMusicCatalog,
  source: SpotifyLikedTrack,
  albums: Map<string, Promise<CatalogRelease[]>>,
  signal?: AbortSignal
): Promise<Match> {
  const primaryArtist = source.artists[0]?.name ?? ''
  const browsed = new Map<string, Promise<CatalogRelease>>()
  const browse = (id: string) => {
    let promise = browsed.get(id)
    if (!promise) {
      promise = catalog.release(id, signal)
      browsed.set(id, promise)
    }
    return promise
  }
  const candidate = (
    release: CatalogRelease,
    track: CatalogTrack,
    method: ResolutionMethod
  ): SpotifyCandidate | null => {
    if (!track.videoId || !track.isAvailable || !release.browseId) return null
    const match = releaseTrack(release, track, null, method, null)
    const scores = spotifyCandidateScore(source, match)
    return scores ? { match, ...scores } : null
  }
  let albumLookup = albums.get(source.album.id)
  if (!albumLookup) {
    albumLookup = (async () => {
      const ids = new Set<string>()
      const releases: CatalogRelease[] = []
      for (const query of uniqueSearchQueries([
        `${source.album.name} ${primaryArtist}`,
        `${spotifySearchTitle(source.album.name)} ${primaryArtist}`,
      ])) {
        for (const album of await catalog.searchAlbums(query, signal)) {
          if (
            ids.has(album.browseId) ||
            textSimilarity(
              spotifySearchTitle(source.album.name),
              spotifySearchTitle(album.title)
            ) < 0.9 ||
            Math.max(
              0,
              ...album.artists.map((artist) =>
                textSimilarity(primaryArtist, artist.name)
              )
            ) < 0.88
          )
            continue
          ids.add(album.browseId)
          const release = await browse(album.browseId)
          if (
            textSimilarity(
              spotifySearchTitle(source.album.name),
              spotifySearchTitle(release.title)
            ) >= 0.9 &&
            Math.max(
              0,
              ...release.artists.map((artist) =>
                textSimilarity(primaryArtist, artist.name)
              )
            ) >= 0.88
          )
            releases.push(release)
          if (ids.size >= 3) return releases
        }
      }
      return releases
    })()
    albums.set(source.album.id, albumLookup)
    albumLookup.catch(() => albums.delete(source.album.id))
  }
  const albumCandidates = (await albumLookup).flatMap((release) =>
    release.tracks.flatMap((track) => {
      const found = candidate(release, track, 'spotify_album')
      return found ? [found] : []
    })
  )
  const albumMatch = selectSpotifyCandidate(albumCandidates)
  if (albumMatch) return albumMatch
  const queries = uniqueSearchQueries([
    `${source.title} ${primaryArtist} ${source.album.name}`,
    `${source.title} ${primaryArtist}`,
    `${spotifySearchTitle(source.title)} ${primaryArtist}`,
    ...source.artists
      .slice(1)
      .map((artist) => `${source.title} ${artist.name}`),
  ])
  const found: SpotifyCandidate[] = []
  for (const result of await searchTracks(catalog, queries, signal)) {
    if (!result.album?.browseId || !result.isAvailable) continue
    // Only browse results that already pass the Recording gates.
    if (
      !spotifyCandidateScore(source, {
        title: result.title,
        artists: result.artists,
        album: result.album.name,
        durationSeconds: result.durationSeconds,
      })
    )
      continue
    const release = await browse(result.album.browseId)
    const track = findReleaseTrack(
      release,
      [result.videoId],
      result.title,
      result.artists
    )
    if (!track) continue
    const checked = candidate(release, track, 'spotify_search')
    if (checked) found.push(checked)
  }
  const match = selectSpotifyCandidate(found)
  if (!match) throw new SpotifyMatchError('no_match')
  return match
}

function uniqueSearchQueries(queries: string[]): string[] {
  const seen = new Set<string>()
  return queries
    .filter((query) => {
      const key = normalizeText(query)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, SEARCH_QUERY_LIMIT)
}

/** Source-neutral song retrieval; each matcher applies its own Recording gates. */
async function searchTracks(
  catalog: YouTubeMusicCatalog,
  queries: string[],
  signal?: AbortSignal
): Promise<CatalogTrack[]> {
  const candidates = new Map<string, CatalogTrack>()
  for (const query of queries)
    for (const candidate of await catalog.searchSongs(
      query,
      { ignoreSpelling: false, limit: SEARCH_RESULT_LIMIT },
      signal
    )) {
      if (candidate.videoId)
        candidates.set(
          `${candidate.album?.browseId ?? ''}:${candidate.videoId}`,
          candidate
        )
    }
  return [...candidates.values()]
}
