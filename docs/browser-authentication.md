# Browser authentication on macOS

Liked Music Syncer reads YouTube Music cookies from the selected installed browser. On startup it checks only that browser. Opening the browser picker checks every installed browser that the app supports.

On a true first launch, the app prefers Chrome when it is installed. Otherwise it uses the supported macOS default web browser, then falls back to registry order. A returning user's selected browser takes precedence. If a cached credential still validates, startup keeps it and does not replace it with a fresh cookie capture.

The Python worker uses yt-dlp's browser-cookie support. yt-dlp may read the browser cookie database before filtering for YouTube Music. The app keeps that browser CookieJar in memory only. It stores the resulting YouTube Music credential encrypted with Electron safeStorage and never sends cookies or authorization headers to the renderer.

If macOS asks for Keychain access, allow it so Chromium-based browser cookies can be decrypted. Safari may also require Full Disk Access under System Settings, Privacy & Security. A denied permission is reported as an authentication issue, not as a signed-out account.

When a browser is signed out, use "Open YouTube Music" in Settings. The app opens the selected browser and checks that source once when the app regains focus.

For each supported browser profile, the app checks `X-Goog-AuthUser` indexes `0` through `4` and exposes every distinct personal YouTube Music account that validates. This is a fixed product limit, not a Google-documented browser-account maximum. An account outside those first five slots will not appear unless the user changes the Google sign-in order or uses another browser profile.

The sidebar keeps the current account picture in the bottom-left corner. Clicking it opens the account picker above the picture. Settings exposes the same accounts in a Select. Both controls validate a candidate before committing it, and the selected browser and account persist across relaunches.

Browser and account switching are disabled while sync work is queued or running. This prevents a job from starting with one account and continuing with another.

Opening either account picker lazily requests the Liked Music playlist's `trackCount` for the accounts in the selected browser. Count failures do not affect authentication or prevent switching. Counts remain in memory and are fetched again after relaunch.

The app does not call Google `ListAccounts`, enumerate Brand Accounts, or use YouTube's `onBehalfOfUser` selector.
