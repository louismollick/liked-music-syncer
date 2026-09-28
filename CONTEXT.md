# Liked Music Syncer

Liked Music Syncer builds and maintains a local music inventory from liked songs on streaming platforms.

## Language

### Library

**Library**:
The inventory of Managed Files and their metadata in the user's output folder. It is not a playable music collection inside this app; playback belongs to external apps such as Navidrome or Plex.
_Avoid_: Player library, playback library

**Managed File**:
An audio file the app created and tagged as its own. Only Managed Files belong to the Library. The app can rebuild its inventory from the tags of files that record a confirmed Match.
_Avoid_: Library file, owned file

**Unmanaged File**:
An audio file in the output folder that the app does not manage: a file it did not create, a file from an older version whose tags record no confirmed Match, or an extra copy of a Release Track the Library already holds. The app reports it but never merges it into the Library or deletes it.
_Avoid_: Foreign file, imported file

**Outside Edit**:
A change to a Managed File that the app did not make. The app reports it and can rewrite the file to its intended state.
_Avoid_: Drift, corruption

**Remote Library**:
A mirror of the Library on a remote music server. Only the app writes to it.
_Avoid_: Cloud library, streaming library

**Remote State**:
Whether a Library track's remote copy is in sync, stale, missing, uploading, or failed to upload.
_Avoid_: Remote tab, remote section

**Inventory Filter**:
A concrete filter that shows library items by an observable local, remote, metadata, matching, or processing state.
_Avoid_: Needs review, low confidence, attention state

### Sources and desire

**Liked Music Library**:
The set of songs a user has liked on a source platform such as YouTube Music or Spotify.
_Avoid_: Playlist, remote library

**Source Contribution**:
A relationship showing that a Liked Music Library or Full Discography catalog contributed a Desired Track. A Desired Track can have many Source Contributions.
_Avoid_: Original source, single source

**Liked Date**:
When a song entered a Liked Music Library. The app uses the platform's timestamp when one exists, and otherwise the first time it saw the like, ordered by the platform's liked-songs order.
_Avoid_: Download date, added date

**Desired Library**:
Every track the user's Liked Music Libraries and Full Discography catalogs say belongs in the Library.
_Avoid_: Wishlist, target set, queue

**Desired Track**:
One member of the Desired Library, backed by at least one Source Contribution.
_Avoid_: Wanted song, pending song

**No Longer Wanted**:
A Library track that no Source Contribution backs anymore, for example after an unlike. The app keeps it until the user deletes it.
_Avoid_: Orphan, stale track, cleanup candidate

**Full Discography**:
A per-artist setting the user turns on to download that artist's whole Official Main Catalog. The app treats that artist's songs as Desired Tracks even when individual songs were not liked. It names an intent, not a finished download: new releases keep arriving while it is on.
_Avoid_: Favorite Artist, liked artist, downloaded artist

**Official Main Catalog**:
The default set of songs considered for a Full Discography artist, focused on official albums, singles, and EPs.
_Avoid_: All uploads, every appearance

### Music identity

**Recording**:
The underlying performance or audio shared by one or more Release Tracks. A source video ID may identify a Recording, but it does not identify one appearance on an album or single.
_Avoid_: Library Track, release

**Release Track**:
A Recording's appearance on one Release. The Library keeps separate Release Tracks when an album, single, EP, or reissue uses the same Recording.
_Avoid_: Recording, duplicate song

**Standalone Track**:
A Recording the Library keeps without a known Release, such as a music video or a cover. The Library files each one as its own single.
_Avoid_: Unknown Album, loose video

**Release**:
A published album, single, or EP identified by a trusted catalog release ID when one is available.
_Avoid_: Recording, liked-song group

**Album**:
A library grouping for Release Tracks based on the final downloaded or tagged release metadata.
_Avoid_: Liked-song group, source album

**Artist**:
A credited performer identified by a trusted source artist ID when one is available. Artists with the same name remain distinct, and a track with several credited performers belongs to each Artist.
_Avoid_: Album artist

**Unidentified Artist**:
An artist credit that has a name but no trusted source artist ID. It can group local library tracks, but it cannot supply a remote artist image or an Official Main Catalog.
_Avoid_: Matched artist, inferred artist

