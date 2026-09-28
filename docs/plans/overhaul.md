# Overhaul plan

Status: revision 5 (ready to implement), after self-review, Codex reviews 1 to 4, and the milestone 0 spikes. Owner decisions come from the grilling session on 2026-09-25/26 and are recorded in `CONTEXT.md` and ADRs 0002 to 0006. This plan says how to build them.

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

Everything runs in the Electron main process except the renderer. No youtubei.js: the spikes showed its YouTube Music parsers fail on current responses, and a small `fetch` client is enough (see "Spike results"). Three external binaries: yt-dlp (official standalone release, self-updating in `userData`), ffmpeg (`ffmpeg-static`), rclone (bundled per architecture). The bgutil PO token provider keeps running as a Node script under Electron's Node mode, as it does today.

### Modules

Each module below has a small interface and hides a lot. Names use `CONTEXT.md` terms. Tests go through each module's interface.

1. **Google Session** (`src/main/session/`). Owns the persistent `persist:ytmusic` Electron session, the sign-in window, cookie reads, SAPISIDHASH authorization, and YouTube Music Account discovery and selection (probing `X-Goog-AuthUser` slots 0 to 4 as today, reading the account name, handle, and channel ID from `account/account_menu`). Each YouTube Music Account needs an immutable provider ID: its channel ID, else the `datasyncId` from the accounts list. An account with neither cannot be selected. Interface: `status()`, `openSignIn()`, `signOut()`, `accounts()`, `selectAccount(id)`, `requestHeaders()`. Switching accounts is refused while any source check or Track Step is running or queued, like today's guard; the UI offers to cancel pending work first. Every switch bumps a session generation number, and source snapshots only commit if their account and generation still match. A dev-only cookie importer (`LMS_DEV_IMPORT_COOKIES=zen`, refused when `app.isPackaged`) copies YouTube cookies from a local Zen profile into the partition so automated verification can run without a human sign-in.

2. **YouTube Music catalog** (`src/main/catalog/`). All YouTube Music reads: liked songs with continuation paging, album, artist, the artist's full album and single lists, song search, watch playlist (lyrics browse ID), timed and plain lyrics, account info, artist images. Implementation: a small Innertube client over `fetch` (`POST music.youtube.com/youtubei/v1/<endpoint>` with a `WEB_REMIX` context), signed with the Google Session's headers for personal reads (liked songs, account menu) and sent signed out for public reads. Timed lyrics use the `ANDROID_MUSIC` client, signed out, as ytmusicapi does. Response parsers are ported from ytmusicapi (MIT) so shapes match what the matching code expects, including the raw `next` fallback the Python code needed when ytmusicapi's watch-playlist parser broke. Interface returns plain typed objects (`CatalogTrack`, `CatalogRelease`, `CatalogArtist`, `Lyrics`). Tests run the parsers against recorded JSON fixtures of public pages; personal responses (liked songs, account) are synthesized, never committed from the real account.

3. **Request scheduler** (`src/main/net/`, internal). One place for per-host rate limits (MusicBrainz 1 request per second, gentle pacing for YouTube Music, LRCLIB, and Spotify), `Retry-After`, timeouts, cancellation, and classification of errors as transient or permanent. The catalog, matcher, and lyrics finder all send requests through it. It is not part of any module's interface.

4. **Matcher** (`src/main/match/`). Turns a Source Contribution into a Match: which catalog track and Release, MusicBrainz recording ID and genre, and the artist credits. Ports the Python resolution rules: official-source preference, title normalization (NFKC plus case folding), a faithful `SequenceMatcher` port for similarity thresholds, and the MusicBrainz 1 request per second throttle. Liked videos without a catalog match become Standalone Tracks. Interface: `match(contribution) -> Match`, with the catalog and MusicBrainz clients injected. Tests use fakes of both plus golden cases recorded from the Python implementation before it is deleted.

5. **Lyrics finder** (`src/main/lyrics/`). Implements the lyrics order above. Spotify track lookup ports the web token TOTP flow and search scoring; the lyrics text comes from the configured lyrics server (`GET <url>?trackid=<id>&format=lrc`). LRCLIB uses `/api/get` then `/api/search`. Classifies text as synced or plain with one shared rule, rejects all-zero timestamp LRC, and detects language with `eld` on the lyrics text. Interface: `find(track) -> { text, synced, source, language } | null`.

