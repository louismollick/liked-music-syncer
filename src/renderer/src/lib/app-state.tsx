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
  activity: ActivityView | null
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
  const [activity, setActivity] = useState<ActivityView | null>(null)
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
    void invoke('activity:get').then(setActivity)
    loadCounts()
  }, [loadCounts])
  useEvent('session:changed', setSession)
  useEvent('settings:changed', setSettings)
  useEvent('activity:changed', setActivity)
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
      activity,
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
      activity,
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
