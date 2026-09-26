export const USER_SCROLL_GRACE_MS = 1500

/**
 * The Activity list re-centres on a new current track only when the previous
 * current row was on screen and the user has not scrolled recently.
 */
export function shouldRecenter(options: {
  previousId: string | null
  currentId: string | null
  wasVisible: boolean
  lastUserScrollAt: number
  now: number
}): boolean {
  if (!options.currentId || options.currentId === options.previousId)
    return false
  return (
    options.wasVisible &&
    options.now - options.lastUserScrollAt > USER_SCROLL_GRACE_MS
  )
}

export function isRowVisible(
  row: { top: number; bottom: number },
  viewport: { top: number; bottom: number }
): boolean {
  return row.bottom > viewport.top && row.top < viewport.bottom
}
