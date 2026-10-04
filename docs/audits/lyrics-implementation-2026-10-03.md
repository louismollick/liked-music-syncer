# Plan B implementation verification

B1 and B2 are implemented on `lyrics-coverage`. No commits, pushes, real-library app runs, or writes under `~/Library/Application Support/liked-music-syncer` were made.

## Behavior

- Queries retain the full title and add the Japanese half of a bilingual title only when the dropped half has no version qualifier. The finder computes version qualifiers once for provider candidate validation. Instrumental, off vocal, karaoke, and Inst. titles skip every provider, including with full-width punctuation. Other protected qualifiers must agree in both directions.
- Queries include original credits, canonical English artist names, and cached native artist names. Tags continue using Plan A's English names. Existing recordings use measured track duration rather than the saved Match's nullable duration.
- Spotify searches title and artist variants, rejects known duration differences above three seconds, reports GraphQL and HTTP-200 lyric errors, and tries one different best candidate after a saved ID yields no synced lyrics. The existing scorer is unchanged.
- LRCLIB validates title, artist, version, and duration on both exact lookup and search. Plain results remain fallbacks while search seeks synced results. If search fails after a plain hit, that fallback survives and the error is recorded.
- PetitLyrics runs last. Its read-only form POST uses the audit's working request format. Word-sync becomes line LRC. Line-sync decodes its obfuscated centisecond cues, including rollover, and pairs them with plain text from the same lyrics ID. Invalid geometry, IDs, line counts, or timestamps are rejected.
- `lookUpLyrics()` serves both matching and the new lyrics step. Stored quality cannot decrease for the same recording, including when matching merges into an existing survivor. A changed catalog video clears the old lyrics and Spotify ID before lookup.
- The lyrics step stamps every completed attempt, including provider errors, unexpected lookup errors, and instrumental skips. Provider errors remain enrichment errors, so retag/upload continue. Cancellation still aborts work without consuming the checkpoint, following existing shutdown behavior.
- Recheck lyrics clears only non-synced checkpoints, resets eligible Needs Attention tracks while leaving Outside Edits paused, and marks planning dirty. There is no expiry or periodic lyrics recheck. Adoption stamps its observed lyric state so rebuilding the inventory does not trigger mass lookups.
- Activity labels lyrics work as Finding lyrics. StepKind has one definition in `domain.ts`.

## Files changed

Provider work: `src/main/lyrics/finder.ts`, `lrclib.ts`, `spotify.ts`, `types.ts`, new `query.ts` and `petitlyrics.ts`; `src/main/net/http.ts` adds provider pacing.

Library/workflow: `src/main/domain.ts`, `src/main/reconcile/steps.ts`, `reconciler.ts`, `src/main/inventory/inventory.ts`, `src/main/library/db.ts`, `migrations.ts`.

IPC/UI: `src/shared/ipc.ts`, `src/main/index.ts`, `src/renderer/src/pages/SettingsPage.tsx`, `ActivityPage.tsx`, `src/renderer/src/components/layout/Sidebar.tsx`, `SongPanel.tsx`.

Tests: `test/lyrics/finder.test.ts`, new `petitlyrics.test.ts`, new `test/reconcile/lyrics.test.ts`, `adoption.test.ts`, `test/library/migrations.test.ts`, and three small real-response XML fixtures plus provenance notes in `test/fixtures/lyrics/`.

## Cleanup verification against the real database

Read the real `library.db` using `sqlite3 -readonly -json`, selecting tracks with nonempty lyrics. Inserted those rows into a separate in-memory database, registered the implementation's actual instrumental-title detector, and executed migration 5's exact SQL there. Compared the cleared IDs with `existing-instrumental-lyrics.json`.

Exactly these five entries would lose their lyrics:

| Track ID | Title |
| --- | --- |
| `1e55ae40-ef71-4233-9784-e91b563abf0d` | `転生したら剣でした<Instrumental> - Reincarnated as a Sword (Instrumental)` |
| `3f72eb6a-ce9f-4c92-80de-f5c56ae001a1` | `転生したら剣でした<Instrumental> - Reincarnated as a Sword (Instrumental)` |
| `7562484f-b395-41f8-9793-668968ce426b` | `HIGHSCHOOL OF THE DEAD<instrumental> - HIGHSCHOOL OF THE DEAD (Instrumental)` |
| `e3d284be-1772-4a7d-b3b7-817b51a6118d` | `miss-dystopia（Inst.） - miss-dystopia (Inst.)` |
| `f19eed47-60a1-40c9-91e3-b77a7821ec6b` | `miss-dystopia（Inst.） - miss-dystopia (Inst.)` |

The in-memory synced count changed from 761 to 756. A second execution changed zero rows. Both カヨコ instrumental entries, `827beff9-5d9b-413f-94f7-76e1063319c2` and `7130c6e4-c7ba-4e35-9f5b-9ffce7e0df78`, retain their lyrics. 宙でおやすみ (demo instrumental), `4549e136-7644-4f42-b30e-e355e9b5428a`, also retains its lyrics. The plain リプル (Instrumental) entry, `baaf1131-a298-4209-a6ad-f3850a839c74`, remains untouched.

The migration clears database enrichment only. Normal retag/sidecar/upload reconciliation applies that correction to managed artifacts when the app next runs.

## Deviations and limits

No product-scope deviations. The provider uses small fixed-tag XML readers without adding an XML dependency. The fixtures reuse saved raw captures, retaining two word-sync lines and three line-sync cues with matching plain text. No live provider re-fetch was necessary.

The full-library Recheck and coverage audit were not run because this task forbids running the app against the real library. PetitLyrics remains an unofficial endpoint; fixtures verify decoding, not audio alignment or future endpoint availability. Aborted work remains unchecked so it can resume after shutdown.