6. **Tag schema** (`src/main/tags/`). The single definition of every tag the app writes and reads, built on node-taglib-sharp: standard MP4 atoms, the raw `©day` date string (keeps `YYYY`, `YYYY-MM`, `YYYY-MM-DD`), cover art, lyrics, and the `----:com.apple.iTunes:LMS_*` freeform atoms. Interface: `readTags(path) -> TagFields`, `writeTags(path, TagFields)`, `fieldDiff(a, b) -> string[]`. Writes `LMS_TAG_SCHEMA_VERSION=6`; reads v5 files for adoption. Tests round-trip a real `.m4a` generated with ffmpeg in the test setup.

7. **Audio acquisition** (`src/main/acquire/`). Downloads with the yt-dlp binary (`-f bestaudio/best`, `mweb` client, bgutil plugin directory, Electron-as-Node JS runtime, no cookies), converts to AAC `.m4a` with ffmpeg only when needed, crops cover art square (Electron `nativeImage`: trim uniform border, center crop, JPEG), writes tags, then moves the file into place with a same-directory temp file and `rename`, so a crash never leaves a half-written file at the final path. Reports byte progress. Interface: `acquire(match, lyrics, destination, onProgress) -> ManagedFileRecord`, plus `retag(file, fields)` for network-free tag rewrites. The yt-dlp binary manager is an internal seam of this module: download on first use to `userData/bin`, verify against the release's SHA-256 sums, `--update-to stable` at most once a day, keep the previous binary and roll back if the updated one fails `--version`.

8. **Library store** (`src/main/library/`). SQLite through better-sqlite3 and Drizzle, with numbered migrations that never drop user data. Owns tracks, Source Contributions and source snapshots, Managed File records, upload records, tombstones, artists, favorites, and settings. Interface is query and command methods used by the reconciler and IPC; the renderer never sees table rows directly.

9. **Library inventory** (`src/main/inventory/`). The narrow interface to the output folder: `scan() -> { managed, unmanaged, outsideEdits }` and `adopt(scan)`. Walks the folder, reads tags through the Tag schema, classifies Managed vs Unmanaged, detects Outside Edits (size and mtime, then content hash against the file record), and on an empty database rebuilds tracks from LMS tags (see "Adoption"). Also computes layout paths with the collision rule below.

10. **Remote Library** (`src/main/remote/`). rclone wrapper: `list({ hashes })` via `lsjson --recursive --files-only` (adding `--hash` only for full checks), `upload(local, remotePath)`, `move`, `delete`. Records what was uploaded (content hash plus tag fields). The module detects the remote's supported hash types once (`rclone backend features`) and picks MD5 or SHA-1 when available; upload records store the algorithm, the local digest in that algorithm, and the remote size and modification time as rclone reported them. Uploads use `copyto` and are followed by a check of that one object (audio and `.lrc` alike): a hash comparison when the backend has a common hash, otherwise the object is downloaded to a temp file and hashed locally before the upload record is marked verified. Backends without writable modification times fall back to size plus the recorded remote time. Computes Remote State per track: in sync, stale (the local file changed since the upload record, with the field diff), missing, uploading, failed. A remote file whose size or modification time no longer matches its upload record is treated as stale and replaced. When no upload record exists or a remote hash matches none, it downloads that one file to a temp dir and reads its tags. Tests use rclone's local backend against temp directories.

11. **Reconciler** (`src/main/reconcile/`). The heart of the app. Computes the Desired Library from active Source Contributions, compares each Desired Track with its Managed File and remote copy, and derives the next Track Step: match, acquire, retag, move, upload. Runs one track at a time through its remaining steps, newest Liked Date first, then catalog tracks by release date, persists progress after each step, retries transient failures (1 min, 5 min, 30 min), then marks Needs Attention. Emits Activity events. Interface: `checkSources()`, `refresh(scope)`, `retry(trackId)`, `deleteTracks(ids, where)`, `snapshot()`, `subscribe(listener)`. Tests run the reconciler with in-memory fakes for catalog, matcher, acquisition, and remote.

