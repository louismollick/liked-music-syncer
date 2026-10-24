/**
 * Reservations on remote paths. Uploads, remote moves, old-path cleanup and
 * tombstone deletes all write or delete remote objects from different lanes, so
 * each reserves every path it touches until its upload record is committed.
 * Whoever waits sees the other's committed state when it finally runs.
 */
const tails = new Map<string, Promise<void>>()

/**
 * Runs `fn` once it holds every key. Keys are taken in sorted order, so two
 * callers with overlapping sets cannot deadlock. Callers pass keys already
 * normalized the way paths are compared elsewhere (`remotePathKey`).
 */
export async function withPathLocks<T>(
  keys: readonly string[],
  fn: () => Promise<T>
): Promise<T> {
  const releases: Array<() => void> = []
  try {
    for (const key of [...new Set(keys)].sort()) {
      const previous = tails.get(key) ?? Promise.resolve()
      let release!: () => void
      const mine = new Promise<void>((resolve) => {
        release = resolve
      })
      const tail = previous.then(() => mine)
      tails.set(key, tail)
      // Drop the entry once nobody queued behind us.
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      await previous
      releases.push(release)
    }
    return await fn()
  } finally {
    for (const release of releases) release()
  }
}
