# Automatic browser authentication and account switching

Status: Ready for implementation  
Platform: macOS first  
Scope: YouTube Music browser authentication, identity selection, profile UI, and immediate settings persistence

## Outcome

On launch, the app uses the selected installed browser—Chrome on a true first run when available—to obtain and validate YouTube Music authentication without asking the user to press a capture button. A signed-in user sees their YouTube Music profile in the bottom-left sidebar. A signed-out user sees a Sign In item that leads to contextual recovery in Settings.

Opening the browser picker scans every installed, supported browser for the current app session. Selecting a browser or YouTube Music account applies immediately and atomically. Raw cookies and auth headers remain in the main/Python boundary and never enter the renderer.

## Product decisions already settled

- Support macOS for this version. Do not claim equivalent Windows or Linux behavior.
- Prefer Chrome on a true first run. If Chrome is unavailable, prefer the supported system-default browser, then the first installed browser in stable registry order.
- Discover installed browsers dynamically, but recognize them through a small, tested adapter registry. Do not show unsupported or uninstalled applications.
- Probe only the selected Auth Source during startup. Probe all installed Auth Sources when the browser picker opens.
- Do not retain Auth Source statuses between launches. Persist selections and active-account metadata only.
- A readable source with no valid Google session is `signed_out`. Cookie/keychain/TCC/database/network/parser failures are `issue`, not `signed_out`.
- Keep a valid cached credential and profile visible during refresh. Move to `signed_out` only after that credential expires and automatic recapture confirms no session.
- Selecting a signed-out browser immediately makes it the selected source and deactivates the prior source's auth.
- Remember account choices per installed Auth Source. After relaunch, rematch the remembered account by handle before using its old index. If it is no longer available, select the first validated identity. If the browser itself disappears, discard its remembered choice.
- Support personal YouTube Music identities from the first five Google browser sessions only. Brand Accounts are out of scope.
- Probe every `X-Goog-AuthUser` index from `0` through `4`. This fixed cap is a product limit, not a claim that Google limits browsers to five accounts.
- Show every distinct, validated personal identity found by that bounded scan. Do not require proof of complete enumeration before showing the account switcher.
- Disable browser and account switching while any sync job is queued or running.
- Remove the Save Settings button. Every setting applies on write or selection.
- Do not add account ownership to downloads or the library in this change. See [Account ownership and download attribution](../docs/account-ownership-and-download-attribution.md).
- A destructive schema reset is acceptable for this feature; a migration path is not required.

## Feasibility boundary

Automatic cookie capture and validation are already proven by the existing Python worker. Active-account metadata is available through `ytmusicapi.get_account_info()` and includes display name, YouTube handle, and profile-image URL. It does not expose the Google email address, so the UI must not promise or display email.

Multi-account discovery uses one selector: `X-Goog-AuthUser` selects a Google browser session. The worker probes the fixed indexes `0`, `1`, `2`, `3`, and `4`, then calls `get_account_info()` to validate and identify each result. It does not call Google `ListAccounts`, YouTube `account/accounts_list`, or set `onBehalfOfUser`.

Google does not document a maximum browser-session count or the `X-Goog-AuthUser` contract. The scan therefore cannot claim completeness. Five indexes are an intentional simplicity and latency tradeoff. A user whose account is outside that range must reorder their signed-in Google accounts or use a separate browser profile.

## Current pipeline and failure mode

The present flow crosses all three application layers:

```text
Settings renderer
  -> preload/IPC auth.captureBrowserAuth(browser)
    -> Electron AuthService.captureBrowserAuth(browser)
      -> fresh Python process: auth-capture-browser
        -> yt-dlp cookie extraction
        -> derived header validation
      -> safeStorage-encrypted credential in SQLite

Startup renderer
  -> auth.getStatus()
    -> validate only the stored credential
    -> stop if missing or invalid
```

The main gaps are:

- startup never recaptures from the selected browser;
- probing another browser overwrites the single committed credential;
- `x-goog-authuser` is fixed to `0`;
- `AuthStatus` has no source, identity, loading, or structured failure data;
- browser support is a closed renderer-side union and list;
- Firefox is still the default in renderer and settings code;
- settings are staged locally and committed through one bulk Save action;
- auth validation is repeated by downstream services rather than coordinated once.

## Architecture

### Deep module: `AuthCoordinator`

