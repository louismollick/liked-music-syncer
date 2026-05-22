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
