# Library | Sync shell (current)

## Primary navigation
- Primary shell is `Library`, `Sync`, `Settings`.
- Legacy `Overview / Current Run / History` screens removed.

## Library
- Artists-first list.
- Header actions:
  - `Liked Songs Sync`
  - `Reprocess Library`
  - `Refresh Favorite Catalog`
  - `Sync Missing to Remote`
- Artist multi-select supports `Reprocess Artist Songs`.

## Sync
- Default subview: `Queue`.
- Subnav uses track counts.
- `Needs Approval` hidden when `Auto-approve modifications and deletions` is on.
- `Needs Approval` also hidden when there are zero approval rows.
- Reprocess uses preview-first approval rows, with same-video update and changed-video replace actions.
- `Queue`, `Completed`, `Failures` are job-grouped with inline row expansion.
- Sync persistence is job-only: `sync_jobs`, visible `sync_job_tracks`, and `sync_approval_items`.
- Legacy `sync_runs`, `sync_run_items`, and `artifacts` are gone.

## Settings
- `dry run` removed.
- Added `Auto-approve modifications and deletions` toggle.

## Data and migration
- Schema version bumped to `10`.
- Upgrade performs full DB reset for sync/library state.

## API
- Added explicit sync launchers:
  - `sync.startLikedSongsSync()`
  - `sync.startLibraryReprocess()`
  - `sync.reprocessArtists(artistIds)`
  - `sync.refreshFavoriteArtists(...)`
  - `sync.syncMissingToRemote()`
- Added approval IPC:
  - `sync.approveChanges(approvalIds)`
  - `sync.denyChanges(approvalIds)`
- `sync.cancel(jobId)` and `sync.clearSyncData()` remain.
