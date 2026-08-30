# YouTube Music multi-account browser authentication

Research date: 2026-08-29

## Conclusion

The two undocumented endpoints in the implementation plan are real and currently respond, but they are not the only possible product design.

For a complete automatic picker that reuses every Google session already signed into one browser profile, `ListAccounts` plus YouTube's `account/accounts_list` is the most direct route I found. It is still an unofficial integration. Google documents neither the YouTube Music endpoint nor `X-Goog-AuthUser` as an API contract.

There are simpler choices if the product can accept a different behavior:

- Use only the browser's active YouTube identity. The YouTube page configuration identifies the active session and delegated identity. This avoids enumeration.
- Ask the user to switch accounts in YouTube Music, then retry. This also avoids enumeration.
- Treat each browser profile as an Auth Source. That separates many real-world accounts without inspecting Google's multi-login state, but it cannot expose several Google sessions within one profile.
- Replace browser-cookie authentication with an app-owned OAuth flow. This gives each authorization a clear account choice, but it does not silently import every browser session and changes the app's setup, token storage, API quota, and consent requirements.

## What was confirmed live

I ran redacted probes against the selected Zen browser profile on 2026-08-29. The probe printed only status, counts, response keys, and whether identities differed. It did not print or persist cookies, email addresses, Gaia IDs, channel IDs, names, handles, or selector tokens.

- `POST https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard` returned HTTP 200 and the legacy JSON list shape that Chromium's parser documents. It reported two Google sessions.
- Sending the same YouTube Music browser cookies with `X-Goog-AuthUser: 0` and `X-Goog-AuthUser: 1` produced two successful `get_account_info()` calls with distinct identities. This confirms that changing the header selects different Google sessions in this browser profile today.
- `POST https://music.youtube.com/youtubei/v1/account/accounts_list` returned HTTP 200 for both session indexes. Each response contained one `accountItem` identity in this profile.
- The current response used `accountItem`, not the older `accountItemRenderer` shape. Its selection endpoint carried `accountStateToken`, `offlineCacheKeyToken`, `accountSigninToken`, and `datasyncIdToken`. It did not contain a `pageIdToken` in this personal-account-only sample.

This confirms the Google-session path on one real profile. It does not confirm Brand Account enumeration or switching because the tested sessions did not return a Brand Account. Brand handling still needs a redacted fixture and a live Brand Account test before `accountsComplete` can be true.

## Evidence from maintained source

Chromium itself calls GAIA `ListAccounts`, parses the response into an ordered vector, and treats the first account as primary. Its parser also records whether each session is valid, signed out, and verified. Current Chromium has moved its default path to a base64-encoded protobuf response, so depending only on the older `json=standard` array would be brittle. See Chromium's [GAIA cookie manager](https://chromium.googlesource.com/chromium/src/+/HEAD/components/signin/internal/identity_manager/gaia_cookie_manager_service.cc), [GAIA URL construction](https://chromium.googlesource.com/chromium/src/+/HEAD/google_apis/gaia/gaia_urls.cc), [response parser](https://chromium.googlesource.com/chromium/src/+/HEAD/google_apis/gaia/gaia_auth_util.cc), and [parser tests](https://chromium.googlesource.com/chromium/src/+/HEAD/google_apis/gaia/gaia_auth_util_unittest.cc).

yt-dlp reads YouTube's `SESSION_INDEX` from page configuration and emits it as `X-Goog-AuthUser`. It also parses `DATASYNC_ID` into delegated and user session IDs, then sends the delegated value as `X-Goog-PageId`. This is strong implementation evidence for an easier active-identity path, but it is not a Google API guarantee. See yt-dlp's [YouTube extractor authentication code](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_base.py).

ytmusicapi accepts the Google-session index in the copied `X-Goog-AuthUser` header. It also has a `user` constructor argument that writes `context.user.onBehalfOfUser` for a Brand Account. The library tells users to obtain that ID manually from Google's Brand Accounts page; it does not enumerate those IDs. See [YTMusic construction and request context](https://github.com/sigma67/ytmusicapi/blob/main/ytmusicapi/ytmusic.py) and [ytmusicapi authentication setup](https://ytmusicapi.readthedocs.io/en/stable/setup/).

Google's public help pages confirm the domain model but not these wire details. One Google Account may manage several Brand Account channels, and YouTube lets the user switch between them. YouTube says one Google Account may manage up to 100 channels. See [Manage YouTube channels](https://support.google.com/youtube/answer/4642409) and [Switch between channels](https://support.google.com/youtube/answer/3046356).