**Album Artist**:
The artist credited for grouping an album in final library metadata.
_Avoid_: Artist

### Work

**Track Step**:
One unit of work that moves a Desired Track toward its intended state, such as matching, downloading, tagging, writing lyrics, or uploading to the Remote Library. A failed Track Step is retried on its own.
_Avoid_: Job, phase, task

**Activity**:
What the app is doing now and did recently, shown per track with the reason the work exists, such as a new liked song or a Full Discography catalog refresh. Users see track state, not run history.
_Avoid_: Sync Job, run, queue, run history

**Match**:
The saved decision behind a Desired Track: which source track, Release, MusicBrainz recording, and lyrics the app chose. The app writes tags from the Match and only looks it up again on Refresh. A Full Discography catalog names its exact Release Track, so a track a catalog wants is always looked up from that catalog, even when it is also liked.
_Avoid_: Resolution, candidate, lookup result

**Refresh**:
A user request to look up the Match again for one song, album, artist, or the whole Library. Nothing refreshes a Match automatically.
_Avoid_: Reprocess, resync, rerun

**Needs Attention**:
The state of a Desired Track whose Track Step failed permanently or used up its automatic retries. It waits for the user to retry.
_Avoid_: Failed job, error queue

### Authentication

**Google Session**:
The Google identity the user signed into through the app's own sign-in window. One Google Session can expose several YouTube Music Accounts.
_Avoid_: Browser session, auth source, YouTube account

**YouTube Music Account**:
A selectable personal or Brand Account identity used to access YouTube Music. This is the account the app shows and switches.
_Avoid_: Google Session, email account, channel

**Selected YouTube Music Account**:
The YouTube Music Account the app currently uses.
_Avoid_: Active Google Session, current channel

## Example Dialogue

Developer: "Should the Library screen include playback controls?"

Domain expert: "No. The Library shows inventory and metadata. Playback happens in Navidrome, Plex, or another music app."

Developer: "How do we show where a song came from?"

Domain expert: "Show which Liked Music Library or Full Discography catalog contributed it, what source was selected, and whether the file exists in the Library and the Remote Library."

Developer: "Should the user browse old sync runs?"

Domain expert: "No. They should see what is discovered, working, done, or failed now. Internal runs are only useful for debug."

Developer: "I dropped some MP3s from another tool into the output folder. Do they show up as Artists and Albums?"

Domain expert: "No. They are Unmanaged Files. The app lists them so you know they are there, but it never folds them into the Library."

Developer: "What does the user see when a new liked song appears?"

Domain expert: "A new Desired Track appears in Activity with its reason, then each Track Step shows progress until the file is in the Library and, if configured, the Remote Library."

Developer: "One track's upload failed. Does the whole catalog refresh fail?"

Domain expert: "No. Only that Track Step failed. The app retries it a few times, then marks the track Needs Attention. Retrying re-runs the upload without downloading again."

Developer: "We changed how the app writes genre tags. Does every song go back to YouTube Music?"

Domain expert: "No. The app rewrites tags from each track's saved Match. Only a Refresh looks the Match up again."

Developer: "Can the app delete songs automatically when they are no longer liked?"

Domain expert: "No. They become No Longer Wanted and stay until the user deletes them."

Developer: "If YouTube Music no longer likes a song, is it No Longer Wanted?"

Domain expert: "Only if no other Source Contribution backs it. A Full Discography catalog or another Liked Music Library can still want it."

Developer: "Someone retagged a file in the Remote Library by hand. Does the app adopt the new tags?"

Domain expert: "No. Only the app writes to the Remote Library. The app sees the remote copy as stale and replaces it."

Developer: "Does an Album come from the liked source?"

Domain expert: "No. Album identity comes from final library metadata. Source Contributions explain why tracks are present."

Developer: "Should artist pages use album artist or track artist?"

Domain expert: "Artist pages use track artist by default. Album artist still matters for album grouping."

Developer: "Is a Full Discography artist the same as an artist found in liked songs?"

Domain expert: "No. A Full Discography artist is explicitly selected by the user and expands desired music beyond individually liked songs."

Developer: "If a user liked some songs by a Full Discography artist, should those download twice?"

Domain expert: "No. Liked songs and Full Discography discovery merge into one Desired Track when they refer to the same Release Track."
