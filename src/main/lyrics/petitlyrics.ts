import type { HttpClient } from '../net/http'
import { classifyLyricsText } from './classify'
import { formatLrcLine } from './lrc'
import { candidateMatches, type LyricsLookup } from './query'

const ENDPOINT = 'https://p0.petitlyrics.com/api/GetPetitLyricsData.php'

// The API envelope and decoded word payload use fixed, unnamespaced XML tags.
function elements(xml: string, tag: string): string[] {
  return [
    ...xml.matchAll(
      new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
    ),
  ].map((match) => match[1])
}

function text(xml: string, tag: string): string {
  const value = elements(xml, tag)[0] ?? ''
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
      (entity, key: string) => {
        if (key.startsWith('#'))
          return String.fromCodePoint(
            Number.parseInt(
              key.slice(key[1] === 'x' ? 2 : 1),
              key[1] === 'x' ? 16 : 10
            )
          )
        return (
          (
            { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<
              string,
              string
            >
          )[key] ?? entity
        )
      }
    )
}

function songs(xml: string) {
  if (text(xml, 'status') !== '00000000')
    throw new Error(
      `PetitLyrics API status: ${text(xml, 'status') || 'missing'}`
    )
  return elements(xml, 'song').map((song) => ({
    id: text(song, 'lyricsId'),
    title: text(song, 'title'),
    artist: text(song, 'artist'),
    duration: Number(text(song, 'duration')) / 1000,
    data: Buffer.from(text(song, 'lyricsData'), 'base64'),
  }))
}

type PetitSong = ReturnType<typeof songs>[number]

/** LSY supplies centisecond cues; its text slots are not usable lyrics. */
function lineTimings(raw: Buffer): number[] {
  if (raw.length < 0xcc)
    throw new Error('PetitLyrics truncated line-sync header')
  const count = raw.readUInt32LE(0x38)
  const length = raw.readUInt16LE(0x42)
  if (count < 1 || count > 10000 || raw.length !== 0xcc + (2 + length) * count)
    throw new Error('PetitLyrics invalid line-sync geometry')
  let key = raw.readUInt16LE(0x1a)
  if (raw[0x19])
    key =
      (key & 3) |
      ((key & 12) << 2) |
      ((key & 48) >> 2) |
      ((key & 192) << 2) |
      ((key & 768) >> 2) |
      ((key & 3072) << 2) |
      ((key & 12288) >> 2) |
      (key & 49152)
  const times: number[] = []
  let previous = 0
  let wraps = 0
  for (let i = 0; i < count; i++) {
    const time = raw.readUInt16LE(0xcc + 2 * i) ^ key
    if (i > 0 && time < previous) wraps++
    times.push((time + wraps * 65536) * 10)
    previous = time
  }
  return times
}

function timedText(
  cues: { time: number; words: string }[],
  duration: number
): string {
  if (
    !cues.length ||
    !cues.some((cue) => cue.time > 0) ||
    cues.some(
      (cue) =>
        !Number.isFinite(cue.time) ||
        cue.time < 0 ||
        cue.time > (duration + 3) * 1000
    )
  )
    throw new Error('PetitLyrics invalid timestamps')
  return cues
    .sort((a, b) => a.time - b.time)
    .map((cue) => formatLrcLine(cue.time, cue.words.trim()))
    .join('\n')
}

async function decode(
  song: PetitSong,
  plain: () => Promise<PetitSong[]>
): Promise<string | null> {
  const raw = song.data
  const xml = raw.toString('utf8')
  if (/<wsy[\s>]/.test(xml)) {
    const cues = elements(xml, 'line').flatMap((line) => {
      const words = elements(line, 'word')
      if (!words.length) return []
      return [
        {
          time: Number(text(words[0], 'starttime')),
          words:
            text(line, 'linestring') ||
            words.map((word) => text(word, 'wordstring')).join(''),
        },
      ]
    })
    return timedText(cues, song.duration)
  }
  if (raw.subarray(0, 8).toString('ascii') === 'MHDROBJT') {
    const times = lineTimings(raw)
    const paired = (await plain()).find((item) => item.id === song.id)
    if (!paired) throw new Error('PetitLyrics timings/text ID mismatch')
    if (
      paired.data.includes(0) ||
      paired.data.toString('utf8').includes('\ufffd')
    )
      throw new Error('PetitLyrics invalid plain text payload')
    const words = paired.data
      .toString('utf8')
      .replace(/\r\n?/g, '\n')
      .split('\n')
    while (words.length > times.length && !words.at(-1)?.trim()) words.pop()
    if (words.length !== times.length)
      throw new Error('PetitLyrics timings/text line mismatch')
    return timedText(
      times.map((time, i) => ({ time, words: words[i] })),
      song.duration
    )
  }
  if (raw.includes(0) || xml.includes('\ufffd'))
    throw new Error('PetitLyrics unknown payload')
  return xml.trim() || null
}

/** Last fallback, using Canticle's observed read-only form request format. */
export async function petitLyrics(
  http: HttpClient,
  query: LyricsLookup,
  signal?: AbortSignal
): Promise<string | null> {
  let firstPlain: string | null = null
  let decodeError: unknown
  for (const title of query.titles) {
    for (const artist of query.artistNames) {
      const request = async (tier: number) =>
        songs(
          await http.text(ENDPOINT, {
            host: 'petitlyrics',
            method: 'POST',
            retryable: true,
            signal,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'LikedMusicSyncer/2.0',
            },
            body: new URLSearchParams({
              clientAppId: 'p1110417',
              terminalType: '10',
              lyricsType: String(tier),
              key_title: title,
              key_artist: artist,
              key_album: '',
            }).toString(),
          })
        )
      const results = await request(3)
      let plain: Promise<PetitSong[]> | undefined
      for (const song of results) {
        if (!candidateMatches(query, song.title, song.artist, song.duration))
          continue
        try {
          const lyrics = classifyLyricsText(
            await decode(song, () => (plain ??= request(1)))
          )
          if (lyrics?.synced) return lyrics.text
          firstPlain ??= lyrics?.text ?? null
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof Error && error.name === 'AbortError')
          )
            throw error
          decodeError ??= error
        }
      }
      if (firstPlain) return firstPlain
    }
  }
  if (decodeError) throw decodeError
  return null
}