Add a main-process `AuthCoordinator` as the single owner of authentication state and transitions. Its public interface should stay small:

```ts
interface AuthCoordinator {
  bootstrap(): Promise<AuthSessionView>
  getSnapshot(): AuthSessionView
  refresh(scope: 'selected' | 'all', reason: AuthRefreshReason): Promise<AuthSessionView>
  selectSource(sourceId: string): Promise<AuthSessionView>
  selectAccount(accountKey: string): Promise<AuthSessionView>
  openSignIn(): Promise<void>
  subscribe(listener: (snapshot: AuthSessionView) => void): () => void
}
```

The coordinator hides:

- installed-browser discovery and adapter selection;
- source/profile resolution;
- Python probing and account discovery;
- encrypted credential persistence;
- active-account metadata and image caching;
- in-flight request coalescing and generation tokens;
- stale-result rejection;
- retry-on-expired-auth behavior;
- the sync-job switch guard.

The intended dependency flow is:

```text
Renderer auth store
       | safe view models and commands
       v
Preload / IPC
       v
AuthCoordinator
  |          |             |                 |
  v          v             v                 v
Browser   Python auth   Settings +       Sync job
registry  worker port   safeStorage      activity port
```

Downstream services request a validated credential from the coordinator. They do not independently interpret auth status or initiate browser capture.

### Internal ports

Define replaceable interfaces so coordinator behavior can be tested without real browsers or Keychain prompts:

- `BrowserDiscovery`: returns installed applications that match registered adapters.
- `BrowserAdapter`: resolves the cookie backend, likely profile, display metadata, app path, and launch behavior.
- `AuthWorker`: probes one source, validates a credential, discovers identities, and returns structured results.
- `AuthPersistence`: stores selected source/account data, encrypted committed credentials, and cached active metadata.
- `JobActivity`: reports whether any job is queued or running.

Use production implementations in Electron and in-memory fakes in Vitest.

## Browser discovery and adapters

Use macOS Launch Services through a small native helper based on `NSWorkspace.urlsForApplications(toOpen:)` to find applications capable of opening `https` URLs. Match returned bundle identifiers against a browser adapter registry.

Each adapter should declare:

```ts
interface BrowserAdapterDefinition {
  id: string
  bundleIds: string[]
  displayName: string
  logoAsset: string
  cookieBackend: string
  resolveProfile(): Promise<ResolvedBrowserProfile>
  open(appPath: string, url: string): Promise<void>
  limitations?: string[]
}
```

Start with browsers that can be verified through yt-dlp's native support plus the app's existing Zen and Helium mappings. Include aliases or forks only after their cookie location and decryption identity are tested. This is deliberately a registry rather than a renderer hardcode: discovery is generic, while cookie access remains explicit and auditable.

Profile resolution for the first version:

- Chromium family: use `Local State`'s `profile.last_used`; fall back to the newest usable cookie database.
- Firefox and Zen: use the declared default profile; fall back to the newest usable cookie database.
- Safari: use its standard store and surface TCC/Full Disk Access errors as actionable `issue` states.
- Ignore Firefox containers for now.
- Show the resolved profile name when it is not `Default`.

Open sign-in with `/usr/bin/open -a <resolved application path> https://music.youtube.com`. Do not use `shell.openExternal`, because that ignores the selected browser. Opening an exact browser profile is deferred; the UI should show the resolved profile name so a mismatch can be understood.

## Shared contracts

Replace the narrow `AuthStatus`/`YtDlpCookiesBrowser` renderer model with structured view types. Exact names may change during implementation, but the distinctions must remain:

```ts
type AuthSourceCheckState =
  | 'unchecked'
  | 'checking'
  | 'signed_in'
  | 'signed_out'
  | 'issue'

type AuthSessionState =
  | 'loading'
  | 'signed_in'
  | 'signed_out'
  | 'issue'
  | 'no_supported_browser'

interface AuthSourceView {
  id: string
  browserName: string
  browserLogoUrl: string
  applicationPath: string
  profileName: string | null
  status: AuthSourceCheckState
  accountCount: number | null
  accountScanLimit: number
  issue: AuthIssueView | null
}

interface YouTubeMusicAccountView {
  key: string
  displayName: string
  handle: string | null
  imageUrl: string | null
  cachedImageUrl: string | null
  likedSongCount: number | null
  likedSongCountState: 'unrequested' | 'loading' | 'loaded' | 'unavailable'
}

interface AuthSessionView {
  state: AuthSessionState
  selectedSourceId: string | null
  selectedAccountKey: string | null
  activeAccount: YouTubeMusicAccountView | null
  sources: AuthSourceView[]
  accounts: YouTubeMusicAccountView[]
  accountScanLimit: number
  isRefreshing: boolean
  switchingDisabledReason: string | null
  issue: AuthIssueView | null
}
```

