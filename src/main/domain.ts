/** Domain types shared by main-process modules. Names follow CONTEXT.md. */

export interface ArtistCredit {
  name: string
  /** YouTube channel ID when YouTube Music provides one (trusted Artist identity). */
  channelId: string | null
}

export type ReleaseKind = 'album' | 'single' | 'ep'

export type LyricsStatus = 'synced' | 'plain' | 'none'

export type TrackState =
  | 'pending'
  | 'working'
  | 'done'
  | 'needs_attention'
  | 'no_longer_wanted'
  /** The user stopped managing the file; the app leaves the track alone. */
  | 'released'

export type StepKind = 'match' | 'acquire' | 'retag' | 'move' | 'upload'

/** Visible Activity stage for a Track Step. */
export type ActivityStage = 'matching' | 'downloading' | 'uploading'

export function stageForStep(step: StepKind): ActivityStage {
  if (step === 'match') return 'matching'
  if (step === 'upload') return 'uploading'
  return 'downloading'
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
    const rawId = record.channelId ?? record.channel_id ?? record.id
    const channelId = typeof rawId === 'string' && rawId ? rawId : null
    const key = `${name}\u0000${channelId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    credits.push({ name, channelId })
  }
  return credits
}

export function joinArtistNames(credits: ArtistCredit[]): string {
  return credits.map((credit) => credit.name).join(', ')
}
