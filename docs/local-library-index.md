# Local library inventory

The configured output directory is the authority for local file existence and
paths. SQLite stores the last successfully reconciled inventory so the renderer
can open without waiting for a filesystem walk.

`LibraryService.reconcileLocalLibrary()` is the only entry point that refreshes
the local inventory. Startup and file-producing jobs call it in the background.
Operations that read local paths await it before building their work.

Each pass asks the Python worker for a complete snapshot of `.m4a` files and
their same-stem `.lrc` sidecars. The main process applies the snapshot inside a
SQLite savepoint. A walk or database failure rolls back the pass and keeps the
previous inventory available for browsing. It does not start an automatic retry
loop.

The file inventory records two content observations. `tag_fingerprint` is a
SHA-256 digest of metadata owned by Liked Music Syncer: the standard fields the
tag writer manages, LMS identity and provenance fields, embedded lyrics, and
embedded artwork. It deliberately excludes comments, ratings, play counts, and
unknown player-specific fields. Those fields may change without authorizing a
remote overwrite. `sidecar_sha256` records the bytes of the same-stem `.lrc`
file independently so sidecar drift can be repaired without copying the audio
file.

Remote reconciliation computes both observations from the files currently on
the remote server. It never trusts a fingerprint stored inside an audio file.
An owned-metadata difference replaces the remote `.m4a`; an `.lrc` difference
copies only the local sidecar. A remote sidecar with no local counterpart is
left in place because removing it is destructive.

Calls made during an active pass share its promise and request at most one
trailing pass. This absorbs the burst of completion events produced by a sync or
reprocess job without running one scan per song.

The inventory has no age threshold, readiness bootstrap, or index version.
Filesystem-dependent work either completes a current reconcile or stops with
its error. Callers also check a local file immediately before destructive work
or remote copy so an out-of-band deletion after the walk becomes a per-item
failure instead of an invalid copy attempt.
