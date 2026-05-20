import type {
  AppSettingsView,
  AuthStatus,
  BinaryStatus,
  CommandResult,
  LikedArtistView,
  SettingsSaveResult,
  SongLogEntry,
  SyncRunDetail,
  SyncRunItemView,
  SyncRunSummary,
  SyncSnapshot,
  YtDlpCookiesBrowser,
} from '@shared/contracts'
import {
  type Dispatch,
  type JSX,
  type SetStateAction,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from 'react'

type Screen =
  | 'overview'
  | 'current-run'
  | 'history'
  | 'settings'
  | 'library-artists'

const EMPTY_SETTINGS: AppSettingsView = {
  outputDirectory: '',
  dryRun: false,
  remoteCopyEnabled: false,
  outputFormat: 'm4a',
  rcloneRemote: '',
  remoteMusicRoot: '',
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

const panelClass =
  'rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(13,17,22,0.92),rgba(10,14,18,0.96))] shadow-[0_24px_60px_rgba(0,0,0,0.32)]'
const buttonBaseClass =
  'inline-flex items-center justify-center rounded-[14px] border px-4 py-2.5 text-sm font-medium tracking-[0.01em] transition duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
const buttonClass = `${buttonBaseClass} border-white/8 bg-white/[0.04] text-slate-100 hover:border-white/16`
const buttonPrimaryClass = `${buttonBaseClass} border-cyan-300/30 bg-[linear-gradient(180deg,rgba(26,94,112,0.88),rgba(18,65,79,0.92))] text-white hover:border-cyan-200/45`
const buttonGhostClass = `${buttonBaseClass} border-white/8 bg-transparent text-slate-100 hover:border-white/16 hover:bg-white/[0.03]`
const inputClass =
  'w-full rounded-2xl border border-white/8 bg-[#0e1217] px-3.5 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-300/15'

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('overview')
  const [settings, setSettings] = useState<AppSettingsView>(EMPTY_SETTINGS)
  const [authStatus, setAuthStatus] = useState<AuthStatus>(EMPTY_AUTH)
  const [snapshot, setSnapshot] = useState<SyncSnapshot>({
    activeRun: null,
    runs: [],
  })
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [loadedRun, setLoadedRun] = useState<SyncRunDetail | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [runLogs, setRunLogs] = useState<SongLogEntry[]>([])
  const [selectedLogs, setSelectedLogs] = useState<SongLogEntry[]>([])
  const [message, setMessage] = useState('')
  const [binaryStatus, setBinaryStatus] = useState<BinaryStatus | null>(null)
  const [doctorMessage, setDoctorMessage] = useState('')
  const [captureInFlight, setCaptureInFlight] = useState(false)
  const [artists, setArtists] = useState<LikedArtistView[]>([])
  const [selectedArtistIds, setSelectedArtistIds] = useState<string[]>([])
  const [refreshArtistsInFlight, setRefreshArtistsInFlight] = useState(false)
  const [syncMissingRemoteInFlight, setSyncMissingRemoteInFlight] =
    useState(false)
  const [secretDrafts, setSecretDrafts] = useState({
    ytmusicBrowserAuth: '',
  })
  const selectedRunSummary =
    selectedRunId != null
      ? (snapshot.runs.find((run) => run.id === selectedRunId) ?? null)
      : null

  const selectedRun = useMemo(() => {
    if (snapshot.activeRun && snapshot.activeRun.id === selectedRunId) {
      return snapshot.activeRun
    }

    if (loadedRun && loadedRun.id === selectedRunId) {
      return loadedRun
    }

    if (!selectedRunId) {
      return snapshot.activeRun ?? loadedRun ?? null
    }

    return snapshot.runs.find((run) => run.id === selectedRunId)
      ? loadedRun?.id === selectedRunId
        ? loadedRun
        : snapshot.activeRun?.id === selectedRunId
          ? snapshot.activeRun
          : null
      : null
  }, [loadedRun, selectedRunId, snapshot])

  const visibleRun = selectedRun ?? snapshot.activeRun ?? null
  const selectedItem =
    visibleRun?.items.find((item) => item.id === selectedItemId) ??
    visibleRun?.items[0] ??
    null
  const headlineRun = snapshot.activeRun ?? snapshot.runs[0] ?? null
  const currentRunMeta = headlineRun
    ? `${formatProgress(headlineRun)} · ${headlineRun.status}`
    : 'Idle'
  const headlineCounts = headlineRun
    ? {
        completed: headlineRun.completedCount,
        failed: headlineRun.failedCount,
        skipped: headlineRun.skippedCount,
        total: headlineRun.totalCount,
      }
    : { completed: 0, failed: 0, skipped: 0, total: 0 }

  const refreshAll = useEffectEvent(async () => {
    const [nextSettings, nextAuth, nextSnapshot, nextArtists] =
      await Promise.all([
        window.api.settings.get(),
        window.api.auth.getStatus(),
        window.api.sync.getSnapshot(),
        window.api.library.listArtists(),
      ])

    setSettings(nextSettings)
    setAuthStatus(nextAuth)
    setSnapshot(nextSnapshot)
    setArtists(nextArtists)
    setSelectedArtistIds((current) =>
      current.filter((id) => nextArtists.some((artist) => artist.id === id))
    )

    const nextSelectedRunId =
      selectedRunId ??
      nextSnapshot.activeRun?.id ??
      nextSnapshot.runs[0]?.id ??
      null
    if (!selectedRunId) {
      setSelectedRunId(nextSelectedRunId)
    }
    if (
      nextSnapshot.activeRun &&
      nextSnapshot.activeRun.id === nextSelectedRunId
    ) {
      setLoadedRun(nextSnapshot.activeRun)
    }
  })

  useEffect(() => {
    void refreshAll()

    return window.api.sync.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot)
      const nextSelectedRunId =
        selectedRunId ??
        nextSnapshot.activeRun?.id ??
        nextSnapshot.runs[0]?.id ??
        null
      if (!selectedRunId) {
        setSelectedRunId(nextSelectedRunId)
      }
      if (
        nextSnapshot.activeRun &&
        nextSnapshot.activeRun.id === nextSelectedRunId
      ) {
        setLoadedRun(nextSnapshot.activeRun)
      }
    })
  }, [selectedRunId])

  useEffect(() => {
    if (!selectedRunId || snapshot.activeRun?.id === selectedRunId) {
      return
    }
    if (!selectedRunSummary) {
      return
    }
    if (
      loadedRun?.id === selectedRunId &&
      loadedRun.status === selectedRunSummary.status &&
      loadedRun.endedAt === selectedRunSummary.endedAt &&
      loadedRun.processedCount === selectedRunSummary.processedCount &&
      loadedRun.totalCount === selectedRunSummary.totalCount &&
      loadedRun.completedCount === selectedRunSummary.completedCount &&
      loadedRun.failedCount === selectedRunSummary.failedCount &&
      loadedRun.skippedCount === selectedRunSummary.skippedCount
    ) {
      return
    }

    let cancelled = false
    void window.api.sync.getRun(selectedRunId).then((run) => {
      if (!cancelled && run) {
        setLoadedRun(run)
      }
    })

    return () => {
      cancelled = true
    }
  }, [loadedRun, selectedRunId, selectedRunSummary, snapshot.activeRun])

  const refreshSettingsAndSnapshot = useEffectEvent(async () => {
    const [nextSettings, nextSnapshot] = await Promise.all([
      window.api.settings.get(),
      window.api.sync.getSnapshot(),
    ])

    setSettings(nextSettings)
    setSnapshot(nextSnapshot)

    if (!selectedRunId) {
      setSelectedRunId(
        nextSnapshot.activeRun?.id ?? nextSnapshot.runs[0]?.id ?? null
      )
    }
  })

  useEffect(() => {
    const run = visibleRun
    if (!run) {
      setRunLogs([])
      return
    }

    void window.api.sync.getRunLogs(run.id).then(setRunLogs)
  }, [visibleRun])

  useEffect(() => {
    const run = visibleRun
    const item = selectedItem
    if (!run || !item) {
      setSelectedLogs([])
      return
    }

    void window.api.sync
      .getSongLogs({
        runId: run.id,
        youtubeMusicTrackId: item.youtubeMusicTrackId,
      })
      .then(setSelectedLogs)
  }, [selectedItem, visibleRun])

  useEffect(() => {
    if (!visibleRun?.items.length) {
      setSelectedItemId(null)
      return
    }

    if (
      !selectedItemId ||
      !visibleRun.items.some((item) => item.id === selectedItemId)
    ) {
      setSelectedItemId(visibleRun.items[0]?.id ?? null)
    }
  }, [selectedItemId, visibleRun])

  async function runAction(action: Promise<CommandResult>) {
    const result = await action
    setMessage(
      result.details ? `${result.message} ${result.details}` : result.message
    )
    await refreshAll()
  }

  async function saveCurrentSettings(options?: {
    refresh?: boolean
    clearSecretDrafts?: boolean
  }) {
    const result: SettingsSaveResult = await window.api.settings.save({
      outputDirectory: settings.outputDirectory,
      dryRun: settings.dryRun,
      remoteCopyEnabled: settings.remoteCopyEnabled,
      ytmusicBrowserAuth: secretDrafts.ytmusicBrowserAuth.trim() || undefined,
      ytDlpCookiesBrowser: settings.ytDlpCookiesBrowser,
      rcloneRemote: settings.rcloneRemote,
      remoteMusicRoot: settings.remoteMusicRoot,
      folderTemplate: settings.folderTemplate,
      fileTemplate: settings.fileTemplate,
      embedUnsyncedLyrics: settings.embedUnsyncedLyrics,
      writeLrcSidecar: settings.writeLrcSidecar,
    })

    if (result.authStatus) {
      setAuthStatus(result.authStatus)
    }

    if (options?.refresh ?? true) {
      await refreshSettingsAndSnapshot()
    }

    if (options?.clearSecretDrafts ?? true) {
      setSecretDrafts({
        ytmusicBrowserAuth: '',
      })
    }

    return result
  }

  async function handleSaveSettings() {
    const result = await saveCurrentSettings()
    setMessage(
      result.details ? `${result.message} ${result.details}` : result.message
    )
  }

  async function chooseOutputDirectory() {
    const nextValue = await window.api.settings.pickOutputDirectory()
    if (nextValue) {
      setSettings((current) => ({ ...current, outputDirectory: nextValue }))
    }
  }

  async function selectRun(runId: string) {
    setSelectedRunId(runId)
    if (snapshot.activeRun?.id === runId) {
      setLoadedRun(snapshot.activeRun)
      return
    }

    const run = await window.api.sync.getRun(runId)
    if (run) {
      setLoadedRun(run)
    }
  }

  async function handleBinaryTest() {
    const result = await window.api.settings.testBinaries()
    setBinaryStatus(result)
  }

  async function handleDoctor() {
    const result = await window.api.sync.doctor()
    setDoctorMessage(
      result.details ? `${result.message} ${result.details}` : result.message
    )
  }

  async function handleClearSyncData() {
    const confirmed = window.confirm(
      'Clear sync history and processed-song memory? Settings and auth stay saved.'
    )
    if (!confirmed) return

    setLoadedRun(null)
    setSelectedRunId(null)
    setSelectedItemId(null)
    setRunLogs([])
    setSelectedLogs([])
    await runAction(window.api.sync.clearSyncData())
  }

  async function handleCaptureBrowserAuth() {
    setCaptureInFlight(true)
    try {
      await saveCurrentSettings({
        refresh: false,
        clearSecretDrafts: false,
      })

      const result = await window.api.auth.captureBrowserAuth(
        settings.ytDlpCookiesBrowser
      )
      setAuthStatus(result.authStatus)
      setMessage(
        result.details ? `${result.message} ${result.details}` : result.message
      )

      if (result.ok) {
        setSecretDrafts((current) => ({
          ...current,
          ytmusicBrowserAuth: '',
        }))
      }

      await refreshSettingsAndSnapshot()
    } finally {
      setCaptureInFlight(false)
    }
  }

  async function handleRefreshArtists() {
    setRefreshArtistsInFlight(true)
    try {
      const result = await window.api.library.refreshArtists()
      setMessage(
        result.details ? `${result.message} ${result.details}` : result.message
      )
      const nextArtists = await window.api.library.listArtists()
      setArtists(nextArtists)
      setSelectedArtistIds((current) =>
        current.filter((id) => nextArtists.some((artist) => artist.id === id))
      )
    } finally {
      setRefreshArtistsInFlight(false)
    }
  }

  async function handleReprocessArtists() {
    if (selectedArtistIds.length === 0) return
    const result = await window.api.sync.reprocessArtists(selectedArtistIds)
    setMessage(
      result.details ? `${result.message} ${result.details}` : result.message
    )
    await refreshAll()
    if (result.ok) {
      setScreen('current-run')
    }
  }

  async function handleSyncMissingToRemote() {
    setSyncMissingRemoteInFlight(true)
    try {
      await runAction(window.api.sync.syncMissingToRemote())
    } finally {
      setSyncMissingRemoteInFlight(false)
    }
  }

  const authActionLabel = authStatus.isAuthenticated
    ? 'Disconnect account'
    : 'Pull from browser'

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#07090d] font-['IBM_Plex_Sans'] text-slate-100 antialiased">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-0 top-0 h-[26rem] w-[26rem] rounded-full bg-cyan-400/12 blur-3xl" />
        <div className="absolute bottom-[-8rem] right-[-4rem] h-[24rem] w-[24rem] rounded-full bg-sky-500/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(43,175,196,0.12),transparent_22%),radial-gradient(circle_at_bottom_right,rgba(71,85,105,0.18),transparent_28%)]" />
      </div>

      <div className="relative grid min-h-screen grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-white/8 bg-[linear-gradient(180deg,rgba(10,13,18,0.96),rgba(8,10,14,0.88))] p-6 xl:border-b-0 xl:border-r">
          <div className="grid h-full gap-6 xl:grid-rows-[auto_auto_1fr]">
            <div className="grid gap-2">
              <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
                liked music syncer
              </p>
              <h1 className="font-['Syne'] text-[2.1rem] tracking-[-0.04em] text-slate-50">
                Graphite Archive
              </h1>
              <p className="max-w-[18rem] text-sm leading-6 text-slate-400">
                Exact YT Music resolution, richer tags, desktop-grade run
                control.
              </p>
            </div>

            <nav className="grid gap-3">
              <RailButton
                active={screen === 'overview'}
                label="Overview"
                meta={authStatus.isAuthenticated ? 'Connected' : 'Setup'}
                onClick={() => setScreen('overview')}
              />
              <RailButton
                active={screen === 'current-run'}
                label="Current Run"
                meta={currentRunMeta}
                onClick={() => setScreen('current-run')}
              />
              <RailButton
                active={screen === 'history'}
                label="History"
                meta={`${snapshot.runs.length} runs`}
                onClick={() => setScreen('history')}
              />
              <RailButton
                active={screen === 'settings'}
                label="Settings"
                meta={settings.outputDirectory ? 'Configured' : 'Needs output'}
                onClick={() => setScreen('settings')}
              />
              <div className="px-2 pt-3 text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
                Library
              </div>
              <RailButton
                active={screen === 'library-artists'}
                label="Artists"
                meta={`${artists.length} cached`}
                onClick={() => setScreen('library-artists')}
              />
            </nav>

            <div className="grid content-end gap-3">
              <StatusChip
                tone={authStatus.isAuthenticated ? 'success' : 'warning'}
                label={
                  authStatus.isAuthenticated
                    ? 'YT Music connected'
                    : 'Account disconnected'
                }
              />
              {snapshot.activeRun ? (
                <button
                  className={buttonGhostClass}
                  type="button"
                  onClick={() =>
                    runAction(window.api.sync.cancel(snapshot.activeRun!.id))
                  }
                >
                  Stop active run
                </button>
              ) : (
                <div className="grid gap-2">
                  <button
                    className={buttonPrimaryClass}
                    type="button"
                    onClick={() => runAction(window.api.sync.start())}
                  >
                    Start sync
                  </button>
                  <button
                    className={buttonClass}
                    type="button"
                    disabled={syncMissingRemoteInFlight}
                    onClick={() => void handleSyncMissingToRemote()}
                    title="Copies only missing local tracks to remote. No delete/retag."
                  >
                    {syncMissingRemoteInFlight
                      ? 'Syncing missing to remote...'
                      : 'Sync Missing to Remote'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>

        <main className="grid auto-rows-min gap-4 p-4 sm:p-6">
          <header
            className={cn(
              panelClass,
              'flex flex-col gap-5 p-6 lg:flex-row lg:items-start lg:justify-between'
            )}
          >
            <div className="grid gap-2">
              <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
                Desktop sync utility
              </p>
              <h2 className="font-['Syne'] text-[2.3rem] tracking-[-0.04em] text-slate-50">
                {screenTitle(screen)}
              </h2>
              <p className="max-w-3xl text-sm leading-6 text-slate-400">
                {screenCopy(screen, authStatus, headlineRun)}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {!authStatus.isAuthenticated ? (
                <button
                  className={buttonPrimaryClass}
                  type="button"
                  disabled={captureInFlight}
                  onClick={() => void handleCaptureBrowserAuth()}
                >
                  {authActionLabel}
                </button>
              ) : (
                <button
                  className={buttonGhostClass}
                  type="button"
                  onClick={() => runAction(window.api.auth.disconnect())}
                >
                  Disconnect account
                </button>
              )}

              <button
                className={buttonClass}
                type="button"
                onClick={() => setScreen('settings')}
              >
                Settings
              </button>
            </div>
          </header>

          <section className="grid grid-cols-2 gap-3 xl:grid-cols-6">
            <StatTile
              label="Connection"
              value={authStatus.isAuthenticated ? 'Ready' : 'Pending'}
            />
            <StatTile
              label="Last / Active"
              value={headlineRun?.status ?? 'idle'}
            />
            <StatTile
              label="Completed"
              value={String(headlineCounts.completed)}
            />
            <StatTile label="Failed" value={String(headlineCounts.failed)} />
            <StatTile label="Skipped" value={String(headlineCounts.skipped)} />
            <StatTile label="Total Seen" value={String(headlineCounts.total)} />
          </section>

          {message ? (
            <div className={cn(panelClass, 'rounded-[18px] px-4 py-3 text-sm')}>
              {message}
            </div>
          ) : null}

          {screen === 'overview' ? (
            <OverviewScreen
              authStatus={authStatus}
              headlineRun={headlineRun}
              onOpenRun={() => {
                setScreen('current-run')
                if (snapshot.activeRun?.id) {
                  void selectRun(snapshot.activeRun.id)
                }
              }}
              onStartSync={() => runAction(window.api.sync.start())}
              onSyncMissingToRemote={() => void handleSyncMissingToRemote()}
              syncMissingRemoteInFlight={syncMissingRemoteInFlight}
              runActive={Boolean(snapshot.activeRun)}
              onOpenSettings={() => setScreen('settings')}
            />
          ) : null}

          {screen === 'current-run' ? (
            <CurrentRunScreen
              activeRun={snapshot.activeRun}
              visibleRun={visibleRun}
              runLogs={runLogs}
              selectedItem={selectedItem}
              selectedLogs={selectedLogs}
              onPickItem={setSelectedItemId}
            />
          ) : null}

          {screen === 'history' ? (
            <HistoryScreen
              runs={snapshot.runs}
              selectedRunId={selectedRunId}
              visibleRun={visibleRun}
              runLogs={runLogs}
              onSelectRun={(runId) => void selectRun(runId)}
            />
          ) : null}

          {screen === 'settings' ? (
            <SettingsScreen
              settings={settings}
              authStatus={authStatus}
              secretDrafts={secretDrafts}
              binaryStatus={binaryStatus}
              doctorMessage={doctorMessage}
              onSettingsChange={setSettings}
              onSecretDraftsChange={setSecretDrafts}
              onChooseOutputDirectory={() => void chooseOutputDirectory()}
              onSave={() => void handleSaveSettings()}
              onCaptureBrowserAuth={() => void handleCaptureBrowserAuth()}
              onDisconnect={() => void runAction(window.api.auth.disconnect())}
              onBinaryTest={() => void handleBinaryTest()}
              onRemoteTest={() =>
                void runAction(window.api.settings.testRemote())
              }
              onDoctor={() => void handleDoctor()}
              onClearSyncData={() => void handleClearSyncData()}
              captureInFlight={captureInFlight}
            />
          ) : null}
          {screen === 'library-artists' ? (
            <LibraryArtistsScreen
              artists={artists}
              selectedArtistIds={selectedArtistIds}
              onToggleArtist={(artistId) =>
                setSelectedArtistIds((current) =>
                  current.includes(artistId)
                    ? current.filter((id) => id !== artistId)
                    : [...current, artistId]
                )
              }
              onRefreshArtists={() => void handleRefreshArtists()}
              onReprocessArtists={() => void handleReprocessArtists()}
              refreshInFlight={refreshArtistsInFlight}
              authReady={authStatus.isAuthenticated}
              runActive={Boolean(snapshot.activeRun)}
            />
          ) : null}
        </main>
      </div>
    </div>
  )
}

function LibraryArtistsScreen({
  artists,
  selectedArtistIds,
  onToggleArtist,
  onRefreshArtists,
  onReprocessArtists,
  refreshInFlight,
  authReady,
  runActive,
}: {
  artists: LikedArtistView[]
  selectedArtistIds: string[]
  onToggleArtist: (artistId: string) => void
  onRefreshArtists: () => void
  onReprocessArtists: () => void
  refreshInFlight: boolean
  authReady: boolean
  runActive: boolean
}) {
  const selectedArtists = artists.filter((artist) =>
    selectedArtistIds.includes(artist.id)
  )
  const totalLiked = selectedArtists.reduce(
    (sum, artist) => sum + artist.likedTrackCount,
    0
  )
  const sortedArtists = [...artists].sort(
    (a, b) =>
      b.likedTrackCount - a.likedTrackCount || a.name.localeCompare(b.name)
  )
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
            Liked artists
          </h3>
          <button
            className={buttonClass}
            type="button"
            disabled={refreshInFlight}
            onClick={onRefreshArtists}
          >
            {refreshInFlight ? 'Refreshing...' : 'Refresh liked artists'}
          </button>
        </div>
        <div className="grid max-h-[620px] gap-2 overflow-auto pr-1">
          {sortedArtists.map((artist) => (
            <button
              key={artist.id}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition duration-200',
                selectedArtistIds.includes(artist.id)
                  ? 'border-cyan-300/35 bg-[#10171d]'
                  : 'border-white/6 bg-white/[0.03] hover:border-white/14'
              )}
              type="button"
              onClick={() => onToggleArtist(artist.id)}
            >
              <span className="min-w-0">
                <strong className="block truncate text-sm text-slate-50">
                  {artist.name}
                </strong>
                <small className="mt-1 block text-xs text-slate-400">
                  {artist.likedTrackCount} liked
                </small>
              </span>
              {artist.photoUrl ? (
                <img
                  src={artist.photoUrl}
                  alt={artist.name}
                  className="h-11 w-11 rounded-full object-cover"
                />
              ) : (
                <div className="grid h-11 w-11 place-content-center rounded-full border border-white/10 bg-white/[0.03] text-xs text-slate-300">
                  {artist.name.slice(0, 2).toUpperCase()}
                </div>
              )}
            </button>
          ))}
        </div>
      </article>

      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
            Selection
          </h3>
          <button
            className={buttonPrimaryClass}
            type="button"
            disabled={selectedArtistIds.length === 0 || !authReady || runActive}
            onClick={onReprocessArtists}
          >
            Reprocess Artist Songs
          </button>
        </div>
        <MetaRow
          label="Selected artists"
          value={String(selectedArtists.length)}
        />
        <MetaRow label="Combined liked tracks" value={String(totalLiked)} />
        <div className="grid gap-2">
          {selectedArtists.length === 0 ? (
            <p className="text-sm leading-6 text-slate-400">
              Select one or more artists from the list.
            </p>
          ) : (
            selectedArtists.map((artist) => (
              <div
                key={artist.id}
                className="rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2 text-sm text-slate-200"
              >
                {artist.name}
              </div>
            ))
          )}
        </div>
      </article>
    </section>
  )
}

