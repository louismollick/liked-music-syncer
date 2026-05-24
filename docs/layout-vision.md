# Layout Vision

## Purpose

This document captures layout direction for the desktop app.

It is a working document for deciding how the app should move from a sync-tool interface toward a library-first inventory app with sync, review, and debug workflows built around it.

## Source Vision

The product vision says the app should help a user build and maintain a clean local music library from liked songs.

The future app should feel closer to a music inventory browser than a log viewer. Sync controls should support review and confirmation instead of being the whole app.

## Layout Goal

The primary layout should make the finished music library feel like the center of the app, without turning the app into a music player.

The user should be able to:

- browse songs, albums, and artists
- search the local library
- inspect metadata, lyrics state, file paths, source platform, matching result, and processing result
- see how local library items were formed from one or more liked music libraries on source platforms
- see whether local library items are present in the remote library
- start a sync from liked songs
- review planned changes before download
- watch active sync progress
- let background sync happen on a schedule
- inspect failures and diagnostics without making debug output the main experience
- copy completed songs to a remote music server
- check setup and authentication state

## Current Product Shape

The current app is mainly a YouTube Music sync tool.

Current visible workflows include:

- YouTube Music authentication
- fetching liked songs
- starting and stopping sync work
- viewing progress, item statuses, and item details
- downloading and tagging songs locally
- selected artist reprocessing
- library-wide reprocessing
- approval review for reprocess changes
- remote copy and missing-remote review
- setup doctor checks

## Desired Product Shape

The app should become library-first, with sync actions available from that inventory-focused experience.

Candidate primary navigation:

- Library
- Sync

Library should likely be the default area once setup is complete.

Library should contain subnavigation for collection views:

- Albums
- Artists
- Songs
- Playlists, later

Sync should likely become a guided workflow and status surface, without exposing internal sync runs as the main user model:

1. Pull liked songs.
2. Compare liked songs with disk.
3. Match metadata and sources.
4. Automatically download clean new matches by default.
5. Ask for confirmation only before destructive actions, existing-library modifications, or unresolved matching choices.
6. Download, tag, write lyrics, and copy remote if enabled.

Reprocess should use that same Sync system, but with a preview-first workflow for existing library items:

1. Select a scope such as song, album, artist, or whole library.
2. Re-run source resolution, metadata lookup, artwork lookup, and lyrics lookup for each in-scope track.
3. If a track has no resulting change, do not create approval work for it.
4. If a track has changes, create a Proposed Change with a full before/after diff.
5. Do not write or delete anything before approval, unless the global auto-approve setting is enabled.
6. After approval, either replace the whole track when the resolved video changed, or skip download and apply metadata and lyrics updates when the resolved video stayed the same.

Settings should not be a primary navigation item. It should be a utility button, likely placed near the bottom-left of the app shell with a cog icon.

## Candidate Screens

### Library

Browse and search the finished local library as inventory and metadata.

Library should have one global search that can find albums, artists, and songs. Results should be grouped by type, with optional filters to scope the search.

Likely views:

- Songs
- Albums
- Artists
- Playlists, later

Current library navigation behavior:

- Artists default to browse mode; clicking an artist drills into Albums filtered to that artist
- Artists expose a `Select` toggle for bulk artist actions such as selected reprocess and selected catalog refresh
- Albums show the same top-level library sync actions as Artists and can drill into Songs
- Albums and Songs show dismissible filter pills beside the view title when entered from drilldown
- Songs expose lyrics type, language, and remote presence columns in the main table, and those columns are sortable like the core song metadata columns

The Library view should not include playback controls.

Library grid and list views should stay visually clean by default. They should not show local, remote, or matching status badges unless the user asks for that information through filters, detail views, or an inspection mode.

Source-contribution badges should not appear on Library grid or list cards by default.

Remote state belongs in Library as a filter and item detail, because it describes whether inventory exists on the remote music server. It should not be a separate Library subview.

