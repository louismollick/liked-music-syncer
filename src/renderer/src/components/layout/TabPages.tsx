import { useRouterState } from '@tanstack/react-router'
import { memo, useMemo } from 'react'
import { cx } from '../../lib/format'
import { type TabPath, TabProvider, type TabSearches } from '../../lib/tabs'
import { AlbumsPage } from '../../pages/AlbumsPage'
import { ArtistsPage } from '../../pages/ArtistsPage'
import { SongsPage } from '../../pages/SongsPage'

const TABS: Array<{ path: TabPath; Page: () => React.ReactNode }> = [
  { path: '/artists', Page: ArtistsPage },
  { path: '/albums', Page: AlbumsPage },
  { path: '/songs', Page: SongsPage },
]

const TabSlot = memo(function TabSlot({
  active,
  search,
  Page,
}: {
  active: boolean
  search: Record<string, unknown>
  Page: () => React.ReactNode
}) {
  const value = useMemo(() => ({ active, search }), [active, search])
  return (
    // `invisible` rather than `hidden`: the page keeps its size, so grids and
    // virtualized lists don't re-measure when it is shown again.
    <div
      inert={!active}
      className={cx('absolute inset-0', !active && 'invisible')}
    >
      <TabProvider value={value}>
        <Page />
      </TabProvider>
    </div>
  )
})

/** The Artists, Albums and Songs tabs, always mounted; only the current one shows. */
export function TabPages({ searches }: { searches: TabSearches }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  return TABS.map(({ path, Page }) => (
    <TabSlot
      key={path}
      active={pathname === path}
      search={searches[path]}
      Page={Page}
    />
  ))
}
