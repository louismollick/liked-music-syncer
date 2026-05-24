import type { LikedArtistView } from '@shared/contracts'
import { useEffect, useMemo, useState } from 'react'

export function useArtists() {
  const [artists, setArtists] = useState<LikedArtistView[]>([])

  useEffect(() => {
    const loadArtists = () =>
      window.api.library.listArtists().then((rows) => {
        const withPhoto = rows.filter((artist) =>
          Boolean(artist.photoUrl)
        ).length
        console.info('[artist-image] catalog loaded', {
          totalArtists: rows.length,
          withPhotoUrl: withPhoto,
          withoutPhotoUrl: rows.length - withPhoto,
        })
        setArtists(rows)
      })

    void loadArtists()

    const unsubCatalog = window.api.library.subscribeArtists(() => {
      void loadArtists()
    })

    const unsubPhotos = window.api.library.subscribeArtistPhotos((update) => {
      console.info('[artist-image] photo updated', {
        artistId: update.artistId,
        channelId: update.channelId,
        photoUrlHost: (() => {
          try {
            return new URL(update.photoUrl).host
          } catch {
            return null
          }
        })(),
      })
      setArtists((current) =>
        current.map((artist) =>
          artist.id === update.artistId
            ? {
                ...artist,
                photoUrl: update.photoUrl,
                channelId: update.channelId ?? artist.channelId,
              }
            : artist
        )
      )
    })

    return () => {
      unsubCatalog()
      unsubPhotos()
    }
  }, [])

  const filteredArtists = useMemo(
    () => artists.filter((a) => a.likedTrackCount > 0),
    [artists]
  )

  return { artists: filteredArtists }
}
