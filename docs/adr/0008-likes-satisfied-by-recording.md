# Satisfy likes by Recording, keep catalogs per Release Track

ADR 0002 makes the Release Track the Library's identity, so the same Recording on an album and a single is two files. That rarely mattered with one source, because a YouTube Music like resolves to the album its own video belongs to. With Spotify as a second source it matters constantly: Spotify often lists a song on a different Release than YouTube Music does, and strict Release Track identity would download every such song twice. A like is therefore satisfied by any Library track of the same Recording, meaning the same YouTube Music catalog video. Whichever like arrives first decides the Release. Full Discography catalogs still name an exact Release Track and keep strict identity, and live, remix, instrumental, acoustic, and sped-up or slowed versions remain different Recordings.

## Consequences

Identity keys stay `<releaseBrowseId>:<videoId>`. The Recording rule applies when a like is matched, and existing duplicates are not merged retroactively; a Refresh applies it. Turning Spotify on cannot move a track a YouTube Music like already placed, because a YouTube Music like decides the Match before a Spotify like.