## Is there an official account limit?

I found no current Google documentation that sets a maximum number of Google Accounts simultaneously signed into a desktop browser. Google's [multiple-account help page](https://support.google.com/accounts/answer/1721977) explains how to add and switch accounts but gives no limit. Chromium's `ListAccounts` implementation stores an unbounded response vector and defines no product maximum.

The documented limit of 100 applies to YouTube channels managed by one Google Account. It does not bound the number of Google login sessions, and it does not define valid `X-Goog-AuthUser` indexes. Therefore a magic limit such as 10 cannot be described as complete or official.

## Easier alternatives and their tradeoffs

### Read the active identity from YouTube's page configuration

This is the smallest extension to the current browser-cookie design. Fetch the YouTube Music page with the captured cookies, parse `SESSION_INDEX` and `DATASYNC_ID`, build the request headers the same way yt-dlp does, then validate with `get_account_info()`.

It fixes the current hardcoded zero and follows whichever account the browser is using. It does not produce an in-app list of every account. For an active-identity-only product, this is the preferred approach.

### Probe `X-Goog-AuthUser` integers

Probing indexes and validating each result works on the tested profile. It avoids parsing `ListAccounts`, but it has no official upper bound, cannot distinguish completion from truncation, and still needs `account/accounts_list` or another undocumented response to enumerate multiple YouTube identities under one Google session.

This is useful as a fallback discovery aid, not as proof of complete enumeration.

### Use OAuth

The official YouTube Data API supports desktop OAuth and can return the authorized user's liked videos with `videos.list(myRating=like)` or the channel's likes playlist. See Google's [OAuth guide](https://developers.google.com/youtube/v3/guides/authentication) and [ratings guide](https://developers.google.com/youtube/v3/guides/implementation/ratings).

OAuth is cleaner if the product goal changes to "connect accounts to this app." Each account can grant access separately, and the app can store one refresh token per connection. It is not a transparent replacement for "reuse accounts already signed into this browser." Users must consent, the app needs a Google Cloud project and OAuth client, and the official YouTube API may not match every YouTube Music library behavior used by ytmusicapi.

ytmusicapi also supports OAuth, but since November 2024 it requires the application to supply its own YouTube Data API client ID and secret. It still calls YouTube Music's unofficial Innertube endpoints. See [ytmusicapi OAuth setup](https://ytmusicapi.readthedocs.io/en/stable/setup/oauth.html).

## Recommended implementation policy

1. Remove the hardcoded `X-Goog-AuthUser: 0` for the active-only path. Fetch the YouTube Music bootstrap page and use its `SESSION_INDEX` plus delegated session data. Validate the resulting identity before committing it.
2. If a full picker is required, use GAIA `ListAccounts` for the ordered Google-session set. Support both Chromium's current binary response and the observed legacy JSON response. Treat schema changes as `account_enumeration_failed`, never as signed out.
3. Call `account/accounts_list` once per valid Google session. Parse `accountItem` and older fixture-backed variants. Keep selector tokens in the main/Python boundary.
4. Report `accountsComplete: true` only after every session from `ListAccounts` was parsed and every identity response passed validation. A partial result may still be shown, but it must remain incomplete.
5. Keep a bounded integer probe only as fallback telemetry or partial discovery. Probe indexes 0 through 15 with at most two concurrent requests, a five-second request timeout, and a 20-second source-wide deadline. Retry one transient failure. Stop after three consecutive definitive unauthenticated responses once at least one index succeeded. Never stop early on a network, rate-limit, server, or parser error. Deduplicate identical validated identities.
6. Always mark a blind-probe result incomplete, even if all 16 indexes were attempted. No official maximum makes completeness unknowable. If index 15 succeeds, record that the cap was reached and do not claim that no higher index exists.

The cap of 16 is an operational safety limit, not a statement about Google's maximum. It bounds startup traffic and latency. It can be adjusted from field data without changing the completeness rule.

## Decision

For the app as currently described, the best near-term fix is active identity detection from YouTube's bootstrap configuration. It solves the real `authuser: 0` bug without committing to fragile enumeration.

If an in-app multi-account picker remains a requirement, the undocumented endpoints are not an invented obstacle. They are the practical automatic route for cookie-based auth. The live probe proves the Google-session half on this machine. Brand Account fixtures and a live Brand Account remain the missing validation.