Do not send raw cookies, authorization headers, Gaia IDs, or `onBehalfOfUser` tokens to the renderer. Renderer keys should be opaque app-generated identifiers.

Define structured issue codes at the worker boundary, for example:

- `no_session`
- `cookie_store_unreadable`
- `keychain_denied`
- `permission_denied`
- `browser_profile_missing`
- `network_unavailable`
- `credential_rejected`
- `account_scan_failed`
- `unexpected_response`

The Electron layer maps codes to user-facing copy and recovery actions. It must not parse Python exception strings to determine state.

## Persistence

Persist only durable choices and the current usable auth material:

- selected Auth Source identifier;
- remembered account selector per installed Auth Source;
- encrypted committed credential bundle, including its source and selectors;
- active account display name, handle, and cached profile-image path;
- the selected `X-Goog-AuthUser` index per source and the last validated account metadata used to detect an index reorder;

Do not persist:

- browser signed-in/signed-out/issue statuses;
- discovered account lists;
- Google email addresses;
- raw browser CookieJars;
- intermediate credentials produced while scanning other sources.

Store the profile image under the app's cache directory and serve it through a constrained app protocol or existing safe local-file mechanism. On startup, the cached image may render while a refresh ring indicates work. Clear orphaned account-image cache entries when their owning persisted metadata is replaced.

Because migration compatibility is not required, replace the old auth/settings schema cleanly and bump the schema version. Keep the encrypted auth value separate from resettable library inventory even if the initial implementation still rebuilds the development database.

## State transitions and concurrency

| Event | Starting state | Commit rule | Result |
| --- | --- | --- | --- |
| Startup with valid credential | cached signed in | validate, retain credential | signed in; refresh indicator may clear |
| Startup with expired credential | cached signed in | recapture selected source, validate, commit | signed in or confirmed signed out/issue |
| Startup without credential | unknown | probe selected source | signed in, signed out, or issue |
| Browser picker opens | any | scan installed sources without changing selection | rows update; active credential untouched |
| Select signed-in source | any | probe/validate chosen identity before commit | atomically replace source and credential |
| Select signed-out source | any | persist source and clear active credential | signed out |
| Select issue source | any | persist source; do not reuse prior source auth | issue |
| Select another account | signed in | validate the selected session index before commit | switch atomically; retain old account on failure |
| Authenticated request rejected | signed in | recapture once, validate, retry request once | success or terminal signed out/issue |
| Return after Open YouTube Music | signed out | rescan selected source once | updated selected-source state |
| Source disappears | any | remove remembered source choice, select fallback | fallback account auto-picked |

Use one active generation per source. A late scan result may update that source's in-memory row only if its generation is current; it may never overwrite the committed credential after the user has selected another source. Coalesce duplicate refreshes. Scan Chromium-family sources sequentially to avoid overlapping macOS Keychain prompts.

Keep prior in-session row results visible during subsequent refreshes. Show the row spinner only before the first result in a launch. Do not reorder rows while a picker is open; apply the stable signed-in-first sort the next time it opens.

## Required workflows

### 1. Main-process bootstrap

1. Discover installed supported browsers.
2. Resolve the persisted selected source.
3. On true first run, select Chrome if installed; otherwise the supported system default; otherwise registry order.
4. Load cached account metadata and encrypted credential.
5. Validate the credential before auth-dependent startup work.
6. If missing or rejected, probe the selected source automatically.
7. Commit only a validated result and publish the snapshot.
8. Start liked-artist/profile-dependent work after bootstrap settles, or make those services await the same bootstrap promise.

### 2. Browser picker scan

1. Renderer opens the Base UI Select and calls `refresh('all', 'picker_opened')` from `onOpenChange`.
2. Immediately return the installed source list; unchecked rows show a spinner.
3. Probe each source without committing its credentials.
4. Publish incremental status snapshots.
5. Preserve prior results during later scans and apply new sorting only on the next open.
6. Show only the count found within indexes `0` through `4`, using bounded-scan wording.

