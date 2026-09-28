# Catalog correctness and a clean library rebuild

Status: ready for implementation. Reviewed by the primary agent and two independent Codex passes at high effort; findings incorporated. No implementation or library changes have run.

## Decision

Fix the permanent causes, then rebuild the current Library from current source data into an empty database and output folder. Keep the old database and files as an archive until the replacement is verified. The user explicitly accepts redownloading to keep legacy repair logic out of the app.

The previous draft tried to salvage every old file. That introduced provisional Matches, automatic rematching, contribution splitting, and a large migration. Those are removed. Future database recovery remains supported for files the fixed app writes, using an explicit record that a Match actually occurred.

## Verified findings

The audit used `master` at `feee2b5`, the checked-in catalog fixtures, and the September 27 database snapshot at `/tmp/lmsaudit/library.db`. These counts describe that snapshot, not a promise about today's upstream catalog.

- **Albums were discarded.** The seven album cards in `test/fixtures/catalog/artist.json` have year-only subtitles. `catalog/parsers/artist.ts:36` calls the year a release kind; `reconcile/sources.ts:263` filters it out. The tricot snapshot therefore contained 46 singles/EP contributions and no albums, despite reporting success.
- **Old tags became authoritative metadata.** Of 1,777 tracks, 1,463 saved Matches were reconstructed from old tags, including 1,348 with active contributions. `inventory.matchFromTags` supplies those values and `nextStep` deliberately leaves them alone. Catalog claiming sometimes changes the track key without replacing its saved metadata. This explains the second `tricot` identity and mixed disc numbers.
- **Tag version is not provenance.** At least 436 files with provisional saved metadata already carry schema-6 tags. `writeTags` stamps the current schema on retagging, so a schema bump cannot prove that matching happened.
- **A source video is not a Release Track.** The old Fudeki track 18 file holds instrumental video `wh0z37oqqeg`, while its saved source video is `JCm99M7FtFE`, which the release lists as track 6. Reusing files through the source video is unsafe without a saved matching decision. Twelve similar-looking pairs are possible duplicate downloads, not proof that their distinct video IDs identify the same audio.
- **Two bugs can recur without old files.** Refresh prefers a like even when an active catalog contribution fixes a different release identity. Merging chooses a merely intact target file, can orphan a damaged file, and can delete remote audio before replacement succeeds. These need permanent fixes.
- **Some upstream credits really lack IDs.** The saved Fudeki release response has 24 tracks. Tracks 12 and 24 credit `tricot / in the blue shirt` without a channel ID. Keep that Unidentified Artist. Do not infer identity by splitting names or merge artists by name.

The old library has 115 No Longer Wanted tracks. Rebuilding from current likes and catalogs will not recreate them unless current sources want them again. The archive preserves them, including anything now unavailable online.

## Permanent changes

### 1. Discover catalogs from the shelves that define them

`CatalogReleaseRef` carries `shelf: 'albums' | 'singles'` instead of the misleading card `kindLabel`. Pass the category through `releaseRef`, `parseArtistReleasesPage`, and `artistReleases`. Keep year parsing. The release page's header continues to supply the release kind for Match metadata.

Delete `isMainCatalogRelease`. Every parsed release from Albums and Singles & EPs belongs to the Official Main Catalog. Other shelves are excluded by the artist parser.

Parsing must distinguish an empty shelf from an unsupported response. Reject malformed release cards within a recognized shelf or grid, including partial parsing that would silently omit one card. Ignore only recognized non-release items such as continuation controls. Retain the existing repeated-continuation checks. When following a more link, include the inline refs as well as paginated refs, deduplicated by release ID, so a truncated list cannot erase known inline releases.

Persist the shelf in each catalog contribution's raw data. Before committing a new snapshot, reject disappearance of a previously populated shelf, even when the other shelf keeps the total above the existing 50% threshold. Apply this to albums and singles. A new artist with only singles remains valid. A rejected snapshot leaves the prior contributions active and reports a source error. Keep the existing whole-snapshot transaction and decline guard. Legacy raw rows without a shelf cannot establish this comparison; the rebuild gets its baseline from the corrected parser.

