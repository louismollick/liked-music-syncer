import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  EventChannel,
  EventMap,
  InvokeChannel,
  InvokeMap,
} from '../../../shared/ipc'
import { useTabActive } from './tabs'

export function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeMap[C][0] extends void ? [] : [InvokeMap[C][0]]
): Promise<InvokeMap[C][1]> {
  return window.lms.invoke(channel, ...args)
}

export function useEvent<C extends EventChannel>(
  channel: C,
  listener: (payload: EventMap[C]) => void
): void {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(
    () => window.lms.on(channel, (payload) => ref.current(payload)),
    [channel]
  )
}

/**
 * Loads data with `load`, re-running when deps change or when the library
 * changes (debounced), keeping the previous data while reloading. A hidden tab
 * skips library-change reloads and reloads when shown again.
 */
export function useLibraryData<T>(
  load: () => Promise<T>,
  deps: unknown[]
): { data: T | undefined; reload: () => void } {
  const [data, setData] = useState<T>()
  const loadRef = useRef(load)
  loadRef.current = load
  const seq = useRef(0)
  const reload = useCallback(() => {
    const id = ++seq.current
    void loadRef.current().then((value) => {
      if (id === seq.current) setData(value)
    })
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are provided by the caller
  useEffect(reload, deps)
  const active = useTabActive()
  const wasActive = useRef(active)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEvent('library:changed', () => {
    if (!active) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(reload, 400)
  })
  // Refresh a tab each time it is shown, as a fresh mount would, while it keeps
  // showing what it had.
  useEffect(() => {
    if (active && !wasActive.current) reload()
    wasActive.current = active
  }, [active, reload])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return { data, reload }
}
