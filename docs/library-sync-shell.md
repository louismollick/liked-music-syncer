# Library Sync Shell

## Current model
- Single `Sync` destination in left nav.
- No Sync subnavigation.
- One Sync page with filters: `All`, `In Progress`, `Completed`, `Failed`.

## Status model
- Job display status: `In Progress` or `Completed`.
- Track display status: `Queued`, `In Progress`, `Succeeded`, `Failed`.
- Mixed-result jobs remain `Completed` when job lifecycle ends.

## Filter behavior
- `All`: all jobs, all tracks.
- `In Progress`: active jobs only; show only queued/processing tracks.
- `Completed`: completed jobs; show all child tracks.
- `Failed`: failed tracks only, grouped under parent jobs.

## Reprocess
- Reprocess executes directly via worker path.
- No preview stream stage.
- No approval/apply split.
- No-diff work should not create visible sync rows.

## Persistence
- Sync persistence uses `sync_jobs` + `sync_job_tracks`.
- Approval table/approval IPC/settings no longer part of active model.
