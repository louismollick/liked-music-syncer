import type { AlbumArtworkEntry } from '@shared/contracts'
import { useEffect, useMemo, useState } from 'react'
import {
  filterArtworkState,
  normalizeAlbumArtworkKeys,
  readAlbumArtworkCache,
  writeAlbumArtworkCache,
} from './album-artwork-store'

function logRendererArtwork(
  level: 'debug' | 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>
) {
  const prefix = '[album-artwork]'
  const detail = context ? ` ${JSON.stringify(context)}` : ''
  if (level === 'error') {
    console.error(`${prefix} ${message}${detail}`)
    return
  }
  if (level === 'warn') {
    console.warn(`${prefix} ${message}${detail}`)
    return
  }
  console.debug(`${prefix} ${message}${detail}`)
}

export function useAlbumArtwork(albumKeys: string[]) {
  const stableKeys = useMemo(
    () => normalizeAlbumArtworkKeys(albumKeys),
    [albumKeys]
  )
  const [artworkByKey, setArtworkByKey] = useState<
    Record<string, string | null>
  >(() => readAlbumArtworkCache(stableKeys))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const requestKeys = stableKeys
    if (requestKeys.length === 0) {
      setArtworkByKey({})
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    const startedAt = Date.now()
    const cachedArtwork = readAlbumArtworkCache(requestKeys)
    const missingKeys = requestKeys.filter(
      (albumKey) => !(albumKey in cachedArtwork)
    )

    setArtworkByKey(cachedArtwork)
    setError(null)

    if (missingKeys.length === 0) {
      setLoading(false)
      logRendererArtwork('debug', 'cache hit', {
        albumCount: requestKeys.length,
      })
      return
    }

    setLoading(true)

    logRendererArtwork('debug', 'fetch started', {
      albumCount: requestKeys.length,
      missingCount: missingKeys.length,
    })

    const unsub = window.api.library.subscribeAlbumArtwork((entry) => {
      if (cancelled || !requestKeys.includes(entry.albumKey)) return
      writeAlbumArtworkCache([entry])
      setArtworkByKey((current) =>
        filterArtworkState(
          {
            ...current,
            [entry.albumKey]: entry.artworkUrl,
          },
          requestKeys
        )
      )
    })

    void window.api.library
      .getAlbumArtwork(missingKeys)
      .then((result) => {
        if (cancelled) return
        writeAlbumArtworkCache(result.entries)
        const next = filterArtworkState(
          {
            ...cachedArtwork,
            ...Object.fromEntries(
              result.entries.map((entry) => [entry.albumKey, entry.artworkUrl])
            ),
          },
          requestKeys
        )
        const resolved = result.entries.filter(
          (entry) => entry.artworkUrl != null
        ).length
        logRendererArtwork('debug', 'fetch completed', {
          albumCount: requestKeys.length,
          resolvedCount: resolved,
          durationMs: Date.now() - startedAt,
        })
        setArtworkByKey(next)
        setLoading(false)
      })
      .catch((fetchError: unknown) => {
        if (cancelled) return
        const message =
          fetchError instanceof Error ? fetchError.message : String(fetchError)
        logRendererArtwork('error', 'fetch failed', {
          albumCount: requestKeys.length,
          durationMs: Date.now() - startedAt,
          error: message,
        })
        setError(message)
        setLoading(false)
      })

    return () => {
      cancelled = true
      unsub()
    }
  }, [stableKeys])

  const getArtworkUrl = (albumKey: string): string | null =>
    artworkByKey[albumKey] ?? null

  return {
    artworkByKey,
    getArtworkUrl,
    loading,
    error,
  }
}

export type { AlbumArtworkEntry }
