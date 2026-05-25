# Product Vision

## Problem

Music likes are split across streaming platforms.

A user may like songs on YouTube Music, Spotify, SoundCloud, and other services. Each service keeps its own list. Some songs are official releases. Some are music videos. Some are fan uploads, reposts, or low-quality copies.

This makes it hard to build one clean local music library.

The app solves this by turning liked songs and selected favorite artists into a local collection of clean, tagged music files that can be used in apps like Navidrome or Plex.

## Goal

The ideal app is a desktop tool for building and maintaining a personal local music library from liked songs and favorite artists.

The user connects their music accounts. The app reads the liked songs from each platform, merges matching liked songs into one library item with multiple source contributions when needed, finds the best official version of each song, downloads it, and adds rich metadata.

The user can also mark artists as favorites. For favorite artists, the app should act as if the artist's catalog is desired library content, even when the user has not liked every song individually.

The result should be a local library with:

- correct song titles
- correct artists and albums
- album art
- release year
- genre
- synced lyrics when available
- clean album versions instead of unofficial or video versions

The app should also keep a remote music server in sync. A user with Navidrome, Plex, or a similar server on a VPS should be able to send the finished songs there without a separate manual step.

The app is not a music player. It should show inventory, metadata, provenance, local file state, remote file state, and sync controls. Playback belongs in apps such as Navidrome, Plex, or another music app.

## Ideal User Journeys

### 1. Build a Clean Local Library From All Liked Songs

The user connects their music accounts, such as YouTube Music, Spotify, and SoundCloud.

The app fetches every liked song from each account. It combines the lists, merges duplicates, preserves which platforms contributed each song, and creates one clean queue.

For each song, the app finds the best official source, downloads it, adds metadata, adds lyrics when possible, and saves it in the user chosen music folder.

The user ends with a local library ready for Navidrome, Plex, or another music app.

### 2. Replace Unofficial Sources With Official Versions

The user may have liked a music video, fan upload, repost, or unofficial copy.

The app should detect when a better official version exists. It should prefer the album or YouTube Music version when that is the cleaner song source.

For example:

- a YouTube music video gets replaced by the YouTube Music album version
- a SoundCloud fan upload gets replaced by the official YouTube Music version
- duplicate uploads across platforms resolve to one best track

The user should not need to compare sources by hand.

### 3. Keep a Remote Music Server Updated

The user sets up a remote destination, such as a VPS that runs Navidrome.

After songs are downloaded and tagged locally, the app can copy them to the remote music folder.

The user can also check which local songs are missing from the remote library and copy only those missing tracks.

### 4. Review Sync Progress and Results

The user can watch current sync progress in the desktop app when they care to.

Sync should be the single funnel for async download-related work across the app. Whether work was triggered by a Liked Songs Sync, a Favorite Artist catalog refresh, or a Copy Missing to Remote action, it should appear in the same Sync area.

Sync should be one destination with no subnavigation.

The underlying async work model should be track-first, but the Sync UI should stay job-first with expandable nested track rows. For example, a Liked Songs Sync job or Favorite Artist catalog job can appear first as a parent row, then expand into nested track rows once songs are discovered.

Favorite Artist refresh jobs should include the artist name directly in the main parent row label.

Default child track rows should stay lightweight and focus on title, artist, Queue State, active Track Step, and failure reason when needed. Resolved-source badges are not required in the default row UI for now.

The Sync view should expose in-page filters for All, In Progress, Completed, and Failed rather than separate tabs or subviews.

Parent jobs should use only `In Progress` or `Completed` status pills. Child tracks should use `Queued`, `In Progress`, `Succeeded`, or `Failed` status pills.

Completed filtering should keep the same job-first grouped structure so users can review finished work without falling back to run history, even when some child tracks failed.

Failed filtering should use that same job-first grouped structure so users can inspect failures without losing parent-job context. Failed is a track-level filter, not a separate job destination.

In Progress filtering should show only jobs that are still running. Inside those jobs, it should show only non-terminal child tracks, meaning `Queued` and `In Progress`, while hiding already-succeeded and already-failed siblings.

