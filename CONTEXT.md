# Liked Music Syncer

Liked Music Syncer builds and maintains a local music inventory from liked songs on streaming platforms.

## Language

**Library**:
The local inventory of music files and metadata that the app has built or discovered. It is not a playable music collection inside this app; playback belongs to external apps such as Navidrome or Plex.
_Avoid_: Player library, playback library

**Remote Library**:
A copy or serving location for local library files on a remote music server.
_Avoid_: Cloud library, streaming library

**Remote State**:
Whether a library item is present, missing, pending copy, or failed to copy in the remote library.
_Avoid_: Remote tab, remote section

**Inventory Filter**:
A concrete filter that shows library items by an observable local, remote, metadata, matching, or processing state.
_Avoid_: Needs review, low confidence, attention state

**Liked Music Library**:
The set of songs a user has liked on a source platform such as YouTube Music, Spotify, or SoundCloud.
_Avoid_: Playlist, remote library

**Source Contribution**:
A relationship showing that a liked music library contributed to a library item. A library item can have many source contributions.
_Avoid_: Original source, single source

**Album**:
A library grouping based on the final downloaded or tagged album metadata.
_Avoid_: Liked-song group, source album

**Artist**:
A library grouping based primarily on final track artist metadata.
_Avoid_: Album artist

**Favorite Artist**:
An artist the user explicitly marks for full-catalog syncing. The app treats that artist's songs as desired library items even when individual songs were not liked.
_Avoid_: Liked artist

**Official Main Catalog**:
The default set of songs considered for a Favorite Artist, focused on official albums, singles, and EPs.
_Avoid_: All uploads, every appearance

**Album Artist**:
The artist credited for grouping an album in final library metadata.
_Avoid_: Artist

**Sync State**:
The current observable status of library discovery, matching, downloading, tagging, lyrics, and remote copy work. Users should see song and library state, not internal run history.
_Avoid_: Run, sync run, run history

**Queue State**:
The top-level bucket a Sync Job or track work item appears in inside Sync, such as Needs approval, Currently running, Queued, Completed, or Failed.
_Avoid_: Stage, step

**Job Phase**:
The current parent-level progress of a Sync Job, such as fetching liked songs, expanding a Favorite Artist catalog, or copying to remote.
_Avoid_: State, step

**Track Step**:
The current child-level progress of a track work item, such as matching, downloading, tagging, writing lyrics, or copying to remote.
_Avoid_: State, phase

**Sync Job**:
A user-visible unit of async sync work such as a Liked Songs Sync, Favorite Artist catalog refresh, or Copy Missing to Remote operation. A Sync Job can expand into many track work items.
_Avoid_: Run, background task

**Sync Queue**:
The user-visible list of pending and running Sync Jobs and their track work items, organized by Queue State. The underlying work model is track-first, but the UI stays job-first with expandable track rows and can temporarily show a parent Sync Job before its track list is known. Once approval is granted, affected tracks return to the Sync Queue to finish remaining work.
_Avoid_: Run history, worker queue

**Needs Approval**:
The Sync view for proposed changes and cleanup that require user confirmation before work can continue. It is track-first because approval decisions apply to concrete track-level diffs. Once approved, affected tracks return to the Sync Queue rather than jumping directly to Completed Work.
_Avoid_: Active, queue

**Completed Work**:
Finished Sync Jobs and their track work items after they leave the Sync Queue. Completed Work uses the same job-first grouped UI as the Sync Queue rather than flattening into old run history.
_Avoid_: History, completed runs

**Failed Work**:
Sync Jobs and track work items that did not complete successfully. Failed Work uses the same job-first grouped UI as the Sync Queue so failure context stays attached to the parent Sync Job. If one Sync Job finishes with mixed completed and failed tracks, the whole job belongs in Failed Work.
_Avoid_: Error log, failed runs

**Reprocess**:
User-requested work that revisits an existing library item to refresh matching, metadata, lyrics, artwork, or files.
_Avoid_: Resync, rerun

**Proposed Change**:
A pending modification to an existing library item that needs confirmation before it changes or removes local files or metadata.
_Avoid_: Low confidence, review item

**Proposed Cleanup**:
A proposed deletion or removal action for library content that may no longer belong, such as a song no longer found in liked music libraries. It must be confirmed before anything is deleted.
_Avoid_: Auto-delete, pruning

## Example Dialogue

Developer: "Should the Library screen include playback controls?"

Domain expert: "No. The Library shows inventory and metadata. Playback happens in Navidrome, Plex, or another music app."

Developer: "How do we show where a song came from?"

Domain expert: "Show which Liked Music Library contributed it, what source was selected, and whether the resulting file exists in the Local Library and Remote Library."

Developer: "Should the user browse old sync runs?"

Domain expert: "No. They should see what is discovered, pending, complete, or failed now. Internal runs are only useful for debug."

Developer: "What shows up in Sync when a Favorite Artist refresh starts before the songs are known?"

Domain expert: "Show a Sync Job first. Once tracks are discovered, expand that job into track work items in the Sync Queue."

Developer: "How should Favorite Artist refresh rows be labeled?"

Domain expert: "Put the artist name in the main Sync Job label. Otherwise multiple queued artist refreshes are too generic to scan."

Developer: "What should the liked-song job be called if manual and scheduled are the same thing?"

Domain expert: "Call it Liked Songs Sync. The trigger source matters less than the user goal."

Developer: "Why does the Queue say track-first if the UI is grouped by job?"

Domain expert: "Track-first describes the underlying work model. The UI for both Sync Queue and Completed Work stays job-first, with expandable track rows."

Developer: "Should Failures flatten everything into one list?"

Domain expert: "No. Failed Work should keep the same job-first grouped shape so users can see which Sync Job produced the failed tracks."

Developer: "What if one Sync Job has both completed and failed tracks?"

Domain expert: "Move the whole Sync Job out of the Sync Queue and place it in Failed Work. Keep the completed and failed tracks visible together inside that job."

Developer: "Should approval-needed items stay inside the main Queue?"

Domain expert: "No. Needs Approval is its own Sync view because it needs richer diff-style detail. After approval, those tracks return to the Sync Queue for remaining work."

Developer: "Should Needs Approval be grouped by job like the Queue?"

Domain expert: "Not primarily. Needs Approval is track-first because approval decisions are made per track, even if small job context may still be shown."

Developer: "When should the app ask for confirmation?"

Domain expert: "Only when it would modify or delete existing library content, or when the app cannot choose a concrete match safely."

Developer: "Can the app delete songs automatically when they are no longer liked?"

Domain expert: "No. It may propose cleanup, but deletion requires confirmation."

Developer: "If YouTube Music no longer likes a song, should it be cleaned up?"

Domain expert: "Only if no connected liked music library still includes it. Multiple platforms can contribute to the same library item."

Developer: "Does an Album come from the liked source?"

Domain expert: "No. Album identity comes from final library metadata. Liked source contributions explain why tracks are present."

Developer: "Should artist pages use album artist or track artist?"

Domain expert: "Artist pages use track artist by default. Album artist still matters for album grouping."

Developer: "Is a Favorite Artist the same as an artist found in liked songs?"

Domain expert: "No. A Favorite Artist is explicitly selected by the user and expands desired music beyond individually liked songs."

Developer: "If a user liked some songs by a Favorite Artist, should those download twice?"

Domain expert: "No. Liked songs and Favorite Artist discovery should merge into one library item when they refer to the same song."
