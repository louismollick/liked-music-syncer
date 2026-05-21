# Product Vision

## Problem

Music likes are split across streaming platforms.

A user may like songs on YouTube Music, Spotify, SoundCloud, and other services. Each service keeps its own list. Some songs are official releases. Some are music videos. Some are fan uploads, reposts, or low-quality copies.

This makes it hard to build one clean local music library.

The app solves this by turning liked songs into a local collection of clean, tagged music files that can be used in apps like Navidrome or Plex.

## Goal

The ideal app is a desktop tool for building and maintaining a personal local music library from liked songs.

The user connects their music accounts. The app reads the liked songs from each platform, removes duplicates, finds the best official version of each song, downloads it, and adds rich metadata.

The result should be a local library with:

- correct song titles
- correct artists and albums
- album art
- release year
- genre
- synced lyrics when available
- clean album versions instead of unofficial or video versions

The app should also keep a remote music server in sync. A user with Navidrome, Plex, or a similar server on a VPS should be able to send the finished songs there without a separate manual step.

## Ideal User Journeys

### 1. Build a Clean Local Library From All Liked Songs

The user connects their music accounts, such as YouTube Music, Spotify, and SoundCloud.

The app fetches every liked song from each account. It combines the lists, removes duplicates, and creates one clean queue.

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

The user starts a sync and watches progress in the desktop app.

They can see which songs completed, failed, or were skipped. They can inspect a song to see its source, metadata, lyrics status, output path, and logs.

Past runs stay available so the user can review what happened later.

### 5. Reprocess a Specific Artist

The user can refresh the list of artists found in their liked songs.

They can select one or more artists and reprocess only those songs. This helps fix or improve part of the library without running the full sync again.

### 6. Test Setup Before a Real Download

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

The app should become a library viewer first, with sync controls built around review and confirmation.

It should add:

- library search across songs, albums, and artists
- artist pages with photos, metadata, and discography
- album pages with album art, release metadata, and track lists
- song pages with tags, lyrics state, file paths, source platform, original liked song, resolved YouTube video, and processing result
- image-heavy browsing, closer to a music player than a log viewer
- debug views for logs and processing history, kept out of the main path
- a two-step sync flow:
  - pull liked songs, compare them with disk, match metadata, and show a review preview
  - confirm the preview, then download and write files
- clear progress indicators for fetching, matching, metadata lookup, download, tagging, lyrics, and remote copy
- visible errors, missing matches, skipped songs, and low-confidence matches before download
