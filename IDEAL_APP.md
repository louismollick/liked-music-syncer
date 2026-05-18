# Ideal App

## Overview

Liked Music Syncer is a desktop app that pulls liked songs from many music platforms and turns them into one clean local library.

The main goal is simple: take songs you liked on services like YouTube Music, Spotify, and SoundCloud, download them as local files, and make them ready for music servers and players such as Navidrome or Plex.

## Problem

Liked songs are spread across many platforms. You do not own those files. The same song may appear many times. Some uploads are fan-made, low quality, or use the wrong version. Metadata is often missing or wrong.

This app solves that by building one local library from all of your liked songs. It deduplicates tracks, picks the best version, downloads the audio, and tags it with clean metadata.

## Core Features

### Connect Multiple Platforms

The app connects to music platforms such as YouTube Music, Spotify, and SoundCloud. It reads the liked or favorites list from each service.

### Merge All Likes Into One Library

The app combines all liked songs into one collection. It should treat this as one library, not a set of separate platform exports.

### Deduplicate Matching Songs

The app detects when two or more liked items are really the same song. It should merge them into one final track entry.

### Pick the Best Version

When many versions of a song exist, the app should keep the best one. In most cases, that means the official track, album version, or clean release version.

### Replace Unofficial Uploads

The app should replace weak sources with better ones before download.

Examples:

- replace a YouTube music video with the official YouTube Music track if the video has extra intro or outro sections
- replace a fan-uploaded SoundCloud track with an official release from a better source
- replace duplicate uploads with the most official and complete version

The goal is to keep the song the user meant to save, not the exact upload they first liked.

### Download Local Audio Files

The app downloads each final track as a local audio file. The result should be a usable offline library that the user owns and can move anywhere.

### Enrich Files With Metadata

Each file should be tagged with clean metadata so it works well in local libraries and media servers.

Important fields include:

- title
- artist
- album artist
- album
- track number
- disc number
- year
- genre
- album cover
- synced lyrics

### Support Local Music Libraries

The downloaded library should be easy to use with systems like Navidrome or Plex. File layout, tags, and artwork should be good enough for these tools to index with little or no cleanup.

### Transfer Files To A Remote Server

The app should support sending downloaded songs to a remote VPS over SSH. This makes it easy to keep a remote Navidrome or Plex server in sync without a separate manual step.

### Show Match Decisions

Matching songs across platforms is not perfect. The app should show what it matched, what it replaced, and what needs review. Users should be able to inspect low-confidence cases and override them.

### Keep Syncing Over Time

The app should support repeat syncs. New liked songs should be added. Existing songs should not be downloaded twice unless a better version is found.

## Ideal User Flow

1. Connect music accounts.
2. Import liked songs from each platform.
3. Let the app merge duplicates and pick the best version of each song.
4. Download the songs with clean tags and lyrics.
5. Save them to the local library and, if enabled, push them to a remote VPS over SSH.

## Appendix: Decided Technologies And Methods

- Desktop app built with Electron
- UI built with Vite, TypeScript, and React
- Audio downloads handled by the Python `yt-dlp` package
- Synced lyrics fetched from a deployed version of <https://github.com/akashrchandran/spotify-lyrics-api>

## References

- `spotdl`: <https://github.com/spotdl/spotify-downloader>
- `shira`: <https://github.com/KraXen72/shira>
