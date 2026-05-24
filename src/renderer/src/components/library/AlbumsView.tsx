import type { LibraryTrackView } from '@shared/contracts'
import type { JSX } from 'react'
import { useTracks } from '../../hooks/useTracks'

interface AlbumGroup {
  key: string
  album: string
  albumArtist: string
  year: number | null
  trackCount: number
}

function groupByAlbum(tracks: LibraryTrackView[]): AlbumGroup[] {
  const map = new Map<
    string,
    { album: string; albumArtist: string; year: number | null; count: number }
  >()

  for (const track of tracks) {
    const key = `${track.album ?? ''}|||${track.albumArtist ?? ''}`
    const existing = map.get(key)
    if (existing) {
      existing.count++
    } else {
      map.set(key, {
        album: track.album ?? 'Unknown Album',
        albumArtist: track.albumArtist ?? track.artist ?? 'Unknown Artist',
        year: track.year,
        count: 1,
      })
    }
  }

  return [...map.entries()]
    .map(([key, v]) => ({
      key,
      album: v.album,
      albumArtist: v.albumArtist,
      year: v.year,
      trackCount: v.count,
    }))
    .sort((a, b) => a.album.localeCompare(b.album))
}

function AlbumCard({ group }: { group: AlbumGroup }): JSX.Element {
  return (
    <div className="bg-surface-secondary rounded-xl border border-border p-4 flex flex-col gap-1.5 hover:border-border/80 transition-colors">
      <div className="w-full aspect-square bg-surface-tertiary rounded-lg mb-2 flex items-center justify-center">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="w-10 h-10 fill-current text-text-muted opacity-40"
        >
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
        </svg>
      </div>
      <p className="text-sm font-medium text-text-primary truncate">
        {group.album}
      </p>
      <p className="text-xs text-text-muted truncate">{group.albumArtist}</p>
      <p className="text-xs text-text-muted">
        {group.trackCount} {group.trackCount === 1 ? 'track' : 'tracks'}
        {group.year ? ` · ${group.year}` : ''}
      </p>
    </div>
  )
}

export function AlbumsView(): JSX.Element {
  const { tracks, loading } = useTracks()
  const albums = groupByAlbum(tracks)

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full text-text-muted">
        <p className="text-sm">Loading...</p>
      </div>
    )
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-text-primary">Albums</h2>
        <p className="text-xs text-text-muted mt-0.5">{albums.length} albums</p>
      </div>

      <div className="flex-1 overflow-auto">
        {albums.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-text-muted">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="w-12 h-12 fill-current mb-3 opacity-40"
            >
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
            <p className="text-sm">No albums found</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {albums.map((group) => (
              <AlbumCard key={group.key} group={group} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
