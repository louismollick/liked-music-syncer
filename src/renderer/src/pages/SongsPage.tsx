import { useNavigate, useSearch } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SongFilters, SongSort } from '../../../shared/ipc'
import { SetupEmptyState, useSetupNeeded } from '../components/EmptyState'
import { Page, PageTitle } from '../components/layout/Page'
import { SongTable } from '../components/SongTable'
import { Button } from '../components/ui/Button'
import { AddFilterButton, Chip, Menu } from '../components/ui/Chip'
import { Drawer } from '../components/ui/Drawer'
import { invoke, useLibraryData } from '../lib/api'
import { useAppState } from '../lib/app-state'
import { plural } from '../lib/format'
import { useScrollMargin } from '../lib/use-scroll-margin'

export interface SongsSearch {
  lyrics?: 'synced' | 'plain' | 'none'
  remote?: 'in_sync' | 'stale' | 'missing'
  state?: 'needs_attention' | 'no_longer_wanted'
  lang?: string
  favorite?: boolean
  sort?: SongSort
  desc?: boolean
  song?: string
}

const LYRICS_LABEL = {
  synced: 'Lyrics: synced',
  plain: 'Lyrics: plain',
  none: 'Lyrics: none',
} as const
const REMOTE_LABEL = {
  in_sync: 'Remote: in sync',
  stale: 'Remote: stale',
  missing: 'Remote: missing',
} as const
const STATE_LABEL = {
  needs_attention: 'Needs attention',
  no_longer_wanted: 'No longer wanted',
} as const
const LANG_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })

