import type { LibraryTrackView } from '@shared/contracts'
import { useEffect, useState } from 'react'

export function useTracks() {
  const [tracks, setTracks] = useState<LibraryTrackView[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void window.api.library.listTracks().then((t) => {
      setTracks(t)
      setLoading(false)
    })
  }, [])

  return { tracks, loading }
}
