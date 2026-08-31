import type { AuthRefreshReason } from '@shared/contracts'

type RefreshAuth = (
  scope: 'selected' | 'all',
  reason: AuthRefreshReason
) => Promise<unknown>

export async function refreshBrowserPicker(
  open: boolean,
  refreshAuth: RefreshAuth,
  showMessage: (message: string) => void
): Promise<void> {
  if (!open) return

  try {
    await refreshAuth('all', 'picker_opened')
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error))
  }
}
