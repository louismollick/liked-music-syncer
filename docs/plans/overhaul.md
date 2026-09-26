# Overhaul plan

Status: draft for review. Owner decisions come from the grilling session on 2026-09-25/26 and are recorded in `CONTEXT.md` and ADRs 0002 to 0006. This plan says how to build them.

## Goal

Rebuild Liked Music Syncer as a TypeScript-only Electron app that other people can install. It keeps a local music library in sync with the user's YouTube Music likes and Favorite Artist catalogs, optionally mirrors it to an rclone remote, and shows the work as a live per-track Activity view. The UI follows wireframe v4 (`docs/plans/wireframes-v4.html`, a clickable low-fidelity prototype; summarised in "UI" below).

Done means:

- The Python worker, the ExifTool scanner, the SSH scanner, and the job model are gone.
- A new user can install the app, sign in to YouTube Music inside it, pick a folder, and get their liked songs downloaded, tagged, and optionally uploaded, without installing Python, uv, ExifTool, or anything on their server.
- The existing library (LMS tag schema v5) is adopted in place without re-downloading audio.
- CI runs lint, typecheck, and tests on every push, and it is green.

## Settled product decisions

| Topic | Decision |
|---|---|
| Audience | Real app for other people; no users yet, so no backward compatibility beyond adopting existing files. |
| Platforms | macOS (arm64 and x64) first. Code stays portable; macOS-specific code lives behind one platform module. |
| Sources | YouTube Music liked songs and Favorite Artist catalogs. The source seam is shaped so Spotify liked songs can be added later, but no Spotify source ships now. |
| Liked Music Library | YouTube Music's Liked Music playlist (`LM`). Generic YouTube likes that YouTube Music hides are not included. |
| Lyrics order | Synced first: Spotify (through the optional lyrics server), then YouTube Music, then LRCLIB. Then plain lyrics in the same order. One "Find lyrics" switch turns all lookups off. |
| Lyrics files | Synced lyrics always get an `.lrc` sidecar. Whatever lyrics exist are always embedded. No toggles. |
| Output folder | App-owned. Only Managed Files (LMS tags) are in the Library. Unmanaged Files are listed, never merged. Outside Edits are reported and can be rewritten. |
| Folder layout | Fixed. Release tracks: `{albumartist}/{album}/{track:02d} {title}.m4a`. Standalone Tracks: `{artist}/{title}/{title}.m4a`, album tag = title, track 1/1. No template settings. |
| Remote | Any rclone remote. Only the app writes to it. Routine checks compare `rclone lsjson` size and modification time with upload records. A full hash check (`lsjson --hash`, which makes SFTP servers read every file) runs only after the database is rebuilt or when the user asks. No program runs on the server. |
| Work model | Reconciler over the Desired Library (ADR 0006). One track in flight at a time. |
| Identity | Release ID plus source video ID; video ID alone for Standalone Tracks (ADR 0002). |
| Refresh | User-requested only, for a song, album, artist, or everything. Tag rewrites from the saved Match happen automatically and need no network. No automatic lyrics retries. |
| Failures | Transient failures retry with backoff, then become Needs Attention. Permanent failures go straight to Needs Attention. |
| No Longer Wanted | Kept until the user deletes them from a filter in the Songs list. |
| Background | Work runs only while the app is open. The app checks liked songs at launch and every 30 minutes while open, plus the manual refresh button. Favorite Artist catalogs are checked when an artist is favorited, on the "Refresh Favorite Artist catalogs" command, on an artist's Refresh, and at launch when the last check is older than 24 hours. |
| Sign-in | In-app Google sign-in only (ADR 0004). No installed-browser cookie reading. |
| Existing data | Files adopted in place. Fresh database; nothing else carried over. |
| Setup | No wizard. The empty Library shows "Sign in to YouTube Music" and "Choose a folder". |
| Rewrite strategy | New app built from scratch on one long-running branch, replacing `py/` and the old `src/` in one PR. |

## Architecture

Everything runs in the Electron main process except the renderer. Three external binaries: yt-dlp (official standalone release, self-updating in `userData`), ffmpeg (`ffmpeg-static`), rclone (bundled per architecture). The bgutil PO token provider keeps running as a Node script under Electron's Node mode, as it does today.

### Modules

Each module below has a small interface and hides a lot. Names use `CONTEXT.md` terms. Tests go through each module's interface.