12. **App shell** (`src/main/index.ts`, `src/main/ipc.ts`, `src/preload/`). Window lifecycle (IPC keeps working after the window is closed and reopened), one typed IPC surface defined with zod schemas in `src/shared/ipc.ts` and validated in main, `app-media://` protocol for cached artwork, the 30-minute check timer, and orderly shutdown (stop the worker, kill child processes, never leave a detached process).

### Identity and Source Contributions

- **Canonical video ID.** A Release Track's identity is `<releaseId>:<catalogVideoId>`, where `catalogVideoId` is the video ID YouTube Music lists for that track on the Release's own track list (ytmusicapi's resolved ID), never the video the user liked. A Standalone Track's identity is `video:<sourceVideoId>`. Contributions always keep their original source IDs.
- **Liked contributions are scoped to a YouTube Music Account.** Key: `ytm-liked:<accountId>:<sourceVideoId>`. Only the selected account's liked contributions are active. Switching accounts deactivates the previous account's likes after the new account's first complete check (so its tracks become No Longer Wanted, which never deletes anything) and reactivates them if the user switches back. The Library itself is shared across accounts. Favorite Artists are a Library-level choice, not per account.
- **Catalog contributions**: `catalog:<artistId>:<releaseId>:<catalogVideoId>`. Their identity is known at discovery.
- **Matching a liked contribution** computes its identity key. If a track with that key exists, the contribution links to it (merge); otherwise a new track is created.
- **Re-keying.** A Refresh can change a track's identity (a Standalone Track gains a Release, or the Match picks another catalog track). Re-keying runs in one transaction: if no track has the new key, the track row takes the new key and gets a retag and move step. If the Match's catalog video differs from the file record's `audio_video_id`, the track also gets an acquire step; the old file stays in place until the replacement is verified. If another track already has the new key, the contributions move to that track, and the old track's Managed File and upload become redundant: they are deleted through a tombstone (see "Crash safety") once the surviving track has a verified file. Every re-key is recorded in the track's history for the Song panel.
- **Source snapshots.** A liked-songs check or catalog check stages every page (and for catalogs, every release) into a snapshot. A snapshot commits only if every request succeeded, every page parsed into the expected shape (parsers throw on unknown shapes instead of returning empty lists), continuation ended because no token was returned, every release returned a non-empty track list, and the result is not suspiciously small (empty, or under half the previous snapshot, without the page header confirming that count). Activation and deactivation happen in the same transaction. A failed check keeps the previous snapshot and shows a Needs Attention item for the source, not for tracks.
- **Liked Date** for a track is the earliest `firstSeenAt` among its liked contributions, ordered within the same day by liked-list position. Catalog-only tracks show "Catalog".
- **No Longer Wanted** is decided only after every configured source has completed at least one full check since the database was created. A track with no active contribution then becomes No Longer Wanted.
- Un-favoriting an artist deactivates that artist's catalog contributions.
- Deleting No Longer Wanted tracks is an explicit user action from the Songs list with a choice of local, remote, or both, carried out through tombstones (see "Crash safety" for what each choice keeps).
- Albums are grouped by (album, album artist) from track metadata. Artists come from track credits: `channel:<id>` when YouTube Music gives a channel ID, else `name:<normalized>` as an Unidentified Artist. Artist images come from the catalog artist page and are cached in `userData`; Unidentified Artists get none.

### Layout paths and collisions

Paths come from the fixed layout, sanitized for macOS and Linux file names and NFC-normalized. Before any write or move, the inventory checks the target against the actual filesystem (any entry, Managed or not) and against paths reserved by other tracks, compared case-insensitively. The app never replaces a path it does not own. On collision, it appends a stable suffix derived from the track's full identity key (a short hash, lengthened until unique), and stores the chosen path on the file record so it stays stable. New files and moves are placed with a no-clobber link-then-unlink, so a race cannot overwrite an entry that appeared after the check; if the link fails because the path was taken, the suffix rule runs again.

### Data model (SQLite)

- `tracks`: id, identity_key (unique, nullable until matched), adopted (bool), title, artist_credits (JSON), album, album_artist, release_id, release_kind, track_number, track_total, disc_number, disc_total, date, year, duration_seconds, genre, isrc, mb_recording_id, language, lyrics_status, lyrics_source, lyrics_text, enrichment_errors (JSON), cover_url, cover_path (processed JPEG in `userData/covers/`, content-addressed), match (JSON, versioned), state, current_step, attempts, next_attempt_at, last_error, last_error_kind, completed_at, created_at, updated_at.
- `contributions`: id, source_key (unique), kind, account_id (liked only), track_id (nullable), source_video_id, release_id, artist_id, liked_position, first_seen_at, active, raw (JSON: the source-side title and artist for display before matching).
- `files`: track_id (unique), relative_path, audio_video_id (the video the audio was downloaded from), size, mtime_ms, content_sha256, tag_fields (JSON), lrc_sha256, written_at, outside_edit (JSON: which of tags, artwork, audio, sidecar changed; null when clean).
- `uploads`: track_id (unique), remote_path, hash_algo, content_hash, remote_size, remote_mtime, lrc_remote_path, lrc_hash, lrc_remote_size, tag_fields (JSON), verified_at, uploaded_at. Either half can be absent after a single-destination delete.
- `source_snapshots`: source (liked account or catalog artist), status, started_at, completed_at, item_count, error.
- `tombstones`: id, kind (local file, local sidecar, remote file, remote sidecar), path, reason, created_at, done_at.
- `operations`: id, track_id, step, artifact (audio, sidecar), kind (place, replace, move, upload, remote move), from_path, to_path, expected_sha256, phase, started_at. One row per artifact, written before that artifact is touched; all rows of a step are cleared in the transaction that commits the step's records.
- `track_history`: track_id, at, event (matched, re-keyed, refreshed, moved), detail (JSON).
- `unmanaged_files`: relative_path, size, mtime_ms, seen_at.
- `artists`: id (`channel:<id>` or `name:<normalized>`), name, image_path, favorite, favorited_at, catalog_checked_at.
- `track_artists`: track_id, artist_id, position.
- `settings`: key, value, encrypted.
- `meta`: schema bookkeeping for Drizzle migrations.

### Track states and steps

`state` is one of `pending`, `working`, `done`, `needs_attention`, `no_longer_wanted`. The reconciler derives the next step from facts, not from a stored plan:

1. No Match, or a Refresh was requested: **match**. Only the catalog decision is required: which catalog track and Release, or Standalone. MusicBrainz (recording ID, genre) and lyrics are enrichment: their failures are recorded on the track (`enrichment_errors`) and shown in the Song panel, never block acquisition, and are not retried automatically; a Refresh tries again.
2. No Managed File, the audio is missing, or the file's `audio_video_id` differs from the Match's catalog video ID: **acquire**.
3. Managed File tag fields, embedded artwork, embedded lyrics, or the `.lrc` sidecar differ from what the Match, `lyrics_text`, and `cover_path` imply: **retag** (no network; also repairs a missing or wrong sidecar and artwork).
4. Managed File path differs from the layout path: **move** (local rename, plus remote move if uploaded).
5. Remote enabled and upload record missing, stale, or remote hash mismatch: **upload**. The `.lrc` sidecar is its own remote object with its own path and verification fields on the upload record; it is uploaded after the audio, moved with it, and deleted from the remote when the track no longer has synced lyrics.

A file with an `outside_edit` record is paused: no retag, move, acquire, or upload runs for it until the user chooses "Rewrite" (restore the app's version) or "Keep and stop managing" (the file becomes Unmanaged) in the Song panel or the Needs Attention drawer.

The Activity UI groups these into three visible stages: Matching (match), Downloading (acquire, retag, move), Uploading (upload). Progress is weighted 15/70/15 and uses real byte progress for downloads and uploads.

### Crash safety

Every mutating step is idempotent and follows the same pattern: write an `operations` row with the expected result hash, do the side effect at a staged location, verify it, commit the record and clear the operation in one transaction, then finish. On startup, before the worker runs, a recovery pass inspects leftovers. Recovery handles the audio and sidecar of a step together: each artifact whose hash matches its pending operation is the app's own write; when every artifact of the step is accounted for, the step's records commit, otherwise the step re-runs. Only a hash that matches neither the record nor a pending operation is an Outside Edit.

- **Acquire and retag**: work in `<folder>/.lms-staging/<trackId>.<step>.m4a` (same volume, excluded from scans), write tags, fsync, then place it: a no-clobber link for new paths, `rename` over the file only when the record says the app owns that path. Recovery deletes staging files and resolves pending operations by hash as above.
- **`.lrc`**: written to a staging name and renamed, after the audio.
- **Local move**: preflight the destination with the collision rule, place with the same no-clobber link-then-unlink as new files (audio, then sidecar), commit. Recovery finds each artifact at either path by content hash.
- **Upload**: `copyto` to the final remote path (rclone uploads to a temporary name and renames on backends that support it), verify, commit the upload record. Recovery lists the remote path and runs the same verification as a normal upload (common hash, or download and hash when the backend has none) before writing a record; otherwise the upload re-runs.
- **Remote move**: `moveto`, then commit; recovery checks both paths.
- **Delete**: write a tombstone first, delete, mark the tombstone done. Tombstones stay until every requested destination is confirmed gone. A local-only delete keeps the track row and upload record (the track shows as remote only); a remote-only delete keeps the file record. The track row is removed only when both destinations are gone.
- SQLite runs in WAL mode; each step commits in its own transaction.

Crash tests inject a failure after each side effect and before each commit, restart the reconciler, and assert the Library ends in the right state.

### Adoption of the existing library

Superseded by [ADR 0007](../adr/0007-restore-only-confirmed-matches.md). The app no longer adopts files the previous app wrote. It restores only files that record a Match this app looked up, and the existing Library was rebuilt from current sources (see [catalog-and-adoption-repair.md](catalog-and-adoption-repair.md)).

## UI

Reference: wireframe v4. Dark only. One radius (6px) for buttons, inputs, chips, artwork, panels, and palette. No pill shapes. No cards inside cards; surfaces are flat and separated by hairlines (`rgba(255,255,255,.07)`). Accent is white. Status colors: sky for stale, orange for missing, amber for needs attention, emerald for up to date.

- **Sidebar**: "Liked Music" title with back and forward buttons. Below it, a status section ruled off with lines. Busy and not on Activity: current track art, title, step and percent, a 2px progress bar, "N up next". On Activity, or when idle: a status line ("Working · N up next" or "Up to date"), "Liked songs checked X ago", and a large refresh button that starts a check. Then nav with icons: Artists, Albums, Songs, gap, Activity (with needs-attention count), Settings. Account at the bottom.
- **Search**: a small box in the top-right corner of the main area and ⌘K both open the command palette. The palette searches artists (deduplicated by Artist identity), albums, and songs, and runs commands (check liked songs now, refresh Favorite Artist catalogs, open settings).
- **Root lists** (Artists, Albums, Songs): title with count beside it, a filter row of chips plus "+ Filter". Filters are URL-backed. Artists grid favorites on hover. Songs table columns: cover plus title and artist link, album link, year, narrow lang, time, status icons (lyrics synced, plain, none; remote cloud dark when in sync, sky when stale, orange when missing; amber circle for needs attention), Liked date with year ("Sep 24, 2026") or "Catalog". Quick filters: Needs attention, No longer wanted (with bulk delete), Unmanaged.
- **Hierarchy pages**: Artist page (artwork-tinted header, Favorite and Refresh buttons, albums grid, Standalone tracks table). Album page (cover, year, artist link, Refresh, track list). A small breadcrumb of ancestors sits above the page title. No filters on these pages. Back and forward follow browser history.
- **Song panel**: slides in from the right. Artwork, title, artist and album links, why it's here (contributions with Liked Date), Match (catalog ID, Release, genre source), lyrics (status, source, language), files (local path, remote state with field diff), Refresh and Show in Finder buttons.
- **Activity**: same title style as other pages, "N need attention" button beside the title opens a right-side drawer with plain-language reasons and Retry. Below, one scrolling column like synced lyrics: tracks finished in the last 7 days grouped by day, each with its finish time and a small green check (done) or amber warning (gave up, in Needs Attention), the current track highlighted with one step label and a bottom progress bar, then up-next tracks fading out. Any finished work counts, including upload-only or retag-only runs, so a remote catch-up is visible. No per-row text labels. The user can scroll freely; the view re-centers on track change only if the current row was visible and the user has not scrolled in the last 1.5 seconds. Clicking a done track opens Songs with that song's panel.
- **Settings**: one page of rows separated by lines, no boxes. YouTube Music account (switch, sign out), Library folder, Remote (upload switch, rclone remote, remote folder), Lyrics (Find lyrics switch, optional Spotify lyrics server URL).
- **Empty state**: "Sign in to YouTube Music" and "Choose a folder" buttons in the Library until both are done.

Implementation: React 19, Tailwind 4, TanStack Router (hash history), TanStack Virtual for grids and tables, base-ui primitives only where they help (menus, dialogs). A small `ui/` kit (Button, Input, Switch, Chip, Drawer, Palette, Table) enforces the radius and hairline rules. State: a thin store per IPC stream (library snapshot, activity snapshot, session status) with incremental updates; no full re-fetch of every track on each event.

## IPC

Defined once in `src/shared/ipc.ts` with zod. Invokes: `session.*`, `library.query` (paged, filtered, sorted track lists; artists; albums; one track detail), `library.setFavorite`, `library.delete`, `reconcile.check`, `reconcile.refresh`, `reconcile.retry`, `settings.get`, `settings.update`, `settings.chooseFolder`, `app.showInFinder`. Events: `activity` (current track progress at most 10 per second, queue changes, completions), `library.changed` (changed track IDs), `session.changed`. The renderer asks for what it shows instead of receiving whole snapshots.

## Build, packaging, CI

- `pnpm tools:fetch` downloads the bgutil plugin and provider (checksummed) and rclone for the host architecture. yt-dlp is not bundled; the app downloads it on first use and verifies the release's SHA-256 sums file.
- electron-builder: real `appId` (`com.louismollick.likedmusicsyncer`), hardened runtime, notarization wired to environment variables (skipped when absent), `extraResources` for rclone and bgutil. No `py/`.
- GitHub Actions on push and pull request. Job 1 on `ubuntu-latest`: pnpm install, biome check, typecheck (node, web, tests), vitest. Tests needing ffmpeg use `ffmpeg-static`; tests needing rclone download it in a setup step. Job 2 on `macos-latest` (arm64): build the unpacked app with electron-builder and run it with `--smoke-test`, which opens the database, round-trips tags on a fixture, runs the bundled rclone and ffmpeg, and exits non-zero on failure. Signing and notarization need the owner's credentials, so a manual release gate covers the signed, installed app on both architectures: first yt-dlp install, a forced update with rollback, and a real download through the PO token provider. Before the PR is opened, the same download path is exercised in an unpacked build on this arm64 machine.
- Delete: `py/`, `mypy.ini`, ExifTool and uv references, unused npm deps (`googleapis`, `ytmusic-api`, `musicbrainz-api`), ESLint and Prettier leftovers, `reports/`.

## Spike results (milestone 0, done)

- **YouTube Music**: youtubei.js 18.1 cannot parse the current liked-songs page (it returns 2 items and throws type errors). A plain `fetch` Innertube client with SAPISIDHASH works: the owner's account is `X-Goog-AuthUser: 1`, and liked songs paged through 14 continuations to 1,355 items. Timed lyrics work with the `ANDROID_MUSIC` client only when sent without cookies. ytmusicapi's `get_watch_playlist` currently crashes (`KeyError: 'endpoint'`), so the ported `next` parser must be defensive.
- **yt-dlp**: the official `yt_dlp_macos` 2026.08.19 binary with `--js-runtimes node:<Electron binary>` and `ELECTRON_RUN_AS_NODE=1` reports `JS runtimes: node-22.22.1` and solves challenges; with the bgutil provider running (started as `Electron -e "import('file://…/main.js')"`, because passing the script path as an argument trips its CLI parser), `mweb` returns format 251 (Opus) with no PO token warnings. Without the provider it silently falls back to a worse format, so the app must fail the step when the provider is down instead of accepting the fallback.
- **Tags**: node-taglib-sharp 6 reads every v5 LMS freeform atom from real files, writes new freeform atoms with non-ASCII values, round-trips a partial `©day` (`2020-05`), and keeps artwork and lyrics. ffmpeg still decodes the rewritten file and mutagen reads the same values. Raw atoms use `getFirstQuickTimeString` / `setQuickTimeString` with `Mpeg4BoxType.DAY`.
- **rclone**: the local backend lists every hash type; the owner's SFTP remote advertises MD5 and SHA-1 with 1 s time precision (`rclone backend features`); a crypt remote lists no hashes but keeps size and modification time. The plan's hash-algorithm rules cover all three.

## Milestones

Each milestone ends with passing tests. Straightforward backend modules can be delegated to Codex with a precise interface spec and fixtures; the UI is built here.

1. **Foundation and remaining spikes**: new `src/main` skeleton, Drizzle schema and first migration, settings with safeStorage, zod IPC, window lifecycle, request scheduler, CI workflow.
2. **Thin vertical slice**: sign in (dev cookie import), fetch liked songs, match one track, acquire and tag it, restart and adopt it back from tags, upload it to a local rclone remote, all driven by a minimal reconciler. Later milestones widen this path instead of building modules in isolation.
3. **Catalog and matcher breadth**: every parser with fixtures, full resolution rules and golden tests, catalogs for Favorite Artists, snapshots.
4. **Lyrics and artwork**: lyrics finder with three providers, language detection, cover processing, retag repair of sidecars and artwork.
5. **Inventory and adoption**: Unmanaged Files, Outside Edits, adoption of v5 files including favorites, layout moves with collision handling.
6. **Remote breadth**: hash algorithm detection, Remote State with field diffs, full check, fallback read.
7. **Reconciler breadth**: every step, crash recovery, retries, re-keying and merges, account switching, Refresh scopes, deletes, 30-minute check.
8. **Renderer**: new UI kit and every screen from wireframe v4, driven by real IPC.
9. **Cut over**: delete old code and Python, update README and docs (`docs/local-library-index.md` rewritten for the new inventory, `docs/browser-authentication.md` replaced with in-app sign-in notes), close PR #5.
10. **Verification**: run the real app with the dev cookie import against a copy of part of the library and a local rclone remote; screenshot every screen and compare with wireframe v4; exercise a new like arriving, a failed upload, retry, refresh, an Outside Edit, adoption moves, and a crash mid-step.

## Testing strategy

- Module-interface tests only; no tests of private helpers once a module interface covers them.
- Recorded fixtures for catalog parsing; golden cases for the matcher and lyrics classification captured from the Python code before deletion.
- Real files for tags and acquisition (ffmpeg-generated audio, no network).
- rclone local backend for remote.
- Reconciler tests with fakes covering: new like end to end, merge of liked and catalog contributions, re-keying a Standalone Track onto a Release with and without an existing target, account switching both ways with overlapping likes, a partial liked-songs check that must not deactivate anything, retry and backoff to Needs Attention, crash injection at every side-effect boundary, Refresh, No Longer Wanted gating, Outside Edit pause and Rewrite, layout moves with collisions and remote moves.
- Crash and delete tests include the audio-to-`.lrc` gap, a crash between replacing a file and committing it, and each single-destination delete across a restart.
- Source tests include a changed page shape that must fail the check, and enrichment outages (lyrics server and MusicBrainz down) that must not block a new like.
- Tag schema tests cover partial `©day` values, unknown atom preservation, artwork and lyrics replacement, and reading real v5 files.
- Renderer: component tests for the filter URL state and the Activity scroll rules; manual screenshot verification for visuals.

## Risks

- **YouTube Music response changes**: parsing breaks when YouTube changes pages. Mitigation: defensive ported parsers with fixtures, and the catalog module is the only place that knows response shapes.
- **Google blocking in-app sign-in**: no fallback by design (ADR 0004). If it happens, reopen that ADR.
- **yt-dlp JS runtime**: Electron-as-Node may not satisfy EJS. Fallback is bundling Deno.
- **Silent matching drift**: golden tests from the Python code.
- **Spotify token scraping**: fragile and against Spotify's terms; isolated inside the lyrics finder and optional (only used when a lyrics server is configured).
- **Adoption moves on the real library**: the first run on the user's real folder moves Standalone Tracks and re-uploads them. The plan verifies on a copy first; the PR description tells the user what the first run will change.

## Out of scope

Spotify or SoundCloud liked sources, Windows and Linux builds, a menu bar or background mode, parallel downloads, a light theme, configurable folder templates, automatic lyrics retries.
