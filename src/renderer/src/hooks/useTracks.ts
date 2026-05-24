import type { LibraryTrackView } from '@shared/contracts'
import { useEffect, useState } from 'react'

export function useTracks() {
  const [tracks, setTracks] = useState<LibraryTrackView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const loadTracks = (initial = false) => {
      setRefreshing(!initial)

      return window.api.library
        .listTracks()
        .then((rows) => {
          setTracks(rows)
          setLoaded(true)
        })
        .finally(() => {
          setRefreshing(false)
        })
    }

    void loadTracks(true)

    const unsub = window.api.library.subscribeIndexStatus(() => {
      void loadTracks()
    })

    return unsub
  }, [])

  return { tracks, loaded, refreshing }
}
