# Library album artwork

## Behavior

- The **Albums** library view loads cover art from embedded tags in local indexed audio files.
- Artwork is extracted in the main process, normalized to a square JPEG thumbnail, and cached under `userData/artwork-cache`.
- The renderer loads images through the `app-media://` custom protocol (`app-media://artwork/<cache-key>.jpg`).
- Artist-photo lookups now negative-cache "not found" results internally, so artists with no resolved image are not re-queried on every later refresh.
- The renderer keeps an in-memory album-art cache and applies per-album IPC updates as they resolve, so revisiting **Albums** does not blank already-known covers and cold loads can fill progressively.
- Albums without a readable local file or embedded cover keep the existing placeholder card.

## Resolution rules

For each album key (`<album>|||<albumArtist>`):

1. Pick a representative track file, preferring the track `preferredFileId`, then local roots, then filesystem snapshots.
2. Skip remote-only files that are not available on disk.
3. Use a content-based cache key (`fileId`, `tagFingerprint`, `modifiedAt`, `sizeBytes`, thumbnail size) so tag or file changes produce a new thumbnail.

## Refresh and cache

- After a successful library index or reconcile job, stale cache files that no longer match any indexed file fingerprint are removed.
- Extraction failures are logged at `debug`/`warn` and do not block library indexing.

## Logging

On startup, main process logs `Main process logging ready` with `tempLogFile` (mirrored stdout/stderr) and `artworkCacheDir`.

| Source | What to look for |
| --- | --- |
| `artwork` | `Album artwork batch started/finished`, `extraction progress`, cache prune |
| `ipc` | `library:getAlbumArtwork invoked/completed` (duration, resolved count) |
| `artwork-protocol` | First rejected URL or cache miss per file (deduped) |
| `liked-artists` | `Artist catalog snapshot`, `Fetching artist image` (per artist), `Artist image cached and published`, `Artist image refresh finished` (`fetchedCount`, `notFoundCount`, `failedCount`) |
| `startup` | Bootstrap artist image refresh result |

**Renderer DevTools console**

- `[album-artwork]` — batch fetch start/complete/fail with timing
- `[album-artwork]` — cache hit when all visible albums were already cached in renderer memory
- `[artist-image] catalog loaded` — photo URL counts after `listArtists`
- `[artist-image] photo updated` — incremental push when main process caches one artist (`subscribeArtistPhotos`)
- `[artist-image] failed to load` — broken/expired remote thumbnail URL (artist id + URL)

Artist photos are fetched with **concurrency 3** in the main process (one Python worker call per artist). Each successful fetch updates SQLite and pushes `library:artistPhotoUpdated` so the grid can render that card immediately. Thumbnails prefer the artist profile (`get_artist`) and request larger CDN sizes (`=s544`) when the API returns small defaults.

Opening the **Artists** tab calls `library.refreshArtistImages()` when any artist lacks `photoUrl` (see `[artist-image] Artists tab active` in DevTools). Main-process logs appear in the terminal / temp log file, not in the renderer console.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Placeholder only | No local file on disk, no embedded cover, or non-`.m4a`/unsupported container |
| Artwork stale after retag | Run **Refresh** library; cache keys include `tagFingerprint` and `modifiedAt` |
| Images blocked in devtools | Renderer CSP must include `app-media:` in `img-src` |
| Albums tab stuck on “Loading…” (older builds) | Wait for batch artwork IPC or check logs for hung `extract-embedded-cover` calls |
| Artist photos missing after restart | Check `Artist catalog snapshot` (`withoutPhotoUrl`); expired YT thumbnail URLs log `[artist-image] failed to load` |

## API

- `window.api.library.getAlbumArtwork(albumKeys: string[])` → `{ entries: { albumKey, artworkUrl }[] }`
- `window.api.library.subscribeAlbumArtwork(listener)` → pushes `{ albumKey, artworkUrl }` as each album resolves inside a batch
