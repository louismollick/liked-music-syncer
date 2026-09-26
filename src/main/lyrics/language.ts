import { eld } from 'eld'
import { stripLrc } from './lrc'

let loaded: Promise<unknown> | null = null

export async function detectLyricsLanguage(
  text: string
): Promise<string | null> {
  const plain = stripLrc(text).replace(/\s+/g, ' ').trim()
  if (Array.from(plain).length < 20) return null
  if ('load' in eld) loaded ??= eld.load('medium')
  else loaded ??= Promise.resolve()
  await loaded
  const result = eld.detect(plain)
  return result.isReliable() && /^[a-z]{2}$/.test(result.language)
    ? result.language
    : null
}
