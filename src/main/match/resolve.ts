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
import { CatalogShapeError } from '../catalog/types'
import { joinArtistNames } from '../domain'
import type { HttpClient } from '../net/http'
import { HttpError } from '../net/http'
import type { SpotifyLikedTrack } from '../spotify/library'
import { youtubeOriginalTitle } from './oembed'
import { sequenceMatcherRatio } from './sequence-matcher'
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
      { title, album: primary.album ?? song.album },
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
        { title: primary.title, album: primary.album ?? song.album },
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
  constructor(readonly reason: 'no_match' | 'ambiguous' | 'unavailable') {
    super(
      reason === 'ambiguous'
        ? 'Several compatible YouTube Music Release Tracks found; no confident winner'
        : reason === 'unavailable'
          ? 'Matching Release Track is marked unavailable on YouTube Music'
          : 'Not found on YouTube Music (no compatible Release Track)'
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

/** Split mixed-script labels or exact duplicate labels, never edition suffixes. */
function spotifyTitleVariants(title: string): string[] {
  const parts = title.split(/\s+-\s+/u)
  const labelKey = (label: string) =>
    normalizeText(label).replace(/\s+(?=[([{])/gu, '')
  if (parts.length === 2 && labelKey(parts[0]) === labelKey(parts[1]))
    return [...new Set(parts.map(normalizeText))]
  if (
    parts.length !== 2 ||
    /[^\P{L}\p{Script=Latin}]/u.test(parts[0]) ===
      /[^\P{L}\p{Script=Latin}]/u.test(parts[1]) ||
    /^(?:\d{4}\s+)?(?:remaster(?:ed)?|deluxe(?: edition)?|explicit|clean)(?:\s+\d{4})?$/iu.test(
      parts[1]
    ) ||
    parts.some((part) =>
      /\b(?:version|ver\.?|edition|mix|recording)\b/iu.test(part)
    ) ||
    !versionCompatible({ title, album: null }, { title: parts[0], album: null })
  )
    return [normalizeText(title)]
  return [...new Set([title, ...parts].map(normalizeText).filter(Boolean))]
}

function exactSpotifyTitle(source: string, candidate: string): boolean {
  const variants = spotifyTitleVariants(source)
  return spotifyTitleVariants(candidate).some((title) =>
    variants.includes(title)
  )
}

function spotifyTitleScore(source: string, candidate: string): number {
  const sourceVariants = spotifyTitleVariants(source)
  const candidateVariants = spotifyTitleVariants(candidate)
  const suffixBase = (title: string) =>
    normalizeText(
      title
        .replace(/(?:\s*[([{（【][^)\]}）】]*[)\]}）】])+\s*$/u, '')
        .replace(/\s+-\s+.+$/u, '')
    )
  // Bare extra words can be a different song. Only delimited suffixes retain
  // the old containment credit; bilingual labels use their narrow variants.
  let score = 0
  if (
    sourceVariants.length === 1 &&
    candidateVariants.length === 1 &&
    (normalizeText(source) === suffixBase(candidate) ||
      normalizeText(candidate) === suffixBase(source))
  )
    score = textSimilarity(source, candidate)
  for (const left of sourceVariants)
    for (const right of candidateVariants) {
      if (left === right) return 1
      if (
        (sourceVariants.length === 1 && candidateVariants.length === 1) ||
        (!left.includes(right) && !right.includes(left))
      )
        score = Math.max(score, sequenceMatcherRatio(left, right))
    }
  return score
}

function sameArtistTokens(left: string, right: string): boolean {
  const a = normalizeText(left).split(' ').filter(Boolean).sort()
  const b = normalizeText(right).split(' ').filter(Boolean).sort()
  return (
    a.length > 0 && a.length === b.length && a.every((word, i) => word === b[i])
  )
}

type SpotifyEvidence = {
  /** Presence enables the fallback pass, including token-order equivalence. */
  nativeNames?: ReadonlyMap<string, string | null>
  originalTitle?: string | null
}

type SpotifyCandidate = {
  match: Match
} & NonNullable<ReturnType<typeof spotifyCandidateScore>>

export function createSpotifyCache() {
  return {
    albums: new Map<string, Promise<CatalogRelease[]>>(),
    nativeNames: new Map<string, Promise<string | null>>(),
    originalTitles: new Map<string, Promise<string | null>>(),
  }
}

/** Hard Recording gates shared by catalog candidates and existing Library tracks. */
export function spotifyCandidateScore(
  source: SpotifyLikedTrack,
  candidate: Pick<Match, 'title' | 'artists' | 'album' | 'durationSeconds'>,
  evidence: SpotifyEvidence = {}
) {
  const section = (title: string) =>
    normalizeText(
      /(?:\s+-\s+|[([{（【])\s*(reprise|intro|interlude|prelude|bonus track|(?:pt\.?|part)\s+(?:\d+|[ivxlcdm]+))(?=\s|[)\]}）】]|$)/iu.exec(
        title
      )?.[1] ?? ''
    )
  // A reprise or numbered section can share the main song's artist and length.
  if (section(source.title) !== section(candidate.title)) return null
  if (candidate.durationSeconds === null) return null
  const delta = Math.abs(source.durationMs / 1000 - candidate.durationSeconds)
  if (delta > 5) return null
  let titleScore = spotifyTitleScore(
    spotifySearchTitle(source.title),
    spotifySearchTitle(candidate.title)
  )
  let artistScore = Math.max(
    0,
    ...candidate.artists.map((artist) =>
      textSimilarity(source.artists[0]?.name, artist.name)
    )
  )
  if (
    !versionCompatible(
      {
        title: source.title,
        album: { name: source.album.name, browseId: null },
      },
      {
        title: candidate.title,
        album: { name: candidate.album, browseId: null },
      }
    )
  )
    return null
  const exactTitle = exactSpotifyTitle(source.title, candidate.title)
  if (artistScore < 0.88) {
    // Relaxing the artist gate requires exact title evidence and excludes
    // original-title relaxation, so two uncertain identities cannot combine.
    const primary = source.artists[0]?.name ?? ''
    if (
      !normalizeText(primary) ||
      !evidence.nativeNames ||
      evidence.originalTitle ||
      !exactTitle ||
      !candidate.artists.some(
        (artist) =>
          sameArtistTokens(primary, artist.name) ||
          (artist.channelId &&
            normalizeText(primary) ===
              normalizeText(evidence.nativeNames?.get(artist.channelId) ?? ''))
      )
    )
      return null
    artistScore = 1
    titleScore = 1
  } else if (titleScore < 0.9) {
    if (
      !evidence.originalTitle ||
      !exactSpotifyTitle(source.title, evidence.originalTitle) ||
      !versionCompatible(
        {
          title: source.title,
          album: { name: source.album.name, browseId: null },
        },
        {
          title: evidence.originalTitle,
          album: { name: candidate.album, browseId: null },
        }
      )
    )
      return null
    titleScore = 1
  }
  if (titleScore < 0.9) return null
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
    exactAlbum:
      Boolean(source.album.name) &&
      normalizeText(source.album.name) === normalizeText(candidate.album),
    exactTitle,
  }
}

/** Release preference also applies to the multiple appearances of one video. */
export function compareSpotifyCandidates(
  a: SpotifyCandidate,
  b: SpotifyCandidate
): number {
  return (
    Number(b.exactAlbum) - Number(a.exactAlbum) ||
    Number(b.exactTitle) - Number(a.exactTitle) ||
    b.albumScore - a.albumScore ||
    b.score - a.score
  )
}

/** Different Release appearances of a catalog video are one Recording for likes. */
export function selectSpotifyCandidate(
  candidates: SpotifyCandidate[]
): Match | null {
  const recordings = new Map<string, SpotifyCandidate>()
  for (const candidate of candidates) {
    const previous = recordings.get(candidate.match.catalogVideoId)
    if (!previous || compareSpotifyCandidates(candidate, previous) < 0)
      recordings.set(candidate.match.catalogVideoId, candidate)
  }
  const ranked = [...recordings.values()].sort((a, b) => b.score - a.score)
  if (!ranked.length) return null
  const close = ranked.filter(
    (candidate) => ranked[0].score - candidate.score < 0.04 - Number.EPSILON
  )
  close.sort(compareSpotifyCandidates)
  if (
    close[1] &&
    close[0].exactAlbum === close[1].exactAlbum &&
    close[0].exactTitle === close[1].exactTitle
  )
    throw new SpotifyMatchError('ambiguous')
  return close[0].match
}

export async function spotifyContribution(
  catalog: YouTubeMusicCatalog,
  http: HttpClient,
  source: SpotifyLikedTrack,
  cache: ReturnType<typeof createSpotifyCache>,
  signal?: AbortSignal
): Promise<Match> {
  const primaryArtist = source.artists[0]?.name ?? ''
  const { albums } = cache
  let sawUnavailable = false
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
    method: ResolutionMethod,
    evidence: SpotifyEvidence = {}
  ): SpotifyCandidate | null => {
    if (!track.videoId || !release.browseId) return null
    const match = releaseTrack(release, track, null, method, null)
    const scores = spotifyCandidateScore(source, match, evidence)
    if (scores && !track.isAvailable) sawUnavailable = true
    if (!track.isAvailable) return null
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
    const pending = albumLookup
    void pending.catch(() => {
      if (albums.get(source.album.id) === pending)
        albums.delete(source.album.id)
    })
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
  const results = await searchTracks(catalog, queries, signal)
  for (const result of results) {
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
  if (match) return match

  // Optional evidence never runs when ordinary matching has a winner or
  // an ambiguity. Filter first, so unrelated results cannot consume the budget.
  const nativeNames = new Map<string, string | null>()
  let channelReads = 0
  let titleReads = 0
  for (const result of results) {
    if (
      !result.album?.browseId ||
      !result.isAvailable ||
      result.durationSeconds === null ||
      Math.abs(source.durationMs / 1000 - result.durationSeconds) > 5 ||
      !versionCompatible(
        {
          title: source.title,
          album: { name: source.album.name, browseId: null },
        },
        result
      )
    )
      continue
    const artistScore = Math.max(
      0,
      ...result.artists.map((artist) =>
        textSimilarity(primaryArtist, artist.name)
      )
    )
    let evidence: SpotifyEvidence
    if (artistScore < 0.88) {
      if (!exactSpotifyTitle(source.title, result.title)) continue
      evidence = { nativeNames }
      if (
        !spotifyCandidateScore(
          source,
          { ...result, album: result.album.name },
          evidence
        )
      ) {
        for (const artist of result.artists) {
          const id = artist.channelId
          if (!id || nativeNames.has(id)) continue
          let pending = cache.nativeNames.get(id)
          if (!pending) {
            if (channelReads >= 3) continue
            channelReads++
            pending = (async () => {
              try {
                const page = await catalog.artist(id, signal, 'ja')
                signal?.throwIfAborted()
                return page.name
              } catch (error) {
                signal?.throwIfAborted()
                if (
                  error instanceof CatalogShapeError ||
                  error instanceof SyntaxError ||
                  (error instanceof HttpError &&
                    [404, 410].includes(error.status ?? 0))
                )
                  return null
                throw error
              }
            })()
            cache.nativeNames.set(id, pending)
            const request = pending
            void request.catch(() => {
              if (cache.nativeNames.get(id) === request)
                cache.nativeNames.delete(id)
            })
          }
          nativeNames.set(id, await pending)
          signal?.throwIfAborted()
        }
      }
    } else {
      if (
        spotifyCandidateScore(source, { ...result, album: result.album.name })
      )
        continue
      let pending = cache.originalTitles.get(result.videoId)
      if (!pending) {
        if (titleReads >= 3) continue
        titleReads++
        pending = (async () => {
          try {
            const title = await youtubeOriginalTitle(
              http,
              result.videoId,
              signal
            )
            signal?.throwIfAborted()
            return title
          } catch (error) {
            signal?.throwIfAborted()
            if (
              error instanceof CatalogShapeError ||
              error instanceof SyntaxError ||
              (error instanceof HttpError &&
                error.kind === 'permanent' &&
                error.status !== null &&
                error.status >= 400 &&
                error.status < 500)
            )
              return null
            throw error
          }
        })()
        cache.originalTitles.set(result.videoId, pending)
        const request = pending
        void request.catch(() => {
          if (cache.originalTitles.get(result.videoId) === request)
            cache.originalTitles.delete(result.videoId)
        })
      }
      evidence = { originalTitle: await pending }
      signal?.throwIfAborted()
    }
    if (
      !spotifyCandidateScore(
        source,
        { ...result, album: result.album.name },
        evidence
      )
    )
      continue
    const release = await browse(result.album.browseId)
    // Evidence belongs to this video's catalog identity, never a fuzzy fallback.
    const track = release.tracks.find(
      (track) => track.videoId === result.videoId
    )
    if (!track) continue
    const checked = candidate(release, track, 'spotify_search', evidence)
    if (checked) found.push(checked)
  }
  const fallback = selectSpotifyCandidate(found)
  if (!fallback)
    throw new SpotifyMatchError(sawUnavailable ? 'unavailable' : 'no_match')
  return fallback
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
