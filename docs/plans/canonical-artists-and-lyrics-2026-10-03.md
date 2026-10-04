# Canonical artists and lyrics coverage, October 3

Evidence: `docs/audits/lyrics-2026-10-03.md` (lyrics audit, 761 of 1,797 tracks synced).

Order: Plan A, then B1, then B2.

## Plan A: Canonical artists

### Problem

YouTube Music groups artists by channel ID. Each release carries the distributor's own credit text, so one channel appears under several spellings. Example, channel `UCSDwXTEapUN0qI5mBx9XzTw`:

| Credit text | Tracks |
| --- | ---: |
| KISHIDA KYOUDAN & THE AKEBOSHI ROCKETS | 76 |
| KISIDA KYODAN & THE AKEBOSI ROCKETS | 67 |
| KISIDA KYOUDAN & THE AKEBOSI ROCKETS | 27 |
| KISIDAKYOUDAN & THEAKEBOSHIROCKETS | 22 |
| ichigo from 岸田教団&THE明星ロケッツ (+1 romanized) | 4 |
| Kishida Kyoudan & The Akeboshi Rockets | 1 |

The app writes credit text to ARTIST and ALBUMARTIST (`src/main/match/resolve.ts:98`), so Navidrome/Plex split one artist into several. `linkTrackArtists` (`src/main/reconcile/steps.ts:362`) renames the artist row to whichever spelling it linked last. 42 channels have tracks under more than one spelling.

A second mechanism: one artist can have two channels (Topic plus the band's own channel) that YouTube Music merges into one Official Artist Channel. `UCwfLQKQ4kTpMLkCpIOYb0oQ` ("Sokoninaru") and `UC0Whg8Zz7TT1VSpWeCjghKg` ("-sokoninaru-そこに鳴る") both return `urlCanonical` `https://music.youtube.com/@sokoninaru_jpn` with identical release lists. The app keys artists by channel, so this becomes two artist rows.

The artist page name is localized: `hl=en` gives "KISIDA KYODAN & THE AKEBOSI ROCKETS" / "Sokoninaru", `hl=ja` gives "岸田教団&THE明星ロケッツ" / "そこに鳴る". `catalog.artist()` is already called for artist images (`src/main/artist-images.ts:39`), but its `name` is discarded.

### Decision

A linked artist is named by its channel page, not by a release's credit text. Tags use the English page name (the app's default `hl=en`).

### Changes

1. **Resolve artist pages during matching.** Before committing a track, fetch (and cache on the artist row) each linked channel's page: `name` (hl=en) and the primary channel from `header.musicImmersiveHeaderRenderer.subscriptionButton.subscribeButtonRenderer.channelId` (verified live: both Sokoninaru channels give `UC0Whg8Zz7TT1VSpWeCjghKg`; Kishida `UCSDwXTEapUN0qI5mBx9XzTw` gives `UCl7OsED7y9eavZJbTGnK0xg`). Also fetch the hl=ja page name for lyrics queries (decided: lyrics may search with it; tags stay English). Store as `artists.name`, `artists.native_name` (null when identical to `name`), `artists.primary_channel_id`, `artists.page_checked_at`. If the fetch fails, the match step throws `RetryLaterError` so files are never tagged twice. `linkTrackArtists` stops renaming rows from credit text. `artist-images.ts` is not the trigger (830 rows already have `imageCheckedAt`).
2. **Merge by primary channel without re-keying.** Artist IDs stay `channel:<id>`. When two rows share a primary channel, the row with Full Discography (else most tracks) survives and the other gets `alias_of = <survivor id>`, which always points directly at a survivor (no chains). Move the alias's `track_artists` and any Full Discography setting, contributions and snapshot keys to the survivor in one transaction. For Sokoninaru the survivor is `UCwfLQ` (Full Discography, 75 contributions); only the 4 `UC0Whg` tracks move.
3. **One alias-aware linking helper** shared by `linkTrackArtists` (`steps.ts:362`) and `linkAdoptedArtists` (`inventory.ts:402`), so inventory rebuild cannot recreate aliases.
4. **Tags keep credit roles.** ARTIST = canonical names of the track credits; ALBUMARTIST = canonical names of the release credits (e.g. MyGO!!!!! track on a MyGO!!!!! + Ave Mujica release). Credits without a channel keep their text. Persist canonical values in `tracks.artist` / `tracks.albumArtist` (what `desired.ts:44` and `layout.ts:41` read). Add release artist credits to the LMS tag block so inventory rebuild can restore ALBUMARTIST credits.
5. **Backfill.** A migration-triggered pass fetches pages for existing artists, applies merges, recomputes `tracks.artist` / `tracks.albumArtist` from saved credits, and wakes the reconciler. Retag, move (layout uses album artist; Kishida alone has 130 files changing folder) and upload follow. Identity keys are unaffected.
6. **Tests:** several spellings on one channel produce one tag name and one artist row; a two-channel artist collapses into the survivor with its Full Discography and contributions; adoption from tags links to the survivor, not the alias; track vs release credit roles survive.