### 2. Keep a catalog's exact Release Track through Refresh

An active catalog contribution must link to `releaseIdentityKey(release_id, source_video_id)`. Enforce this during matching and merging, not just initial linking.

Change `matchInputFor` to prefer an active catalog contribution when one exists. Refresh then looks up that exact Release Track again. With no active catalog contribution, prefer an active like as today. A like already resolved to the same Release Track can share it; keeping a saved decision is consistent with the existing Match model.

Before committing `runMatch`, check all active catalog contributions on both the current track and any merge target. Each expected key must equal the proposed Match identity. Capture the selected input and relevant active contribution identities before the network work; recheck them in the transaction after the awaits. If the input or relevant source state changed, discard the result and retry from current inputs without consuming the permanent-failure retry budget. Never commit a stale Match or move a catalog contribution to another release.

Revalidate user intent in that transaction too. Stop managing the current track cancels its in-flight work. A released target stays deliberately excluded: a new catalog contribution can link to that identity but schedules no file work; a like resolving to it records the same exclusion without resurrecting or merging into the released track. Move only the resolved liked contribution onto that excluded identity. Keep any prior file and other contributions on the original track, marking it No Longer Wanted only if it loses its last active contribution. Reports distinguish this explicit exclusion from a completed download. A No Longer Wanted target can regain desire, but wait for any pending explicit deletion to finish before reusing it. Such a wait must allow the tombstone loop to run and expose a retryable reason, not spin or merge into a deletion in progress.

A new like is matched normally, then merges by canonical identity into an existing catalog track. Once a catalog no longer wants the track, a remaining like can choose another release on Refresh. This rule removes the old draft's split-and-recreate procedure.

### 3. Restore only files with recorded matching provenance

Add `confirmed?: true` to the persisted Match and `LMS_MATCH_CONFIRMED` to the tag format. `runMatch` sets confirmation only after a successful matcher result. Restoring a confirmed file preserves it. Neither a tag schema version nor a canonical row key grants confirmation. The tag writer derives the atom from the saved Match's explicit confirmation.

`matchFromTags` accepts only a confirmed file with the required source/resolved IDs, valid resolution method, and consistent release/standalone metadata. It reconstructs the canonical identity directly. Unmarked or malformed files are listed as Unmanaged and remain untouched. There is no provisional Match and no automatic v5/v6 repair. The atom records provenance, not cryptographic authenticity or a guarantee against edits made while the database was absent.

Remove the `adopted:` identity creation, `adoptedClaim` fuzzy source/video fallback, and catalog adoption branch that changes a row key without matching. Ordinary confirmed restoration and catalog linking use the same canonical key. A confirmed restored file can be claimed by its recorded liked source when that mapping is unique. If ambiguous, match the like normally and merge by canonical identity; do not choose an arbitrary file. Audit both liked-claim paths, including `claimAdoptedFiles`, so startup ordering does not change the result.

When two confirmed physical files claim one canonical identity, keep one tracked and list the extra as a released Unmanaged File, without deleting it or creating a suffixed track identity. Use deterministic path order and keep the tracked file on later scans. An unreadable file is never selected over a readable one.

Normalize an absent confirmation field and `false` equally wherever stored and read tags are compared. Replace raw JSON equality in both Outside Edit checks with the shared semantic field comparison. An audio-only edit must remain an audio edit when an old stored tag JSON lacks the new field. Existing unconfirmed saved Matches must never gain confirmation merely through retagging.

For this release, the existing database is replaced by the rebuild procedure below. No automatic migration attempts to bless or repair its old saved Matches. During implementation, update `CONTEXT.md` so Unmanaged File includes files the current app declines to manage, including unsupported old tags and extra physical copies. Record the intentional legacy adoption cutoff and catalog-first Refresh rule in a short ADR; replace the old adoption policy in `docs/plans/overhaul.md` with a reference to that decision.