1. **Google Session** (`src/main/session/`). Owns the persistent `persist:ytmusic` Electron session, the sign-in window, cookie reads, SAPISIDHASH authorization, and YouTube Music Account discovery and selection (probing `X-Goog-AuthUser` slots as today). Interface: `status()`, `openSignIn()`, `signOut()`, `accounts()`, `selectAccount(id)`, `requestHeaders()`. A dev-only cookie importer (`LMS_DEV_IMPORT_COOKIES=zen`, refused when `app.isPackaged`) copies YouTube cookies from a local Zen profile into the partition so automated verification can run without a human sign-in.

2. **YouTube Music catalog** (`src/main/catalog/`). All YouTube Music reads: liked songs with continuation paging, album, artist, the artist's full album and single lists, song search, watch playlist (lyrics browse ID), timed and plain lyrics, account info, artist images. Implementation: youtubei.js for the Innertube session and request signing, with response parsers ported from ytmusicapi (MIT) so shapes match what the matching code expects. Timed lyrics use a raw `browse` call with the Android Music client, as ytmusicapi does. Interface returns plain typed objects (`CatalogTrack`, `CatalogRelease`, `CatalogArtist`, `Lyrics`). Tests run the parsers against recorded JSON fixtures of public pages; personal responses (liked songs, account) are synthesized, never committed from the real account.

3. **Matcher** (`src/main/match/`). Turns a Source Contribution into a Match: which catalog track and Release, MusicBrainz recording ID and genre, and the artist credits. Ports the Python resolution rules: official-source preference, title normalization (NFKC plus case folding), a faithful `SequenceMatcher` port for similarity thresholds, and the MusicBrainz 1 request per second throttle. Liked videos without a catalog match become Standalone Tracks. Interface: `match(contribution) -> Match`, with the catalog and MusicBrainz clients injected. Tests use fakes of both plus golden cases recorded from the Python implementation before it is deleted.

4. **Lyrics finder** (`src/main/lyrics/`). Implements the lyrics order above. Spotify track lookup ports the web token TOTP flow and search scoring; the lyrics text comes from the configured lyrics server (`GET <url>?trackid=<id>&format=lrc`). LRCLIB uses `/api/get` then `/api/search`. Classifies text as synced or plain with one shared rule, rejects all-zero timestamp LRC, and detects language with `eld` on the lyrics text. Interface: `find(track) -> { text, synced, source, language } | null`.

5. **Tag schema** (`src/main/tags/`). The single definition of every tag the app writes and reads, built on node-taglib-sharp: standard MP4 atoms, the raw `©day` date string (keeps `YYYY`, `YYYY-MM`, `YYYY-MM-DD`), cover art, lyrics, and the `----:com.apple.iTunes:LMS_*` freeform atoms. Interface: `readTags(path) -> TagFields`, `writeTags(path, TagFields)`, `fieldDiff(a, b) -> string[]`. Writes `LMS_TAG_SCHEMA_VERSION=6`; reads v5 files for adoption. Tests round-trip a real `.m4a` generated with ffmpeg in the test setup.

6. **Audio acquisition** (`src/main/acquire/`). Downloads with the yt-dlp binary (`-f bestaudio/best`, `mweb` client, bgutil plugin directory, Electron-as-Node JS runtime, no cookies), converts to AAC `.m4a` with ffmpeg only when needed, crops cover art square (Electron `nativeImage`: trim uniform border, center crop, JPEG), writes tags, then moves the file into place with a same-directory temp file and `rename`, so a crash never leaves a half-written file at the final path. Reports byte progress. Interface: `acquire(match, lyrics, destination, onProgress) -> ManagedFileRecord`, plus `retag(file, fields)` for network-free tag rewrites. Also owns the yt-dlp binary: download on first use to `userData/bin`, `--update-to stable` at most once a day.

7. **Library store** (`src/main/library/`). SQLite through better-sqlite3 and Drizzle, with numbered migrations that never drop user data. Owns tracks, Source Contributions, Managed File records, upload records, artists, favorites, settings, and Unmanaged File listings. Also owns the scanner: walk the output folder, read tags of `.m4a` files, classify Managed vs Unmanaged, detect Outside Edits (size, mtime, then content hash), and rebuild tracks from LMS tags when the database is empty. Interface is query and command methods used by the reconciler and IPC; the renderer never sees table rows directly.

8. **Remote Library** (`src/main/remote/`). rclone wrapper: `list({ hashes })` via `lsjson --recursive --files-only` (adding `--hash` only for full checks), `upload(local, remotePath)`, `move`, `delete`. Records what was uploaded (content hash plus tag fields). Uploads use `copyto` with modification times preserved and are followed by a hash check of that one file. Computes Remote State per track: in sync, stale (the local file changed since the upload record, with the field diff), missing, uploading, failed. A remote file whose size or modification time no longer matches its upload record is treated as stale and replaced. When no upload record exists or a remote hash matches none, it downloads that one file to a temp dir and reads its tags. Tests use rclone's local backend against temp directories.