### 3. Browser selection

1. Reject the command with a structured busy reason if a sync job is queued or running.
2. Persist the selected source immediately.
3. If its known state is signed out, clear/deactivate the committed credential and show signed-out recovery.
4. Otherwise probe indexes `0` through `4`, select the remembered identity when it can be rematched, or the first validated identity.
5. Atomically persist the credential and active metadata only after validation.
6. On failure, show the chosen source's issue or signed-out state; never silently fall back to the old browser.

### 4. Account selection

1. Offer the control when the five-index scan returns at least two distinct validated identities.
2. Disable it during queued/running sync work.
3. Build a candidate credential with the selected `X-Goog-AuthUser` index.
4. Validate and fetch account metadata.
5. Commit the selected session index, credential, and metadata together.
6. If validation fails, retain the previous selected account and show an inline error.

### 5. Sign-in and focus return

- The sidebar shows `Sign In` only when the selected source is signed out.
- Clicking it navigates to Settings with a one-shot route/search flag.
- Settings consumes the flag, opens the browser picker, and thereby starts detection.
- If the selected source remains signed out, show `Open YouTube Music in <Browser>` immediately to the right of the browser control.
- After opening the selected app, arm exactly one selected-source refresh for the next Electron app focus event.
- Do not poll periodically.
- For `issue` or `no_supported_browser`, show `Auth Issue` instead of `Sign In`, hide the Open button, and present specific recovery plus Retry in Settings.

### 6. Expired credentials during work

Provide downstream services one helper such as `withValidatedYouTubeMusicAuth(operation)`. When a request is rejected as unauthenticated:

1. ask the coordinator to recapture the selected source;
2. validate and commit the replacement;
3. retry the original operation exactly once;
4. publish signed-out or issue state if recovery fails.

Do not retry unrelated network failures as auth failures.

## Five-index account discovery

For each selected or scanned browser source:

1. Extract the browser cookies once and keep them in memory for the duration of the scan.
2. Construct five candidates with `X-Goog-AuthUser` set to `0`, `1`, `2`, `3`, and `4`.
3. Validate each candidate with `get_account_info()`. Probe all five indexes even if an earlier index is invalid; do not assume indexes are contiguous.
4. Limit concurrency to two requests per source and apply the existing worker request timeout.
5. Treat a rejected or absent session at one index as an empty slot, not as a source-wide failure. Preserve structured network, cookie, permission, and parser failures as source issues.
6. Deduplicate results that resolve to the same handle. If a handle is absent, use an opaque main-process fingerprint derived from normalized account metadata and never expose it to the renderer.
7. Mark the browser signed in when at least one candidate validates. Report the number found within the five-index scan without implying that it is the browser's total account count.
8. Persist the chosen index and last validated account metadata. On relaunch, rescan all five indexes and rematch by handle. Reuse the old index only when its validated metadata still matches; otherwise select the first validated result.

The worker must not call `ListAccounts`, `account/accounts_list`, or use `onBehalfOfUser`. Brand Account enumeration and switching are explicitly deferred.

## Renderer and component plan

### shadcn/Base UI setup

The repository currently uses Tailwind 4, React 19, and a manual Vite renderer, but has no `components.json`. Initialize shadcn through the CLI with Base UI explicitly selected and preserve the existing color system.

Implementation sequence:

1. Run `pnpm dlx shadcn@latest info --json` and save the relevant output in the implementation PR description.
2. Remove or rename the legacy case-sensitive `components/ui/Select.tsx` before generating the shadcn Select.
3. Initialize the existing project with paths for `src/renderer/src/assets/main.css` and the `@renderer` alias, choosing Base UI—not Radix.
4. Use CLI dry-run/diff before adding components.
5. Add only the needed primitives through the CLI: Select, Popover, Avatar, Skeleton, Spinner, Item, Badge, Alert, Field, and any CLI-required dependencies.
6. Map generated styles to existing `surface-*`, `text-*`, `border`, `accent`, `success`, and `error` tokens. Avoid importing an unrelated visual theme.

Use Base UI APIs (`onOpenChange`, `items`, `render`) and do not copy Radix-only examples such as `asChild`.

