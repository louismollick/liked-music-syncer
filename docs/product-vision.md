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

They can see which songs are discovered, waiting for confirmation, downloading, complete, or failed. They can inspect a song to see its source, metadata, lyrics status, output path, local state, remote state, and logs.

The user should not need to understand internal sync runs. Over time, sync should be able to run automatically on a schedule in the background, with the app surfacing the current library state and concrete problems that need action.

The user should still be able to open Sync to see when likes were last checked, manually check now for new songs, review what was downloaded, inspect failures, and confirm proposed changes before they modify existing library content.

### 5. Reprocess a Specific Artist

The user can refresh the list of artists found in their liked songs.

They can select one or more artists and reprocess only those songs. This helps fix or improve part of the library without running the full sync again.

Reprocessing should also be available from selected library items such as an artist, album, or song. If reprocessing finds metadata, artwork, lyrics, or file changes for existing library content, the app should show proposed changes before applying them.

### 6. Build a Library From Favorite Artists

The user can mark artists as favorites.

The app treats favorite artists as another source of desired songs. It can discover the artist's official main catalog, match clean versions, and download them using the same pipeline as liked songs.

The MVP can limit favorite selection to artists already known from the library or liked-song discovery. The target behavior should let the user search for and add any artist.

Favorite Artist discovery should deduplicate against liked songs and other source contributions so the same song is not downloaded twice.

Favorite Artist catalog refresh should be manual for now, because full catalog discovery can be request-heavy and artists release new songs less often than users add new liked songs.

The user can filter Artists to show only favorites.

The user can refresh one favorite artist from Artist detail, or refresh multiple favorite artists from the favorites-filtered Artists view.

### 7. Test Setup Before a Real Download

The user can run a dry run to check matching and metadata without writing final songs.

They can also check required tools, auth, and remote copy settings before starting a full sync.

## Current Features

The current app is a desktop sync tool focused on YouTube Music.

It can:

- pull YouTube Music auth from a selected browser
- save and clear auth
- fetch liked songs from YouTube Music
- start, stop, and inspect sync runs
- show run progress, item status, item details, and logs
- keep a history of previous runs
- download songs locally
- enrich songs with metadata
- add album art when found
- add lyrics when found
- write synced lyric sidecar files
- embed unsynced lyrics
- use custom folder and file naming templates
- skip work for songs already processed
- run in dry-run mode for metadata-only checks
- refresh liked-song artists
- reprocess selected artists
- copy finished songs to a remote music folder
- find local songs missing from the remote folder
- copy missing remote songs after review
- check local tools and app setup with doctor checks
- clear sync history, item logs, and processed-song memory while keeping settings and auth

The current app does not yet provide the full ideal multi-platform flow. Spotify and SoundCloud are part of the intended vision, but the visible app experience today centers on YouTube Music liked songs.

## Future Features

The app should become a library inventory viewer first, with sync controls built around review and confirmation.

It should add:

- global library search across songs, albums, and artists, with grouped results
- artist pages based on track artist metadata, with photos, metadata, and discography
- favorite artist selection, full-catalog discovery, and an Artists filter for favorites
- manual Favorite Artist catalog refresh, separate from scheduled liked-song checks
- album pages with album art, release metadata, and track lists based on final library metadata
- song pages with tags, lyrics state, file paths, detailed liked source contributions, resolved download source, and processing result
- album pages that summarize which liked music libraries contributed songs on the album
- image-heavy browsing, closer to a music player than a log viewer
- debug views for logs and processing history, kept out of the main path
- scheduled background sync, with internal runs hidden from the primary user experience
- a visible Sync area for last checked time, manual check-now, pending work, download history, and failures
- automatic download for clean new matches by default
- confirmation before destructive actions or modifications to existing library content, such as deleting songs no longer liked or updating metadata on existing files
- proposed cleanup for songs no longer found in liked music libraries, with deletion requiring confirmation
- a two-step sync flow:
  - pull liked songs, compare them with disk, and match metadata
  - auto-download clean new matches, while showing proposed changes for destructive or modifying actions
- clear progress indicators for fetching, matching, metadata lookup, download, tagging, lyrics, and remote copy
- visible errors, missing matches, already-present songs, and other concrete states before download
