import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ActivityTrackView } from '../../../shared/ipc'
import { PageTitle } from '../components/layout/Page'
import { Artwork } from '../components/ui/Artwork'
import { Button } from '../components/ui/Button'
import { isRowVisible, shouldRecenter } from '../lib/activity-scroll'
import { useActivity, useAppState } from '../lib/app-state'
import { dayLabel, plural } from '../lib/format'

const STAGE_LABEL = {
  matching: 'Matching',
  downloading: 'Downloading',
  uploading: 'Uploading',
} as const
const STAGES = {
  matching: [0, 0.15],
  downloading: [0.15, 0.7],
  uploading: [0.85, 0.15],
} as const

function stagePercent(track: ActivityTrackView): number {
  if (!track.stage) return 0
  const [base, weight] = STAGES[track.stage]
  return Math.round(
    Math.max(0, Math.min(1, (track.progress - base) / weight)) * 100
  )
}

/**
 * One column, like synced lyrics: done tracks above, the current track
 * highlighted, up-next below. Scroll position is kept when the track changes;
 * it re-centres only if the current row was visible and the user is not
 * scrolling.
 */
export function ActivityPage() {
  const { setAttentionOpen, openSong } = useAppState()
  const activity = useActivity()
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef<HTMLDivElement>(null)
  const lastUserScroll = useRef(0)
  const programmatic = useRef(false)
  const lastCurrentId = useRef<string | null>(null)
  const wasVisible = useRef(true)
  const initialized = useRef(false)

  const center = useCallback((smooth: boolean) => {
    const scroller = scrollRef.current
    const row = currentRef.current
    if (!scroller || !row) return
    programmatic.current = true
    scroller.scrollTo({
      top: row.offsetTop - scroller.clientHeight / 2 + row.offsetHeight / 2,
      behavior: smooth ? 'smooth' : 'auto',
    })
    setTimeout(() => {
      programmatic.current = false
    }, 800)
  }, [])

  const current = activity?.current ?? null
  // Remember whether the current row is visible before the list re-renders.
  const measureVisibility = () => {
    const scroller = scrollRef.current
    const row = currentRef.current
    if (!scroller || !row) return
    wasVisible.current = isRowVisible(
      row.getBoundingClientRect(),
      scroller.getBoundingClientRect()
    )
  }

  useLayoutEffect(() => {
    if (!initialized.current && current) {
      initialized.current = true
      lastCurrentId.current = current.id
      center(false)
      return
    }
    if (
      shouldRecenter({
        previousId: lastCurrentId.current,
        currentId: current?.id ?? null,
        wasVisible: wasVisible.current,
        lastUserScrollAt: lastUserScroll.current,
        now: Date.now(),
      })
    ) {
      center(true)
    }
    if (current) lastCurrentId.current = current.id
  }, [current, center])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || initialized.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [])

  const recent = activity?.recent ?? []
  const upNext = activity?.upNext ?? []
  const attention = activity?.needsAttention.length ?? 0
  const groups: Array<{ day: string; items: ActivityTrackView[] }> = []
  for (const track of recent) {
    const day = track.completedAt ? dayLabel(track.completedAt) : 'Earlier'
    const last = groups.at(-1)
    if (last?.day === day) last.items.push(track)
    else groups.push({ day, items: [track] })
  }

  const openDone = (id: string) => {
    void navigate({ to: '/songs', search: { song: id } })
    openSong(id)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-6 pb-2">
        <PageTitle title="Activity">
          {attention > 0 && (
            <Button
              size="sm"
              variant="attention"
              className="self-center"
              onClick={() => setAttentionOpen(true)}
            >
              {attention} need{attention === 1 ? 's' : ''} attention
            </Button>
          )}
        </PageTitle>
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          if (!programmatic.current) lastUserScroll.current = Date.now()
          measureVisibility()
        }}
        className="relative flex-1 overflow-y-auto scroll-thin lyric-mask"
      >
        <div
          className="max-w-2xl mx-auto px-6"
          style={{ paddingTop: '38vh', paddingBottom: '38vh' }}
        >
          {groups.map((group) => (
            <div key={group.day}>
              <div className="h-9 flex items-end pb-1 px-4 text-[11px] uppercase tracking-wider text-zinc-600">
                {group.day}
              </div>
              {group.items.map((track) => (
                <button
                  type="button"
                  key={track.id}
                  onClick={() => openDone(track.id)}
                  className="w-full h-14 flex flex-col justify-center px-4 rounded-md text-left text-zinc-400 hover:text-white hover:bg-white/[.04]"
                >
                  <div className="truncate text-[15px]">{track.title}</div>
                  <div className="truncate text-[12px] text-zinc-600">
                    {track.artist}
                  </div>
                </button>
              ))}
            </div>
          ))}
          {current ? (
            <div
              ref={currentRef}
              className="my-2 rounded-md bg-white/[.06] relative overflow-hidden fade-in"
              key={current.id}
            >
              <div className="flex items-center gap-4 p-4">
                <Artwork
                  src={current.coverUrl}
                  label={current.title}
                  className="w-14 h-14 shrink-0"
                />
                <div className="min-w-0">
                  <div className="text-xl font-semibold truncate">
                    {current.title}
                  </div>
                  <div className="text-[13px] text-zinc-400 truncate">
                    {current.artist}
                  </div>
                </div>
                <div className="ml-auto text-[13px] text-zinc-300 tabular-nums whitespace-nowrap">
                  {current.stage ? STAGE_LABEL[current.stage] : 'Working'}
                  {current.stage && current.stage !== 'matching'
                    ? ` · ${stagePercent(current)}%`
                    : ''}
                </div>
              </div>
              <div
                className="absolute left-0 bottom-0 h-[2px] bg-white transition-[width] duration-300"
                style={{ width: `${Math.round(current.progress * 100)}%` }}
              />
            </div>
          ) : (
            <div
              ref={currentRef}
              className="my-2 h-14 flex items-center px-4 text-[15px] text-zinc-500"
            >
              {activity?.checking
                ? 'Checking your liked songs…'
                : upNext.length
                  ? 'Waiting to retry…'
                  : 'Up to date. New likes will appear here.'}
            </div>
          )}
          {upNext.map((track, index) => (
            <div
              key={track.id}
              className="h-14 flex flex-col justify-center px-4"
              style={{ opacity: Math.max(0.28, 0.85 - index * 0.09) }}
            >
              <div className="truncate text-[15px] text-zinc-300">
                {track.title}
              </div>
              <div className="truncate text-[12px] text-zinc-600">
                {track.artist}
              </div>
            </div>
          ))}
          {(activity?.upNextCount ?? 0) > upNext.length && (
            <div className="h-10 flex items-center px-4 text-[12px] text-zinc-600">
              and{' '}
              {plural(
                (activity?.upNextCount ?? 0) - upNext.length,
                'more song'
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
