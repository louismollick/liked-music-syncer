# Library Album Keys

Albums use semantic album keys instead of raw `album + albumartist` concatenation.

## Unknown album normalization

- canonical unknown album label: `Unknown Album`
- values treated as unknown: `null`, empty string, `_Singles`, `Unknown Album`
- new writes use `Unknown Album`
- read paths normalize legacy `_Singles` to `Unknown Album` before renderer consumers see track data

## Album key behavior

- normal albums key by `canonical album name + album artist`
- unknown albums key by `Unknown Album` only
- this intentionally collapses unknown-album tracks across album artists into one shared bucket

## Renderer behavior

- Albums view shows one `Unknown Album` card for all unknown-album tracks
- subtitle is the single album artist when all grouped tracks agree
- subtitle is `Various Artists` when grouped tracks span multiple album artists

## Migration

Use `uv run --project py python -m liked_music_syncer.migrate_unknown_album ...` to rewrite legacy LMS-managed `_Singles` files and mirror the resulting path changes to remote.