Remote-state filters: All / Remote only / Local only / In both Remote and Local

Lyrics filters: All / Synced / Unsynced / None

Albums should be the default Library view once setup is complete.

### Artist

Show artist-level context.

Artist detail is based primarily on final track artist metadata, not album artist metadata.

Likely content:

- artist image
- favorite artist toggle
- search/add artist as future target
- local songs
- albums
- full-catalog sync state when marked as favorite
- official main catalog coverage when marked as favorite
- manual catalog refresh action when marked as favorite
- album artist appearances when relevant
- liked-song sources
- reprocess action
- processing history filtered to that artist

Reprocess should be available from selected Library items such as artist, album, or song.

Artist reprocess and whole-library reprocess should be the same Reprocess workflow with different scopes.

Reprocess should target local library tracks that have a source-song tag identity, even if those tracks are no longer currently desired by liked-song or Favorite Artist discovery.

Favorite Artist catalog refresh should be available on Artist detail for one artist. The Artists view should also support a bulk refresh action when filtered to favorites.

### Album

Show album-level context.

Album detail is based on final downloaded or tagged album metadata, not liked-song grouping from a source platform.

Likely content:

- album art
- release metadata
- album artist
- track list
- local file state
- lyrics and tagging completeness
- reprocess action
- summarized liked source contributions for the album

Album detail should show source contributions at summary level, such as which platforms contributed songs on the album and how many songs came from each platform.

The current Albums collection view also acts as the drilldown surface from Artists, with an artist filter pill that can be cleared back to the full album inventory.

### Song

Show song-level detail.

Likely content:

- title, artists, album, year, genre
- album art
- lyrics state
- local file path
- source platform
- liked source contributions
- resolved download source
- local library state
- remote library state
- processing result
- reprocess action
- diagnostics surfaced in terminal stdout/stderr and mirrored to per-launch temp log files; parsed worker log events also show as pretty terminal lines

Song detail should show source contributions in the most detail. A compact badge row is acceptable on the detail page, with expandable rows for original liked item details such as platform, liked title, liked artist, URL or id, liked date if known, and match reason when available.

The current Songs collection view also acts as the drilldown surface from Albums, with an album filter pill that can be cleared back to the full song inventory.

### Sync

Review newly discovered songs and manage all async download-related work.

Sync should be the funnel for async downloading operations across the app. Whether work comes from a Liked Songs Sync, a Favorite Artist catalog refresh, or a Copy Missing to Remote action, it should land in the same Sync area.

Sync should show current and pending work, not a history organized around internal runs. If run history remains available, it should be a debug-only surface.

Sync should remain visible in primary navigation even when scheduled background sync exists.

For now, live progress should stay inside Sync rather than a persistent shell panel. Primary navigation should stay Library and Sync.

Likely subnavigation:

- Queue
- Needs approval
- Completed
- Failures

Failures should support clearing only failed jobs without wiping queued, approval, or completed sync history.

Likely job phases:

- setup check
- fetch liked songs or liked sources
- expand favorite-artist catalogs
- match and compare
- review preview
- confirm changes
- download audio
- tag files and write lyrics
- copy to remote
- completion summary

Likely content:

- manual sync jobs
- Liked Songs Sync jobs, whether triggered manually or on a schedule
- favorite-artist catalog refresh jobs
- copy-missing-to-remote jobs
- newly discovered liked songs
- newly discovered favorite-artist songs
- tracks ready to download
- proposed changes awaiting confirmation
- proposed cleanup awaiting confirmation
- active tracks and their current step
- finished job summaries
- failed jobs and failed tracks
- timestamp of the last liked-song check
- manual check-now action

The Sync header should show last checked time and a manual check-now action.

Queue model:

- The underlying async work model is track-first, but the Queue UI should be job-first with expandable nested track rows.
- Parent job kinds should include Liked Songs Sync jobs, Favorite Artist catalog refresh jobs, and Copy Missing to Remote jobs.
- Each queued job should appear as a parent row with nested track rows under it.
- Track rows should be expanded by default when available.
- If a job has not decomposed into tracks yet, the parent row should still be visible in Queue.
- Favorite Artist refresh rows should include the artist name directly in the main parent row label.

