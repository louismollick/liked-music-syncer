# YouTube Music sign-in

The app signs users in inside its own persistent Electron session
(`persist:ytmusic`) and reads cookies from that session (ADR 0004). It does not
read cookies from installed browsers.

- The sign-in window loads Google's normal sign-in page with Electron's own
  user agent. Spoofing a Chrome user agent makes Google's checks fail, so do not
  add one.
- Personal requests (liked songs, account menu) are signed with a SAPISIDHASH
  built from the session's `__Secure-3PAPISID`/`SAPISID` cookie and sent to
  `music.youtube.com/youtubei/v1/…` with `X-Goog-AuthUser` set to the selected
  account's slot. Public requests (albums, artists, search, lyrics) are sent
  signed out. Timed lyrics use the `ANDROID_MUSIC` client and must be sent
  without cookies, or YouTube answers 400.
- A Google session can expose several YouTube Music Accounts. The app probes
  slots 0 to 4 and identifies each account by its channel ID; accounts without
  a channel cannot be selected. Liked songs are scoped to the selected account.
- Google refreshes session cookies (`__Secure-1PSIDTS`, `SIDCC`, …) in the
  `Set-Cookie` headers of signed responses. The app stores them back into the
  session like a browser would; the requests go through Node's fetch, which
  would otherwise drop them and let the session go stale.
- An expired or revoked session still has cookies, but Google answers signed
  requests as signed out (`logged_in: "0"` in `responseContext`) instead of
  failing. The transport treats that as `SignedOutError`: the session switches
  to signed out with "sign in again" and checks stop. Without this, the
  logged-out page reads as a parser error ("Missing playlist shelf").
- yt-dlp downloads are always signed out and use the bundled bgutil PO token
  provider, so the user's account is never tied to download traffic.

## Automated verification without a human

Unpackaged dev builds accept `LMS_DEV_IMPORT_COOKIES=zen`, which copies the
YouTube and Google cookies from the newest local Zen browser profile into the
app's session on start. It is refused in packaged builds. Combine it with
`LMS_USER_DATA_DIR=/some/scratch/dir` so verification runs never touch the real
app data. The imported copy shares Zen's Google session, and Google stops
accepting it once Zen refreshes its own cookies (often within an hour).
Relaunch to import fresh cookies when checks start reporting an expired session.
