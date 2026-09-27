import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  ActivityView,
  LibraryCounts,
  SessionView,
  Settings,
} from '../../../shared/ipc'
import { invoke, useEvent } from './api'

interface AppState {
  session: SessionView | null
  settings: Settings | null
  counts: LibraryCounts | null
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  /** Opens the Song panel for a track. */
  openSong: (trackId: string) => void
  closeSong: () => void
  songId: string | null
  attentionOpen: boolean
  setAttentionOpen: (open: boolean) => void
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
}

const Context = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionView | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [counts, setCounts] = useState<LibraryCounts | null>(null)
  const [songId, setSongId] = useState<string | null>(null)
  const [attentionOpen, setAttentionOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const loadCounts = useCallback(
    () => void invoke('library:counts').then(setCounts),
    []
  )
  useEffect(() => {
    void invoke('session:get').then(setSession)
    void invoke('settings:get').then(setSettings)
    loadCounts()
  }, [loadCounts])
  useEvent('session:changed', setSession)
  useEvent('settings:changed', setSettings)
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEvent('library:changed', () => {
    if (countsTimer.current) clearTimeout(countsTimer.current)
    countsTimer.current = setTimeout(loadCounts, 400)
  })

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await invoke('settings:update', patch))
  }, [])

  const value = useMemo<AppState>(
    () => ({
      session,
      settings,
      counts,
      updateSettings,
      openSong: setSongId,
      closeSong: () => setSongId(null),
      songId,
      attentionOpen,
      setAttentionOpen,
      paletteOpen,
      setPaletteOpen,
    }),
    [
      session,
      settings,
      counts,
      updateSettings,
      songId,
      attentionOpen,
      paletteOpen,
    ]
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useAppState(): AppState {
  const value = useContext(Context)
  if (!value) throw new Error('useAppState outside provider')
  return value
}

const ActivityContext = createContext<ActivityView | null>(null)

/**
 * Activity changes up to 10 times a second while downloading, so it lives in
 * its own context: only components that show it re-render.
 */
export function ActivityProvider({ children }: { children: React.ReactNode }) {
  const [activity, setActivity] = useState<ActivityView | null>(null)
  useEffect(() => {
    void invoke('activity:get').then(setActivity)
  }, [])
  useEvent('activity:changed', setActivity)
  return (
    <ActivityContext.Provider value={activity}>
      {children}
    </ActivityContext.Provider>
  )
}

export function useActivity(): ActivityView | null {
  return useContext(ActivityContext)
}