### 4. Complete a replacement before deleting displaced merge files

Keep this logic within the existing matching, placement, and tombstone machinery. Do not add a second repair pipeline or remote recovery downloader.

Before a merge, inspect both files: existence, hash, audio video ID, and Outside Edit status. Keep a valid file matching the new Match's `catalogVideoId`, preferring the target on a tie. Otherwise keep an existing valid file as the temporary fallback until acquisition places the new audio. With no valid file, leave acquisition pending. `runAcquire` already stages replacement before placement.

Move the kept file's upload record with that physical file. Displaced healthy audio and sidecars receive deferred merge tombstones. A displaced file that exists but is damaged becomes released Unmanaged, using the same inventory exclusion as Stop managing; it is never silently deleted or re-adopted. Remove missing file records. Retain deletion intent for displaced remote objects, but defer executing it until a replacement is verified.

Add nullable `replacement_track_id` and `expected_sha256` columns to tombstones in a new numbered migration. Do not overload `track_id`, which already controls explicit-deletion finalization. Merge tombstones have `track_id = NULL` and depend on the survivor through `replacement_track_id`. Local merge cleanup records the displaced audio and sidecar hashes separately.

- Local cleanup requires a placed, hash-valid survivor file with the audio ID selected by its current saved Match and no Outside Edit. It must also preserve the existing owned-path guard. Immediately before deleting a displaced artifact, check its expected hash. Missing paths complete without deletion; changed bytes cancel deletion and become released Unmanaged, including changed sidecars. Dropping the old file record must not make a later outside edit disposable.
- Remote cleanup additionally requires a verified current survivor upload to the same target and an enabled matching remote configuration. Disabling the remote preserves the old remote objects. A different target leaves this cleanup pending for the original target. Keep the existing target-and-path ownership check, including sidecars.
- Failed acquisition, failed upload, or a restart cannot satisfy these conditions by setting track state to `done` alone. Check the actual file and upload facts.
- When the survivor merges again, transfer its cleanup dependencies to the new survivor within that transaction.
- If the user explicitly deletes a No Longer Wanted survivor, convert its dependent cleanup to explicit deletion only for the chosen local/remote scope, clearing the replacement dependency. Cancel cleanup for the unchosen scope: retain its local artifacts as released Unmanaged and leave its remote objects untouched. Stop managing cancels all dependent cleanup with the same retention behavior. These choices may leave extra remote copies, which the operation report must identify; silently deleting the unchosen scope is worse. Do not leave replacement dependencies pointing to a deleted or released track. Converted local cleanup still checks the recorded displaced-file hash.

Pending local cleanup paths remain excluded from adoption. A cleanup failure stays retryable through the existing tombstone loop. Healthy replacements must never be deleted because an old tombstone names a reused path.

This is required for ordinary Refresh and merges, even after rebuilding. It resolves the earlier review's remote-copy loss without a legacy salvage subsystem.

## Implementation order and tests

Implement each permanent change with behavior tests through the existing catalog, inventory, and reconciler interfaces. Do not change unrelated renderer work currently in the tree.