function OverviewScreen({
  authStatus,
  headlineRun,
  onOpenRun,
  onStartSync,
  onSyncMissingToRemote,
  syncMissingRemoteInFlight,
  runActive,
  onOpenSettings,
}: {
  authStatus: AuthStatus
  headlineRun: SyncRunSummary | null
  onOpenRun: () => void
  onStartSync: () => void
  onSyncMissingToRemote: () => void
  syncMissingRemoteInFlight: boolean
  runActive: boolean
  onOpenSettings: () => void
}) {
  return (
    <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
      <article
        className={cn(
          panelClass,
          'grid gap-5 bg-[linear-gradient(180deg,rgba(16,21,27,0.96),rgba(11,15,21,0.98))] p-6'
        )}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
              Connection
            </p>
            <h3 className="mt-2 font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
              {authStatus.isAuthenticated
                ? 'YT Music ready'
                : 'Pull auth from browser'}
            </h3>
          </div>
          <StatusChip
            tone={authStatus.isAuthenticated ? 'success' : 'warning'}
            label={authStatus.isAuthenticated ? 'connected' : 'setup'}
          />
        </div>
        <p className="max-w-2xl text-sm leading-6 text-slate-400">
          {authStatus.isAuthenticated
            ? 'Worker can fetch liked songs and start exact catalog resolution.'
            : 'Use the selected browser as the default source for YT Music auth. Manual headers stay available in settings as an override.'}
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            className={buttonPrimaryClass}
            type="button"
            onClick={onStartSync}
          >
            Start sync
          </button>
          <button
            className={buttonClass}
            type="button"
            onClick={onOpenSettings}
          >
            Open settings
          </button>
          <button
            className={buttonClass}
            type="button"
            disabled={runActive || syncMissingRemoteInFlight}
            onClick={onSyncMissingToRemote}
            title="Copies only missing local tracks to remote. No delete/retag."
          >
            {syncMissingRemoteInFlight
              ? 'Syncing missing to remote...'
              : 'Sync Missing to Remote'}
          </button>
        </div>
      </article>

      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
              Latest run
            </p>
            <h3 className="mt-2 font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
              {headlineRun ? headlineRun.status : 'No history yet'}
            </h3>
          </div>
          {headlineRun ? (
            <StatusChip
              tone={toneForRun(headlineRun.status)}
              label={headlineRun.status}
            />
          ) : null}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <MetaRow
            label="Started"
            value={headlineRun ? formatDateTime(headlineRun.startedAt) : '—'}
          />
          <MetaRow
            label="Progress"
            value={headlineRun ? formatProgress(headlineRun) : '0 / 0'}
          />
          <MetaRow
            label="Completed"
            value={headlineRun ? String(headlineRun.completedCount) : '0'}
          />
          <MetaRow
            label="Failed"
            value={headlineRun ? String(headlineRun.failedCount) : '0'}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <button className={buttonClass} type="button" onClick={onOpenRun}>
            Inspect run
          </button>
        </div>
      </article>
    </section>
  )
}

