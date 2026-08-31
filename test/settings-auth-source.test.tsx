import type { AppSettingsView, AuthSessionView } from '@shared/contracts'
import { createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { refreshBrowserPicker } from '../src/renderer/src/auth/refreshBrowserPicker'
import { AccountDiscoveryStatus } from '../src/renderer/src/components/auth/AccountDiscoveryStatus'
import { AccountCount } from '../src/renderer/src/components/auth/AccountIdentity'
import {
  getSelectableAuthSources,
  SettingsView,
} from '../src/renderer/src/components/settings/SettingsView'

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
      accountCount: 2,
      accountsComplete: true,
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
  it('uses a skeleton only for the number while the liked-song count loads', () => {
    const markup = renderToStaticMarkup(
      createElement(AccountCount, {
        account: {
          ...authSession.activeAccount!,
          likedSongCount: null,
          likedSongCountState: 'loading',
        },
      })
    )

    expect(markup).toContain('animate-pulse')
    expect(markup).toContain('liked songs')
    expect(markup).not.toContain('animate-spin')
  })

  it('uses the shared account discovery status', () => {
    const markup = renderToStaticMarkup(createElement(AccountDiscoveryStatus))

    expect(markup).toContain('role="status"')
    expect(markup).toContain('Finding other accounts...')
    expect(markup).toContain('animate-spin')
  })

  it('excludes the selected browser from the menu options', () => {
    const sources = [
      ...authSession.sources,
      {
        ...authSession.sources[0]!,
        id: 'safari',
        browserName: 'Safari',
      },
    ]

    expect(
      getSelectableAuthSources(sources, authSession.selectedSourceId).map(
        (source) => source.id
      )
    ).toEqual(['safari'])
  })

  it('opens the controlled browser picker without owning its scan lifecycle', () => {
    const onBrowserPickerOpenChange = vi.fn()
    const view = SettingsView({
      settings,
      authSession,
      browserPickerOpen: false,
      onBrowserPickerOpenChange,
      onChange: vi.fn(),
      onSelectSource: vi.fn(),
      onSelectAccount: vi.fn(),
      onLoadAccountCounts: vi.fn(),
      switchingAccountKey: null,
      accountSwitchError: null,
      onAction: vi.fn(),
    })
    const findBrowserSelect = (node: ReactNode): (() => void) | undefined => {
      if (
        !isValidElement<{
          items?: Array<{ value: string }>
          onOpenChange?: (open: boolean) => void
          children?: ReactNode
        }>(node)
      )
        return undefined
      if (node.props.items?.[0]?.value === 'zen' && node.props.onOpenChange)
        return () => {
          node.props.onOpenChange?.(true)
          node.props.onOpenChange?.(false)
        }
      const childNodes = Array.isArray(node.props.children)
        ? node.props.children
        : [node.props.children]
      for (const child of childNodes) {
        const result = findBrowserSelect(child)
        if (result) return result
      }
      return undefined
    }

    findBrowserSelect(view)?.()

    expect(onBrowserPickerOpenChange.mock.calls).toEqual([[true], [false]])
  })

  it('starts browser scans when settings mounts with the picker already open', async () => {
    const refreshAuth = vi.fn().mockResolvedValue(undefined)

    await refreshBrowserPicker(true, refreshAuth, vi.fn())

    expect(refreshAuth).toHaveBeenCalledWith('all', 'picker_opened')
  })

  it('renders the selected browser status in the closed select trigger', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsView, {
        settings,
        authSession,
        browserPickerOpen: false,
        onBrowserPickerOpenChange: vi.fn(),
        onChange: vi.fn(),
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
    expect(trigger).toContain('bg-success')
    expect(trigger).toContain('2 accounts found')
    expect(trigger).toContain('text-text-primary')
    expect(trigger).toContain('text-text-muted')
    expect(trigger).not.toContain('Select a browser')
    expect(markup).toContain('Listener')
    expect(markup).not.toContain('@listener')
    expect(markup).toContain('321 liked songs')
    expect(markup).not.toContain('Checked the first 5 browser account slots.')
    expect(markup).not.toContain('Retry')
    expect(markup).not.toContain('aria-label="Refresh browser authentication"')
  })
})
