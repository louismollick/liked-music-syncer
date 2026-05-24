import type { AlbumArtworkEntry } from '@shared/contracts'
import { useEffect, useMemo, useState } from 'react'

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
    () => [...new Set(albumKeys.filter(Boolean))].sort(),
    [albumKeys]
  )
  const [artworkByKey, setArtworkByKey] = useState<
    Record<string, string | null>
  >({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (stableKeys.length === 0) {
      setArtworkByKey({})
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    const startedAt = Date.now()
    setLoading(true)
    setError(null)

    logRendererArtwork('debug', 'fetch started', {
      albumCount: stableKeys.length,
    })

    void window.api.library
      .getAlbumArtwork(stableKeys)
      .then((result) => {
        if (cancelled) return
        const next: Record<string, string | null> = {}
        for (const entry of result.entries) {
          next[entry.albumKey] = entry.artworkUrl
        }
        const resolved = result.entries.filter(
          (entry) => entry.artworkUrl != null
        ).length
        logRendererArtwork('debug', 'fetch completed', {
          albumCount: stableKeys.length,
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
          albumCount: stableKeys.length,
          durationMs: Date.now() - startedAt,
          error: message,
        })
        setError(message)
        setArtworkByKey({})
        setLoading(false)
      })

    return () => {
      cancelled = true
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
