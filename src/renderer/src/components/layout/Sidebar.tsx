import { Link, useRouter, useRouterState } from '@tanstack/react-router'
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Disc3,
  Music2,
  RefreshCw,
  Settings,
  User,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ActivityTrackView } from '../../../../shared/ipc'
import { invoke } from '../../lib/api'
import { useActivity, useAppState } from '../../lib/app-state'
import { cx, plural, timeAgo } from '../../lib/format'
import { Artwork } from '../ui/Artwork'
import { IconButton } from '../ui/Button'

const STAGE_LABEL = {
  matching: 'Matching',
  downloading: 'Downloading',
  uploading: 'Uploading',
} as const

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function StatusSection() {
  const { session } = useAppState()
  const activity = useActivity()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const now = useNow()
  const [spinning, setSpinning] = useState(false)
  const current = activity?.current ?? null
  const onActivity = pathname.startsWith('/activity')
  const busy = Boolean(current) && !onActivity
  const working = Boolean(activity?.working || activity?.checking)
  const upNext = activity?.upNextCount ?? 0
  const signedIn = session?.state === 'signed_in'

  const remaining = upNext + (current ? 1 : 0)
  const checked = activity?.lastCheckedAt ?? null
  const title = !signedIn
    ? 'Not signed in'
    : activity?.checking
      ? 'Checking likes…'
      : working
        ? remaining > 0
          ? `Syncing ${plural(remaining, 'song')}`
          : 'Syncing'
        : 'Up to date'
  const detail = !signedIn
    ? 'Sign in from Settings'
    : !checked
      ? 'Not checked yet'
      : `${activity?.checking ? 'Last checked' : 'Checked'} ${timeAgo(checked, now)}`

  const check = () => {
    setSpinning(true)
    void invoke('activity:check')
    setTimeout(() => setSpinning(false), 900)
  }

  return (
    <Link
      to="/activity"
      className="block border-y border-line px-5 py-4 hover:bg-white/[.03] transition-colors"
    >
      {busy && current ? (
        <div className="fade-in">
          <div className="flex items-center gap-3">
            <Artwork
              src={current.coverUrl}
              label={current.title}
              className="w-9 h-9 shrink-0"
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium truncate">
                {current.title}
              </div>
              <div className="text-[11px] text-zinc-400 truncate tabular-nums">
                {current.stage ? STAGE_LABEL[current.stage] : 'Working'}
                {current.stage && current.stage !== 'matching'
                  ? ` · ${Math.round(stageFraction(current) * 100)}%`
                  : ''}
              </div>
            </div>
          </div>
          <div className="mt-3 h-[2px] bg-white/10">
            <div
              className="h-full bg-white transition-[width] duration-300"
              style={{ width: `${Math.round(current.progress * 100)}%` }}
            />
          </div>
          <div className="mt-2 text-[11px] text-zinc-500">
            {plural(upNext, 'song')} up next
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[13px]">
              <span
                className={cx(
                  'w-1.5 h-1.5 rounded-[1px]',
                  !signedIn
                    ? 'bg-zinc-600'
                    : working
                      ? 'bg-sky-400'
                      : 'bg-emerald-400'
                )}
              />
              <span className="truncate tabular-nums">{title}</span>
            </div>
            <div className="text-[11px] text-zinc-500 mt-1 truncate">
              {detail}
            </div>
          </div>
          <button
            type="button"
            title="Check liked songs now"
            disabled={!signedIn}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              check()
            }}
            className="w-10 h-10 shrink-0 rounded-md border border-line flex items-center justify-center text-zinc-300 hover:text-white hover:bg-white/10 disabled:opacity-30"
          >
            <RefreshCw
              className={cx(
                'w-[18px] h-[18px]',
                (spinning || activity?.checking) && 'spin'
              )}
              strokeWidth={1.8}
            />
          </button>
        </div>
      )}
    </Link>
  )
}

function stageFraction(current: ActivityTrackView | null): number {
  if (!current?.stage) return 0
  const [base, weight] = {
    matching: [0, 0.15],
    downloading: [0.15, 0.7],
    uploading: [0.85, 0.15],
  }[current.stage]
  return Math.max(0, Math.min(1, (current.progress - base) / weight))
}

const NAV = [
  {
    to: '/artists',
    label: 'Artists',
    icon: User,
    match: ['/artists', '/artist/'],
  },
  {
    to: '/albums',
    label: 'Albums',
    icon: Disc3,
    match: ['/albums', '/album/'],
  },
  { to: '/songs', label: 'Songs', icon: Music2, match: ['/songs'] },
] as const

export function Sidebar() {
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { session } = useAppState()
  const activity = useActivity()
  const account =
    session?.accounts.find((a) => a.id === session.selectedAccountId) ?? null
  const attention = activity?.needsAttention.length ?? 0

  const item = (
    to: string,
    label: string,
    Icon: typeof User,
    active: boolean,
    badge?: React.ReactNode
  ) => (
    <Link
      key={to}
      to={to}
      className={cx(
        'flex items-center gap-2.5 px-2 h-8 rounded-md text-[13px] transition-colors',
        active
          ? 'bg-white/10 text-white'
          : 'text-zinc-400 hover:text-white hover:bg-white/5'
      )}
    >
      <Icon className="w-4 h-4 shrink-0" strokeWidth={1.8} />
      {label}
      {badge}
    </Link>
  )

  return (
    <aside className="w-[232px] shrink-0 border-r border-line bg-side flex flex-col">
      <div className="h-12 pl-[84px] pr-3 flex items-center drag">
        <div className="text-[14px] font-semibold tracking-tight flex-1">
          Liked Music
        </div>
        <div className="flex gap-0.5 no-drag">
          <IconButton title="Back" onClick={() => router.history.back()}>
            <ChevronLeft className="w-4 h-4" />
          </IconButton>
          <IconButton title="Forward" onClick={() => router.history.forward()}>
            <ChevronRight className="w-4 h-4" />
          </IconButton>
        </div>
      </div>
      <StatusSection />
      <nav className="px-3 pt-4 space-y-0.5">
        {NAV.map((entry) =>
          item(
            entry.to,
            entry.label,
            entry.icon,
            entry.match.some((m) => pathname.startsWith(m))
          )
        )}
        <div className="h-4" />
        {item(
          '/activity',
          'Activity',
          Activity,
          pathname.startsWith('/activity'),
          attention > 0 ? (
            <span className="ml-auto text-[11px] text-amber-300/90 tabular-nums">
              {attention}
            </span>
          ) : null
        )}
        {item(
          '/settings',
          'Settings',
          Settings,
          pathname.startsWith('/settings')
        )}
      </nav>
      <div className="mt-auto px-5 py-3 border-t border-line">
        {account ? (
          <Link to="/settings" className="flex items-center gap-2 group">
            <Artwork
              src={account.photoUrl}
              label={account.name}
              kind="artist"
              className="w-7 h-7"
            />
            <div className="text-[12px] leading-tight min-w-0">
              <div className="truncate group-hover:text-white">
                {account.name}
              </div>
              <div className="text-zinc-500 truncate">
                {account.likedCount !== null
                  ? `${account.likedCount.toLocaleString('en-US')} liked songs`
                  : (account.handle ?? 'YouTube Music')}
              </div>
            </div>
          </Link>
        ) : (
          <Link
            to="/settings"
            className="text-[12px] text-zinc-500 hover:text-white"
          >
            Not signed in
          </Link>
        )}
      </div>
    </aside>
  )
}
