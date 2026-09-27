import { useNavigate } from '@tanstack/react-router'
import { useRef } from 'react'
import { SetupEmptyState, useSetupNeeded } from '../components/EmptyState'
import { AlbumGrid } from '../components/Grids'
import { Page, PageTitle } from '../components/layout/Page'
import { AddFilterButton, Chip, SortMenu } from '../components/ui/Chip'
import { invoke, useLibraryData } from '../lib/api'
import { plural } from '../lib/format'
import { useTabSearch } from '../lib/tabs'
import { useScrollMargin } from '../lib/use-scroll-margin'

export interface AlbumsSearch {
  sort?: 'liked' | 'title' | 'year'
  fullDiscography?: boolean
}

const SORT_LABEL = {
  liked: 'Recently liked',
  title: 'Title',
  year: 'Year',
} as const

export function AlbumsPage() {
  const search = useTabSearch<AlbumsSearch>()
  const navigate = useNavigate()
  const setup = useSetupNeeded()
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const sort = search.sort ?? 'liked'
  const { data } = useLibraryData(
    () =>
      invoke('library:albums', {
        sort,
        fullDiscography: search.fullDiscography,
      }),
    [sort, search.fullDiscography]
  )
  const margin = useScrollMargin(gridRef, scrollRef, data?.length)
  if (setup) return <SetupEmptyState />
  const albums = data ?? []
  const update = (patch: Partial<AlbumsSearch>) =>
    void navigate({ to: '/albums', search: { ...search, ...patch } })
  const set = (next: AlbumsSearch['sort']) => update({ sort: next })
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto scroll-thin">
      <Page>
        <PageTitle
          title="Albums"
          meta={data ? plural(albums.length, 'album') : undefined}
        />
        <div className="flex items-center gap-2">
          {search.fullDiscography && (
            <Chip
              label="By Full Discography artists"
              onRemove={() => update({ fullDiscography: undefined })}
            />
          )}
          <AddFilterButton
            sections={[
              {
                title: 'Artists',
                options: [
                  {
                    label: 'By Full Discography artists',
                    onSelect: () => update({ fullDiscography: true }),
                    active: search.fullDiscography,
                  },
                ],
              },
            ]}
          />
          <div className="ml-auto">
            <SortMenu
              label={SORT_LABEL[sort]}
              sections={[
                {
                  title: 'Sort by',
                  options: (
                    Object.keys(SORT_LABEL) as Array<keyof typeof SORT_LABEL>
                  ).map((key) => ({
                    label: SORT_LABEL[key],
                    onSelect: () => set(key),
                    active: sort === key,
                  })),
                },
              ]}
            />
          </div>
        </div>
        {data && albums.length === 0 && (
          <div className="py-16 text-center text-[13px] text-zinc-500">
            No albums yet.
          </div>
        )}
        <AlbumGrid
          albums={albums}
          scrollRef={scrollRef}
          gridRef={gridRef}
          scrollMargin={margin}
        />
      </Page>
    </div>
  )
}
