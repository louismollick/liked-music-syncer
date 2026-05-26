# Library Performance

Library navigation is now TanStack Router driven with hash URLs like `#/library?tab=albums&artist=Radiohead`.

- Top-level sections are `#/library`, `#/sync`, `#/settings`.
- Library, sync, and settings now stay mounted as persistent top-level panes, which removes section-switch remount lag and preserves in-section UI state.
- Library tab/filter state is URL-backed, so Electron back/forward restores the prior library drill-in state.
- Artists, albums, and songs panes stay mounted inside one stable `/library` route, which preserves image nodes, scroll state, and virtualizer state across library tab switches.
- Inactive library panes stay measurable with `visibility:hidden` instead of collapsing with `display:none`, which prevents artist/album grid pop-in on tab switch.
- Only visible artist/album cards render, plus small overscan.
- Only visible/overscanned album artwork requests fire on Albums tab open.
- Song rows use a virtualized list with fixed headers to cut tab-switch mount cost.
- Dev builds log `library-tab-switch-*` perf measures for tab-switch validation.
