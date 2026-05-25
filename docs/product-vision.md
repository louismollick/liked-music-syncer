# Product Vision

## Core UX
- Sync is one destination in nav.
- Sync uses one page with four filters: `All`, `In Progress`, `Completed`, `Failed`.
- Keep grouped job+track presentation for context.

## Status Model
- Parent job status is lifecycle-only: `In Progress` or `Completed`.
- Child track status is outcome/work state: `Queued`, `In Progress`, `Succeeded`, `Failed`.
- Mixed success/failure child outcomes do not change completed parent jobs into failed jobs.

## Filter Model
- `All`: every visible job and track.
- `In Progress`: only active jobs + non-terminal tracks.
- `Completed`: completed jobs + all tracks.
- `Failed`: only failed tracks under parent jobs.

## Reprocess Model
- Reprocess runs as direct execution.
- No preview-only stage.
- No approval/apply split.
- No-diff items produce no visible sync rows.

## Approval and Settings
- No approval flow.
- No approval IPC/API.
- No auto-approve setting.
- Modifications/deletions execute directly by default.

## Data/Compatibility
- Existing legacy statuses should be normalized to renderer-facing display statuses.
- Legacy approval rows can be ignored safely and removed by migration.