If one Sync Job finishes with both completed and failed tracks, the whole job should appear in Failures rather than being split across multiple Sync views.

Sync terminology should distinguish Queue State, Job Phase, and Track Step so parent progress and child progress are not conflated.

The user should be able to inspect an active song to see its current Track Step, such as matching, downloading, tagging, writing lyrics, or copying to remote. The scheduler should run one executable job at a time while still showing queued follow-up jobs in Sync.

The app should not have a Needs Approval flow. Modifications and deletions should execute by default without a separate approval gate or setting.

The user should not need to understand internal sync runs. Over time, sync should be able to run automatically on a schedule in the background, with the app surfacing the current library state and concrete problems that need action.

The user should still be able to open Sync to see when likes were last checked, manually check now for new songs, confirm proposed changes before they modify existing library content, watch running jobs, review completed work, and inspect failures.

### 5. Reprocess a Specific Artist

The user can refresh the list of artists found in their liked songs.

They can select one or more artists and reprocess only those songs. This helps fix or improve part of the library without running the full sync again.

Reprocessing should also be available from selected library items such as an artist, album, or song. Artist reprocess and whole-library reprocess should be the same Reprocess workflow with different scopes.

Reprocess should target local library tracks that have a source-song tag identity, even if those tracks are no longer currently desired by liked-song or Favorite Artist discovery.

When reprocessing starts, the app should still do all the same source resolution, metadata lookup, artwork lookup, and lyrics lookup work it would do for a fresh track.

If reprocessing finds no actual diff for a track, that track should not create visible sync work.

If the resolved YouTube video changes, the app should treat that as one combined track replacement and execute it using the current replace-the-track behavior.

If the resolved YouTube video stays the same, the app should skip the audio download step and focus on metadata, lyrics, artwork, tags, sidecars, and other local updates.

Reprocess should execute direct changes as a normal worker job, without a preview-only approval phase or approval setting.

### 6. Reprocess the Whole Library

The user can start a library-wide Reprocess from the Library area.

This should use the same Reprocess workflow as artist reprocess, but with a whole-library scope.

The goal is to refresh the existing library in place, not to re-fetch current desired songs first. Source reconciliation and cleanup still belong to the normal sync and cleanup flows.

### 7. Build a Library From Favorite Artists

The user can mark artists as favorites.

The app treats favorite artists as another source of desired songs. It imports exact YouTube Music release tracklists from the artist `albums` and `singles` shelves, preserves release variants such as album vs single when YouTube Music exposes them separately, and downloads those release tracks without trying to "upgrade" them through music-video resolution.

The MVP can limit favorite selection to artists already known from the library or liked-song discovery. The target behavior should let the user search for and add any artist.

Favorite Artist discovery should skip exact release duplicates already managed locally, but keep separate releases of the same song when they are different album/single variants. Liked-video imports should still skip when an equivalent managed song already exists.

Favorite Artist catalog refresh should be manual for now, because full catalog discovery can be request-heavy and artists release new songs less often than users add new liked songs.

The user can filter Artists to show only favorites.

The user can refresh one favorite artist from Artist detail, or refresh multiple favorite artists from the favorites-filtered Artists view.

### 8. Test Setup Before a Real Download

The user can check required tools, auth, and remote copy settings before starting a sync.

For existing library tracks, they can use Reprocess preview and approval flow to inspect modifications before any write occurs.

## Current Features

The current app is a desktop sync tool focused on YouTube Music.

It can:

