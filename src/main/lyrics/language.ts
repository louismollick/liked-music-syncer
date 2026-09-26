// The static 'medium' build is preloaded and bundled into the main process
// (eld is ESM-only and its dynamic entry loads data files at runtime).
import { eld } from 'eld/medium'
import { stripLrc } from './lrc'

export async function detectLyricsLanguage(
  text: string
): Promise<string | null> {
  const plain = stripLrc(text).replace(/\s+/g, ' ').trim()
  if (Array.from(plain).length < 20) return null
  const result = eld.detect(plain)
  return result.isReliable() && /^[a-z]{2}$/.test(result.language)
    ? result.language
    : null
}