### Shared auth store

Create one app-level auth session hook/provider in `AppShell` or the nearest common layout owner. It should:

- fetch the coordinator snapshot once;
- subscribe to pushed snapshots;
- expose source/account commands;
- deduplicate user actions;
- hold the one-shot Settings-open intent;
- avoid separate `useSettings()` auth fetches in each pane.

### Sidebar profile region

Add a footer below the navigation in the fixed sidebar:

- no cached identity and loading: rounded-square Skeleton with a subtle shimmer;
- cached identity while refreshing: keep the Avatar and add an animated progress ring;
- signed in: show only a clickable rounded-square Avatar with fallback initials; do not render the current account name or handle beside it while the popover is closed;
- signed out: menu-style `Sign In` row;
- issue/no browser: menu-style `Auth Issue` row.

Anchor the profile Popover to the bottom-left Avatar and make it expand upward so the trigger remains visually in place. Inside the open popover:

- keep the current account at the bottom, with its display name and handle to the right of the anchored profile picture;
- do not duplicate the current account in the selectable list;
- place every other account found in the current browser's five-index scan in rows above the current account;
- show each alternative account's rounded-square picture, display name, handle, and lazy liked-song count;
- show the browser name and non-default profile name without displacing the anchored current-account row;
- when an alternative is clicked, keep the popover open and show a Spinner on that row while the coordinator validates it;
- after a successful switch, close the popover and replace the bottom-left Avatar with the selected account's picture;
- after a failed switch, leave the prior account and Avatar active, keep the popover open, and show an inline error on the attempted row.

The anchored Avatar is the only current-account picture in this composition. The open popover adds the current account's text to its right rather than rendering a second current-account row or image.

### Settings authentication section

- Replace Capture Auth with the browser Select.
- Browser rows contain logo, clean display name, optional profile, status text, and semantic status indicator.
- First checks show a row Spinner.
- Signed-in rows show `1 account found` or `X accounts found` for the bounded five-index scan. Supporting text states `Checked the first 5 browser account slots` where needed; do not say this is the browser's complete account count.
- Signed-out rows show `Signed out` and a red indicator.
- Unreadable/failed rows show `Issue getting auth` and a red indicator, with detail outside the compact row.
- Order signed-in sources first, then signed-out, issue, and unchecked sources; preserve registry order within groups.
- Place `Open YouTube Music in <Browser>` to the right only for the selected signed-out source.
- Below the browser control, render an account Select for two or more identities found in the five-index scan, or a read-only Item for one identity.
- The closed account Select trigger shows the selected account's rounded-square picture, display name, and handle.
- Every account Select row, including the selected account when the menu is open, shows its rounded-square picture, display name, handle, and lazy liked-song count.
- Account selection uses the same coordinator command, validation spinner, atomic commit, failure handling, and resulting sidebar Avatar update as the sidebar popover.
- Disable source and account controls while queued/running jobs exist and explain why.

### Lazy liked-song counts

Liked-song counts are supplementary account metadata, not part of authentication validation:

1. Do not fetch counts during startup, browser discovery, or the all-browser picker scan.
2. When the sidebar account popover or Settings account Select opens, request counts for accounts in the selected source whose count state is `unrequested`.
3. For each account, call `get_liked_songs(limit=1)` and read the returned Liked Music playlist `trackCount`; do not enumerate the full liked-song library.
4. Run at most two count requests concurrently and coalesce requests when both account controls are open.
5. Cache successful counts for the current app session. Do not persist them across launches in this version.
6. Render a small row-level Spinner while loading, then localized text such as `1 liked song` or `1,234 liked songs`.
7. If a count request fails or the response omits `trackCount`, show no count or an unobtrusive unavailable state. Do not change the account or source auth state and do not block switching.
8. Invalidate the in-memory count when recapture shows that the account identity at an index changed.

## Immediate settings persistence

Replace the full-form `settings.save()` contract with `settings.update(partial)` and remove Save Settings from the UI.

- Selects, checkboxes, and directory-picker results persist immediately.
- Text inputs update optimistically, serialize writes, and debounce by about 400 ms.
- Flush a pending text write on blur and before unmount/navigation.
- Roll back discrete controls if persistence fails.
- Keep edited text on failure and show an inline save error with Retry.
- Successful writes remain silent.
- Output-directory text may persist on debounce, but trigger expensive root reconciliation only on blur, Enter, or picker completion, and only when the normalized value changed.
- Browser/account changes use coordinator commands, not the generic settings update endpoint.