1. **Catalog discovery.** Pin the seven year-only album refs and their IDs/years using `artist.json`; assert the catalog check creates album contributions, including Fudeki and Jodeki. Test more-link pagination, inline refs, repeated tokens, malformed individual cards, legitimate singles-only artists, and loss of either previously populated shelf. Failed snapshots leave contributions unchanged.
2. **Catalog identity.** Fresh shared like/catalog track, then Refresh: the exact album track and file remain. New like resolving to an existing catalog track: one identity and one file. Deactivate the catalog, Refresh from the remaining like: legitimate re-key still works. Change source input or add/remove a catalog contribution during a delayed match: stale result is discarded and current work succeeds. Stop managing the current/target track during that wait, and add new like/catalog contributions to a released identity: no resurrection or automatic download. Reuse a No Longer Wanted target after its pending deletion finishes. Verify all active catalog contribution identities after each case.
3. **Restoration.** Write confirmed release and standalone files through the real pipeline, discard the test DB, restore: canonical identities, artist credits, order, and audio remain. Cover unlike source/resolved video IDs, catalog-first and likes-first startup, ambiguous source mappings, duplicate confirmed copies, unmarked v5/v6 files, malformed marked files, and repeat startup. No adopted-prefix identities, arbitrary source claims, or unnecessary downloads. Verify an old saved Match cannot become confirmed through retagging.
4. **Outside Edits and merges.** Missing confirmation field does not misclassify edited audio. Test matching source audio versus valid wrong target audio, two valid wrong-audio files, missing/damaged targets, associated uploads/sidecars, failed replacement download, failed upload, remote disabled/changed, restart, second merge, Stop managing, and path reuse. Test local-only and remote-only deletion both before and after replacement, including retained artifacts and canceled dependencies. Edit displaced audio and sidecars while cleanup is deferred, then complete the replacement: edited artifacts survive as Unmanaged. No old copy disappears before its required replacement exists; no damaged file is re-adopted.
5. **Fresh tricot end to end.** Use the saved Fudeki/Jodeki responses as fixtures after removing irrelevant response data. Start empty, enable its catalog and representative likes. Under those fixture responses, Fudeki and Jodeki each have 24 tracks in order. Fudeki has 22 channel-identified tricot tracks and two unidentified remix credits; no name-only `tricot` duplicate. Repeat the source check and restart: no duplicate files or repeated matching. The expected downloads are for the fresh desired set, not the old draft's two/five missing-file repair.
6. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and a packaged startup smoke test. Record unrelated pre-existing failures separately. The new migration must preserve old tombstone semantics for rows with no replacement dependency.

These are implementation gates. Planning and source inspection do not establish that they already pass.

## Rebuild the current Library

This is an operator procedure after the implementation passes its gates, not a permanent reset feature. It is not executed as part of preparing this plan.

### Preserve the old state and source intent

1. Stop the app before archiving or changing any paths. Back up the SQLite database through SQLite's backup mechanism. Preserve the entire old app data directory and music folder under dated sibling names. They must sit outside the new output folder, where scanning cannot adopt them. Verify the backups are readable. Preserve the old build for rollback.
2. Export the settings, selected account ID, full-discography artist channel IDs, and historical liked-source keys with `first_seen_at`. Export the No Longer Wanted list and an audio manifest containing path, release/video identity, and hash. Take the export from the final stopped snapshot, not the earlier audit copy.
3. The audited selections are Ave Mujica, East Of Eden, KISIDA KYODAN & THE AKEBOSI ROCKETS, Sokoninaru, and tricot. Use their saved channel IDs, not a name search. The audited selected account is `UCLlhNejpwRa6CC04-VaC70Q`; verify it at execution.

### Build in the final local paths