- pull YouTube Music auth from a selected browser
- save and clear auth
- fetch liked songs from YouTube Music
- start, stop, and inspect sync jobs
- show job progress, item status, and item details
- download songs locally
- enrich songs with metadata
- add album art when found
- add lyrics when found
- write synced lyric sidecar files
- embed unsynced lyrics
- use custom folder and file naming templates
- skip work for songs already processed
- refresh library by reconciling the persisted local index
- search local library artists
- cache artist images after local artists are shown
- reprocess selected artists
- reprocess the whole library
- preview reprocess diffs before apply, with approval or auto-approve
- mark local library artists as favorites
- auto-start a favorite artist catalog sync the first time an artist is favorited
- block sync actions until local library indexing/bootstrap is ready
- if that auto-start fails, show the failure reason immediately in the app status message
- manually refresh selected favorite artist catalogs later
- discover favorite catalogs from YouTube Music albums and singles shelves only
- preserve separate album/single release variants instead of collapsing them into one managed item
- skip liked-video imports when the managed library already has the same song title + primary artist, even if durations differ
- treat MusicBrainz as fallback-only metadata fill, never as an override for successful YouTube Music matches
- prefer synced lyrics in this order: YT Music synced, Spotify synced, YT Music plain, Spotify plain
- copy finished songs to a remote music folder
- find local songs missing from the remote folder
- copy missing remote songs after review
- show progress while finding and copying tracks missing from remote
- compare missing remote songs by LMS source/resolved tags, not file paths
- scan remote backfill tags over SSH for SFTP rclone remotes
- check local tools and app setup with doctor checks
- clear sync history, item metadata/status snapshots, and processed-song memory while keeping settings and auth

Remote backfill requires an SFTP rclone remote with SSH shell access. The VPS must have `exiftool` installed, for example with `sudo apt-get install -y libimage-exiftool-perl` on Ubuntu. Non-SFTP rclone remotes are unsupported for remote backfill.

The current app does not yet provide the full ideal multi-platform flow. Spotify and SoundCloud are part of the intended vision, but the visible app experience today centers on YouTube Music liked songs.

## Future Features

The app should become a library inventory viewer first, with sync controls built around review and confirmation.

It should add:

- global library search across songs, albums, and artists, with grouped results
- artist pages based on track artist metadata, with photos, metadata, and discography
- arbitrary favorite artist search beyond local library artists
- album pages with album art, release metadata, and track lists based on final library metadata
- song pages with tags, lyrics state, file paths, detailed liked source contributions, resolved download source, and processing result
- album pages that summarize which liked music libraries contributed songs on the album
- image-heavy browsing, closer to a music player than a log viewer
- debug diagnostics via terminal stdout/stderr and processing history, kept out of the main path
- scheduled background sync, with internal runs hidden from the primary user experience
- a visible Sync area with subnavigation for Queue, Needs approval, Completed, and Failures
- one unified async queue for Liked Songs Sync jobs, Favorite Artist catalog refreshes, and Copy Missing to Remote work
- an underlying track-first async work model with a job-first Queue, Completed, and Failures UI
- nested track rows under each queued parent job, expanded by default when track lists are available
- Queue sections for currently running work and queued work
- a separate Needs Approval view for proposed changes and cleanup that require richer diff-style review
- a track-first Needs Approval view for concrete per-track diffs and confirmation actions
- standard table-style selection in Needs Approval, with row checkboxes, a header checkbox, and bulk approve or deny actions
- full before/after diffs in Needs Approval across all changed fields, including empty-to-filled values and album art changes
- a Completed view that mirrors Queue with job-first groups and expandable track rows
- a Failures view that mirrors Queue and Completed with job-first groups and expandable track rows
- mixed-result jobs grouped into Failures rather than split between Completed and Failures
- explicit Sync terminology separating Queue State, Job Phase, and Track Step
- automatic download for clean new matches by default
- confirmation before destructive actions or modifications to existing library content, such as deleting songs no longer liked or updating metadata on existing files
- a global setting to auto-approve all modifications and deletions, bypassing Needs Approval when enabled
- proposed cleanup for songs no longer found in liked music libraries, with deletion requiring confirmation
- one Reprocess workflow that can target song, album, artist, or whole-library scope
- Reprocess scope based on local library tracks that have a source-song tag identity
- preview-only Reprocess evaluation before writes, with same-video changes skipping redownload and resolved-video changes using full replacement after approval
- a two-step sync flow:
  - pull liked songs, compare them with disk, and match metadata
  - auto-download clean new matches, while showing proposed changes for destructive or modifying actions
- clear progress indicators for fetching, matching, metadata lookup, download, tagging, lyrics, and remote copy
- one active executor at a time, while still showing per-track steps for the currently running song and queued follow-up jobs
- visible errors, missing matches, already-present songs, and other concrete states before download