Use per-field revisions or an ordered write queue so an older response cannot overwrite a newer edit.

## Implementation sequence

### Phase 1 — contracts, errors, and tests

Files: `src/shared/contracts.ts`, new auth-domain modules, Vitest fixtures.

- Define safe view models, structured issues, worker response schemas, and refresh reasons.
- Add state-transition tests against an in-memory coordinator shell before wiring real browsers.
- Remove the closed browser union from renderer-facing contracts; keep backend identifiers internal.

Done when state transitions, stale-result rejection, and atomic source/account commits are executable in tests.

### Phase 2 — five-index account discovery

Files: `py/src/liked_music_syncer/auth.py`, new focused account-discovery module, `py/tests/fixtures/auth/`, parser tests.

- Separate cookie extraction, credential derivation, validation, and active metadata.
- Return structured results/errors as JSON.
- Replace the hardcoded `x-goog-authuser: 0` candidate with probes for indexes `0` through `4`.
- Deduplicate validated personal identities and return their session indexes with opaque account keys.

Done when tests prove all five indexes are attempted, invalid gaps do not stop later probes, duplicates collapse, and no Google or YouTube account-list endpoint is called.

### Phase 3 — browser discovery and AuthCoordinator

Files: new `src/main/auth/` module, `src/main/services/auth-service.ts` replacement/facade, `settings-service.ts`, database/schema files, startup composition.

- Implement Launch Services discovery and adapter registry.
- Resolve profiles and browser app paths.
- Implement coordinator bootstrap, scanning, switching, persistence, generations, and job guard.
- Cache the active profile image.
- Make auth-dependent startup services await bootstrap.

Done when main-process tests cover first run, valid cache, expired cache, signed out, issue, source removal, racing scans, and busy jobs.

### Phase 4 — downstream auth recovery

Files: `sync-service.ts`, `liked-artists-service.ts`, any other YTMusic callers.

- Route credential access through the coordinator.
- Add one-time recapture/retry for explicit authentication rejection.
- Remove duplicated ad hoc validation decisions.

Done when a simulated expired credential recovers once and the original operation retries exactly once.

### Phase 5 — IPC, preload, and app store

Files: `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/contracts.ts`, renderer app/layout hooks.

- Expose snapshot, refresh, source selection, account selection, lazy liked-song-count loading, sign-in opening, and subscription APIs.
- Validate every IPC input in the main process.
- Add the shared renderer auth provider and one-shot Settings navigation intent.

Done when two mounted panes observe one consistent snapshot and raw auth material is absent from renderer payloads.

### Phase 6 — shadcn/Base UI and auth UI

Files: `components.json`, generated `components/ui/` primitives, sidebar/layout, Settings authentication components, browser logo assets.

- Initialize and add components with the shadcn CLI.
- Build the picture-only profile footer, upward anchored Popover, browser Select rows, equivalent Settings account Select, row-level count/switch loading states, and recovery actions.
- Add checked-in browser SVG logos rather than a broad icon dependency.

Done when every settled visual state can be reached with fixture data and keyboard interaction works.

### Phase 7 — immediate settings writes

Files: settings contracts/service/hook/view and their tests.

- Replace bulk Save with partial updates.
- Implement serialized debounced text writes and immediate discrete writes.
- Remove Save Settings and Capture Auth.
- Separate output-root reconciliation from keystroke persistence.

Done when refresh/relaunch retains each setting and failed writes have the agreed rollback/error behavior.

### Phase 8 — integration, cleanup, and documentation

- Remove obsolete auth capture helpers, old status fields, closed browser lists, and dead Save code.
- Update `CONTEXT.md` only if implementation changes the agreed domain terms.
- Document macOS permissions/recovery behavior under `docs/` once verified.
- Document the fixed five-index product limit and recovery instructions for accounts outside the range.

Done when automated checks and the macOS manual matrix pass.

## Test strategy

### Unit and fixture tests

