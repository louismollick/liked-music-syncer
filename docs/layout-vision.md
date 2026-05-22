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
- inspect failures and logs without making debug output the main experience
- copy completed songs to a remote music server
- check setup and authentication state

## Current Product Shape

The current app is mainly a YouTube Music sync tool.

Current visible workflows include:

- YouTube Music authentication
- fetching liked songs
- starting and stopping sync work
- viewing progress, item statuses, item details, and logs
- viewing previous sync runs
- downloading and tagging songs locally
- dry-run checks
- selected artist reprocessing
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
- Recently added

The Library view should not include playback controls.

Library grid and list views should stay visually clean by default. They should not show local, remote, or matching status badges unless the user asks for that information through filters, detail views, or an inspection mode.

Source-contribution badges should not appear on Library grid or list cards by default.

Remote state belongs in Library as a filter and item detail, because it describes whether inventory exists on the remote music server. It should not be a separate Library subview.

Likely remote-state filters:

- Remote only
- Local only
- Remote present
- Remote missing
- Copy pending
- Copy failed
- Already in library

Likely concrete inventory and matching filters:

- Missing from local library
- Missing from remote library
- No YouTube Music match
- Already in library
- No longer liked
- Download failed
- Lyrics missing
- Album art missing
- Favorite artists only

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
- logs behind an expandable debug area

Song detail should show source contributions in the most detail. A compact badge row is acceptable on the detail page, with expandable rows for original liked item details such as platform, liked title, liked artist, URL or id, liked date if known, and match reason when available.

### Sync

Review newly discovered songs and manage download work.

Sync should show current and pending work, not a history organized around internal runs. If run history remains available, it should be a debug-only surface.

Sync should remain visible in primary navigation even when scheduled background sync exists.

Likely stages:

- setup check
- fetch liked songs
- match and compare
- review preview
- confirm download
- active progress
- completion summary

Likely content:

- newly discovered liked songs
- newly discovered favorite-artist songs
- songs ready to download
- proposed changes awaiting confirmation
- proposed cleanup awaiting confirmation
- downloads currently in progress
- finished downloads
- failed downloads
- timestamp of the last liked-song check
- manual check-now action
- download history
- failure history

Sync content should be organized by state sections rather than a timeline:

- Pending changes
- Downloading
- Downloaded
- Failed

The Sync header should show last checked time and a manual check-now action.

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
- Should active sync progress be a dedicated screen, a persistent bottom panel, or both?
- Should logs be hidden inside item details, grouped under a Debug section, or both?
- What does the review preview need to show before download?
- What proposed changes require confirmation before applying to existing library items?
- Which concrete inventory and matching filters belong in Library versus Sync?
- Should artist reprocessing live on artist pages, sync review, or both?
- How much of the current run-history UI remains visible in the main layout?

## Working Assumptions

- Library is the main product surface.
- Library means inventory and metadata, not playback.
- Library includes subnavigation for Albums, Artists, Songs, and eventually Playlists.
- Albums is the default Library view.
- Library grid and list views avoid status badge clutter by default.
- Library search is global across Albums, Artists, and Songs, with grouped results.
- Remote state is part of Library, not a top-level navigation area.
- Sync is a workflow, not the whole product.
- Sync focuses on discovered songs, confirmation, active downloads, and finished downloads.
- Clean new matches should auto-download by default.
- Confirmation is for destructive actions, existing-library modifications, and unresolved matching choices.
- Deleting songs that are no longer liked should be proposed cleanup only, not automatic.
- No longer liked means absent from all connected liked music libraries, not merely removed from one contributing platform.
- Reprocess actions belong on selected Library items such as artist, album, or song.
- Sync remains a primary navigation item.
- Sync shows last liked-song check time and allows a manual check for new songs.
- Sync includes item-oriented history for downloads and failures.
- Sync history should be grouped by song state, not internal run.
- Sync screen should use state sections instead of a timeline.
- Skipped is not a primary Sync bucket; already-known or already-present songs belong in Library inventory state.
- Favorite Artists extend desired library contents beyond individually liked songs.
- Favorite Artist MVP can mark artists already known from the library or liked-song discovery.
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
- Sync should stay visible in primary navigation as the place to inspect discovered songs, pending confirmation, active downloads, download history, failures, and last checked time.
- Sync should include songs discovered from Favorite Artists alongside songs discovered from liked music libraries.
- Sync should merge duplicate desired songs across liked music libraries and Favorite Artist discovery so a song is not downloaded twice.
- Scheduled background sync should focus on liked-song checks. Favorite Artist catalog refresh can be triggered manually to avoid heavy repeated catalog scans.
- Favorite Artist catalog refresh should not be a default Sync action; Sync can still show resulting discovered songs, downloads, and failures.
- Sync should not present "Skipped" as a main state. If a song already exists or needs no action, that should be visible through Library state instead.
- Existing songs are normally left alone. Reprocessing existing songs is an explicit user action from Library.
- Reprocessing can create proposed metadata, artwork, lyrics, or file changes that require confirmation before applying.
- Songs no longer found in liked music libraries can be shown as proposed cleanup, but the app should not auto-delete them.
- Multiple platforms can contribute to the same library item during the same sync. The UI should show all liked source contributions, not force a single original source.
- Album detail should summarize source contributions; song detail should show full source-contribution rows.
- Album identity should come from final library metadata. Liked source contributions explain provenance, not album grouping.
- Artist pages should use track artist by default. Album artist remains visible for album grouping and album detail.
- Debug and log viewing should be available, but not a main focus.
