import { isZeroTimestampOnlyLrc, stripLrc } from './lrc'

export interface ClassifiedLyrics {
  text: string
  synced: boolean
}

export function classifyLyricsText(
  value: string | null | undefined
): ClassifiedLyrics | null {
  const text = value?.replace(/\r\n?/g, '\n').trim()
  if (!text) return null
  const hasTimestamp = /^\[\d+:\d{2}(?:[.:]\d{1,3})?\]/m.test(text)
  if (hasTimestamp && !isZeroTimestampOnlyLrc(text))
    return { text, synced: true }
  const plain = hasTimestamp ? stripLrc(text) : text
  return plain ? { text: plain, synced: false } : null
}