Child track rows should stay lightweight by default:

- title
- primary artist
- Queue State
- Track Step when active
- failure reason when failed

Resolved-source badges are not required in the default child row UI for now.

Queue state sections:

- Currently running
- Queued

Within each Queue state section, rows should still preserve the parent job and nested track structure.

Currently running tracks should sort before queued siblings inside a running job group.

Queue should be the live operational view for running and waiting work. A separate Active view is not needed if Queue already shows Job Phase and Track Step inline. One executable job should run at a time, with later jobs remaining visibly queued behind it.

Needs Approval should be its own Sync view because approval work may need richer diff-style detail than the main Queue.

After approval is granted, tracks should return to Queue to finish remaining work and may then appear in Currently running.

Needs Approval can diverge from the other Sync views:

- Needs Approval should be track-first because approval decisions apply to concrete track-level diffs.
- Small parent-job context can still be shown, but job grouping is not the primary unit there.
- Needs Approval is still less finalized than Queue, Completed, and Failures and should not block implementation of those views.
- Needs Approval should use a table-like selection model with a leading checkbox column.
- The header checkbox should follow standard table behavior and toggle selection for the whole table.
- Default selection should be none.
- Needs Approval should support bulk approve and bulk deny actions on the explicit selection.
- Needs Approval should show a full before/after diff for every changed field, including empty-to-filled values.
- Diff detail should include all tracked fields for now, not only user-facing metadata.
- Album art changes should be visible in the diff.
- Same-video reprocess changes should stay preview-only until approval.
- Resolved-video replacement changes should also stay preview-only until approval, then execute as one combined replacement action for that track.
- Denied items should leave Needs Approval and end in Completed rather than Failures.
- If the global auto-approve setting for modifications and deletions is enabled, qualifying items should bypass Needs Approval entirely and this view should not be shown.

Terminology inside Sync should stay explicit:

- Queue State = Needs approval, Currently running, Queued, Completed, or Failed
- Job Phase = parent job progress such as fetching liked songs, expanding catalog, or remote copy
- Track Step = child track progress such as matching, downloading, tagging, writing lyrics, or copying to remote

Completed should use a very similar visual structure to Queue:

- Completed should be job-first, with expandable nested track rows.
- Completed and Queue should look closely related rather than feeling like separate products.
- Completed should preserve the parent job context so users can see what trigger produced the finished tracks.

Failures should also use that same grouped structure:

- Failures should be job-first, with expandable nested failed track rows.
- Failures should preserve parent job context so users can see which trigger produced the failure.
- Queue, Completed, and Failures should feel like variations of one Sync list system rather than separate layouts.
- If a parent job finishes with a mix of completed and failed tracks, the whole job should move to Failures rather than being split across Completed and Failures.

### Settings

Settings are utility chrome, not a peer of Library and Sync in the primary navigation.

Likely content:

- YouTube Music auth
- future music accounts
- output folder
- naming templates
- remote copy settings
- preference toggles for app behavior
- tool checks
- destructive maintenance actions

## Open Layout Questions

- What should the first screen be before setup is complete?
- What should the first screen be after setup is complete?
- Should any in-app diagnostic surface return later, or should terminal diagnostics remain the only debug path?
- What does the review preview need to show before download?
- What proposed changes require confirmation before applying to existing library items?
- Which concrete inventory and matching filters belong in Library versus Sync?
- Should artist reprocessing live on artist pages, sync review, or both?
- Should completed track rows disappear from Queue immediately, or remain briefly marked done inside a running job group?
- How much of the current run-history UI remains visible in the debug surface?

## Working Assumptions

