# Layout Vision

## Navigation
- Left nav keeps Library expandable (`Artists`, `Albums`, `Songs`).
- Left nav `Sync` is one non-expandable destination.
- No Sync subnavigation.

## Library Cards
- Artist and album grid cards use edge-to-edge square media.
- Metadata sits in a compact padded footer below the image/artwork.

## Sync Page
- One Sync page with in-page filters: `All`, `In Progress`, `Completed`, `Failed`.
- Job cards remain parent/child grouped (job header + track rows).
- Job pill semantics: `In Progress` or `Completed` only.
- Track pill semantics: `Queued`, `In Progress`, `Succeeded`, `Failed`.

## Filter Semantics
- `All`: all jobs and all tracks.
- `In Progress`: only running/queued jobs; inside each, show only `Queued`/`In Progress` tracks.
- `Completed`: only completed jobs; inside each, show all tracks (including failed tracks).
- `Failed`: show only failed tracks, grouped under parent job headers; hide non-failed siblings.

## Reprocess Behavior
- Reprocess executes directly (no preview phase, no apply phase split).
- Same-video updates apply metadata/lyrics/artwork directly.
- Resolved-video changes use direct replacement behavior.
- No-diff reprocess rows should not create visible sync work.

## Approval
- No approval gate anywhere in app.
- No approval settings.
- No approval-specific terminology in UI.

## Failure Handling
- Failed tracks remain visible in `All`, `Completed` (if parent job completed), and `Failed`.
- Mixed-result parent jobs remain `Completed` once lifecycle ends.
- `clear failures` clears failed-result history only; do not wipe active/success-only history.