function CurrentRunScreen({
  activeRun,
  visibleRun,
  runLogs,
  selectedItem,
  selectedLogs,
  onPickItem,
}: {
  activeRun: SyncRunDetail | null
  visibleRun: SyncRunDetail | null
  runLogs: SongLogEntry[]
  selectedItem: SyncRunItemView | null
  selectedLogs: SongLogEntry[]
  onPickItem: (itemId: string) => void
}) {
  if (!visibleRun) {
    return (
      <section
        className={cn(
          panelClass,
          'grid min-h-[260px] content-center gap-3 p-6'
        )}
      >
        <h3 className="font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
          No run loaded
        </h3>
        <p className="text-sm leading-6 text-slate-400">
          Start a sync or pick a prior run from history.
        </p>
      </section>
    )
  }

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_400px]">
      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
              Current run
            </p>
            <h3 className="mt-2 font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
              {formatProgress(visibleRun)}
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusChip
              tone={toneForRun(visibleRun.status)}
              label={visibleRun.status}
            />
            {activeRun?.id === visibleRun.id ? (
              <StatusChip tone="accent" label="live" pulse />
            ) : null}
          </div>
        </div>

        <div className="grid gap-2">
          <div className="sticky top-0 z-10 grid grid-cols-1 gap-3 rounded-2xl border border-white/6 bg-[#090c10]/95 px-4 py-3 text-[0.68rem] uppercase tracking-[0.16em] text-slate-500 md:grid-cols-[2.3fr_1fr_1fr_1fr]">
            <span>Track</span>
            <span>Status</span>
            <span>Stage</span>
            <span>Resolution</span>
          </div>

          <div className="grid max-h-[620px] gap-2 overflow-auto pr-1">
            {visibleRun.items.map((item) => (
              <button
                key={item.id}
                className={cn(
                  'grid cursor-pointer grid-cols-1 gap-3 rounded-2xl border px-4 py-4 text-left transition duration-200 hover:-translate-y-0.5 md:grid-cols-[2.3fr_1fr_1fr_1fr]',
                  selectedItem?.id === item.id
                    ? 'border-cyan-300/35 bg-[#10171d] shadow-[0_0_0_1px_rgba(103,232,249,0.12)]'
                    : 'border-white/6 bg-white/[0.03] hover:border-white/14'
                )}
                type="button"
                onClick={() => onPickItem(item.id)}
              >
                <span className="min-w-0">
                  <strong className="block truncate text-sm text-slate-50">
                    {item.title}
                  </strong>
                  <small className="mt-1 block truncate text-xs text-slate-400">
                    {item.artist}
                  </small>
                </span>
                <span>
                  <StatusChip
                    tone={toneForItem(item.status)}
                    label={item.status}
                    compact
                  />
                </span>
                <span className="font-['IBM_Plex_Mono'] text-xs text-slate-300">
                  {item.stage}
                </span>
                <span className="text-sm text-slate-300">
                  {item.resolutionMethod}
                </span>
              </button>
            ))}
          </div>
        </div>
      </article>

      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        {selectedItem ? (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
                  Selected item
                </p>
                <h3 className="mt-2 font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
                  {selectedItem.title}
                </h3>
              </div>
              <StatusChip
                tone={toneForItem(selectedItem.status)}
                label={selectedItem.status}
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <MetaRow label="Artist" value={selectedItem.artist} />
              <MetaRow label="Album" value={selectedItem.album} />
              <MetaRow label="Album artist" value={selectedItem.albumArtist} />
              <MetaRow label="Track" value={formatTrack(selectedItem)} />
              <MetaRow label="Source kind" value={selectedItem.sourceKind} />
              <MetaRow
                label="Video type"
                value={selectedItem.videoType ?? '—'}
              />
              <MetaRow
                label="Resolution"
                value={selectedItem.resolutionMethod}
              />
              <MetaRow
                label="Lyrics"
                value={selectedItem.lyricsSource ?? 'none'}
              />
              <MetaRow label="Codec" value={selectedItem.audioCodec ?? '—'} />
              <MetaRow
                label="Output"
                value={selectedItem.outputPath ?? '—'}
                mono
              />
            </div>

            <div className="grid gap-3">
              <div>
                <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
                  Item log
                </p>
              </div>
              <LogStream
                entries={selectedLogs}
                emptyMessage="No item-level logs yet."
              />
            </div>
          </>
        ) : (
          <div className="grid gap-5">
            <div className="grid min-h-[160px] content-center gap-3">
              <h3 className="font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
                No item selected
              </h3>
              <p className="text-sm leading-6 text-slate-400">
                Pick a run item to inspect metadata and logs.
              </p>
            </div>
            <MetaRow
              label="Log directory"
              value={visibleRun.logDirectory}
              mono
            />
          </div>
        )}

        <div className="grid gap-3">
          <div>
            <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
              Run log
            </p>
          </div>
          <LogStream
            entries={runLogs}
            emptyMessage="No run-level logs yet."
            maxHeightClass="max-h-[340px]"
          />
        </div>
      </article>
    </section>
  )
}