9. **Reconciler** (`src/main/reconcile/`). The heart of the app. Computes the Desired Library from active Source Contributions, compares each Desired Track with its Managed File and remote copy, and derives the next Track Step: match, acquire, retag, move, upload. Runs one track at a time through its remaining steps, newest Liked Date first, then catalog tracks by release date, persists progress after each step, retries transient failures (1 min, 5 min, 30 min), then marks Needs Attention. Emits Activity events. Interface: `checkSources()`, `refresh(scope)`, `retry(trackId)`, `deleteTracks(ids, where)`, `snapshot()`, `subscribe(listener)`. Tests run the reconciler with in-memory fakes for catalog, matcher, acquisition, and remote.

10. **App shell** (`src/main/index.ts`, `src/main/ipc.ts`, `src/preload/`). Window lifecycle (IPC keeps working after the window is closed and reopened), one typed IPC surface defined with zod schemas in `src/shared/ipc.ts` and validated in main, `app-media://` protocol for cached artwork, the 30-minute check timer, and orderly shutdown (stop the worker, kill child processes, never leave a detached process).

### Identity and Source Contributions

- A Source Contribution row is created per liked video (`ytm-liked:<videoId>`) and per Favorite Artist catalog track (`catalog:<artistId>:<releaseId>:<videoId>`). It records `firstSeenAt`, the platform's liked-list position, and whether it is still active.
- Liked contributions have no identity until matched. The Match step computes the identity key: `<releaseId>:<videoId>` when a Release is known, else `video:<videoId>`. If a track with that key exists, the contribution links to it (merge); otherwise a new track is created.
- Catalog contributions already carry release and video IDs, so their identity is known at discovery.
- Liked Date for a track is the earliest `firstSeenAt` among its active liked contributions, ordered within the same day by liked-list position. Catalog-only tracks show "Catalog".
- A track with no active contribution becomes No Longer Wanted, but only after a successful liked-songs check has completed since launch. Adopted tracks never flip to No Longer Wanted before that first check links their contributions.
- Un-favoriting an artist deactivates that artist's catalog contributions.
- Deleting No Longer Wanted tracks is an explicit user action from the Songs list with a choice of local, remote, or both. It removes the file, its `.lrc`, the upload, and the track row.
- Albums are grouped by (album, album artist) from track metadata. Artists come from track credits: `channel:<id>` when YouTube Music gives a channel ID, else `name:<normalized>` as an Unidentified Artist. Artist images come from the catalog artist page and are cached in `userData`; Unidentified Artists get none.

### Data model (SQLite)

- `tracks`: id, identity_key (unique, nullable until matched), title, artist_credits (JSON), album, album_artist, release_id, release_kind, track_number, track_total, disc_number, disc_total, date, year, duration_seconds, genre, isrc, mb_recording_id, language, lyrics_status, lyrics_source, cover_url, match (JSON, versioned), state, current_step, attempts, next_attempt_at, last_error, last_error_kind, completed_at, created_at, updated_at.
- `contributions`: id, source_key (unique), kind, track_id (nullable), source_video_id, release_id, artist_id, liked_position, first_seen_at, active, raw (JSON: the source-side title and artist for display before matching).
- `files`: track_id (unique), relative_path, size, mtime_ms, content_hash, tag_fields (JSON), lrc_hash, written_at.
- `uploads`: track_id (unique), remote_path, content_hash, lrc_hash, tag_fields (JSON), uploaded_at.
- `unmanaged_files`: relative_path, size, mtime_ms, seen_at.
- `artists`: id (`channel:<id>` or `name:<normalized>`), name, image_path, favorite, favorited_at, catalog_checked_at.
- `track_artists`: track_id, artist_id, position.
- `settings`: key, value, encrypted.
- `meta`: schema bookkeeping for Drizzle migrations.

### Track states and steps

`state` is one of `pending`, `working`, `done`, `needs_attention`, `no_longer_wanted`. The reconciler derives the next step from facts, not from a stored plan:

1. No Match, or a Refresh was requested: **match** (catalog, MusicBrainz, lyrics lookup).
2. No Managed File, or the audio is missing: **acquire**.
3. Managed File tag fields differ from the fields the Match implies: **retag** (no network).
4. Managed File path differs from the layout path: **move** (local rename, plus remote move if uploaded).
5. Remote enabled and upload record missing, stale, or remote hash mismatch: **upload**.

