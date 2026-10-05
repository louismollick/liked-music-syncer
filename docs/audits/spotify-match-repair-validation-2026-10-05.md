# Spotify matching repair validation

Validated October 5, 2026 against an isolated checkout and anonymous public YouTube Music reads. The running scratch profile was not changed by validation. The read-only SQLite backup, old/new comparisons and full parsed responses remain in `/tmp/lms-failure-review`. No cookies or session tokens were used in these replays.

## Failure replay

All 46 reviewed failures were replayed. The repair matched 22; 19 still had no compatible Release Track, four remained ambiguous, and one was marked unavailable. Newly accepted tracks were checked against their available browsed release membership, exact native artist/title evidence or explicit release preference, symmetric version checks and the five-second duration limit. The largest accepted duration difference was 1.291 seconds.

| Spotify title | Chosen catalog title | Catalog video | Duration difference, seconds |
|---|---|---|---:|
| Blurry Eyes | Blurry Eyes | ZWUof4OK7Sw | 0.628 |
| Driver's High - Remastered 2022 | Driver's High (Remastered 2022) | P3fNZ2wwLGw | 0.385 |
| Gaitou To Apartment | 外灯とアパート - Gaitou To Apartment | g0jDmd2kZ3g | 0.160 |
| HONEY - Remastered 2022 | HONEY (Remastered 2022) | Lbq3gklWvIc | 0.292 |
| Laputa | Laputa | iT6_UhWEP4Q | 0.456 |
| Lazy river | Lazy river | P4I8n9T1CLU | 0.433 |
| READY STEADY GO - Remastered 2022 | READY STEADY GO (Remastered 2022) | scohx9trwrw | 0.644 |
| Reverb | Reverb | _FfCWvM9_Eo | 0.891 |
| Sucide Girl | スーサイド・ガール - suicide girl | xD-8dSk37VI | 0.971 |
| Svefn-g-englar | Svefn-g-englar | VCVtqwu3_vg | 0.150 |
| The Sun | 太陽 - The Sun | 3e5wGzuZXSY | 0.983 |
| flower | flower | _0Yr5qrMoDw | 0.734 |
| いかれたBaby | いかれたBaby - IKARETA BABY | GJMBdDibHbw | 0.000 |
| ゆきこさん | ゆきこさん - Yukikosan | K-g02aE1oh0 | 0.507 |
| わたしの金曜日 | わたしの金曜日 - Watashino Kinyobi | W8SNdZoekgo | 0.254 |
| トラブルメイカーガール | トラブルメイカーガール - TROUBLEMAKER GIRL | a9CFl8ga4UU | 0.413 |
| ノーボーイ・ノークライ | ノーボーイ・ノークライ - No Boy No Cry | Ssw44LPpEmE | 0.934 |
| メイズ参上！ | メイズ参上！ - Maids Sanjo! | Xu3ew8Z5660 | 0.948 |
| 回廊 | 回廊 - Corridor | 7mAenPspG-A | 0.494 |
| 拍動 | 拍動 - Pulsation | C1MEaBZUzmA | 1.291 |
| 海ファズ | Umifuzz | Vi0u6MMk3zc | 0.214 |
| 自然法则 | 自然法则 - Natural Law | eweLaWyZowo | 0.560 |

Party!!, Bakaneji, ヘッドライト花火 and 春 remain ambiguous. The metadata does not distinguish their competing video IDs strongly enough. suddenly remains unavailable. 笹川真生 and 0.8Syooogeki remain unresolved because their returned native-page names do not match exactly; title and duration alone do not override the artist gate.

## Successful-track regression replay

A read-only backup contained 299 downloaded Spotify likes. The original and revised matchers were run over those sources with shared cached public catalog responses, so both saw identical search/release data.

- The original matcher produced 294 ordinary winners. Every one retained the same identity key with the revised matcher; none became a failure.
- Five other sources were ambiguous when freshly searched by the original matcher. The revised matcher resolved The Reason, Imagine and three blink-182 songs through stronger exact release/title evidence.
- Four fresh-search results differed from saved scratch choices. Out Of Control differed in both original and revised fresh searches, indicating catalog/search drift rather than this repair. Three blink-182 songs preferred their explicitly named Enema Of The State album over the previously saved Greatest Hits appearance. Each was inspected: the same artist and song title, the requested album, and compatible duration. Normal existing-recording reuse remains intact; this test did not rewrite those files or change saved identities.

## Regression fixtures and checks

The checked-in fixture minimizes 22 representative real response captures, includes competing wrong artists and editions, and replaces liked dates/positions with neutral values. Release pages for the new alias path were fetched from the real catalog before inclusion. Unit and integration tests exercise exact native aliases, token multiplicity, short-title substring rejection, original-title video identity, unavailable membership, fallback-only optional reads, request caps, promise eviction, cancellation, transient errors, and existing-library joins without another match or download.