Side effect: "ichigo from 岸田教団" tracks file under the band, matching YouTube Music's artist page.

## Plan B: Lyrics

### Product rules

- **Lyrics never get worse automatically, for the same recording.** synced > plain > none. A lookup only replaces stored lyrics with something at least as good, compared against the merge survivor's lyrics when a merge happens. When Refresh changes `catalogVideoId`, recording-specific enrichment (lyrics, `spotifyTrackId`) is cleared first, so the old recording's words never attach to new audio. Today `steps.ts:895` can replace synced with plain when Spotify errors and YouTube returns plain.
- **No automatic periodic rechecks.** A **Recheck lyrics** button (next to the lyrics server setting) clears `lyricsCheckedAt` on tracks without synced lyrics, resets eligible `needs_attention` tracks, and marks planning dirty. `lyricsCheckedAt = null` means "never looked up": enabling lyrics therefore looks up unchecked tracks; inventory adoption stamps it from the tag state so a rebuild does not trigger 1,797 lookups.
- **A lookup always completes.** The `lyrics` step stamps `lyricsCheckedAt` after every attempt, including provider errors (recorded in `enrichmentErrors`) and instrumental skips. It never blocks retag/upload; another Recheck retries errors.
- **Version protection on every candidate path.** Instrumental, off vocal, karaoke and `Inst.` titles (including full-width punctuation) get no lookup. For other qualifiers (live, TV size, remix, acoustic, cover, demo, new recording) a candidate must carry the same qualifiers and no incompatible extra ones. Applies to Spotify search results, LRCLIB results (add title/artist fields to its response type) and PetitLyrics.

### B1: Matching fixes and the lyrics step

- `finder.ts`: title variants. Full title, plus the native half of a bilingual `X - Y` title only when the dropped half has no version qualifier. Detect qualifiers once; skip instrumental titles.
- `lrclib.ts`: keep a plain `/get` result as fallback instead of returning; search, and among results within 3 s prefer synced; try the native-title variant.
- `spotify.ts`: throw on GraphQL errors and HTTP-200 error-shaped lyrics responses; search title variants; hard 3 s duration gate; when a saved ID has nothing synced, search once and try a different best candidate.
- Artist variants: canonical English name (Plan A), the original credit text, and the native name from the hl=ja artist page (cached on the artist row) when it differs. Tags stay English.
- Lyrics-only lookups use the track's measured `durationSeconds` (adopted Matches have null duration and lyrics browse ID).
- `steps.ts`: extract the lyrics block into `lookUpLyrics()` used by `match` and the new `lyrics` step; apply the no-downgrade rule there. `nextStep` checks `lyrics` before `retag`. One `StepKind` definition (today it exists in both `steps.ts:86` and `domain.ts:22`); Activity gets a label for the new step instead of falling through to "downloading".
- One-off, idempotent correction outside the no-downgrade helper: remove lyrics from the 5 instrumental-labelled tracks whose lyrics and timings exactly duplicate a vocal version. Leave the other 3 alone.
- Tests (`test/lyrics/finder.test.ts`, fake HTTP pattern): LRCLIB `/get` plain while search has synced; instrumental never gets vocal lyrics; Spotify error after a YouTube plain result keeps stored synced; bilingual title matches via its native half.

### B2: PetitLyrics

- `petitlyrics.ts`, last fallback after LRCLIB. Reference: Canticle's `internal/petitlyrics/client.go` and `decode.go`. Word-synced reduces to line LRC; line-synced pairs timing with text from the same lyrics ID.
- Tests with one line-synced and one word-synced fixture from the audit captures in `~/Library/Application Support/liked-music-syncer/lyrics-audit-2026-10-03`.

### Cut

Per-provider attempt history, audio alignment, Uta-Net, Sekaiphoria, guessed artist alias lists, Spotify scorer rewrite.

### Success check

After B2 and a Recheck, rerun the audit coverage count. Expect somewhat fewer than the audit's 948: that projection used hand-picked Japanese artist names and Uta-Net titles for some PetitLyrics queries (21 PetitLyrics-only recoveries), and the 5-track cleanup lowers the baseline.