The Activity UI groups these into three visible stages: Matching (match), Downloading (acquire, retag, move), Uploading (upload). Progress is weighted 15/70/15 and uses real byte progress for downloads and uploads.

### Adoption of the existing library

On first run with an empty database, the scanner reads every `.m4a` in the folder. Files with `LMS_TAG_SCHEMA_VERSION` become tracks with a Match rebuilt from tags (release ID, source and resolved video IDs, credits, MusicBrainz ID, lyrics status) and are marked done. Their contributions get linked on the first liked-songs check. Files whose path differs from the fixed layout (for example Standalone Tracks under `Unknown Album` with job-index track numbers) get a move step and a retag (album becomes the title, track 1/1). Everything else is an Unmanaged File. This path is tested on a copy of the real library before the PR is opened.

## UI

Reference: wireframe v4. Dark only. One radius (6px) for buttons, inputs, chips, artwork, panels, and palette. No pill shapes. No cards inside cards; surfaces are flat and separated by hairlines (`rgba(255,255,255,.07)`). Accent is white. Status colors: sky for stale, orange for missing, amber for needs attention, emerald for up to date.

- **Sidebar**: "Liked Music" title with back and forward buttons. Below it, a status section ruled off with lines. Busy and not on Activity: current track art, title, step and percent, a 2px progress bar, "N up next". On Activity, or when idle: a status line ("Working · N up next" or "Up to date"), "Liked songs checked X ago", and a large refresh button that starts a check. Then nav with icons: Artists, Albums, Songs, gap, Activity (with needs-attention count), Settings. Account at the bottom.
- **Search**: a small box in the top-right corner of the main area and ⌘K both open the command palette. The palette searches artists (deduplicated by Artist identity), albums, and songs, and runs commands (check liked songs now, refresh Favorite Artist catalogs, open settings).
- **Root lists** (Artists, Albums, Songs): title with count beside it, a filter row of chips plus "+ Filter". Filters are URL-backed. Artists grid favorites on hover. Songs table columns: cover plus title and artist link, album link, year, narrow lang, time, status icons (lyrics synced, plain, none; remote cloud dark when in sync, sky when stale, orange when missing; amber circle for needs attention), Liked date with year ("Sep 24, 2026") or "Catalog". Quick filters: Needs attention, No longer wanted (with bulk delete), Unmanaged.
- **Hierarchy pages**: Artist page (artwork-tinted header, Favorite and Refresh buttons, albums grid, Standalone tracks table). Album page (cover, year, artist link, Refresh, track list). A small breadcrumb of ancestors sits above the page title. No filters on these pages. Back and forward follow browser history.
- **Song panel**: slides in from the right. Artwork, title, artist and album links, why it's here (contributions with Liked Date), Match (catalog ID, Release, genre source), lyrics (status, source, language), files (local path, remote state with field diff), Refresh and Show in Finder buttons.
- **Activity**: same title style as other pages, "N need attention" button beside the title opens a right-side drawer with plain-language reasons and Retry. Below, one scrolling column like synced lyrics: done tracks from the last 7 days grouped by day, the current track highlighted with one step label and a bottom progress bar, then up-next tracks fading out. No per-row labels. The user can scroll freely; the view re-centers on track change only if the current row was visible and the user has not scrolled in the last 1.5 seconds. Clicking a done track opens Songs with that song's panel.
- **Settings**: one page of rows separated by lines, no boxes. YouTube Music account (switch, sign out), Library folder, Remote (upload switch, rclone remote, remote folder), Lyrics (Find lyrics switch, optional Spotify lyrics server URL).
- **Empty state**: "Sign in to YouTube Music" and "Choose a folder" buttons in the Library until both are done.

Implementation: React 19, Tailwind 4, TanStack Router (hash history), TanStack Virtual for grids and tables, base-ui primitives only where they help (menus, dialogs). A small `ui/` kit (Button, Input, Switch, Chip, Drawer, Palette, Table) enforces the radius and hairline rules. State: a thin store per IPC stream (library snapshot, activity snapshot, session status) with incremental updates; no full re-fetch of every track on each event.

## IPC

Defined once in `src/shared/ipc.ts` with zod. Invokes: `session.*`, `library.query` (paged, filtered, sorted track lists; artists; albums; one track detail), `library.setFavorite`, `library.delete`, `reconcile.check`, `reconcile.refresh`, `reconcile.retry`, `settings.get`, `settings.update`, `settings.chooseFolder`, `app.showInFinder`. Events: `activity` (current track progress at most 10 per second, queue changes, completions), `library.changed` (changed track IDs), `session.changed`. The renderer asks for what it shows instead of receiving whole snapshots.

## Build, packaging, CI

