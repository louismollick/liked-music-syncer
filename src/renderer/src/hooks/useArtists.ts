import type { LikedArtistView } from '@shared/contracts'
import { useEffect, useMemo, useState } from 'react'

export function useArtists() {
  const [artists, setArtists] = useState<LikedArtistView[]>([])

  useEffect(() => {
    void window.api.library.listArtists().then(setArtists)
    const unsub = window.api.library.subscribeArtists(() => {
      void window.api.library.listArtists().then(setArtists)
    })
    return unsub
  }, [])

  const filteredArtists = useMemo(
    () => artists.filter((a) => a.likedTrackCount > 0),
    [artists]
  )

  return { artists: filteredArtists }
}