- Library is the main product surface.
- Library means inventory and metadata, not playback.
- Library includes subnavigation for Albums, Artists, Songs, and eventually Playlists.
- Albums is the default Library view.
- Library grid and list views avoid status badge clutter by default.
- Library search is global across Albums, Artists, and Songs, with grouped results.
- Search results should update immediately while typing, even during background sync/status updates.
- Remote state is part of Library, not a top-level navigation area.
- Sync is a workflow, not the whole product.
- Sync focuses on discovered songs, confirmation, active downloads, and finished downloads.
- Clean new matches should auto-download by default.
- Confirmation is for destructive actions, existing-library modifications, and unresolved matching choices.
- Deleting songs that are no longer liked should be proposed cleanup only, not automatic.
- No longer liked means absent from all connected liked music libraries, not merely removed from one contributing platform.
- Reprocess actions belong on selected Library items such as artist, album, or song.
- Reprocess can also target the whole library.
- Sync remains a primary navigation item.
- Sync shows last liked-song check time and allows a manual check for new songs.
- Sync should use subnavigation for Queue, Needs approval, Completed, and Failures.
- Sync should funnel Liked Songs Sync jobs, Favorite Artist catalog refreshes, and Copy Missing to Remote work into one place.
- The underlying async work model should be track-first, while Queue, Completed, and Failures remain job-first in the UI.
- Queue should use state sections instead of a timeline.
- Queue sections should be Currently running and Queued.
- Queue should preserve parent jobs with nested track rows, expanded by default when tracks are known.
- Running work should appear inline in Queue with Job Phase and Track Step visible there.
- No persistent live sync UI should appear outside Sync for now.
- One executable job should run at a time.
- Completed should use the same job-first grouped shape as Queue, with expandable nested tracks.
- Completed and Queue should look very similar visually.
- Failures should use the same job-first grouped shape as Queue and Completed.
- Mixed-result jobs should leave Queue as one group and land in Failures.
- Needs Approval should be a separate Sync view rather than a section inside Queue.
- Needs Approval should be track-first, even though Queue, Completed, and Failures stay job-first.
- Needs Approval should support standard table-style selection with row checkboxes and a header checkbox.
- Skipped is not a primary Sync bucket; already-known or already-present songs belong in Library inventory state.
- Favorite Artists extend desired library contents beyond individually liked songs.
- Favorite Artist MVP can mark artists already known from the scanned local library.
- Favorite Artist target behavior should allow searching for and adding any artist.
- Favorite Artist discovery should default to official main catalog: albums, singles, and EPs.
- Favorite Artist discovery should dedupe against liked-song discovery.
- Favorite Artist catalog discovery is manual for now, not part of every scheduled liked-song check.
- Library should support filtering Artists to only favorites.
- Favorite Artist catalog refresh belongs on Artist detail and as a bulk action from the favorites-filtered Artists view.
- Internal sync runs are not part of the main user model.
- The long-term app should support scheduled background sync.
- Debug information exists, but should not dominate the main layout.
- Review before download is central to the future app.
- The app should support YouTube Music now while leaving room for Spotify and SoundCloud later.

## Decisions