function HistoryScreen({
  runs,
  selectedRunId,
  visibleRun,
  runLogs,
  onSelectRun,
}: {
  runs: SyncRunSummary[]
  selectedRunId: string | null
  visibleRun: SyncRunDetail | null
  runLogs: SongLogEntry[]
  onSelectRun: (runId: string) => void
}) {
  return (
    <section className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        <div>
          <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
            Run history
          </p>
          <h3 className="mt-2 font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
            {runs.length} recorded runs
          </h3>
        </div>
        <div className="grid gap-2">
          {runs.map((run) => (
            <button
              key={run.id}
              className={cn(
                'grid cursor-pointer grid-cols-1 gap-3 rounded-2xl border px-4 py-4 text-left transition duration-200 hover:-translate-y-0.5 md:grid-cols-[minmax(0,1fr)_auto_auto]',
                selectedRunId === run.id
                  ? 'border-cyan-300/35 bg-[#10171d] shadow-[0_0_0_1px_rgba(103,232,249,0.12)]'
                  : 'border-white/6 bg-white/[0.03] hover:border-white/14'
              )}
              type="button"
              onClick={() => onSelectRun(run.id)}
            >
              <span className="min-w-0">
                <strong className="block truncate text-sm text-slate-50">
                  {formatDateTime(run.startedAt)}
                </strong>
                <small className="mt-1 block truncate text-xs text-slate-400">
                  {run.id}
                </small>
              </span>
              <span className="text-sm text-slate-300">
                {formatProgress(run)}
              </span>
              <StatusChip
                tone={toneForRun(run.status)}
                label={run.status}
                compact
              />
            </button>
          ))}
        </div>
      </article>

      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        {visibleRun ? (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
                  Run detail
                </p>
                <h3 className="mt-2 break-all font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
                  {visibleRun.id}
                </h3>
              </div>
              <StatusChip
                tone={toneForRun(visibleRun.status)}
                label={visibleRun.status}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <MetaRow
                label="Started"
                value={formatDateTime(visibleRun.startedAt)}
              />
              <MetaRow
                label="Ended"
                value={
                  visibleRun.endedAt ? formatDateTime(visibleRun.endedAt) : '—'
                }
              />
              <MetaRow label="Processed" value={formatProgress(visibleRun)} />
              <MetaRow
                label="Completed"
                value={String(visibleRun.completedCount)}
              />
              <MetaRow label="Failed" value={String(visibleRun.failedCount)} />
              <MetaRow
                label="Skipped"
                value={String(visibleRun.skippedCount)}
              />
              <MetaRow
                label="Log directory"
                value={visibleRun.logDirectory}
                mono
              />
            </div>
            <div className="grid gap-3">
              <div>
                <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
                  Run log
                </p>
              </div>
              <LogStream
                entries={runLogs}
                emptyMessage="No run-level logs yet."
                maxHeightClass="max-h-[340px]"
              />
            </div>
          </>
        ) : (
          <div className="grid min-h-[260px] content-center gap-3">
            <h3 className="font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
              No run selected
            </h3>
            <p className="text-sm leading-6 text-slate-400">
              Pick a run to inspect its summary.
            </p>
          </div>
        )}
      </article>
    </section>
  )
}

