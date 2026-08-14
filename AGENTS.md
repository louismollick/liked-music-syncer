# AGENTS.md

Liked Music Syncer builds a local music inventory from liked songs. Playback belongs to other apps.

- Trace behavior across the whole pipeline: the renderer, Electron services, Python worker, etc. before making claims or changes. Do not infer the whole pipeline from one layer.
- Keep `docs/` for intent, rationale, and operator knowledge that code, config, tests, or `--help` cannot reveal. Update those docs when that knowledge changes.