- AuthCoordinator transition table, request coalescing, stale generations, and atomic commits.
- First-run source selection priority.
- Source removal and remembered-account invalidation.
- Structured error mapping: no session versus unreadable/permission/network/parser issue.
- Worker tests for indexes `0` through `4`, gaps, duplicate identities, rejected sessions, and account metadata.
- A partial five-index result retains signed-in state and reports only the number found.
- Liked-song counts use `trackCount` without following playlist continuations, run at most two requests concurrently, coalesce duplicate loads, and remain non-fatal on failure.
- Busy-job guard blocks both source and account changes.
- Immediate settings ordering, debounce, flush, rollback, and retry.
- Renderer row sorting remains stable during an open picker.

### Integration tests

- Mock Python worker through the real IPC handlers and preload contract.
- Confirm scans do not replace committed credentials.
- Confirm selection validates before commit.
- Confirm both account controls invoke the same selection command and receive the same committed snapshot.
- Confirm opening either account control lazily loads counts only for the selected source and does not repeat cached requests.
- Confirm an auth rejection causes one recapture and one operation retry.
- Confirm snapshots reach all mounted renderer consumers.
- Confirm no raw cookie/header/selector value crosses to renderer.

### macOS manual matrix

Test current macOS on at least Chrome, Safari, Firefox, and one Chromium fork supported by the registry:

- browser absent, signed out, signed in, multiple profiles, and browser running;
- Keychain allow, deny, and cancel;
- Safari Full Disk Access/TCC denied;
- offline with valid cache and offline during recapture;
- zero through six Google Sessions, confirming that only indexes `0` through `4` appear and the UI describes the scan limit accurately;
- browser picker first open, second open, and rapid close/reopen;
- select source/account during idle and during queued/running sync;
- Open YouTube Music, sign in, return focus, and one-shot rescan;
- relaunch persistence for selection and active metadata, with statuses reset;
- picture-only closed sidebar state; upward popover placement; current identity text beside the anchored Avatar; no duplicated current account; switching success and failure;
- equivalent Settings trigger/rows, lazy count loading and failure, keyboard navigation, focus return, Avatar fallback, reduced motion, and screen-reader labels.

Run before handoff:

```bash
pnpm lint
pnpm typecheck
pnpm test
cd py && uv run pytest
pnpm build
```

## Security and privacy constraints

- Browser reads occur only for the selected source at startup and for installed supported sources when the user opens the picker.
- The first version may rely on yt-dlp reading the source cookie database before domain filtering; disclose this behavior in operator/privacy documentation.
- Keep CookieJars in memory only and minimize their lifetime.
- Encrypt committed credentials with Electron `safeStorage`.
- Never log cookie values, auth headers, selectors, emails, full internal endpoint payloads, or unredacted fixtures.
- Sanitize worker errors before exposing them to the renderer.
- Use allowlisted HTTPS hosts for profile-image downloads and constrain local cached-image access.
- Treat undocumented endpoint responses as hostile input and validate their shape.

## Acceptance criteria

- A true first launch selects installed Chrome and attempts auth automatically; absence falls back deterministically.
- A returning user with valid cached credentials remains visibly signed in without a disruptive placeholder.
- An expired credential triggers selected-source recapture and one retry.
- Signed-out and issue states are distinct and offer the correct recovery.
- Opening the browser picker scans all installed supported sources and shows incremental row states.
- Browser scans never replace the active credential until the user selects and validates a source.
- Browser selection persists and takes effect immediately, including a signed-out selection.
- Open YouTube Music targets the selected browser and causes one refresh on return focus.
- The sidebar profile region, loading treatment, popover, and account metadata match the settled behavior.
- The closed sidebar shows only the current rounded-square profile picture. Its upward-opening popover keeps that picture anchored, shows the current name and handle to its right, and lists only the other accounts above it.
- A successful switch from either account control updates the shared selected account and bottom-left picture; a failed switch preserves the prior account and shows an inline error.
- The Settings account Select shows picture, name, and handle in its trigger and every menu row.
- Opening either account control lazily displays available liked-song counts without delaying startup, scanning, or account switching, and count failures never become auth failures.
- Account switching appears when at least two distinct identities validate within indexes `0` through `4`.
- The UI describes account counts as results from the first five browser account slots and never claims complete enumeration.
- Browser/account switches are disabled during queued or running sync work.
- All settings persist without a Save button and surface write failures correctly.
- No email or sensitive authentication material reaches the renderer or logs.
- Existing sync, library, and liked-artist flows use the coordinator and continue to pass their tests.