Claude Opus 5.5 approved the revised plan after the first round identified false-positive and optional-network-failure risks. Its two binding constraints are reflected in the tests: narrow variants do not gain substring credit, and native reads filter duration/version/exact title before spending their budget.

## Implementation review round 1 fixes

Codex identified full bilingual-label containment, recording suffixes treated as bilingual variants, and loss of release evidence when deduplicating with a Standalone Recording. All three were reproduced and fixed. Added regressions reject short-title containment in both directions, exclude version/edition/mix/recording suffixes from relaxed title identity, and preserve proven release metadata while reusing a Standalone track's existing audio file and joining contributions.

After these changes, offline rescoring of the 294 ordinary winners in the captured successful-track replay rejects none. All 22 real fixture cases still pass. The complete suite passes with 478 tests and two skipped; lint, all typechecks and the production build also pass. Independent reviewers must approve the revised commit before merge.

Claude additionally found that bare whole-title containment could download or reuse a different song, and that saved-library selection bypassed the runner-up margin. Those were fixed with delimited-suffix-only containment credit, exact-title evidence before saved-library reuse, and the same candidate selector as fresh matching. Five real-shaped negative pairs now fail, including Home/Home Again, Interlude/Interlude II and Stay/Stay With Me. Existing delimited suffixes still score successfully. Integration tests verify that uncertain saved metadata triggers a fresh search and that proven video identity still joins contributions without another download.

The sign-out regression covers refreshes finishing both before and after delayed storage clearing. The album version regression preserves "The World We Live In" as a studio album. Spotify account-switch tests verify failed replacement checks preserve the old account, successful checks replace it, and switching back reactivates its sources. Invalid route values for `likedOn` are discarded before IPC.

At this revision all 501 tests pass, with two skipped. Lint, all typechecks and the production build pass. An additional integration case checks that an exact Release Track previously released by the user takes precedence over a Standalone upgrade, preserving the exclusion and avoiding identity collisions.

Offline rescoring still preserves the 294 captured ordinary winners. A fresh full 299-source replay is recorded separately in `/tmp/lms-failure-review/success-regression-round2.json`. Both matchers shared the same live catalog responses. This time the original matcher found 296 ordinary winners, all unchanged by the revision, with no new failures. The remaining three old ambiguities resolved to the explicitly requested Enema Of The State album for Adam's Song, What's My Age Again? and All The Small Things. Their exact titles and artist and compatible durations were inspected; these are the same three edition preferences inspected in the first replay.

## Implementation review round 2 fixes

Claude found same-script suffixes such as Reprise and Pt. 2 receiving exact bilingual title evidence. Variant splitting now requires exactly one segment to contain non-Latin letters, apart from identical repeated normalized labels. A separate symmetric recording-section gate covers reprises, intros/interludes/preludes, bonus tracks and numbered parts, so ordinary suffix scoring cannot reintroduce the same false positives. Tests exercise those titles in both directions, distinct part numbers, Japanese labels with an English section suffix, fresh matching and saved-library reuse.

Codex found version labels in the first bilingual segment bypassing the exclusion, and exact album names Live and LIVE! bypassing the studio/live gate. Both were fixed and reproduced through the full matcher, with studio-name regressions retained. All 22 real fixture cases pass. The complete suite passes with 523 tests and two skipped; lint, all typechecks and the production build pass.

The first replay of these changes exposed one ordinary winner choosing a different album: the catalog label "LET IT DIE（OAO） - LET IT DIE (OAO)" repeats the same Latin title with width and parenthesis-spacing differences. A narrow identical-label rule restores that evidence without admitting different same-script suffixes. A regression covers both directions. Offline rescoring again preserves all 294 original captured ordinary winners.

The optional Standalone-to-Release metadata upgrade can be reversed by Refresh when the higher-priority YouTube liked source still resolves as Standalone. This accepted non-blocking limitation is documented in the PR description. It does not cause another audio download.

The final full 299-source live replay, in `/tmp/lms-failure-review/success-regression-round3-final.json`, preserves all 294 ordinary winners from the original matcher on identical shared catalog responses, with no new failures or changed ordinary identities. Five old ambiguities resolve through stronger evidence: The Reason, Imagine and the three blink-182 songs already inspected in the original validation. LET IT DIE retains the original THE NEWEST JOKE album identity after the identical-label correction.

## Implementation review round 3 fix

Claude approved head 51f1705. Codex then reproduced optional-evidence budget exhaustion by candidates already rejected for incompatible recording sections. The section parser is now shared by scoring and the optional-read prefilter. No ordinary scoring changes were made after the 299-source replay.

Two new full-matcher regressions were verified failing before this change and passing afterwards: three rejected sections preceding a valid original-title candidate, and three rejected mixed-script sections preceding a valid native-artist candidate. Each valid match now needs only its one relevant read. All 22 real fixture cases still pass; the complete suite passes with 525 tests and two skipped. Lint, all typechecks and the production build pass.
