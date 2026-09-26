import { useNavigate, useSearch } from '@tanstack/react-router'
import { useRef } from 'react'
import { SetupEmptyState, useSetupNeeded } from '../components/EmptyState'
import { ArtistGrid } from '../components/Grids'
import { Page, PageTitle } from '../components/layout/Page'
import { AddFilterButton, Chip, SortMenu } from '../components/ui/Chip'
import { invoke, useLibraryData } from '../lib/api'
import { plural } from '../lib/format'
import { useScrollMargin } from '../lib/use-scroll-margin'

export interface ArtistsSearch {
  filter?: 'favorites' | 'suggested'
  sort?: 'songs' | 'name'
}

export function ArtistsPage() {
  const search = useSearch({ strict: false }) as ArtistsSearch
  const navigate = useNavigate()
  const setup = useSetupNeeded()
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const { data, reload } = useLibraryData(
    () =>
      invoke('library:artists', {
        favorites: search.filter === 'favorites',
        suggested: search.filter === 'suggested',
        sort: search.sort ?? 'songs',
      }),
    [search.filter, search.sort]
  )
  const margin = useScrollMargin(
    gridRef,
    scrollRef,
    `${data?.length}-${search.filter}`
  )
  const set = (patch: Partial<ArtistsSearch>) =>
    void navigate({ to: '/artists', search: { ...search, ...patch } })
  if (setup) return <SetupEmptyState />
  const artists = data ?? []
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto scroll-thin">
      <Page>
        <PageTitle
          title="Artists"
          meta={data ? plural(artists.length, 'artist') : undefined}
        />
        <div className="flex items-center gap-2 flex-wrap">
          {search.filter === 'favorites' && (
            <Chip
              label="Favorites"
              onRemove={() => set({ filter: undefined })}
            />
          )}
          {search.filter === 'suggested' && (
            <Chip
              label="Suggested from your old library"
              onRemove={() => set({ filter: undefined })}
            />
          )}
          <AddFilterButton
            sections={[
              {
                title: 'Show',
                options: [
                  {
                    label: 'Favorites',
                    onSelect: () => set({ filter: 'favorites' }),
                    active: search.filter === 'favorites',
                  },
                  {
                    label: 'Suggested from your old library',
                    onSelect: () => set({ filter: 'suggested' }),
                    active: search.filter === 'suggested',
                  },
                ],
              },
            ]}
          />
          <div className="ml-auto">
            <SortMenu
              label={search.sort === 'name' ? 'Name' : 'Most songs'}
              sections={[
                {
                  title: 'Sort by',
                  options: [
                    {
                      label: 'Most songs',
                      onSelect: () => set({ sort: 'songs' }),
                      active: search.sort !== 'name',
                    },
                    {
                      label: 'Name',
                      onSelect: () => set({ sort: 'name' }),
                      active: search.sort === 'name',
                    },
                  ],
                },
              ]}
            />
          </div>
        </div>
        {data && artists.length === 0 && (
          <div className="py-16 text-center text-[13px] text-zinc-500">
            {search.filter === 'favorites'
              ? 'No Favorite Artists yet. Hover an artist and click the star.'
              : search.filter === 'suggested'
                ? 'No suggestions.'
                : 'No artists yet. New likes appear here as they download.'}
          </div>
        )}
        <ArtistGrid
          artists={artists}
          scrollRef={scrollRef}
          gridRef={gridRef}
          scrollMargin={margin}
          onChanged={reload}
        />
      </Page>
    </div>
  )
}
