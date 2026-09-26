import type { YouTubeMusicCatalog } from '../catalog/types'
import { formatLrcLine } from './lrc'
import type { LyricsQuery } from './types'

export async function youtubeMusicLyrics(
  catalog: YouTubeMusicCatalog,
  query: LyricsQuery,
  signal?: AbortSignal
): Promise<string | null> {
  if (!query.lyricsBrowseId) return null
  const lyrics = await catalog.lyrics(query.lyricsBrowseId, signal)
  const lines = lyrics?.timed
    ?.filter(
      (line) =>
        Number.isInteger(line.startMs) &&
        line.startMs >= 0 &&
        typeof line.text === 'string'
    )
    .map((line) => formatLrcLine(line.startMs, line.text))
  return lines?.length ? lines.join('\n') : (lyrics?.plain ?? null)
}
