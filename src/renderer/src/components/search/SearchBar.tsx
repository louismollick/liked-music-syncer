import type { LibraryTrackView, LikedArtistView } from '@shared/contracts'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AlbumGroup } from '../library/library-utils'
import { SearchDropdown } from './SearchDropdown'
import { useSearch } from './useSearch'

interface Props {
  artists: LikedArtistView[]
  tracks: LibraryTrackView[]
  onSelectArtist: (artist: LikedArtistView) => void
  onSelectAlbum: (album: AlbumGroup) => void
  onSelectSong: (track: LibraryTrackView) => void
}

export function SearchBar({
  artists,
  tracks,
  onSelectArtist,
  onSelectAlbum,
  onSelectSong,
}: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useSearch(query, artists, tracks)

  const showDropdown = open && query.trim().length > 0

  useEffect(() => {
    if (!showDropdown) return
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDropdown])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const handleSelect = (fn: () => void) => {
    fn()
    setQuery('')
    setOpen(false)
  }

  return (
    <div
      ref={containerRef}
      className="relative border-b border-border bg-surface-primary"
    >
      <div className="flex items-center px-4 h-11">
        <svg
          aria-hidden="true"
          className="w-4 h-4 text-text-muted flex-shrink-0 mr-3"
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zm-5.242 1.656a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Search albums, artists, songs..."
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false)
              setQuery('')
              inputRef.current?.blur()
            }
          }}
          className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
        />
        <kbd className="hidden sm:flex items-center gap-0.5 text-xs text-text-muted border border-border rounded px-1.5 py-0.5 font-sans flex-shrink-0">
          <span className="text-base leading-none">⌘</span>
          <span>K</span>
        </kbd>
      </div>
      {showDropdown && (
        <SearchDropdown
          artists={results.artists}
          albums={results.albums}
          songs={results.songs}
          onSelectArtist={(a) => handleSelect(() => onSelectArtist(a))}
          onSelectAlbum={(a) => handleSelect(() => onSelectAlbum(a))}
          onSelectSong={(t) => handleSelect(() => onSelectSong(t))}
        />
      )}
    </div>
  )
}
