import { useRouterState } from '@tanstack/react-router'
import { createContext, useContext, useRef } from 'react'

/**
 * The Artists, Albums and Songs tabs stay mounted so switching between them is
 * instant and keeps scroll position. Each hidden tab keeps the search it last
 * had, and links back to a tab return to that search.
 */
export const TAB_PATHS = ['/artists', '/albums', '/songs'] as const
export type TabPath = (typeof TAB_PATHS)[number]
type Search = Record<string, unknown>
export type TabSearches = Record<TabPath, Search>

export const isTabPath = (path: string): path is TabPath =>
  (TAB_PATHS as readonly string[]).includes(path)

const EMPTY: TabSearches = { '/artists': {}, '/albums': {}, '/songs': {} }

/** The search each tab last had, following the current location. */
export function useRememberedSearches(): TabSearches {
  const location = useRouterState({ select: (state) => state.location })
  const memory = useRef(EMPTY)
  if (isTabPath(location.pathname)) {
    // The Song panel's `song` belongs to the visit, not the tab.
    const { song: _song, ...search } = location.search as Search
    const previous = memory.current[location.pathname]
    if (JSON.stringify(previous) !== JSON.stringify(search))
      memory.current = { ...memory.current, [location.pathname]: search }
  }
  return memory.current
}

const SearchesContext = createContext<TabSearches>(EMPTY)
export const TabSearchesProvider = SearchesContext.Provider

/** The search a link to `to` should carry: a tab's remembered search, otherwise none. */
export function useTabLinkSearch(): (to: string) => Search | undefined {
  const searches = useContext(SearchesContext)
  return (to) => (isTabPath(to) ? searches[to] : undefined)
}

interface TabState {
  active: boolean
  search: Search
}
/** Outside a tab, content is always active. */
const TabContext = createContext<TabState>({ active: true, search: {} })
export const TabProvider = TabContext.Provider

/** False while the enclosing tab is hidden. */
export function useTabActive(): boolean {
  return useContext(TabContext).active
}

/** The enclosing tab's search; it stays put while the tab is hidden. */
export function useTabSearch<T>(): T {
  return useContext(TabContext).search as T
}
