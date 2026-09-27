# Library inventory and remote mirror

This note records how the app keeps its database, the output folder, and the
remote in agreement, and why. The plan in `docs/plans/overhaul.md` has the full
design; this is the part an operator or a future contributor needs.

## The folder is app-owned

Only files the app created belong to the Library. The app recognises them by
their `LMS_*` freeform MP4 atoms. Anything else in the folder is an Unmanaged
File: it is listed (Songs → Unmanaged) and never merged into the Library. There
is deliberately no "guess the identity of a foreign file" logic.

If the database is lost, the app rebuilds it from those tags on the next start
(adoption). Adoption reconstructs only facts the tags contain, keeps each
file's identity provisional (`adopted:…`) until a liked song or catalog track
claims it, and never re-downloads a file whose audio already came from the
right video. Tracks only become No Longer Wanted after every configured source
has completed a full check since the database was created, so a fresh database
cannot mark the whole library unwanted.

## Every write is journalled

Audio and `.lrc` files are written in `<folder>/.lms-staging/` (same volume),
tagged there, then placed with a no-clobber hard link (new paths) or an atomic
rename (paths the app already owns). Before touching a file the app writes an
`operations` row with the expected SHA-256. On startup it resolves leftover
rows by hash: a file that matches its pending operation is the app's own write
and its record is committed; only a file that matches neither the record nor a
pending operation is an Outside Edit. The staging folder is then deleted.

Outside Edits pause all automatic work on that track until the user chooses
Rewrite or Stop managing. The app never silently overwrites a file someone
changed.

## Tags are rewritten from saved facts, not the network

Each track stores its Match (catalog track, Release, MusicBrainz data, lyrics
text, processed cover). When tag rules change, the app recomputes the intended
tags from those saved facts and rewrites only files that differ. A difference
in `LMS_TAG_SCHEMA_VERSION` alone never triggers a rewrite, so an app update
does not rewrite and re-upload the whole library.

## The remote is a mirror only the app writes

Remote uploads go through rclone and work with any backend. After each upload
the app verifies the object: with a common hash when the backend has one (the
owner's SFTP remote exposes MD5 and SHA-1), otherwise by downloading it and
comparing SHA-256 locally. It records the upload (path, hash, size, and the tag
fields uploaded) so "stale" can say which fields differ without reading the
remote. Nothing runs on the server.

When a track has no upload record (fresh database or adoption), the app checks
that one remote object with the same verification and accepts an identical copy
at the same path instead of uploading it again. It never hashes the whole
remote: on SFTP a hashed listing makes the server read every file, and a cached
listing would go stale when objects disappear. Rebuilding after a lost database
therefore costs one small rclone call per adopted file.
