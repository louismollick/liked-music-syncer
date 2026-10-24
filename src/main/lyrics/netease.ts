import { z } from 'zod'
import type { HttpClient } from '../net/http'
import { classifyLyricsText } from './classify'
import {
  durationMatches,
  type LyricsLookup,
  normalizeLyricsName,
  sameVersion,
  titleMatches,
  versionQualifiers,
} from './query'

const BASE = 'https://music.163.com/api'
const HEADERS = {
  Referer: 'https://music.163.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
}
const MAX_LYRIC_FETCHES = 3

// `/search/get` is plain JSON; the `/web` variant is encrypted. Durations are ms.
const searchSchema = z.object({
  code: z.number(),
  result: z
    .object({
      songs: z
        .array(
          z.object({
            id: z.number(),
            name: z.string(),
            alias: z.array(z.string()).optional(),
            artists: z.array(z.object({ name: z.string() })),
            album: z.object({ name: z.string() }).optional(),
            duration: z.number(),
          })
        )
        .optional(),
    })
    .optional(),
})
type NeteaseSong = NonNullable<
  NonNullable<z.infer<typeof searchSchema>['result']>['songs']
>[number]

// Only `lrc` is read; `tlyric` (translation) and `romalrc` are other languages.
const lyricSchema = z.object({
  code: z.number(),
  lrc: z.object({ lyric: z.string().nullish() }).optional(),
})

/**
 * The labels NetEase puts on the credit lines that open a lyric. Only these
 * count, so a sung line like `She said: hello` is never taken for a credit.
 */
const CREDIT_LABELS = [
  // Chinese (simplified, with traditional spellings)
  '原曲',
  '作词',
  '作曲',
  '编曲',
  '制作人',
  '制作',
  '製作',
  '版权支持',
  '混音',
  '和声',
  '和聲',
  '吉他',
  '贝斯',
  '鼓',
  '录音',
  '錄音',
  '母带',
  '母帶',
  '监制',
  '監製',
  '出品',
  '发行',
  '词',
  '曲',
  // Japanese
  '作詞',
  '編曲',
  // English
  'Lyrics by',
  'Composed by',
  'Arranged by',
  'Produced by',
]
// A known label, then `:` or a tab. `{"t":` starts NetEase's JSON credit lines.
const CREDIT = new RegExp(
  `^(?:(?:${CREDIT_LABELS.join('|')})\\s*(?:[:：]|\\t)|\\{"t":)`,
  'i'
)
const NO_LYRICS = /纯音乐[，,]?\s*请欣赏|暂无歌词|没有填词的纯音乐/

/** A leading line is a credit when its label (after any timestamp) is a known one. */
function isCredit(line: string): boolean {
  return CREDIT.test(line.replace(/^(?:\[[^\]]*\])+/, '').trim())
}

/** Drops the credit lines before the first line that is not one. */
export function stripNeteaseCredits(lrc: string): string | null {
  const lines = lrc.replace(/\r\n?/g, '\n').split('\n')
  const first = lines.findIndex((line) => {
    const body = line.replace(/^(?:\[[^\]]*\])+/, '').trim()
    return body !== '' && !isCredit(line)
  })
  if (first < 0) return null
  const text = lines.slice(first).join('\n').trim()
  return NO_LYRICS.test(text) ? null : text
}

/**
 * Same song and recording: title, artist, a duration within 3s and the same
 * version qualifiers. Aliases and the album name can reveal a version the
 * title omits, so they may only add qualifiers the query already has.
 */
function sameRecording(query: LyricsLookup, song: NeteaseSong): boolean {
  // The primary artist or one of its known names must be credited: a guest's own
  // song with the same title and length is not this recording. Variants join all
  // credits ("A, B"), so with several credits only the first part is the primary's.
  const primary = new Set(
    [
      ...query.artists.slice(0, 1).map((credit) => credit.name),
      ...query.artistNames.map((name) =>
        query.artists.length > 1 ? name.split(', ')[0] : name
      ),
    ].map(normalizeLyricsName)
  )
  return (
    // A wrong song's lyrics are worse than none, so an unknown length never passes.
    query.durationSeconds !== null &&
    durationMatches(query, song.duration / 1000) &&
    titleMatches(query, song.name) &&
    sameVersion(query, [song.name, ...(song.alias ?? [])].join(' ')) &&
    versionQualifiers(song.album?.name ?? '').every((kind) =>
      query.qualifiers.includes(kind)
    ) &&
    song.artists.some((artist) => primary.has(normalizeLyricsName(artist.name)))
  )
}

/** NetEase Cloud Music, searched by native title and artist, then by title alone. */
export async function neteaseLyrics(
  http: HttpClient,
  query: LyricsLookup,
  signal?: AbortSignal
): Promise<string | null> {
  const title = query.titles.at(-1) ?? query.title
  const artist = query.artists[0]?.name
  const terms = [...(artist ? [`${title} ${artist}`] : []), title]
  const tried = new Set<number>()
  let plain: string | null = null
  for (const term of terms) {
    const search = searchSchema.parse(
      await http.json(`${BASE}/search/get`, {
        host: 'netease',
        method: 'POST',
        retryable: true,
        signal,
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          s: term,
          type: '1',
          limit: '10',
        }).toString(),
      })
    )
    if (search.code !== 200)
      throw new Error(`NetEase search code ${search.code}`)
    for (const song of search.result?.songs ?? []) {
      if (tried.has(song.id) || !sameRecording(query, song)) continue
      if (tried.size >= MAX_LYRIC_FETCHES) return plain
      tried.add(song.id)
      const lyric = lyricSchema.parse(
        await http.json(`${BASE}/song/lyric?id=${song.id}&lv=1&tv=-1`, {
          host: 'netease',
          signal,
          headers: HEADERS,
        })
      )
      if (lyric.code !== 200)
        throw new Error(`NetEase lyric code ${lyric.code}`)
      const lyrics = classifyLyricsText(
        stripNeteaseCredits(lyric.lrc?.lyric ?? '')
      )
      if (lyrics?.synced) return lyrics.text
      plain ??= lyrics?.text ?? null
    }
  }
  return plain
}
