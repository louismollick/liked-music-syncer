# Take genres only from Last.fm and drop MusicBrainz

The app no longer talks to MusicBrainz. Genres come only from Last.fm artist top tags, filtered to a vendored list of recognized genre names. A successful lookup sets the genre, replacing any existing one, and a clean miss clears it. A failed lookup never strips a genre the track already has. Without a Last.fm API key, tracks keep the genre they have.

MusicBrainz also supplied an ISRC and a recording ID. Nothing used them except carrying them into tags and showing them in track details, so they are gone from the database, the tag fields and the UI. Rewriting a file removes the `ISRC` and `MusicBrainz Track Id` atoms (tag schema version 9). A database migration clears every genre and marks every wanted, matched track for a Last.fm lookup, so the first retag pass replaces all MusicBrainz-era genres.

Why: on the live library Last.fm covered 603 of the 614 tracks MusicBrainz had genres for, plus 780 of the 1,174 MusicBrainz lacked. MusicBrainz cost about 5 seconds per track at its one request per second limit, and Last.fm costs one cached request per artist.

Trade-off: Last.fm genres belong to the artist, not the release or recording, and a generic artist name can collide with a different artist on Last.fm. The lookup already skips Unidentified Artists and names shared by more than one Artist in the library (ADR 0001).
