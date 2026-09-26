# Run the whole app in TypeScript

The app runs entirely in the Electron main process and renderer, in TypeScript. Only yt-dlp, ffmpeg, and rclone stay external, as bundled or self-updating binaries. We replaced the Python worker because a distributed macOS app would have to ship and sign a frozen Python runtime (lingua alone adds about 170 MB per architecture), and because domain logic duplicated across TypeScript and Python had already drifted. YouTube Music access uses youtubei.js for the session with parsers ported from ytmusicapi, which keeps the Python ecosystem's response shapes without its runtime.

## Consequences

Text matching, path templating, and language detection were reimplemented, so recorded-response tests compare the new behaviour against the old Python output. yt-dlp must be the official standalone binary so it can update itself outside the signed app bundle.
