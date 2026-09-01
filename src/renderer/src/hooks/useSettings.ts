import type { AppSettingsView, CommandResult } from '@shared/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'

const EMPTY_SETTINGS: AppSettingsView = {
  outputDirectory: '',
  remoteCopyEnabled: false,
  outputFormat: 'm4a',
  rcloneRemote: '',
  remoteMusicRoot: '',
  lyricsApiBaseUrl: '',
  hasYtMusicBrowserAuth: false,
  ytDlpCookiesBrowser: 'chrome',
  folderTemplate: '{albumartist}/{album}',
  fileTemplate: '{track:02d} {title}',
  embedUnsyncedLyrics: true,
  writeLrcSidecar: true,
}

const TEXT_KEYS = new Set<keyof AppSettingsView>([
  'outputDirectory',
  'rcloneRemote',
  'remoteMusicRoot',
  'lyricsApiBaseUrl',
  'folderTemplate',
  'fileTemplate',
])

type PendingTextWrite = {
  value: string
  previous: string
  timer: ReturnType<typeof setTimeout>
  resolve: (result: CommandResult) => void
}

function allowedSettings(partial: Partial<AppSettingsView>) {
  const {
    outputFormat: _outputFormat,
    hasYtMusicBrowserAuth: _hasAuth,
    ytDlpCookiesBrowser: _browser,
    ...allowed
  } = partial
  return allowed
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettingsView>(EMPTY_SETTINGS)
  const settingsRef = useRef(EMPTY_SETTINGS)
  const pendingText = useRef(
    new Map<keyof AppSettingsView, PendingTextWrite[]>()
  )

  useEffect(() => {
    void window.api.settings.get().then((next) => {
      settingsRef.current = next
      setSettings(next)
    })
  }, [])

  const persist = useCallback(
    async (
      partial: Partial<AppSettingsView>,
      previous: Partial<AppSettingsView>,
      rollback: boolean
    ): Promise<CommandResult> => {
      try {
        const result = await window.api.settings.update(
          allowedSettings(partial)
        )
        if (!result.ok && rollback) {
          setSettings((current) => {
            const next = rollbackCurrent(current, partial, previous)
            settingsRef.current = next
            return next
          })
        }
        return result
      } catch (error) {
        if (rollback) {
          setSettings((current) => {
            const next = rollbackCurrent(current, partial, previous)
            settingsRef.current = next
            return next
          })
        }
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
    []
  )

  const flush = useCallback(
    async (keys?: Array<keyof AppSettingsView>): Promise<CommandResult> => {
      const selectedKeys = keys ?? [...pendingText.current.keys()]
      const partial: Partial<AppSettingsView> = {}
      const previous: Partial<AppSettingsView> = {}
      const writes: PendingTextWrite[] = []
      for (const key of selectedKeys) {
        const queued = pendingText.current.get(key)
        if (!queued?.length) continue
        pendingText.current.delete(key)
        for (const item of queued) clearTimeout(item.timer)
        const latest = queued.at(-1)!
        setPartialValue(partial, key, latest.value)
        setPartialValue(previous, key, queued[0]!.previous)
        writes.push(...queued)
      }
      if (!writes.length) return { ok: true, message: 'Settings unchanged.' }
      const result = await persist(partial, previous, true)
      for (const write of writes) write.resolve(result)
      return result
    },
    [persist]
  )

  useEffect(
    () => () => {
      void flush()
    },
    [flush]
  )

  const update = useCallback(
    (
      partial: Partial<AppSettingsView>,
      options: { immediate?: boolean } = {}
    ): Promise<CommandResult> => {
      const previous: Partial<AppSettingsView> = {}
      for (const key of Object.keys(partial) as Array<keyof AppSettingsView>) {
        setPartialValue(previous, key, settingsRef.current[key])
      }
      settingsRef.current = { ...settingsRef.current, ...partial }
      setSettings(settingsRef.current)

      const entries = Object.entries(partial) as Array<
        [keyof AppSettingsView, AppSettingsView[keyof AppSettingsView]]
      >
      const shouldDebounce =
        !options.immediate &&
        entries.length === 1 &&
        TEXT_KEYS.has(entries[0]![0]) &&
        typeof entries[0]![1] === 'string'
      if (!shouldDebounce) return persist(partial, previous, true)

      const [key, value] = entries[0] as [keyof AppSettingsView, string]
      return new Promise((resolve) => {
        const queued = pendingText.current.get(key) ?? []
        for (const item of queued) clearTimeout(item.timer)
        const timer = setTimeout(() => {
          void flush([key])
        }, 400)
        for (const item of queued) item.timer = timer
        queued.push({
          value,
          previous: String(previous[key] ?? ''),
          timer,
          resolve,
        })
        pendingText.current.set(key, queued)
      })
    },
    [flush, persist]
  )

  return { settings, setSettings, update, flush }
}

function setPartialValue(
  target: Partial<AppSettingsView>,
  key: keyof AppSettingsView,
  value: AppSettingsView[keyof AppSettingsView]
) {
  ;(target as Record<keyof AppSettingsView, unknown>)[key] = value
}

function rollbackCurrent(
  current: AppSettingsView,
  partial: Partial<AppSettingsView>,
  previous: Partial<AppSettingsView>
) {
  const next = { ...current }
  for (const key of Object.keys(previous) as Array<keyof AppSettingsView>) {
    if (Object.is(current[key], partial[key])) {
      setPartialValue(next, key, previous[key]!)
    }
  }
  return next
}
