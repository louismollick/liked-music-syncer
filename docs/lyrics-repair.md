# Lyrics Repair

Use this once per filesystem root if older syncs wrote bogus unsynced `.lrc` files.

## Commands

Local dry-run:

```bash
uv run --project py python -m liked_music_syncer.fix_unsynced_lrc --root "/Users/mollicl/Downloads/music"
```

Local apply:

```bash
uv run --project py python -m liked_music_syncer.fix_unsynced_lrc --root "/Users/mollicl/Downloads/music" --apply
```

Remote host:

```bash
uv run --project py python -m liked_music_syncer.fix_unsynced_lrc --root "/path/to/remote/music" --apply
```

Run local root and remote root separately. Do not run this through `rclone`.

## Behavior

- `.lrc` sidecars now exist only for truly synced lyrics
- plain/unsynced lyrics stay embedded-only when enabled
- repair targets only narrow bogus cases: every lyric timestamp is zero
- default scan scope is LMS-managed files only
- pass `--include-non-lms` only if you want to repair unmanaged files too
- pass `--json` for machine-readable output
