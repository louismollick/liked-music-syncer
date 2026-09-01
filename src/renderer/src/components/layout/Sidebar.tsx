import type {
  AuthSessionView,
  YouTubeMusicAccountView,
} from '@shared/contracts'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { LogInIcon, TriangleAlertIcon } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { type LibraryTab, libraryTabSchema } from '../../routes/library'
import { AccountDiscoveryStatus } from '../auth/AccountDiscoveryStatus'
import {
  AccountAvatar,
  AccountCount,
  AccountIdentity,
} from '../auth/AccountIdentity'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

type SectionKey = 'library'

interface Props {
  counts: {
    all: number
    inProgress: number
    completed: number
    failed: number
  }
  authSession: AuthSessionView
  onSelectAccount: (key: string) => Promise<boolean>
  onLoadAccountCounts: () => Promise<void>
  onError: (message: string) => void
  switchingAccountKey: string | null
  accountSwitchError: string | null
}

export function SidebarAccountOptions({
  accounts,
  accountsComplete,
  selectedAccountKey,
  switchingAccountKey,
  onSelectAccount,
  onSelected,
}: {
  accounts: YouTubeMusicAccountView[]
  accountsComplete: boolean
  selectedAccountKey: string | null
  switchingAccountKey: string | null
  onSelectAccount: (key: string) => Promise<boolean>
  onSelected: () => void
}): JSX.Element {
  return (
    <div className="divide-y divide-border/70 border-b border-border/80 empty:border-b-0">
      {!accountsComplete ? <AccountDiscoveryStatus /> : null}
      {accountsComplete
        ? accounts
            .filter((account) => account.key !== selectedAccountKey)
            .map((account) => (
              <button
                key={account.key}
                type="button"
                disabled={switchingAccountKey !== null}
                onClick={() => {
                  void onSelectAccount(account.key).then((ok) => {
                    if (ok) onSelected()
                  })
                }}
                className="flex w-full items-center rounded-md p-2 text-left transition-colors hover:bg-surface-tertiary disabled:opacity-60"
              >
                <AccountIdentity
                  account={account}
                  avatarClassName="size-10"
                  showHandle={false}
                  switching={switchingAccountKey === account.key}
                />
              </button>
            ))
        : null}
    </div>
  )
}

function loadExpanded(): Set<SectionKey> {
  try {
    const stored = localStorage.getItem('sidebar-expanded')
    if (stored) return new Set(JSON.parse(stored) as SectionKey[])
  } catch {}
  return new Set<SectionKey>(['library'])
}

function saveExpanded(expanded: Set<SectionKey>): void {
  localStorage.setItem('sidebar-expanded', JSON.stringify([...expanded]))
}

function NavSection({
  label,
  icon,
  expanded,
  active,
  onToggle,
  children,
}: {
  label: string
  icon: JSX.Element
  expanded: boolean
  active: boolean
  onToggle: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
          active
            ? 'text-text-primary'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-tertiary/50'
        }`}
      >
        <span className="w-4 h-4 flex-shrink-0">{icon}</span>
        <span className="flex-1">{label}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={`w-3 h-3 text-text-muted flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4.5 1.5l4.5 4.5-4.5 4.5" />
        </svg>
      </button>
      {expanded ? <div className="mt-0.5 ml-3">{children}</div> : null}
    </div>
  )
}

function NavSubItem({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
        active
          ? 'bg-surface-tertiary text-text-primary font-medium'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-tertiary/50'
      }`}
    >
      <span className="flex-1">{label}</span>
    </button>
  )
}

function NavItem({
  label,
  icon,
  active,
  badge,
  onClick,
}: {
  label: string
  icon: JSX.Element
  active: boolean
  badge?: number
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
        active
          ? 'bg-surface-tertiary text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-tertiary/50'
      }`}
    >
      <span className="w-4 h-4 flex-shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 ? (
        <span className="text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center bg-accent text-white">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

