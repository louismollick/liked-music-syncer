# Restore only confirmed Matches, and look up catalog tracks from their catalog

The first release adopted files the previous app wrote and treated their tags as a saved Match. Those tags lacked artist channel IDs and consistent disc numbers, and sometimes recorded the liked video instead of the release track, so the Library showed duplicate artists, wrong orders, and a second download of the same songs. A tag schema version could not tell these files apart from files this app wrote, because retagging stamps the current version onto old data.

Files now record `LMS_MATCH_CONFIRMED` only when this app's matcher produced their Match. When the database is rebuilt, the app restores exactly those files with their canonical Release Track identity. Every other file, including anything the previous app wrote, is an Unmanaged File the app never changes. A second copy of a Release Track the Library already holds is also Unmanaged. The existing Library was rebuilt from current likes and catalogs instead of repaired in place.

When a Full Discography catalog wants a track, Refresh looks it up from that catalog, even if the track is also liked. A catalog names one exact Release Track, and a like that the matcher would file elsewhere must not move the catalog's track to another Release.

## Consequences

A database rebuilt before a file gains the confirmation atom leaves that file Unmanaged. Liked songs are still matched normally and merge into the catalog track by identity, so nothing downloads twice.
