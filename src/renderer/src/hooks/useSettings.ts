import type { AppSettingsView, CommandResult } from '@shared/contracts'
import { useEffect, useState } from 'react'

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

export function useSettings() {
  const [settings, setSettings] = useState<AppSettingsView>(EMPTY_SETTINGS)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
  }, [])

  const update = async (
    partial: Partial<AppSettingsView>
  ): Promise<CommandResult> => {
    const previous = settings
    setSettings((current) => ({ ...current, ...partial }))
    const {
      outputFormat: _outputFormat,
      hasYtMusicBrowserAuth: _hasAuth,
      ytDlpCookiesBrowser: _browser,
      ...allowed
    } = partial
    try {
      return await window.api.settings.update(allowed)
    } catch (error) {
      setSettings(previous)
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { settings, setSettings, update }
}
