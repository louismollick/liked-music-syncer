import type { SyncSnapshot } from '@shared/contracts'
import { useEffect, useState } from 'react'

const EMPTY: SyncSnapshot = {
  jobs: [],
  counts: { all: 0, inProgress: 0, completed: 0, failed: 0 },
}

export function useSyncSnapshot() {
  const [snapshot, setSnapshot] = useState<SyncSnapshot>(EMPTY)

  useEffect(() => {
    void window.api.sync.getSnapshot().then(setSnapshot)
    const unsub = window.api.sync.subscribe(setSnapshot)
    return unsub
  }, [])

  return snapshot
}
