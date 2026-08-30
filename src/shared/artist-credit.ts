export interface ArtistCredit {
  name: string
  channelId: string | null
}

function normalizeArtistName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function artistCreditId(credit: ArtistCredit): string {
  return credit.channelId
    ? `artist_channel_${credit.channelId}`
    : `local_artist_${normalizeArtistName(credit.name).replace(/\s+/g, '_')}`
}

export function normalizeArtistCredits(value: unknown): ArtistCredit[] {
  if (!Array.isArray(value)) return []
  const credits: ArtistCredit[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) continue
    const rawChannelId = record.channelId ?? record.channel_id ?? record.id
    const channelId =
      typeof rawChannelId === 'string' && rawChannelId ? rawChannelId : null
    const key = `${channelId ?? ''}\u0000${name}`
    if (seen.has(key)) continue
    seen.add(key)
    credits.push({ name, channelId })
  }
  return credits
}

export function parseArtistCreditsJson(value: string | null): ArtistCredit[] {
  if (!value) return []
  try {
    return normalizeArtistCredits(JSON.parse(value))
  } catch {
    return []
  }
}

export function stringifyArtistCredits(value: unknown): string {
  return JSON.stringify(normalizeArtistCredits(value))
}
