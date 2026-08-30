# Account ownership and download attribution

Status: Future design opinion; intentionally outside the automatic-auth implementation

## Recommendation

Do not make an audio file “belong” to the YouTube Music Account that caused its download. Treat the file as one local library artifact, and record account-specific provenance separately.

The useful future distinction is:

```text
YouTube Music Account
        |
        | observed/liked through
        v
Source Contribution ----> Library Track ----> File Artifact
        |
        v
     Sync Job
```

A track can be liked by several accounts, imported from another service, or matched to an existing local file. Those facts should converge on one library track without erasing which account contributed each observation.

## Why this model is preferable

Partitioning files by account looks simple initially, but it creates awkward behavior as soon as two accounts like the same recording:

- the app either downloads duplicates or invents a primary owner;
- switching accounts can make an existing file appear unavailable even though it is still local;
- unliking from one account risks deleting a file still wanted by another;
- Brand Account changes become filesystem migrations;
- metadata repair and remote copies become account-specific for no musical reason.

Account attribution is still valuable. It answers “why is this track here?”, permits account-scoped views, and makes future removal policies safe. It belongs on the source observation, not the bytes on disk.

## Proposed future entities

These names are proposals, not additions to the current canonical glossary.

### Source Account

A durable app record for a selectable account on an external platform. For YouTube Music, it should use a verified stable platform identifier when one is available—not `X-Goog-AuthUser`, an array index, email, display name, or handle.

Suggested fields:

```text
id
platform
platform_account_id
display_name_snapshot
handle_snapshot
image_cache_key
first_seen_at
last_seen_at
retired_at
```

An Auth Source is not a Source Account. Browsers and profiles are ways to obtain a session; they do not own library data.

### Source Contribution

An assertion that a Source Account contributed or observed a source item.

Suggested fields:

```text
id
source_account_id
platform_item_id
library_track_id
relationship        # liked, imported, playlist_member, manually_added
observed_present_at
observed_absent_at
first_seen_at
last_seen_at
```

Use a uniqueness rule based on source account, platform item, and relationship. Do not assume one platform item always maps permanently to one audio file; catalog replacements and matching corrections happen.

### Sync Job account context

Snapshot the account used by each source-reading job:

```text
sync_job.source_account_id
sync_job.account_display_name_snapshot
sync_job.auth_source_description_snapshot
```

The stable account relationship supports queries. The snapshots explain historical logs even if the account is renamed or its browser later disappears. The Auth Source description is diagnostic context, not ownership.

### File Artifact provenance

Keep the File Artifact attached to the Library Track. If auditability is needed, add a provenance/event relation recording which job first created or later replaced the artifact:

```text
file_artifact_event
  file_artifact_id
  sync_job_id
  event_kind          # created, replaced, retagged, moved, copied
  occurred_at
```

Do not add `owner_account_id` to the file table.

## Expected behavior in common cases

### Two accounts like the same song

Create two Source Contributions pointing to one Library Track. Keep one managed local artifact when the resolved recording and format are equivalent. Account-scoped views can show the track for both accounts.

### One account unlikes the song

Mark only that contribution absent. Keep the Library Track and file if another live contribution, a manual-retention flag, or another source still requires it. A future cleanup policy can remove an unreferenced managed artifact, but removal must never be the direct side effect of one account's absence result.

### A Brand Account is selected

Treat it as its own Source Account even when it shares a Google Session with a personal identity. Google Session membership and browser position are authentication details and may change independently.

### An account disappears from browser cookies

Retain its Source Account and historical contributions. Mark the authentication relationship unavailable; do not delete provenance. A later session may make the same account accessible through another Auth Source.

### An existing local file matches a newly liked item

Attach the new Source Contribution to the matched Library Track. Record that the artifact was discovered or reused rather than downloaded by that account. This avoids false ownership claims.

### A catalog item is replaced

Keep the original observation and record the updated platform mapping or contribution history. Do not rewrite historical jobs to pretend they saw the replacement identifier.

## Identity requirement

This design should wait until the app can obtain a stable, validated identifier for a selectable YouTube Music identity. Display names, handles, profile pictures, authuser indices, and `onBehalfOfUser` positions are all unsuitable as database identity keys.

If the auth work can enumerate accounts but cannot prove a stable identifier, account switching may still be useful as ephemeral authentication state, but durable download attribution should remain deferred.

## Suggested rollout later

1. Add Source Account and Sync Job account context without changing file placement or cleanup.
2. Add Source Contributions during liked-song ingestion and backfill an `unknown legacy account` contribution only where necessary.
3. Add account-scoped library filters and provenance explanations.
4. Define an explicit retention/cleanup policy for tracks with no live contributions.
5. Only then consider account-aware sync scheduling or remote destinations.

The automatic-auth feature should prepare for this by keeping browser identity, Google Session, and YouTube Music Account separate in its internal model. It should not modify the present library schema merely to anticipate this future.