- The primary app model is Library with sync actions.
- Primary navigation should include Library and Sync.
- Settings should be opened from utility chrome, likely a bottom-left cog button, instead of appearing as a primary navigation tab.
- Remote should be folded into Library as inventory state.
- Library should open to Albums by default.
- Library should provide global search across albums, artists, and songs rather than isolated search per subview.
- Status details should appear in item detail views or when requested through filters, not on every default Library card.
- Source-contribution badges and rows belong on detail pages, not Library grid or list cards.
- Avoid generic review categories such as "Needs attention" or "Low confidence"; use concrete states such as missing local file, missing remote file, no YouTube Music match, failed download, missing lyrics, or missing album art.
- The app should never play music. It should show metadata, inventory, provenance, local state, remote state, and sync controls.
- The app should avoid exposing "runs" in primary UI. Users care about discovered songs, pending confirmation, active work, finished work, and concrete failures, not which internal run produced them.
- Sync should stay visible in primary navigation as the place to inspect discovered songs, pending confirmation, active downloads, completed work, failures, and last checked time.
- Sync should include songs discovered from Favorite Artists alongside songs discovered from liked music libraries.
- Sync should merge duplicate desired songs across liked music libraries and Favorite Artist discovery so a song is not downloaded twice.
- Sync should remain a `Library | Sync` primary-navigation model for now, without a persistent shell progress surface.
- Sync should use subnavigation for Queue, Needs approval, Completed, and Failures.
- Queue should be the unified async inbox for Liked Songs Sync jobs, Favorite Artist refreshes, and Copy Missing to Remote jobs.
- Queue should be organized first by state sections: Currently running and Queued.
- The underlying async work model should be track-first, while Queue, Completed, and Failures remain job-first in the UI.
- Parent jobs in Queue should expand into nested track rows, and those nested rows should be expanded by default.
- Liked Songs Sync jobs, Favorite Artist catalog jobs, and Copy Missing to Remote jobs should all appear as parent rows in the same Queue.
- Favorite Artist refresh parent rows should include the artist name in the main label.
- Child track rows should stay lightweight by default and should not show resolved-source badges for now.
- Needs Approval should be a separate Sync view with richer diff-style detail.
- Needs Approval should be track-first and may remain less finalized than the other Sync views for now.
- Once approval is granted, affected tracks should return to Queue for the rest of their lifecycle.
- Running work should appear inline in Queue with Job Phase and Track Step visible there.
- One executable job should run at a time.
- Completed should be job-first with expandable track rows, and should visually mirror Queue.
- Failures should be job-first with expandable track rows, and should visually mirror Queue and Completed.
- If one job finishes with both completed and failed tracks, that whole job group should land in Failures.
- Sync should use explicit terminology that separates Queue State, Job Phase, and Track Step.
- Scheduled background sync should focus on liked-song checks. Favorite Artist catalog refresh can be triggered manually to avoid heavy repeated catalog scans.
- Favorite Artist catalog refresh should not be a default Sync action; Sync can still show resulting discovered songs, downloads, and failures.
- Sync should not present "Skipped" as a main state. If a song already exists or needs no action, that should be visible through Library state instead.
- Existing songs are normally left alone. Reprocessing existing songs is an explicit user action from Library.
- Artist reprocess and whole-library reprocess are the same Reprocess workflow with different scopes.
- Reprocess scope includes local library tracks with a source-song tag identity.
- Reprocessing should re-run matching, metadata, artwork, and lyrics lookups even for already-processed tracks.
- If reprocessing produces no actual diff, the track should not enter Needs Approval.
- If reprocessing keeps the same resolved video, download can be skipped and the work can focus on metadata, artwork, lyrics, tags, and sidecars.
- If reprocessing changes the resolved video, the existing replace-the-track behavior still applies after approval.
- Reprocessing can create proposed metadata, artwork, lyrics, or file changes that require confirmation before applying.
- Reprocessing should compute those changes as preview-only work first, with no writes before approval unless auto-approve is enabled.
- Songs no longer found in liked music libraries can be shown as proposed cleanup, but the app should not auto-delete them.
- Needs Approval should show a complete before/after diff across all changed fields, including empty-to-filled values and album art changes.
- Needs Approval should use standard table-selection behavior with a header checkbox and bulk approve or deny actions.
- Denied approval items should complete as no-op user decisions, not failures.
- A global setting can auto-approve all modifications and deletions, bypassing Needs Approval entirely.
- Multiple platforms can contribute to the same library item during the same sync. The UI should show all liked source contributions, not force a single original source.
- Album detail should summarize source contributions; song detail should show full source-contribution rows.
- Album identity should come from final library metadata. Liked source contributions explain provenance, not album grouping.
- Artist pages should use track artist by default. Album artist remains visible for album grouping and album detail.
- Debug diagnostics should be available via terminal output, but not a main focus.
