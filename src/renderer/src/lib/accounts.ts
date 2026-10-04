import type { SessionView } from '../../../shared/ipc'

export function hasSignedInAccount(
  youtube: Pick<SessionView, 'state'> | null,
  spotify: Pick<SessionView, 'state'> | null
): boolean {
  return youtube?.state === 'signed_in' || spotify?.state === 'signed_in'
}
