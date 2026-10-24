/** Text helpers shared by the renderer and the menu bar. */

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const diff = Math.max(0, now - Date.parse(iso))
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
}
