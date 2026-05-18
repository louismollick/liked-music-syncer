# liked-music-syncer

Electron desktop app for syncing your YouTube liked videos into tagged local audio files.

It can:

- log into YouTube with Google OAuth
- pull liked videos
- optionally keep only `categoryId === "10"`
- try to match each track to a better YouTube Music source
- try MusicBrainz metadata matching
- try synced lyrics via Spotify-match + lyrics API
- download audio with `yt-dlp`
- convert/tag output with `ffmpeg`
- write `.m4a` + optional `.lrc`
- optionally copy output to a VPS via `rclone`
- write per-run logs and per-song debug logs

## Current setup model

There is no `.env` file right now.

Runtime config is entered in the app UI:

`Settings` tab:

- `Output directory`
- `Google client ID`
- `Google client secret`
- `Lyrics API base URL`
- optional `rclone remote`
- optional `remote music root`
- feature toggles

Secrets are stored through Electron `safeStorage` when available.

## Requirements

Local dev:

- Node `22+`
- `pnpm`
- macOS arm64 tested

Needed tools:

- `ffmpeg`
- `npm` for `pnpm tools:fetch`
- optional `rclone` if using remote copy

App/runtime services:

- Google OAuth desktop app credentials
- a lyrics API URL compatible with the `lyricbridge` Spotify/LRC flow

## Credentials you need

### 1. Google OAuth client

You need a Google OAuth client that can access YouTube Data API.

Create in Google Cloud:

1. Create/select a Google Cloud project.
2. Enable `YouTube Data API v3`.
3. Configure OAuth consent screen.
4. If the consent screen is in `Testing`, add your Google account under `Test users`.
5. If using a Google Workspace org and the app is `Internal`, make sure the login account is inside that workspace.
6. Create an `OAuth client ID`.
7. Choose `Desktop app`.
8. Copy:
   - `Client ID`
   - `Client secret`

If you see:

`liked-music-syncer has not completed the Google verification process`

that usually means the account you used to log in is not approved yet.

Approve it here:

1. Open Google Cloud Console.
2. Go to `APIs & Services` -> `OAuth consent screen`.
3. Find `Audience`.
4. If app status is `Testing`, add your Gmail under `Test users`.
5. Save.
6. Wait a minute or two.
7. Retry `Login with Google` in the app.

For personal use, you do **not** need full Google verification if you only use `Testing` mode with approved test users.

Put them in the app:

- `Settings` -> `Google client ID`
- `Settings` -> `Google client secret`

Then click `Login with Google` in the app.

### 2. Lyrics API URL

You need the same style of lyrics endpoint used by your `lyricbridge` workflow.

Expected behavior:

- app calls `GET <LYRICS_API_BASE_URL>?trackid=<spotifyTrackId>&format=lrc`
- endpoint returns synced line data

Put it in:

- `Settings` -> `Lyrics API base URL`

### 3. Optional remote copy config

Only needed if you want VPS copy.

You need:

- a working `rclone` install on PATH
- a configured `rclone` remote, typically SFTP
- remote music root path

Put them in:

- `Settings` -> `rclone remote`
- `Settings` -> `remote music root`

## Tool binaries

### Dev mode

Prepare bundled yt-dlp PO-token assets:

```bash
pnpm tools:fetch
```

That now fetches/builds:

- `resources/bin/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip`
- `resources/bin/bgutil-ytdlp-pot-provider/server/build/main.js`
- `resources/bin/README.txt`

Then add `ffmpeg` manually:

- `resources/bin/ffmpeg`

The app starts the local bgutil provider automatically on sync start and points `yt-dlp` at `mweb` + the bundled PO-token plugin.

### Packaged app

Packaged builds expect these exact bundled files:

- `resources/bin/ffmpeg`
- `resources/bin/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip`
- `resources/bin/bgutil-ytdlp-pot-provider/server/build/main.js`

If you package without it, packaged audio fixup/convert will fail.

If you package without the bgutil plugin/provider bundle, `yt-dlp` will fall back to the old behavior and YouTube may reject playback requests with bot-check errors.

## YouTube auth note

`Settings -> Auth mode` only controls how the app talks to the YT Music API.

- `OAuth device`: used for liked-song/library API access
- `Browser headers`: used for YT Music API requests only

`yt-dlp` playback/download auth is separate. The app now handles that through the bundled bgutil PO-token plugin/provider automatically. You do not need to paste a manual PO token into the UI.

In `Browser headers` mode, the app can now derive YT Music auth from the selected `yt-dlp cookies browser` using the same browser-cookie extraction path as `yt-dlp`. Manual header paste remains available as fallback.

## Install

```bash
pnpm install
```

If native SQLite binding is missing after install:

```bash
pnpm rebuild better-sqlite3
```

## First run

1. Start the app:

```bash
pnpm dev
```

2. Open `Settings`.
3. Set `Output directory`.
4. Enter `Google client ID`.
5. Enter `Google client secret`.
6. Enter `Lyrics API base URL`.
7. Optionally enable:
   - `Only process categoryId === 10`
   - `Dry run`
   - `Prefer YT Music official source`
   - `Enable remote copy`
   - `Enable background polling`
8. Save settings.
9. In Google Cloud, confirm your login email is added as a test user if consent screen is `Testing`.
10. Click `Login with Google`.
11. Complete browser OAuth flow.
12. Run `pnpm tools:fetch` if you have not already.
13. Click `Start Sync`.

## Recommended first test

Use this order:

1. set `Dry run = on`
2. run sync once
3. inspect tabs:
   - `No Metadata`
   - `No Lyrics`
   - `Matched to YT Music`
   - `Not Matched to YT Music`
   - `Not in Music Category`
4. use `Copy Song Logs` on a few rows
5. turn off dry run
6. run again

This is the fastest way to debug matching before downloading media.

## Commands

Dev:

```bash
pnpm dev
```

Format:

```bash
pnpm format
```

Lint:

```bash
pnpm lint
```

Typecheck:

```bash
pnpm typecheck
```

Tests:

```bash
pnpm test
```

Build app code:

```bash
pnpm build
```

Package macOS app:

```bash
pnpm package
```

Other package targets:

```bash
pnpm build:win
pnpm build:linux
pnpm build:unpack
```

## Logs and local data

App data lives under Electron `userData`.

Important files:

- SQLite DB: `liked-music-syncer.db`
- run logs: `logs/<runId>/run.log`
- structured logs: `logs/<runId>/run.ndjson`

The UI `Copy Song Logs` button copies only that song's log lines for the selected run.

## What each diagnostic tab means

- `No Metadata`: no accepted MusicBrainz / better metadata match; fallback metadata used
- `No Lyrics`: no synced lyrics found or fetched
- `Matched to YT Music`: original liked video replaced by a stronger YT Music source
- `Not Matched to YT Music`: replacement was attempted or considered, but original source kept
- `Not in Music Category`: filtered because `categoryId !== "10"` while category filter enabled

## Known practical caveats

- Google OAuth login requires valid desktop-app credentials, not web-app creds.
- The app currently depends on a separate lyrics API; it does not ship one.
- Remote copy currently assumes `rclone` is already configured outside the app.
- Packaged builds need bundled `ffmpeg`.