export function SongsPage() {
  const search = useSearch({ strict: false }) as SongsSearch
  const navigate = useNavigate()
  const setup = useSetupNeeded()
  const { counts, openSong, settings } = useAppState()
  const scrollRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const [unmanagedOpen, setUnmanagedOpen] = useState(false)
  const [unmanaged, setUnmanaged] = useState<
    Array<{ path: string; size: number }>
  >([])
  const sort = search.sort ?? 'liked'
  const descending = search.desc ?? sort === 'liked'
  const filters: SongFilters = {
    lyrics: search.lyrics,
    remote: search.remote,
    state: search.state,
    language: search.lang,
    favorite: search.favorite,
  }
  const { data } = useLibraryData(
    () => invoke('library:songs', { filters, sort, descending, limit: 5000 }),
    [
      search.lyrics,
      search.remote,
      search.state,
      search.lang,
      search.favorite,
      sort,
      descending,
    ]
  )
  const margin = useScrollMargin(
    tableRef,
    scrollRef,
    `${data?.total}-${search.state}`
  )
  useEffect(() => {
    if (search.song) openSong(search.song)
  }, [search.song, openSong])
  useEffect(() => {
    if (unmanagedOpen) void invoke('library:unmanaged').then(setUnmanaged)
  }, [unmanagedOpen])

  if (setup) return <SetupEmptyState />
  const set = (patch: Partial<SongsSearch>) =>
    void navigate({
      to: '/songs',
      search: { ...search, song: undefined, ...patch },
    })
  const rows = data?.rows ?? []
  const languages = [
    ...new Set(rows.map((r) => r.language).filter(Boolean) as string[]),
  ].sort()
  const remoteOn = Boolean(settings?.remoteEnabled)
  const langName = (code: string) => {
    try {
      return LANG_NAMES.of(code) ?? code
    } catch {
      return code
    }
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto scroll-thin">
      <Page>
        <PageTitle
          title="Songs"
          meta={data ? plural(data.total, 'song') : undefined}
        />
        <div className="flex items-center gap-2 flex-wrap">
          {search.state && (
            <Chip
              label={STATE_LABEL[search.state]}
              onRemove={() => set({ state: undefined })}
            />
          )}
          {search.lyrics && (
            <Chip
              label={LYRICS_LABEL[search.lyrics]}
              onRemove={() => set({ lyrics: undefined })}
            />
          )}
          {search.remote && (
            <Chip
              label={REMOTE_LABEL[search.remote]}
              onRemove={() => set({ remote: undefined })}
            />
          )}
          {search.lang && (
            <Chip
              label={`Language: ${langName(search.lang)}`}
              onRemove={() => set({ lang: undefined })}
            />
          )}
          {search.favorite && (
            <Chip
              label="Favorite Artists"
              onRemove={() => set({ favorite: undefined })}
            />
          )}
          <AddFilterButton
            sections={[
              {
                title: 'Lyrics',
                options: (['synced', 'plain', 'none'] as const).map((v) => ({
                  label: LYRICS_LABEL[v].replace('Lyrics: ', ''),
                  onSelect: () => set({ lyrics: v }),
                  active: search.lyrics === v,
                })),
              },
              ...(remoteOn
                ? [
                    {
                      title: 'Remote',
                      options: (['in_sync', 'stale', 'missing'] as const).map(
                        (v) => ({
                          label: REMOTE_LABEL[v].replace('Remote: ', ''),
                          onSelect: () => set({ remote: v }),
                          active: search.remote === v,
                        })
                      ),
                    },
                  ]
                : []),
              {
                title: 'State',
                options: (['needs_attention', 'no_longer_wanted'] as const).map(
                  (v) => ({
                    label: STATE_LABEL[v],
                    onSelect: () => set({ state: v }),
                    active: search.state === v,
                  })
                ),
              },
              {
                title: 'Artists',
                options: [
                  {
                    label: 'By Favorite Artists',
                    onSelect: () => set({ favorite: true }),
                    active: search.favorite,
                  },
                ],
              },
              ...(languages.length
                ? [
                    {
                      title: 'Language',
                      options: languages.map((code) => ({
                        label: langName(code),
                        hint: code.toUpperCase(),
                        onSelect: () => set({ lang: code }),
                        active: search.lang === code,
                      })),
                    },
                  ]
                : []),
            ]}
          />
          {search.state === 'no_longer_wanted' && rows.length > 0 && (
            <Menu
              sections={[
                {
                  title: `Delete ${plural(rows.length, 'song')}`,
                  options: [
                    {
                      label: 'From this Mac',
                      onSelect: () =>
                        void invoke('library:delete', {
                          trackIds: rows.map((r) => r.id),
                          where: 'local',
                        }),
                    },
                    ...(remoteOn
                      ? [
                          {
                            label: 'From the remote',
                            onSelect: () =>
                              void invoke('library:delete', {
                                trackIds: rows.map((r) => r.id),
                                where: 'remote',
                              }),
                          },
                          {
                            label: 'From both',
                            onSelect: () =>
                              void invoke('library:delete', {
                                trackIds: rows.map((r) => r.id),
                                where: 'both',
                              }),
                          },
                        ]
                      : []),
                  ],
                },
              ]}
              trigger={() => (
                <Button size="sm" variant="ghost" className="text-zinc-300">
                  <Trash2 className="w-3.5 h-3.5" /> Delete…
                </Button>
              )}
            />
          )}
          <div className="ml-auto flex items-center gap-2 text-[12px] text-zinc-500">
            <button
              type="button"
              className="hover:text-white"
              onClick={() => set({ state: 'needs_attention' })}
            >
              Needs attention {counts?.needsAttention ?? 0}
            </button>
            <span className="text-zinc-700">·</span>
            <button
              type="button"
              className="hover:text-white"
              onClick={() => set({ state: 'no_longer_wanted' })}
            >
              No longer wanted {counts?.noLongerWanted ?? 0}
            </button>
            <span className="text-zinc-700">·</span>
            <button
              type="button"
              className="hover:text-white"
              onClick={() => setUnmanagedOpen(true)}
            >
              Unmanaged {counts?.unmanaged ?? 0}
            </button>
          </div>
        </div>
        {data && rows.length === 0 && (
          <div className="py-16 text-center text-[13px] text-zinc-500">
            {Object.values(filters).some(Boolean)
              ? 'No songs match these filters.'
              : 'No songs yet. New likes appear here as they download.'}
          </div>
        )}
        <div ref={tableRef}>
          <SongTable
            rows={rows}
            sort={sort}
            descending={descending}
            onSort={(next) =>
              set(
                next === sort
                  ? { desc: !descending }
                  : { sort: next, desc: next === 'liked' }
              )
            }
            scrollRef={scrollRef}
            scrollMargin={margin}
          />
        </div>
      </Page>
      <Drawer
        open={unmanagedOpen}
        onClose={() => setUnmanagedOpen(false)}
        title={`Unmanaged files · ${unmanaged.length}`}
      >
        <div className="px-4 py-3 text-[12px] text-zinc-500 border-b border-line">
          Audio files in your folder that the app did not create. They are
          listed here and never added to the Library.
        </div>
        {unmanaged.map((file) => (
          <div
            key={file.path}
            className="px-4 py-2 border-b border-line font-mono text-[11px] text-zinc-400 break-all selectable"
          >
            {file.path}
          </div>
        ))}
      </Drawer>
    </div>
  )
}