4. Create a fresh database at the normal app data path and an empty `/Users/louismollick/Music/liked-music-syncer`. Build here directly so absolute cover paths do not break during a later scratch-directory promotion.
5. Before any app launch, seed only allowlisted intent into that fresh DB using a disposable operator script: the five artists' IDs/names/channel IDs with Full Discography enabled, non-secret user preferences, and inactive/unlinked liked contribution stubs preserving source key, account/video ID, and first-seen time. Stubs have no saved Match or usable old raw metadata; the fresh successful liked check replaces their raw payload before activation. New likes get the normal new first-seen time. Carry over no tracks, files, uploads, tombstones, operations, source snapshots, artist-image paths, or old Matches.
6. Persist `remoteEnabled=false`, empty `rcloneRemote` and `remoteFolder`, the empty new output path, and no selected account until sign-in. Verify these facts and the empty work tables before startup. Do not copy browser `Partitions`; unset `LMS_DEV_IMPORT_COOKIES` so a development launch cannot import a different Google session. The existing app processes stored remote tombstones even when remote is off; a fresh DB with none is the isolation guarantee.
7. Launch the fixed build and sign in to the same YouTube Music Account. Fetch a fresh complete liked snapshot and every selected artist's catalog. Historical inactive stubs cannot schedule old music while signed out. Failed source checks remain visible; a quiet worker is not evidence of a complete rebuild. Compare current counts with the old snapshot and platform header, and explain differences before accepting the rebuild.
8. Let the ordinary pipeline download, tag, and inventory the desired set. Produce a local report: successful source checks, unique canonical identities, active contributions with matching tracks, file hashes/audio IDs, failed steps, and ordered Fudeki/Jodeki track lists. Every active desired track must have its expected file or a specifically reviewed failure. Preserve unavailable music in the old archive. Compare identities as well as counts; upstream duplicate release IDs remain distinct under ADR 0002.

### Replace the remote only after local acceptance

9. Keep the old remote untouched while the local rebuild runs. Its audited path is `vps:/home/ubuntu/louismollick-server/music`. After the local report is accepted, stop the app, verify the remote path and space, rename the old remote folder to a dated sibling outside the player's scanned music root, and create an empty folder at the original path. This is a directory archive, with no reliance on hard-link or rclone overwrite behavior. Keep playback services from scanning an intermediate missing/partial library where practical.
10. Configure the new DB for that original remote path and enable uploads. Its upload records start empty. Wait for every expected audio/sidecar upload to verify and for all errors to be resolved or explicitly accepted. Compare the resulting inventory with the local report, then trigger the external player's scan.
11. Keep both old archives until the user has checked the rebuilt library, including any unavailable and No Longer Wanted tracks. Deleting those archives is a separate explicit action. No general migration framework, automatic legacy repair, or title-based deduplication is added to the app.

Rollback: stop the app, preserve the incomplete new state separately, restore the old app-data and local-output directories to their original paths, restore the old remote directory if cutover occurred, and run the old build. Do not run both builds against the same data or output paths.

## Tradeoffs

This redownloads the active desired library and uploads it again. The old snapshot occupied roughly 9.2 GB; the corrected catalog adds previously missing albums, so neither final size nor track count can be predicted from that figure. Allow space for both generations locally and remotely. Matching, lyrics, and current availability may differ from the old app. Preserving like timestamps and the entire old archive limits unnecessary information loss without preserving bad metadata.

There is intentionally no support for silently restoring unmarked legacy tags into a new Library. Future files from the fixed app remain recoverable without treating a schema number as proof of a Match.

The multi-disc track-total issue noted in the prior audit and cosmetic collision suffix renaming remain separate work. Neither explains the reported tricot symptoms. Name-based artist merging and display-only ordering fixes remain rejected.

## Review record

- Recovered the original thread's 33 messages and relevant tool outputs, including both Codex review reports. The second report's rollout ordering, duplicate adoption, confirmation-field comparison, missing-shelf, and merge deletion concerns informed this revision.
- An independent `gpt-6-sol` review at high effort checked which changes remain necessary after a clean rebuild. It confirmed the catalog, identity, provenance, and merge-lifecycle requirements. It also rejected a proposed generic merge refusal because the current UI had no valid way to unblock every case.
- A fresh independent `gpt-6-sol` review at high effort found three remaining gaps: scoped deletion could strand cleanup, delayed matching could undo Stop managing, and deferred deletion could erase a later Outside Edit. The final revision specifies cancellation/retention by deletion scope, transactional user-intent checks and released-identity behavior, and expected hashes for displaced files. Each has explicit acceptance tests. The primary agent checked these corrections; they have not had another independent review round.
- Claude review was omitted at the user's request because its allowance was exhausted. No app, live library, or remote operation ran during this planning work. Implementation tests and the later rebuild report remain required gates.
