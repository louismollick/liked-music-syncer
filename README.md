# Liked Music

A macOS app that keeps a folder of tagged `.m4a` files in sync with your YouTube
Music likes and the artists whose Full Discography you download, and can mirror that folder to a
server with rclone. Playback belongs to other apps (Navidrome, Plex, Apple
Music); this app builds the library.

- Sign in to YouTube Music inside the app, choose a folder, and new likes
  download, get tagged (MusicBrainz genre, synced lyrics, square cover art), and
  appear in Activity with live progress.
- Star an artist to download their whole Official Main Catalog.
- Turn on the remote to upload new and changed songs to any rclone remote. The
  app verifies every upload; nothing needs to be installed on the server.
- Unliked songs are never deleted automatically. They show up under
  Songs → No longer wanted, where you can delete them.

Domain terms are defined in [`CONTEXT.md`](CONTEXT.md); design decisions are in
[`docs/adr/`](docs/adr) and [`docs/plans/overhaul.md`](docs/plans/overhaul.md).

## Development

Requirements: Node 22+, pnpm 11, macOS. `pnpm tools:fetch` prepares pinned,
checksummed tools for development and packaging.

```bash
pnpm install
pnpm tools:fetch   # bgutil PO token provider + rclone + FFmpeg into resources/bin
pnpm dev
```

yt-dlp is downloaded by the app on first use into its data folder and updated
at most once a day. `tools:fetch` pins and verifies FFmpeg 9.0 for Apple Silicon
and 9.0.2 for Intel Macs. The `ffmpeg-static` dependency is only used in tests.

Other commands:

```bash
pnpm lint          # biome
pnpm typecheck     # main, renderer, tests
pnpm test          # vitest (uses real SQLite, ffmpeg and rclone's local backend)
pnpm build:unpack  # local unpacked .app in release/
pnpm build:mac     # signed and notarized when Apple credentials are in the environment
```

Local unpacked builds disable hardened runtime so ad-hoc signatures can load
the bundled Electron framework. Release builds keep hardened runtime enabled.

A packaged build can check itself: `"Liked Music.app/Contents/MacOS/Liked Music" --smoke-test`.

### Useful environment variables (dev only)

- `LMS_USER_DATA_DIR=/path` uses a separate data directory (database, covers,
  yt-dlp binary, sign-in session).
- `LMS_DEV_IMPORT_COOKIES=zen` copies YouTube cookies from the local Zen browser
  into the app's session, for automated runs without signing in. See
  [`docs/sign-in.md`](docs/sign-in.md).

## Layout on disk

- Release tracks: `Album Artist/Album/01 Title.m4a`
- Standalone tracks (videos and covers with no album): `Artist/Title/Title.m4a`
- Synced lyrics: a `.lrc` file next to the song

Tags follow [`src/main/tags/schema.ts`](src/main/tags/schema.ts). Files carry
`LMS_*` freeform atoms that let the app rebuild its database from the folder.
See [`docs/local-library-index.md`](docs/local-library-index.md) for how the
folder, database, and remote stay consistent.
