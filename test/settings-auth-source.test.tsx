import type { AppSettingsView, AuthSessionView } from '@shared/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../src/renderer/src/components/settings/SettingsView'

const settings: AppSettingsView = {
  outputDirectory: '',
  remoteCopyEnabled: false,
  outputFormat: 'm4a',
  rcloneRemote: '',
  remoteMusicRoot: '',
  lyricsApiBaseUrl: '',
  hasYtMusicBrowserAuth: true,
  ytDlpCookiesBrowser: 'zen',
  folderTemplate: '{albumartist}/{album}',
  fileTemplate: '{track:02d} {title}',
  embedUnsyncedLyrics: true,
  writeLrcSidecar: true,
}

const authSession: AuthSessionView = {
  state: 'signed_in',
  selectedSourceId: 'zen',
  selectedAccountKey: 'account',
  activeAccount: {
    key: 'account',
    displayName: 'Listener',
    handle: '@listener',
    imageUrl: null,
    cachedImageUrl: null,
    likedSongCount: 321,
    likedSongCountState: 'loaded',
  },
  sources: [
    {
      id: 'zen',
      browserName: 'Zen',
      browserLogoUrl: '',
      applicationPath: '/Applications/Zen.app',
      profileName: null,
      status: 'signed_in',
      accountCount: null,
      accountsComplete: false,
      issue: null,
    },
  ],
  accounts: [
    {
      key: 'account',
      displayName: 'Listener',
      handle: '@listener',
      imageUrl: null,
      cachedImageUrl: null,
      likedSongCount: 321,
      likedSongCountState: 'loaded',
    },
  ],
  accountsComplete: false,
  isRefreshing: false,
  switchingDisabledReason: null,
  issue: null,
}

describe('Settings authentication source', () => {
  it('renders the restored browser name in the closed select trigger', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsView, {
        settings,
        authSession,
        onChange: vi.fn(),
        onRefreshAuth: vi.fn(),
        onSelectSource: vi.fn(),
        onSelectAccount: vi.fn(),
        onLoadAccountCounts: vi.fn(),
        switchingAccountKey: null,
        accountSwitchError: null,
        onAction: vi.fn(),
      })
    )

    const trigger = markup.match(
      /<button[^>]*data-slot="select-trigger"[\s\S]*?<\/button>/
    )?.[0]
    expect(trigger).toContain('Zen')
    expect(trigger).not.toContain('Select a browser')
    expect(markup).toContain('Listener')
    expect(markup).toContain('@listener')
    expect(markup).toContain('321 liked songs')
  })
})
