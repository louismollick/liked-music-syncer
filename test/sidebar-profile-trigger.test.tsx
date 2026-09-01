import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/library', search: {} } }),
}))

import {
  Sidebar,
  SidebarAccountOptions,
} from '../src/renderer/src/components/layout/Sidebar'

describe('Sidebar profile trigger', () => {
  it('holds discovered account rows until account discovery finishes', () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarAccountOptions, {
        accounts: [
          {
            key: 'current',
            displayName: 'Current listener',
            handle: '@current',
            imageUrl: null,
            cachedImageUrl: null,
            likedSongCount: null,
            likedSongCountState: 'unrequested',
          },
          {
            key: 'other',
            displayName: 'Other listener',
            handle: '@other',
            imageUrl: null,
            cachedImageUrl: null,
            likedSongCount: null,
            likedSongCountState: 'unrequested',
          },
        ],
        accountsComplete: false,
        selectedAccountKey: 'current',
        switchingAccountKey: null,
        onSelectAccount: vi.fn(async () => true),
        onSelected: vi.fn(),
      })
    )

    expect(markup).toContain('Finding other accounts...')
    expect(markup).not.toContain('Other listener')
  })

  it('limits the interactive profile trigger to the avatar bounds', () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        counts: { all: 0, inProgress: 0, completed: 0, failed: 0 },
        authSession: {
          state: 'signed_in',
          selectedSourceId: 'chrome',
          selectedAccountKey: 'account',
          activeAccount: {
            key: 'account',
            displayName: 'Listener',
            handle: '@listener',
            imageUrl: null,
            cachedImageUrl: null,
            likedSongCount: null,
            likedSongCountState: 'unrequested',
          },
          sources: [],
          accounts: [],
          accountsComplete: true,
          isRefreshing: false,
          switchingDisabledReason: null,
          issue: null,
        },
        onSelectAccount: vi.fn(async () => true),
        onLoadAccountCounts: vi.fn(async () => undefined),
        switchingAccountKey: null,
        accountSwitchError: null,
      })
    )
    const trigger = markup.match(
      /<button[^>]*aria-label="Open YouTube Music account menu"[^>]*>/
    )?.[0]

    expect(trigger).toContain('pointer-events-none')
    expect(trigger).toContain('w-full')
    expect(markup).toContain('pointer-events-auto size-10')
  })
})