- `pnpm tools:fetch` downloads the bgutil plugin and provider (checksummed) and rclone for the host architecture. yt-dlp is not bundled; the app downloads it on first use and verifies the release's SHA-256 sums file.
- electron-builder: real `appId` (`com.louismollick.likedmusicsyncer`), hardened runtime, notarization wired to environment variables (skipped when absent), `extraResources` for rclone and bgutil. No `py/`.
- GitHub Actions on push and pull request, `ubuntu-latest`: pnpm install, biome check, typecheck (node, web, tests), vitest. Tests needing ffmpeg use `ffmpeg-static`; tests needing rclone download it in a setup step.
- Delete: `py/`, `mypy.ini`, ExifTool and uv references, unused npm deps (`googleapis`, `ytmusic-api`, `musicbrainz-api`), ESLint and Prettier leftovers, `reports/`.

## Milestones

Each milestone ends with passing tests. Straightforward backend modules can be delegated to Codex with a precise interface spec and fixtures; the UI is built here.

0. **Spikes** (half a day each, keep notes in the PR description):
   - youtubei.js with cookies from the Electron session: liked songs paging past 5000? (ytmusicapi caps at the requested limit), album, artist albums with continuation, timed lyrics via Android Music client.
   - yt-dlp standalone binary with `--js-runtimes node:<electron binary>` and `ELECTRON_RUN_AS_NODE=1`, plus the bgutil plugin, on a real video. Fallback: bundle Deno.
   - node-taglib-sharp: read a real v5 file from the library copy, round-trip every LMS freeform atom, raw `©day`, cover, lyrics.
   - `rclone lsjson --hash` on the local backend and on SFTP (read-only listing of a scratch path only).
1. **Foundation**: new `src/main` skeleton, Drizzle schema and first migration, settings with safeStorage, zod IPC, window lifecycle, CI workflow.
2. **Session and catalog**: sign-in window, dev cookie import, account probing; catalog adapter and parsers with fixtures.
3. **Tags and acquisition**: tag schema module, yt-dlp manager, download, convert, cover crop, atomic placement.
4. **Matcher and lyrics**: port resolution rules and golden tests; lyrics finder with the three providers.
5. **Library store and adoption**: scanner, Managed vs Unmanaged, Outside Edit detection, adoption of v5 files, layout moves.
6. **Remote**: rclone wrapper, upload records, Remote State, fallback read.
7. **Reconciler**: step derivation, executor, retries, Activity events, 30-minute check, Refresh scopes, delete.
8. **Renderer**: new UI kit and every screen from wireframe v4, driven by real IPC.
9. **Cut over**: delete old code and Python, update README and docs (`docs/local-library-index.md` rewritten for the new scanner, `docs/browser-authentication.md` replaced with in-app sign-in notes), close PR #5.
10. **Verification**: run the real app with the dev cookie import against a copy of part of the library and a local rclone remote; screenshot every screen and compare with wireframe v4; exercise a new like arriving, a failed upload, retry, refresh, and adoption moves.

## Testing strategy

- Module-interface tests only; no tests of private helpers once a module interface covers them.
- Recorded fixtures for catalog parsing; golden cases for the matcher and lyrics classification captured from the Python code before deletion.
- Real files for tags and acquisition (ffmpeg-generated audio, no network).
- rclone local backend for remote.
- Reconciler tests with fakes covering: new like end to end, merge of liked and catalog contributions, retry and backoff to Needs Attention, crash mid-step then resume, Refresh, No Longer Wanted, Outside Edit, layout move with remote move.
- Renderer: component tests for the filter URL state and the Activity scroll rules; manual screenshot verification for visuals.

## Risks

- **youtubei.js parity**: response parsing breaks when YouTube changes. Mitigation: ported ytmusicapi parsers with fixtures, and the catalog module is the only place that knows response shapes.
- **Google blocking in-app sign-in**: no fallback by design (ADR 0004). If it happens, reopen that ADR.
- **yt-dlp JS runtime**: Electron-as-Node may not satisfy EJS. Fallback is bundling Deno.
- **Silent matching drift**: golden tests from the Python code.
- **Spotify token scraping**: fragile and against Spotify's terms; isolated inside the lyrics finder and optional (only used when a lyrics server is configured).
- **Adoption moves on the real library**: the first run on the user's real folder moves Standalone Tracks and re-uploads them. The plan verifies on a copy first; the PR description tells the user what the first run will change.

## Out of scope

Spotify or SoundCloud liked sources, Windows and Linux builds, a menu bar or background mode, parallel downloads, a light theme, configurable folder templates, automatic lyrics retries.
