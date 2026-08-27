# liked-music-syncer

Electron desktop app for syncing your YouTube liked videos into tagged local audio files.

It can:

- log into YouTube with Google OAuth
- pull liked videos
- optionally keep only `categoryId === "10"`
- try to match each track to a better YouTube Music source
- enrich every confidently matched song with MusicBrainz IDs and genre
- try synced lyrics via Spotify-match + lyrics API
- download audio with `yt-dlp`
- convert/tag output with `ffmpeg`
- write `.m4a` + optional synced-only `.lrc`
- optionally copy output to a VPS via `rclone`
- print sync diagnostics to process `stdout`/`stderr`
- mirror those same terminal diagnostics into per-launch temp log files
- import favorite artists from exact YT Music `albums` + `singles` release tracklists
- preserve separate album/single release variants instead of collapsing them
- skip liked-video duplicates against existing managed songs by normalized title + primary artist
- keep trusted YT Music title/artist/album metadata while using MusicBrainz to
  fill genre in all resolution paths and release metadata only as fallback

## Library index behavior

- The app opens with the last committed local inventory and starts a background
  filesystem reconcile on every launch.
- Local files and matching `.lrc` sidecars are the authority for existence and
  paths. The database is a rebuildable inventory.
- Sync, reprocess, and remote-copy work waits for a reconcile immediately before
  it reads local paths.
- Download and reprocess workers request another background reconcile when they
  finish, including after partial failure or cancellation.
- Concurrent requests share one active reconcile. A request received during that
  pass adds at most one trailing pass.
- A failed filesystem walk leaves the last committed inventory intact. The app
  reports the error and retries on the next launch or `Refresh Library` request.

See [`docs/local-library-index.md`](docs/local-library-index.md) for the
implementation contract.

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

- `npm` for `pnpm tools:fetch`
- optional `rclone` if using remote copy

`pnpm install` installs the app's pinned `ffmpeg` binary. A system installation is
not required.

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
- worker prefers lyrics in this order: YT Music synced, Spotify synced, YT Music plain, Spotify plain
- `.lrc` sidecars are only written for truly synced lyrics
- plain/unsynced lyrics stay embedded-only when enabled

## Lyrics sidecar repair

If old runs wrote bogus all-zero timestamp `.lrc` files, repair each filesystem root separately with:

```bash
uv run --project py python -m liked_music_syncer.fix_unsynced_lrc --root "/Users/mollicl/Downloads/music"
uv run --project py python -m liked_music_syncer.fix_unsynced_lrc --root "/Users/mollicl/Downloads/music" --apply
```

Run the same command again on the remote host using the remote library path there. Do not run this through `rclone`.

Behavior:

- dry-run by default
- scans LMS-managed files only by default
- rewrites bogus embedded all-zero timed lyrics to plain embedded lyrics
- deletes bogus sibling `.lrc`
- leaves valid synced `.lrc` untouched

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

The app starts the local bgutil provider automatically on sync start and points `yt-dlp` at `mweb` + the bundled PO-token plugin.

### Packaged app

Packaged builds include `ffmpeg` from the pinned `ffmpeg-static` dependency and
expect these bundled files:

- `resources/bin/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip`
- `resources/bin/bgutil-ytdlp-pot-provider/server/build/main.js`

If you package without the bgutil plugin/provider bundle, `yt-dlp` will fall back to the old behavior and YouTube may reject playback requests with bot-check errors.

## YouTube auth note

`Settings -> Auth mode` only controls how the app talks to the YT Music API.

- `OAuth device`: used for liked-song/library API access
- `Browser headers`: used for YT Music API requests only

`yt-dlp` playback/download auth is separate. The app now handles that through the bundled bgutil PO-token plugin/provider automatically. You do not need to paste a manual PO token into the UI.

In `Browser headers` mode, the app can derive YT Music auth from the selected `yt-dlp cookies browser` using the same browser-cookie extraction path as `yt-dlp`. The browser selector includes Zen and Helium in addition to yt-dlp's built-in browsers. Sign in at `music.youtube.com` in the selected browser and fully quit it before capturing auth if its cookie database is locked. Manual header paste remains available as fallback.

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

1. run `Liked Songs Sync` once
2. inspect the Library and Sync surfaces
3. inspect tabs:
   - `No Metadata`
   - `No Lyrics`
   - `Matched to YT Music`
   - `Not Matched to YT Music`
   - `Not in Music Category`
4. watch terminal diagnostics while the job executes, or inspect the per-launch temp log file
5. use `Reprocess Library` or `Reprocess Artist Songs` to preview modifications before approving them, or apply them directly when `Don't require approvals for modifications and deletions` is enabled

This is the fastest way to debug matching and reprocess diffs before approving updates, or to apply them immediately when approvals are disabled.

## Navigation

- App navigation is URL-backed with hash routes: `#/library`, `#/sync`, `#/settings`.
- Library drill-in state also lives in the URL, eg `#/library?tab=albums&artist=Radiohead` or `#/library?tab=songs&albumKey=...`.
- Electron back/forward now restores library tab/filter state.
- Artists, albums, and songs keep their mounted pane instances while switching library tabs, so scroll position and virtualized state persist within the library route.

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

## Diagnostics and local data

App data lives under Electron `userData`.

Important files:

- SQLite DB: `liked-music-syncer.db`
- temp launch logs: `<temp>/liked-music-syncer/logs/launch-<ISO-safe-timestamp>-pid-<pid>.log`

Logging format:

- `[timestamp] [level] [source] [runId?] [itemId?] message | key=value ...`
- `error` lines go to `stderr`
- `warn`/`info`/`debug` lines go to `stdout`
- parsed worker `log` events are mirrored into terminal as pretty `[worker]` lines
- same terminal lines are mirrored into one combined temp log file per app launch
- reprocess preview now emits incremental progress logs and flushes approval candidates in batches instead of staying silent until the full preview finishes
- persisted lines are prefixed with `[stdout] ` or `[stderr] `
- temp launch logs are not auto-cleaned up
- in TTY terminals, only `[warn]` and `[error]` tokens are colored
- color is disabled when output is redirected or `NO_COLOR` is set
- worker `run`/`item` NDJSON still stays internal and is not mirrored raw to terminal

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
- Packaging must preserve the unpacked `ffmpeg-static` binary configured in `electron-builder.yml`.
