interface LyricsApiLine {
  timeTag?: string
  startTimeMs?: string
  words?: string
}

interface LyricsApiResponse {
  error?: boolean
  message?: string
  lines?: LyricsApiLine[]
}

export interface LyricsFetchResult {
  lyrics: string | null
  totalLines: number
  syncedLines: number
}

function formatLrcTimestamp(milliseconds: number) {
  const total = Math.max(0, milliseconds)
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const centiseconds = Math.floor((total % 1000) / 10)

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
    centiseconds
  ).padStart(2, '0')}`
}

function normalizeTimeTag(line: LyricsApiLine) {
  if (typeof line.timeTag === 'string' && line.timeTag.trim() !== '') {
    return line.timeTag.replace(/^\[|\]$/g, '')
  }

  if (typeof line.startTimeMs === 'string' && line.startTimeMs.trim() !== '') {
    const parsed = Number(line.startTimeMs)
    if (Number.isFinite(parsed)) {
      return formatLrcTimestamp(parsed)
    }
  }

  return null
}

export async function fetchLyricsLrc(
  spotifyTrackId: string,
  lyricsApiBaseUrl: string,
  timeoutMs = 10000
): Promise<LyricsFetchResult> {
  const target = new URL(lyricsApiBaseUrl)
  target.searchParams.set('trackid', spotifyTrackId)
  target.searchParams.set('format', 'lrc')

  const response = await fetch(target, {
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`Lyrics API request failed: ${response.status}`)
  }

  const payload = (await response.json()) as LyricsApiResponse
  if (payload.error) {
    throw new Error(payload.message || 'Lyrics API returned an error')
  }

  const totalLines = payload.lines?.length ?? 0
  const syncedLines: string[] = []
  const plainLines: string[] = []

  for (const line of payload.lines || []) {
    if (typeof line.words !== 'string' || line.words.trim() === '') {
      continue
    }
    const words = line.words.trim()
    plainLines.push(words)
    const timeTag = normalizeTimeTag(line)
    if (timeTag) {
      syncedLines.push(`[${timeTag}]${words}`)
    }
  }

  if (syncedLines.length > 0) {
    return {
      lyrics: `${syncedLines.join('\n')}\n`,
      totalLines,
      syncedLines: syncedLines.length,
    }
  }

  if (plainLines.length === 0) {
    return {
      lyrics: null,
      totalLines,
      syncedLines: 0,
    }
  }

  return {
    lyrics: `${plainLines.join('\n')}\n`,
    totalLines,
    syncedLines: 0,
  }
}