export function Sidebar({
  counts,
  authSession,
  onSelectAccount,
  onLoadAccountCounts,
  onError,
  switchingAccountKey,
  accountSwitchError,
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState<Set<SectionKey>>(loadExpanded)
  const [profileOpen, setProfileOpen] = useState(false)
  useEffect(() => {
    if (profileOpen && authSession.accountsComplete) {
      void onLoadAccountCounts().catch((error) =>
        onError(error instanceof Error ? error.message : String(error))
      )
    }
  }, [profileOpen, authSession.accountsComplete, onLoadAccountCounts, onError])
  const navigate = useNavigate()
  const location = useRouterState({
    select: (state) => state.location,
  })

  const tabParse = libraryTabSchema.safeParse(location.search.tab)
  const activeLibraryTab: LibraryTab = tabParse.success
    ? tabParse.data
    : 'artists'

  const navigateToLibrary = (tab: LibraryTab) =>
    void navigate({
      to: '/library',
      search: { tab },
    })

  const toggle = (key: SectionKey, firstSubItem: LibraryTab) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
        navigateToLibrary(firstSubItem)
      }
      saveExpanded(next)
      return next
    })
  }

  const isLibraryActive = location.pathname === '/library'
  const selectedSource = authSession.sources.find(
    (source) => source.id === authSession.selectedSourceId
  )

  return (
    <aside className="w-56 flex-shrink-0 bg-surface-primary border-r border-border flex flex-col h-screen">
      <div className="px-4 py-5 border-b border-border">
        <h1 className="text-base font-bold text-text-primary tracking-tight">
          Liked Music
        </h1>
        <p className="text-xs text-text-muted mt-0.5">Syncer</p>
      </div>

      <nav className="flex-1 p-3 flex flex-col gap-1 overflow-y-auto">
        <NavSection
          label="Library"
          expanded={expanded.has('library')}
          active={isLibraryActive}
          onToggle={() => toggle('library', 'artists')}
          icon={
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.5 3.5a.5.5 0 0 1 0-1h11a.5.5 0 0 1 0 1h-11zm2-2a.5.5 0 0 1 0-1h7a.5.5 0 0 1 0 1h-7zM0 13a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 16 13V6a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 0 6v7zm6.258-6.437a.5.5 0 0 1 .507.013l4 2.5a.5.5 0 0 1 0 .848l-4 2.5A.5.5 0 0 1 6 12V7a.5.5 0 0 1 .258-.437z" />
            </svg>
          }
        >
          <NavSubItem
            label="Artists"
            active={isLibraryActive && activeLibraryTab === 'artists'}
            onClick={() => navigateToLibrary('artists')}
          />
          <NavSubItem
            label="Albums"
            active={isLibraryActive && activeLibraryTab === 'albums'}
            onClick={() => navigateToLibrary('albums')}
          />
          <NavSubItem
            label="Songs"
            active={isLibraryActive && activeLibraryTab === 'songs'}
            onClick={() => navigateToLibrary('songs')}
          />
        </NavSection>

        <NavItem
          label="Sync"
          active={location.pathname === '/sync'}
          badge={counts.inProgress}
          onClick={() => void navigate({ to: '/sync' })}
          icon={
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z" />
              <path
                fillRule="evenodd"
                d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"
              />
            </svg>
          }
        />

        <NavItem
          label="Settings"
          active={location.pathname === '/settings'}
          onClick={() =>
            void navigate({
              to: '/settings',
              search: { detectAuth: undefined, browserPicker: undefined },
            })
          }
          icon={
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z" />
              <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.892 3.433-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z" />
            </svg>
          }
        />
      </nav>
      <div>
        {authSession.state === 'loading' && !authSession.activeAccount ? (
          <div
            role="status"
            className="m-3 size-10 animate-pulse rounded-lg bg-surface-tertiary"
            aria-label="Checking YouTube Music account"
          />
        ) : (authSession.state === 'signed_in' ||
            authSession.state === 'loading') &&
          authSession.activeAccount ? (
          <Popover
            open={profileOpen}
            onOpenChange={(open) => {
              setProfileOpen(open)
            }}
          >
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className="group pointer-events-none relative z-[60] flex w-full px-3 py-3 outline-none"
                  aria-label="Open YouTube Music account menu"
                />
              }
            >
              <AccountAvatar
                account={authSession.activeAccount}
                className={`pointer-events-auto size-10 transition-shadow group-hover:ring-2 group-hover:ring-text-secondary/70 group-focus-visible:ring-2 group-focus-visible:ring-ring ${
                  profileOpen ? 'ring-2 ring-text-secondary/70' : ''
                }`}
              />
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              collisionAvoidance={{ side: 'none', align: 'none' }}
              sideOffset={-64}
              className="max-h-screen w-56 gap-0 overflow-y-auto rounded-none p-1 shadow-none ring-0 border-t border-border"
            >
              {selectedSource ? (
                <button
                  type="button"
                  onClick={() => {
                    setProfileOpen(false)
                    void navigate({
                      to: '/settings',
                      search: {
                        detectAuth: undefined,
                        browserPicker: true,
                      },
                    })
                  }}
                  className="m-1 mb-0 rounded-md px-2 py-1.5 text-left text-xs font-medium text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
                >
                  From browser: {selectedSource.browserName}
                  {selectedSource.profileName
                    ? ` (${selectedSource.profileName})`
                    : ''}
                </button>
              ) : null}
              <SidebarAccountOptions
                accounts={authSession.accounts}
                accountsComplete={authSession.accountsComplete}
                selectedAccountKey={authSession.selectedAccountKey}
                switchingAccountKey={switchingAccountKey}
                onSelectAccount={onSelectAccount}
                onSelected={() => setProfileOpen(false)}
              />
              {accountSwitchError ? (
                <p className="px-2 py-1 text-xs text-error">
                  {accountSwitchError}
                </p>
              ) : null}
              <div className="-mb-1 h-16 pt-3 pl-14 pr-2">
                <p className="truncate text-sm font-medium text-text-primary">
                  {authSession.activeAccount.displayName}
                </p>
                <AccountCount account={authSession.activeAccount} />
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: '/settings',
                search: {
                  detectAuth:
                    authSession.state === 'signed_out' ? true : undefined,
                  browserPicker: undefined,
                },
              })
            }
            className="m-3 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface-tertiary hover:text-text-primary"
          >
            {authSession.state === 'signed_out' ? (
              <LogInIcon aria-hidden="true" className="size-4 flex-shrink-0" />
            ) : (
              <TriangleAlertIcon
                aria-hidden="true"
                className="size-4 flex-shrink-0"
              />
            )}
            {authSession.state === 'signed_out' ? 'Sign In' : 'Auth Issue'}
          </button>
        )}
      </div>
    </aside>
  )
}
