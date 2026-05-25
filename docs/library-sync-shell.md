# Library | Sync shell (current)

## Primary navigation
- Primary shell is `Library`, `Sync`, `Settings`.
- Legacy `Overview / Current Run / History` screens removed.

## Library
- Artists-first list.
- **Albums** shows embedded cover thumbnails from local indexed files (`app-media://` cache). See [library-album-artwork.md](./library-album-artwork.md).
- Header actions:
  - `Liked Songs Sync`
  - `Reprocess Library`
  - `Refresh Favorite Catalog`
  - `Sync Missing to Remote`
- Artist multi-select supports `Reprocess Artist Songs`.

## Sync
- Default subview: `Queue`.
- Subnav uses track counts.
- `Needs Approval` hidden when `Don't require approvals for modifications and deletions` is on.
- `Needs Approval` also hidden when there are zero approval rows.
- Reprocess uses preview-first approval rows only when approvals are required.
- When approvals are disabled, reprocess skips preview rows entirely, runs as a normal worker job, and writes no `sync_approval_items`.
- Direct reprocess now pre-seeds all candidate tracks into Queue as `pending`/`idle` before processing starts, then advances rows to `processing` one-by-one.
- Same-video direct reprocess updates metadata, tags, lyrics, artwork, and paths in place without redownloading audio.
- Changed-video direct reprocess replaces the local file through the normal redownload path.
- Reprocess includes all local tracks with an LMS source ID (`lms_source` identity), including older liked-song downloads that only have a legacy YouTube ID in comments and are not marked `managedByApp`.
- Reprocess creates a queue job immediately on click, then fills in the planned track count while scanning candidates; preview rows appear after the Python preview pass finishes.
- Reprocess eligibility includes managed local tracks with LMS source IDs even when `source_origin` tags were never written (common for older liked-song downloads).
- A running reprocess job appears in `Queue` while preview work is in progress.
- Reprocess preview progress is now logged incrementally, and changed rows can appear on the running job before the full preview finishes.
- Rows with pending approval land in `Needs Approval` after preview when approvals are required.
- `Queue`, `Completed`, `Failures` are job-grouped with inline row expansion.
- Sync persistence is job-only: `sync_jobs`, visible `sync_job_tracks`, and `sync_approval_items`.
- Legacy `sync_runs`, `sync_run_items`, and `artifacts` are gone.

## Settings
- `dry run` removed.
- Added `Don't require approvals for modifications and deletions` toggle.

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
 - `sync.cancel(jobId)` now supports cancelling a reprocess preview job (these run with status `running` during the preview pass).
