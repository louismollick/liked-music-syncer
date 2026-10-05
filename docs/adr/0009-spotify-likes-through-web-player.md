# Read Spotify likes through the web player session

Spotify's Web API needs a registered developer app, and since 2026 the owner of a Development Mode app needs Premium. The app instead signs the user into open.spotify.com in its own persistent Electron session (as ADR 0004 does for Google), exchanges the `sp_dc` cookie for a web player token with the same TOTP scheme the lyrics client uses, and pages through the web player's `fetchLibraryTracks` query. This works on free accounts. It never calls REST `/v1/me/tracks` with that token, because Spotify throttles that route hard, with day-long `Retry-After` responses.

## Consequences

The persisted query hash and the TOTP secret rotate with Spotify web releases, so the client re-reads the hash from the web player bundle when Spotify reports `PersistedQueryNotFound`, and a failed or partial check never deactivates a like. The library query provides no ISRC, so matching to YouTube Music relies on title, artist, album, and duration. Audio always comes from YouTube Music; the app never downloads from Spotify.