function SettingsScreen({
  settings,
  authStatus,
  secretDrafts,
  binaryStatus,
  doctorMessage,
  captureInFlight,
  onSettingsChange,
  onSecretDraftsChange,
  onChooseOutputDirectory,
  onSave,
  onCaptureBrowserAuth,
  onDisconnect,
  onBinaryTest,
  onRemoteTest,
  onDoctor,
  onClearSyncData,
}: {
  settings: AppSettingsView
  authStatus: AuthStatus
  secretDrafts: {
    ytmusicBrowserAuth: string
  }
  binaryStatus: BinaryStatus | null
  doctorMessage: string
  captureInFlight: boolean
  onSettingsChange: Dispatch<SetStateAction<AppSettingsView>>
  onSecretDraftsChange: Dispatch<
    SetStateAction<{
      ytmusicBrowserAuth: string
    }>
  >
  onChooseOutputDirectory: () => void
  onSave: () => void
  onCaptureBrowserAuth: () => void
  onDisconnect: () => void
  onBinaryTest: () => void
  onRemoteTest: () => void
  onDoctor: () => void
  onClearSyncData: () => void
}) {
  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
              Auth
            </p>
            <h3 className="mt-2 font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
              YT Music access
            </h3>
          </div>
          <StatusChip
            tone={authStatus.isAuthenticated ? 'success' : 'warning'}
            label={authStatus.isAuthenticated ? 'connected' : 'disconnected'}
          />
        </div>

        <div className="grid gap-4">
          <div className="grid gap-3 rounded-[22px] border border-cyan-300/12 bg-[linear-gradient(180deg,rgba(26,42,49,0.52),rgba(11,17,22,0.22))] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-1">
                <span className="text-[0.78rem] uppercase tracking-[0.12em] text-cyan-200/70">
                  Default flow
                </span>
                <p className="text-sm leading-6 text-slate-300">
                  Pull auth from the browser below. This is the main path now.
                </p>
              </div>
              <StatusChip
                tone={settings.hasYtMusicBrowserAuth ? 'accent' : 'neutral'}
                label={
                  settings.hasYtMusicBrowserAuth ? 'saved auth' : 'no auth'
                }
                compact
              />
            </div>
          </div>

          <SelectField
            label="Browser source"
            value={settings.ytDlpCookiesBrowser}
            options={[
              'firefox',
              'chrome',
              'brave',
              'chromium',
              'edge',
              'opera',
              'safari',
              'vivaldi',
              'whale',
            ]}
            onChange={(value) =>
              onSettingsChange((current) => ({
                ...current,
                ytDlpCookiesBrowser: value,
              }))
            }
            hint="Used for both YT Music auth pull and yt-dlp cookie extraction."
          />

          <details className="group rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-3">
                <div className="grid gap-1">
                  <span className="text-[0.78rem] uppercase tracking-[0.12em] text-slate-500">
                    Manual override
                  </span>
                  <p className="text-sm leading-6 text-slate-300">
                    Paste browser-auth JSON or copied `/browse` headers only if
                    browser pull fails.
                  </p>
                </div>
                <span className="text-xs uppercase tracking-[0.14em] text-slate-500 transition group-open:rotate-45">
                  +
                </span>
              </div>
            </summary>
            <div className="mt-4 border-t border-white/6 pt-4">
              <TextAreaField
                label={`Browser auth override ${settings.hasYtMusicBrowserAuth ? '(stored auth exists)' : ''}`}
                value={secretDrafts.ytmusicBrowserAuth}
                onChange={(value) =>
                  onSecretDraftsChange(() => ({
                    ytmusicBrowserAuth: value,
                  }))
                }
                hint="Save or pull again to replace the stored auth."
                mono
              />
            </div>
          </details>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            className={buttonPrimaryClass}
            type="button"
            onClick={onCaptureBrowserAuth}
            disabled={captureInFlight}
          >
            {captureInFlight ? 'Pulling from browser...' : 'Pull from browser'}
          </button>
          <button
            className={buttonGhostClass}
            type="button"
            onClick={onDisconnect}
          >
            Clear saved auth
          </button>
        </div>
      </article>

      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        <div>
          <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
            Output
          </p>
          <h3 className="mt-2 font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
            Paths and templates
          </h3>
        </div>

        <div className="grid gap-4">
          <Field
            label="Output directory"
            value={settings.outputDirectory}
            onChange={(value) =>
              onSettingsChange((current) => ({
                ...current,
                outputDirectory: value,
              }))
            }
            mono
            actionLabel="Choose"
            onAction={onChooseOutputDirectory}
          />
          <Field
            label="Folder template"
            value={settings.folderTemplate}
            onChange={(value) =>
              onSettingsChange((current) => ({
                ...current,
                folderTemplate: value,
              }))
            }
            mono
          />
          <Field
            label="File template"
            value={settings.fileTemplate}
            onChange={(value) =>
              onSettingsChange((current) => ({
                ...current,
                fileTemplate: value,
              }))
            }
            mono
          />
        </div>

        <div className="grid gap-3">
          <ToggleField
            label="Dry run / metadata-only"
            checked={settings.dryRun}
            onChange={(checked) =>
              onSettingsChange((current) => ({ ...current, dryRun: checked }))
            }
          />
          <ToggleField
            label="Write `.lrc` sidecar"
            checked={settings.writeLrcSidecar}
            onChange={(checked) =>
              onSettingsChange((current) => ({
                ...current,
                writeLrcSidecar: checked,
              }))
            }
          />
          <ToggleField
            label="Embed unsynced lyrics"
            checked={settings.embedUnsyncedLyrics}
            onChange={(checked) =>
              onSettingsChange((current) => ({
                ...current,
                embedUnsyncedLyrics: checked,
              }))
            }
          />
        </div>
      </article>

      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        <div>
          <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
            Remote copy
          </p>
          <h3 className="mt-2 font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
            Post-write transfer
          </h3>
        </div>

        <div className="grid gap-4">
          <Field
            label="rclone remote"
            value={settings.rcloneRemote}
            onChange={(value) =>
              onSettingsChange((current) => ({
                ...current,
                rcloneRemote: value,
              }))
            }
            mono
          />
          <Field
            label="Remote music root"
            value={settings.remoteMusicRoot}
            onChange={(value) =>
              onSettingsChange((current) => ({
                ...current,
                remoteMusicRoot: value,
              }))
            }
            mono
          />
        </div>

        <ToggleField
          label="Enable remote copy"
          checked={settings.remoteCopyEnabled}
          onChange={(checked) =>
            onSettingsChange((current) => ({
              ...current,
              remoteCopyEnabled: checked,
            }))
          }
        />

        <div className="flex flex-wrap gap-3">
          <button className={buttonClass} type="button" onClick={onRemoteTest}>
            Check remote config
          </button>
        </div>
      </article>

      <article className={cn(panelClass, 'grid gap-5 p-6')}>
        <div>
          <p className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
            Tools
          </p>
          <h3 className="mt-2 font-['Syne'] text-2xl tracking-[-0.04em] text-slate-50">
            Doctor and binaries
          </h3>
        </div>

        <div className="flex flex-wrap gap-3">
          <button className={buttonClass} type="button" onClick={onBinaryTest}>
            Check binaries
          </button>
          <button className={buttonClass} type="button" onClick={onDoctor}>
            Run doctor
          </button>
          <button className={buttonPrimaryClass} type="button" onClick={onSave}>
            Save settings
          </button>
        </div>

        {binaryStatus ? (
          <div className="grid gap-3 md:grid-cols-2">
            <MetaRow label="uv" value={binaryStatus.uv ?? 'missing'} mono />
            <MetaRow
              label="ffmpeg"
              value={binaryStatus.ffmpeg ?? 'missing'}
              mono
            />
            <MetaRow
              label="rclone"
              value={binaryStatus.rclone ?? 'missing'}
              mono
            />
          </div>
        ) : null}

        {doctorMessage ? (
          <p className="text-sm leading-6 text-slate-400">{doctorMessage}</p>
        ) : null}
        {authStatus.lastError ? (
          <p className="text-sm leading-6 text-rose-300">
            {authStatus.lastError}
          </p>
        ) : null}

        <div className="grid gap-3 rounded-2xl border border-rose-300/12 bg-rose-300/[0.04] p-4">
          <div>
            <p className="text-[0.68rem] uppercase tracking-[0.16em] text-rose-200/80">
              Danger
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Clears run history, item logs, and processed-song memory. Settings
              and saved auth stay intact.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              className={buttonGhostClass}
              type="button"
              onClick={onClearSyncData}
            >
              Clear sync database
            </button>
          </div>
        </div>
      </article>
    </section>
  )
}

