import { describe, expect, it, vi } from 'vitest'
import type {
  CatalogRelease,
  CatalogTrack,
  LikedSong,
  WatchInfo,
  YouTubeMusicCatalog,
} from '../../src/main/catalog/types'
import { createMatcher } from '../../src/main/match/matcher'
import type { HttpClient } from '../../src/main/net/http'

const artist = { name: 'Artist', channelId: 'UCartist' }
function track(
  videoId: string,
  title = 'Song',
  albumId: string | null = null,
  videoType: CatalogTrack['videoType'] = 'ATV',
  discNumber: number | null = null,
  trackNumber: number | null = null
): CatalogTrack {
  return {
    videoId,
    title,
    artists: [artist],
    album: albumId ? { name: 'Album', browseId: albumId } : null,
    durationSeconds: 200,
    videoType,
    isExplicit: false,
    thumbnailUrl: 'https://lh3.googleusercontent.com/art=w120-h120',
    trackNumber,
    discNumber,
    isAvailable: true,
  }
}
function liked(value: CatalogTrack): LikedSong {
  return { ...value, position: 0 }
}
function release(tracks: CatalogTrack[], browseId = 'MPRE1'): CatalogRelease {
  return {
    browseId,
    audioPlaylistId: null,
    title: 'Album',
    kindLabel: 'Album',
    artists: [artist],
    year: 2020,
    thumbnailUrl: 'https://lh3.googleusercontent.com/art=w120-h120',
    trackCount: tracks.length,
    tracks,
  }
}
function setup(
  watches: Record<string, WatchInfo>,
  releases: Record<string, CatalogRelease>,
  searches: CatalogTrack[] = []
) {
  const catalog = {
    watch: vi.fn(
      async (id: string) => watches[id] ?? { track: null, lyricsBrowseId: null }
    ),
    release: vi.fn(async (id: string) => releases[id]),
    searchSongs: vi.fn(async () => searches),
  } as unknown as YouTubeMusicCatalog
  const http = { json: vi.fn(async () => ({})) } as unknown as HttpClient
  return { matcher: createMatcher({ catalog, http }), catalog, http }
}
describe('catalog resolution', () => {
  it.each([
    'Song (Live)',
    'Song (2024 Remaster)',
    'Song (Acoustic)',
  ])('does not replace a missing source ID with %s on its release', async (title) => {
    const source = liked(track('video', 'Song', 'MPRE1', 'OMV'))
    const { matcher } = setup(
      { video: { track: source, lyricsBrowseId: null } },
      { MPRE1: release([track('wrong-version', title, 'MPRE1')]) }
    )
    const match = await matcher.match({ kind: 'liked', song: source })
    expect(match.catalogVideoId).toBe('video')
    expect(match.resolutionMethod).toBe('standalone')
  })
  it('disambiguates restored catalog audio by its saved release position', async () => {
    const original = track('video', 'Song', 'MPRE1', 'OMV', null, 2)
    const { matcher } = setup({}, {})
    const match = await matcher.match({
      kind: 'catalog',
      artistId: 'UCartist',
      track: original,
      release: release([
        track('audio-1', 'Song', 'MPRE1', 'ATV', null, 1),
        track('audio-2', 'Song', 'MPRE1', 'ATV', null, 2),
      ]),
    })
    expect(match.catalogVideoId).toBe('audio-2')
    expect(match.release?.trackNumber).toBe(2)
  })
  it('refreshes a catalog contribution whose release restored the original audio', async () => {
    const original = track('video', 'Song', 'MPRE1', 'OMV')
    const restored = track('audio', 'Song', 'MPRE1')
    const { matcher } = setup({}, {})
    const match = await matcher.match({
      kind: 'catalog',
      artistId: 'UCartist',
      track: original,
      release: release([restored, track('other', 'Other', 'MPRE1')]),
    })
    expect(match).toMatchObject({
      sourceVideoId: 'video',
      catalogVideoId: 'audio',
      identityKey: 'MPRE1:audio',
    })
  })
  it('uses the liked release when watch metadata has no album', async () => {
    const song = liked(track('liked', 'Song', 'MPRE1'))
    const { matcher, catalog } = setup(
      { liked: { track: track('liked', 'Song'), lyricsBrowseId: null } },
      { MPRE1: release([track('liked', 'Song', 'MPRE1')]) }
    )
    const match = await matcher.match({ kind: 'liked', song })
    expect(match.release?.browseId).toBe('MPRE1')
    expect(catalog.searchSongs).not.toHaveBeenCalled()
  })

  it('finds the restored audio by unique title and artist in the liked release', async () => {
    const song = liked(track('video', 'Song', 'MPRE1', 'OMV'))
    const { matcher, catalog } = setup(
      { video: { track: song, lyricsBrowseId: null } },
      {
        MPRE1: release([
          track('audio', 'Song', 'MPRE1'),
          track('other', 'Other', 'MPRE1'),
        ]),
      }
    )
    const match = await matcher.match({ kind: 'liked', song })
    expect(match.catalogVideoId).toBe('audio')
    expect(match.resolutionMethod).toBe('liked_album_exact')
    expect(catalog.searchSongs).not.toHaveBeenCalled()
  })
  it('matches a liked ATV to its own release track ID', async () => {
    const likedTrack = liked(track('liked', 'Song', 'MPRE1'))
    const albumTrack = track('liked', 'Song', 'MPRE1')
    const { matcher } = setup(
      { liked: { track: likedTrack, lyricsBrowseId: 'MPLYx' } },
      { MPRE1: release([albumTrack]) }
    )
    const match = await matcher.match({ kind: 'liked', song: likedTrack })
    expect(match).toMatchObject({
      identityKey: 'MPRE1:liked',
      catalogVideoId: 'liked',
      resolutionMethod: 'liked_album_exact',
      lyricsBrowseId: 'MPLYx',
      album: 'Album',
    })
    expect(match.release).toMatchObject({
      date: '2020',
      kind: 'album',
      trackNumber: 1,
      trackTotal: 1,
    })
  })
  it('resolves an OMV via song search and uses the release track list video ID', async () => {
    const song = liked(track('omv', 'Song (Official Video)', null, 'OMV'))
    const search = track('search-atv', 'Song', 'MPRE1')
    const listed = track('album-atv', 'Song', 'MPRE1')
    const { matcher } = setup(
      {
        omv: { track: song, lyricsBrowseId: null },
        'search-atv': { track: search, lyricsBrowseId: 'MPLYalbum' },
      },
      { MPRE1: release([listed]) },
      [search]
    )
    const match = await matcher.match({ kind: 'liked', song })
    expect(match).toMatchObject({
      sourceVideoId: 'omv',
      catalogVideoId: 'album-atv',
      identityKey: 'MPRE1:album-atv',
      resolutionMethod: 'search_song_exact',
    })
  })
  it('finds a unique release-list track when search and release IDs differ', async () => {
    const song = liked(track('omv', 'Song', null, 'OMV'))
    const candidate = track('search-id', 'Song', 'MPRE1')
    const albumTrack = track('album-id', 'Song', 'MPRE1')
    const another = track('other-id', 'Other Song', 'MPRE1')
    const { matcher } = setup(
      {
        omv: { track: song, lyricsBrowseId: null },
        'search-id': { track: candidate, lyricsBrowseId: null },
      },
      { MPRE1: release([albumTrack, another]) },
      [candidate]
    )
    expect((await matcher.match({ kind: 'liked', song })).identityKey).toBe(
      'MPRE1:album-id'
    )
  })
  it('prefers an official audio result over a music video with the same identity', async () => {
    const song = liked(track('liked-omv', 'Song', null, 'OMV'))
    const omv = track('search-omv', 'Song', 'MPRE2', 'OMV')
    const atv = track('search-atv', 'Song', 'MPRE1', 'ATV')
    const watches = {
      'liked-omv': { track: song, lyricsBrowseId: null },
      'search-omv': { track: omv, lyricsBrowseId: null },
      'search-atv': { track: atv, lyricsBrowseId: null },
    }
    const { matcher } = setup(
      watches,
      { MPRE1: release([atv]), MPRE2: release([omv], 'MPRE2') },
      [omv, atv]
    )
    expect((await matcher.match({ kind: 'liked', song })).catalogVideoId).toBe(
      'search-atv'
    )
  })
  it('uses oEmbed original title when Music search rewrites the title', async () => {
    const song = liked(track('omv', 'Song', null, 'OMV'))
    const rewritten = track('rewritten', 'Different Name', 'MPRE1')
    const { matcher, http } = setup(
      {
        omv: { track: song, lyricsBrowseId: null },
        rewritten: { track: rewritten, lyricsBrowseId: null },
      },
      { MPRE1: release([rewritten]) },
      [rewritten]
    )
    vi.mocked(http.json).mockResolvedValue({ title: 'Song' })
    expect((await matcher.match({ kind: 'liked', song })).catalogVideoId).toBe(
      'rewritten'
    )
    expect(http.json).toHaveBeenCalledWith(
      expect.stringContaining('/oembed?'),
      expect.objectContaining({ host: 'youtube' })
    )
  })
  it('keeps a UGC cover as a standalone single when no catalog song matches', async () => {
    const song = liked({
      ...track('ugc', 'Song (Cover)', null, 'UGC'),
      artists: [{ name: 'Artist - Topic', channelId: null }],
    })
    const { matcher } = setup(
      { ugc: { track: song, lyricsBrowseId: null } },
      {}
    )
    const match = await matcher.match({ kind: 'liked', song })
    expect(match).toMatchObject({
      identityKey: 'video:ugc',
      album: 'Song (Cover)',
      albumArtist: 'Artist -',
      resolutionMethod: 'standalone',
    })
  })
  it('rejects a live to studio version mismatch', async () => {
    const song = liked(track('live', 'Song (Live)', null, 'OMV'))
    const studio = track('studio', 'Song', 'MPRE1')
    const { matcher } = setup(
      { live: { track: song, lyricsBrowseId: null } },
      { MPRE1: release([studio]) },
      [studio]
    )
    expect((await matcher.match({ kind: 'liked', song })).release).toBeNull()
  })
  it('matches full-discography catalog tracks and reads optional lyrics', async () => {
    const listed = track('catalog-id', 'Song', 'MPRE1')
    const { matcher } = setup(
      { 'catalog-id': { track: listed, lyricsBrowseId: 'MPLYcatalog' } },
      {}
    )
    expect(
      await matcher.match({
        kind: 'catalog',
        artistId: 'UCartist',
        release: release([listed]),
        track: listed,
      })
    ).toMatchObject({
      identityKey: 'MPRE1:catalog-id',
      resolutionMethod: 'favorite_artist_release_exact',
      lyricsBrowseId: 'MPLYcatalog',
    })
  })
  it('computes per-disc totals and positions', async () => {
    const tracks = [
      track('a', 'A', 'MPRE1', 'ATV', 1, 1),
      track('b', 'B', 'MPRE1', 'ATV', 1, 2),
      track('c', 'C', 'MPRE1', 'ATV', 2, 1),
    ]
    const { matcher } = setup(
      { c: { track: tracks[2], lyricsBrowseId: null } },
      {}
    )
    const match = await matcher.match({
      kind: 'catalog',
      artistId: 'UCartist',
      release: release(tracks),
      track: tracks[2],
    })
    expect(match.release).toMatchObject({
      trackNumber: 1,
      trackTotal: 1,
      discNumber: 2,
      discTotal: 2,
    })
  })
})

describe('YouTube like search fallback version gates', () => {
  it.each([
    'Live',
    'Remix',
    'Instrumental',
    'Acoustic',
    'Sped Up',
    'Slowed',
    'Karaoke',
    'Cover',
  ])('rejects %s in either direction, retaining the liked standalone Recording', async (version) => {
    for (const [sourceTitle, candidateTitle] of [
      ['Song', `Song (${version})`],
      [`Song (${version})`, 'Song'],
    ]) {
      const source = liked(track('source', sourceTitle))
      const found = track('candidate', candidateTitle, 'MPRE1')
      const { matcher } = setup(
        { source: { track: source, lyricsBrowseId: null } },
        { MPRE1: release([found]) },
        [found]
      )
      expect(
        (await matcher.match({ kind: 'liked', song: source })).resolutionMethod
      ).toBe('standalone')
    }
  })
})
