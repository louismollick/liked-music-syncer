# Spotify liked songs, October 4

Add Spotify Liked Songs as a second Liked Music Library. A song liked on both platforms downloads once.

Decisions: `CONTEXT.md` (Recording, Liked Date, Match, Spotify Account), ADR 0008 (likes satisfied by Recording), ADR 0009 (web player session). Research: `docs/audits/spotify-likes-research-2026-10-04.md` (SongMirror, Stash, music-liked-sync, spotDL compared, with citations).

## Product rules

- One optional Spotify Account, signed in through an in-app window. YouTube Music, Spotify, or both.
- Spotify is checked on the same 30-minute timer as YouTube Music likes.
- Liked Date comes from Spotify's `addedAt`. A song liked on both platforms uses the earliest Liked Date.
- Audio and tags always come from a YouTube Music Release Track. Spotify only guides the search.
- A Spotify like with no confident Release Track match goes to Needs Attention ("Not found on YouTube Music"). This includes songs that exist on YouTube Music only as a music video. No video fallback, no "closest result".
- A like is satisfied by any Library track of the same Recording (ADR 0008). Catalogs stay per Release Track.
- Refresh priority: active catalog contribution, then YouTube Music like, then Spotify like.
- Signing out of Spotify, or an expired session, leaves Spotify likes active as last seen. Activity shows the source error. Same as switching YouTube Music Accounts today.
- Explicit vs clean is ignored when matching.
- First import is not special: tracks appear in Activity like any new likes.
- UI: Song panel lists Source Contributions ("Liked on Spotify", "Liked on YouTube Music"). Inventory Filters "Liked on Spotify" and "Liked on YouTube Music". Spotify sign-in/out lives in Settings next to the Google account.

## Phase 1: Spotify session and liked-songs check

1. **`SpotifySession`** (`src/main/session/spotify-session.ts`), modeled on `GoogleSession` (`src/main/session/google-session.ts`): partition `persist:spotify`, sign-in window on `https://accounts.spotify.com/login?continue=https://open.spotify.com/`, done when an `sp_dc` cookie exists for `.spotify.com`. Exposes `accountId()` (Spotify user ID from the token or the `me` query), `generation()`, `signOut()`. Electron's honest user agent, like ADR 0004.
2. **Authenticated token.** Extract the server-time + TOTP + `/api/token` code from `src/main/lyrics/spotify.ts` into a shared helper (e.g. `src/main/spotify/token.ts`) that both the anonymous lyrics client and the authenticated client use. Authenticated calls send the session's cookies (`sp_dc`, `sp_t`) and reject responses with `isAnonymous: true`. Keep anonymous and authenticated token caches separate. Request a `client-token` if Pathfinder requires it (Stash: `SpotifyAuthManager.kt`).
3. **`fetchLibraryTracks` reader** (`src/main/spotify/library.ts`): Pathfinder `POST https://api-partner.spotify.com/pathfinder/v2/query`, `operationName: fetchLibraryTracks`, `limit: 50`, seed hash `087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240`. Page by raw item count until `totalCount`. Fail on a missing shape, a page that doesn't advance, or an empty page before `totalCount`. On `PersistedQueryNotFound`, re-read the hash from the web player JS bundle once and retry. On 401, refresh the token once. Honor `Retry-After` on 429 by failing the check with a source error (no tight retry loop). Never call REST `/v1/me/tracks`. Skip local files and podcast episodes.
4. **Normalized type** `SpotifyLikedTrack`: `trackId`, `title`, `artists: { id, name }[]`, `album: { id, name }`, `trackNumber | null`, `durationMs`, `addedAt` (ISO), `position`. Parse both `duration` and `trackDuration`, and both nesting shapes Stash handles.
5. **Contributions.** New contribution kind `spotify_liked` (or a `platform` on `liked`; pick the one that keeps `MatchInput` cleanly typed). Source key `spotify-liked:<accountId>:<trackId>`, snapshot source `spotify-liked:<accountId>`. `sourceVideoId` becomes nullable (migration). Reuse `validateLikedSnapshot` and the staged-snapshot transaction from `checkLikedSongs` (`src/main/reconcile/sources.ts`). Store the Liked Date from `addedAt`.
6. **Wanted states.** `updateWantedStates` requires a successful snapshot from every configured liked source (YouTube Music account and Spotify account) before marking anything No Longer Wanted.
7. **Reconciler.** `Reconciler.check()` runs the Spotify check after the YouTube check, with its own `sourceErrors` entry.
8. **Tests** with fixtures shaped like the Pathfinder responses in SongMirror/Stash: pagination, premature empty page, hash refresh, anonymous token rejection, unlike deactivation, suspicious snapshot.

## Phase 2: Matching Spotify likes to YouTube Music

Matcher input becomes source-neutral: `MatchInput` gains `{ kind: 'spotify'; track: SpotifyLikedTrack }`. Do not fake a `LikedSong` for Spotify.

Order, stopping at the first confident result:

1. **Existing Library track of the same Recording.** A track whose stored `spotifyTrackId` equals the liked track ID and passes the gates below, or a track whose metadata passes the gates and is backed by a like. Join it.
2. **Album-first.** New catalog method `searchAlbums(query)` (YouTube Music search with the albums filter). Query `albumName albumArtist`, then once more with only decorative suffixes removed (keep live/remix edition text). Album title similarity ≥ 0.90, artist ≥ 0.88, check at most the top 3. Browse with `catalog.release`, find the track with the gates, and cache the browsed track list per Spotify album ID for the run (12 likes from one album = one lookup).
3. **Song search fallback.** Generalize `searchCandidate` (`src/main/match/resolve.ts`) to take a source-neutral query. Queries: `title primaryArtist albumName`, `title primaryArtist`, title without feature/catalog decorations + primary artist, title + another credited artist. Dedupe, cap at 6, 20 results each, songs filter. Candidate must have an album browseId and be found in the browsed release (`findReleaseTrack`).

Gates for Spotify candidates:

- Duration within ±5 s (Spotify durations are the recording, unlike YouTube music videos).
- Title ≥ 0.90 and primary artist ≥ 0.88 (`textSimilarity`, `identityScoresMatch` building blocks; compare the primary artist on its own, not a joined string).
- Symmetric version check (below).
- Ranking: `0.45 T + 0.30 A + 0.15 L + 0.10 D` (L = album title similarity, 0.5 if unknown; D = `max(0, 1 - |Δs|/10)`). No popularity. Auto-accept needs a gap ≥ 0.04 over the runner-up after collapsing candidates that share a catalog video ID (same Recording). Prefer the candidate on the Spotify album when they share a video ID.
- No confident winner: Needs Attention with reason "Not found on YouTube Music". Distinguish no match, ambiguous, auth failure and network failure in the error.

Shared changes:

- **Symmetric version check.** `versionCompatible` (`src/main/match/text.ts`) today only checks markers present in the source. Make it reject live/studio, remix/original, instrumental/vocal, acoustic, sped-up/slowed, karaoke and cover mismatches in both directions. Applies to YouTube Music likes' search fallback too. Keep YouTube Music's own 45/60 s duration tolerance for YouTube likes.
- **Recording rule (ADR 0008) for all likes.** In `runMatch` (`src/main/reconcile/steps.ts`), when a like (either platform) resolves to `releaseId:videoId` and an existing non-catalog-only track already has the same `catalogVideoId` on another Release, join that track instead of creating a new identity. A track backed only by catalog contributions keeps strict Release identity; a like whose Recording matches a catalog track joins it. No retroactive merge of existing duplicates.
- **Refresh priority.** `matchSource` (`steps.ts`): active catalog, then active YouTube Music like, then active Spotify like, then inactive ones in the same order.
- **Lyrics.** When a Spotify like backs a track, set `tracks.spotifyTrackId` from it (overriding a lyrics-search guess) and skip the Spotify lyrics search.

## Phase 3: Tags and rebuild

- Files record every source ID they matched: `LMS_YOUTUBE_MUSIC_TRACK_ID` (liked video, when a YouTube like backs the track) and `LMS_SPOTIFY_TRACK_ID` (the liked Spotify track when a Spotify like backs it, otherwise the lyrics-found ID as today). Add an origin value or atom that says which platforms liked it, so a rebuild knows the Spotify ID came from a like and not from lyrics search. Bump `LMS_TAG_SCHEMA_VERSION`.
- Rebuild: a Spotify like claims a restored, confirmed file whose tags record that Spotify track ID as liked, the same way `unclaimedRestoredBySource` / `claimAdoptedFiles` (`src/main/reconcile/sources.ts`) handle YouTube likes. No match, no download.

## Phase 4: UI

- Settings: Spotify row next to the Google account. Signed out: "Sign in to Spotify". Signed in: display name, liked count, sign out.
- Song panel: Source Contributions say "Liked on Spotify" / "Liked on YouTube Music" with Liked Date.
- Inventory Filters: "Liked on Spotify", "Liked on YouTube Music".
- Activity: Spotify source errors (signed out, session expired, Spotify changed its API) shown like the YouTube source error. Needs Attention reason text for unmatched Spotify likes.
- Follow the existing dark, dense style in `src/renderer/src/pages/SettingsPage.tsx` and `components/SongPanel.tsx`.

## Live validation (needs the user)

Nobody has run `fetchLibraryTracks` against a real account yet. After Phase 1 builds, the user runs the worktree app with a scratch profile (`LMS_USER_DATA_DIR=/tmp/lms-spotify pnpm dev`), signs in to Spotify, and checks the liked count. Save a trimmed real response as a test fixture. Then run matching against the real likes and review the Needs Attention list and a sample of matches before trusting the thresholds.

## Constraints for implementers

- A sync is running from the main checkout. Never run the app from the worktree without `LMS_USER_DATA_DIR` pointing at a scratch directory, and never point it at the real output folder or Remote Library.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass after each phase. One commit per phase.
- Keep it simple: no preview screen, no manual match UI, no ISRC, no MusicBrainz lookups for Spotify.