function RailButton({
  active,
  label,
  meta,
  onClick,
}: {
  active: boolean
  label: string
  meta: string
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        'grid gap-1 rounded-[18px] border px-4 py-3 text-left transition duration-200 hover:translate-x-1',
        active
          ? 'border-white/14 bg-[#131920] text-slate-50 shadow-[0_18px_40px_rgba(0,0,0,0.28)]'
          : 'border-white/8 bg-white/[0.03] text-slate-100 hover:border-white/14 hover:bg-white/[0.05]'
      )}
      type="button"
      onClick={onClick}
    >
      <span className="text-sm font-medium">{label}</span>
      <small className="text-xs text-slate-500">{meta}</small>
    </button>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <article className={cn(panelClass, 'grid gap-2 rounded-[18px] px-4 py-3')}>
      <span className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      <strong className="text-base font-medium text-slate-50">{value}</strong>
    </article>
  )
}

function Field({
  label,
  value,
  onChange,
  actionLabel,
  onAction,
  mono = false,
  secret = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  actionLabel?: string
  onAction?: () => void
  mono?: boolean
  secret?: boolean
}) {
  return (
    <label className="grid gap-3">
      <span className="text-[0.78rem] uppercase tracking-[0.12em] text-slate-500">
        {label}
      </span>
      <div className="flex flex-wrap gap-2">
        <input
          className={cn(
            inputClass,
            mono && "font-['IBM_Plex_Mono'] text-[13px]"
          )}
          type={secret ? 'password' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {actionLabel && onAction ? (
          <button className={buttonClass} type="button" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </div>
    </label>
  )
}

function TextAreaField({
  label,
  value,
  onChange,
  hint,
  mono = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  mono?: boolean
}) {
  return (
    <label className="grid gap-3">
      <span className="text-[0.78rem] uppercase tracking-[0.12em] text-slate-500">
        {label}
      </span>
      <textarea
        className={cn(
          inputClass,
          'min-h-[176px] resize-y',
          mono && "font-['IBM_Plex_Mono'] text-[13px]"
        )}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="text-sm leading-6 text-slate-400">{hint}</p> : null}
    </label>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string
  value: YtDlpCookiesBrowser
  options: YtDlpCookiesBrowser[]
  onChange: (value: YtDlpCookiesBrowser) => void
  hint?: string
}) {
  return (
    <label className="grid gap-3">
      <span className="text-[0.78rem] uppercase tracking-[0.12em] text-slate-500">
        {label}
      </span>
      <select
        className={inputClass}
        value={value}
        onChange={(event) =>
          onChange(event.target.value as YtDlpCookiesBrowser)
        }
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {hint ? <p className="text-sm leading-6 text-slate-400">{hint}</p> : null}
    </label>
  )
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-2xl border border-white/6 bg-white/[0.03] px-4 py-3">
      <span className="text-sm text-slate-300">{label}</span>
      <input
        className="h-4 w-4 accent-cyan-400"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

function LogStream({
  entries,
  emptyMessage,
  maxHeightClass = 'max-h-[280px]',
}: {
  entries: SongLogEntry[]
  emptyMessage: string
  maxHeightClass?: string
}) {
  return (
    <div className={cn('grid gap-2 overflow-auto', maxHeightClass)}>
      {entries.length ? (
        entries.map((entry) => {
          const context = parseLogContext(entry.contextJson)
          return (
            <div
              key={entry.id}
              className="grid gap-2 rounded-2xl border border-white/6 bg-white/[0.03] px-3.5 py-3 text-sm text-slate-400"
            >
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[74px_132px_1fr]">
                <span
                  className={cn(
                    'text-[0.68rem] uppercase tracking-[0.14em]',
                    entry.level === 'error'
                      ? 'text-rose-300'
                      : entry.level === 'warn'
                        ? 'text-amber-300'
                        : entry.level === 'info'
                          ? 'text-cyan-300'
                          : 'text-slate-500'
                  )}
                >
                  {entry.level}
                </span>
                <span className="font-['IBM_Plex_Mono'] text-xs text-slate-300">
                  {entry.stage}
                </span>
                <div className="grid gap-1">
                  <span className="text-slate-200">{entry.message}</span>
                  <span className="font-['IBM_Plex_Mono'] text-[11px] text-slate-500">
                    {entry.event} · {formatDateTime(entry.timestamp)}
                  </span>
                </div>
              </div>
              {context ? (
                <pre className="overflow-auto rounded-xl border border-white/6 bg-[#0b0f14] px-3 py-2 font-['IBM_Plex_Mono'] text-[11px] leading-5 text-slate-300 whitespace-pre-wrap break-words">
                  {context}
                </pre>
              ) : null}
            </div>
          )
        })
      ) : (
        <p className="text-sm leading-6 text-slate-400">{emptyMessage}</p>
      )}
    </div>
  )
}

function StatusChip({
  tone,
  label,
  compact = false,
  pulse = false,
}: {
  tone: 'success' | 'warning' | 'danger' | 'accent' | 'neutral'
  label: string
  compact?: boolean
  pulse?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border uppercase tracking-[0.14em]',
        compact ? 'px-2 py-1 text-[0.62rem]' : 'px-3 py-2 text-[0.68rem]',
        pulse && 'animate-pulse',
        tone === 'success' &&
          'border-emerald-300/20 bg-emerald-400/10 text-emerald-200',
        tone === 'warning' &&
          'border-amber-300/20 bg-amber-300/10 text-amber-200',
        tone === 'danger' && 'border-rose-300/20 bg-rose-300/10 text-rose-200',
        tone === 'accent' && 'border-cyan-300/20 bg-cyan-300/10 text-cyan-200',
        tone === 'neutral' && 'border-white/8 bg-white/[0.03] text-slate-300'
      )}
    >
      {label}
    </span>
  )
}

function MetaRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="grid gap-2 rounded-2xl border border-white/6 bg-white/[0.03] px-4 py-3">
      <span className="text-[0.68rem] uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      <strong
        className={cn(
          'break-words text-sm font-medium text-slate-100',
          mono && "font-['IBM_Plex_Mono'] text-[13px]"
        )}
      >
        {value}
      </strong>
    </div>
  )
}

