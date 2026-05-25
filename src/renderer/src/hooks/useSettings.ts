import type {
  AppSettingsView,
  AuthStatus,
  CommandResult,
} from '@shared/contracts'
import { useEffect, useState } from 'react'

const EMPTY_SETTINGS: AppSettingsView = {
  outputDirectory: '',
  remoteCopyEnabled: false,
  outputFormat: 'm4a',
  rcloneRemote: '',
  remoteMusicRoot: '',
  lyricsApiBaseUrl: '',
  hasYtMusicBrowserAuth: false,
  ytDlpCookiesBrowser: 'firefox',
  folderTemplate: '{albumartist}/{album}',
  fileTemplate: '{track:02d} {title}',
  embedUnsyncedLyrics: true,
  writeLrcSidecar: true,
}

const EMPTY_AUTH: AuthStatus = {
  authMode: 'none',
  isAuthenticated: false,
  hasBrowserAuth: false,
  lastError: null,
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettingsView>(EMPTY_SETTINGS)
  const [authStatus, setAuthStatus] = useState<AuthStatus>(EMPTY_AUTH)

  useEffect(() => {
    void Promise.all([
      window.api.settings.get(),
      window.api.auth.getStatus(),
    ]).then(([s, a]) => {
      setSettings(s)
      setAuthStatus(a)
    })
  }, [])

  const save = async (): Promise<CommandResult> => {
    const result = await window.api.settings.save({
      outputDirectory: settings.outputDirectory,
      remoteCopyEnabled: settings.remoteCopyEnabled,
      ytDlpCookiesBrowser: settings.ytDlpCookiesBrowser,
      rcloneRemote: settings.rcloneRemote,
      remoteMusicRoot: settings.remoteMusicRoot,
      lyricsApiBaseUrl: settings.lyricsApiBaseUrl,
      folderTemplate: settings.folderTemplate,
      fileTemplate: settings.fileTemplate,
      embedUnsyncedLyrics: settings.embedUnsyncedLyrics,
      writeLrcSidecar: settings.writeLrcSidecar,
    })
    const [nextSettings, nextAuth] = await Promise.all([
      window.api.settings.get(),
      window.api.auth.getStatus(),
    ])
    setSettings(nextSettings)
    setAuthStatus(nextAuth)
    return result
  }

  return { settings, setSettings, authStatus, setAuthStatus, save }
}