function screenTitle(screen: Screen) {
  switch (screen) {
    case 'overview':
      return 'Overview'
    case 'current-run':
      return 'Current Run'
    case 'history':
      return 'History'
    case 'settings':
      return 'Settings'
    case 'library-artists':
      return 'Library Artists'
  }
}

function screenCopy(
  screen: Screen,
  authStatus: AuthStatus,
  headlineRun: SyncRunSummary | null
) {
  switch (screen) {
    case 'overview':
      return authStatus.isAuthenticated
        ? 'Connection state, run summary, and the shortest path into a new sync.'
        : 'Pull auth from your selected browser, then let the Python worker take over.'
    case 'current-run':
      if (!headlineRun) {
        return 'No run loaded yet. Start a sync to populate the inspector.'
      }
      return headlineRun.status === 'running'
        ? 'Live NDJSON events stream into the current run view with compact desktop density.'
        : headlineRun.status === 'cancelled'
          ? 'Latest run stays inspectable here after cancellation.'
          : 'Latest run stays inspectable here after it finishes.'
    case 'history':
      return 'Prior runs stay inspectable without the old category and YT Music diagnostic tabs.'
    case 'settings':
      return 'Browser auth, output, templates, remote copy, and worker doctor checks.'
    case 'library-artists':
      return 'Cached artist list from liked songs with multi-select reprocess.'
  }
}

function formatProgress(
  run: Pick<SyncRunSummary, 'processedCount' | 'totalCount'>
) {
  return `${run.processedCount} / ${run.totalCount || 0}`
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function toneForRun(status: SyncRunSummary['status']) {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'warning'
    case 'running':
      return 'accent'
    default:
      return 'neutral'
  }
}

function toneForItem(status: SyncRunItemView['status']) {
  switch (status) {
    case 'completed':
    case 'completed_local_only':
      return 'success'
    case 'failed_retryable':
    case 'failed_terminal':
      return 'danger'
    case 'skipped_existing':
      return 'warning'
    case 'processing':
      return 'accent'
    default:
      return 'neutral'
  }
}

function formatTrack(item: SyncRunItemView) {
  if (item.trackNumber && item.trackTotal) {
    return `${item.trackNumber} / ${item.trackTotal}`
  }
  if (item.trackNumber) {
    return String(item.trackNumber)
  }
  return '—'
}

function parseLogContext(value: string) {
  if (!value) return null

  try {
    const parsed = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length > 0
    ) {
      return JSON.stringify(parsed, null, 2)
    }
  } catch {
    return value
  }

  return null
}

export default App
