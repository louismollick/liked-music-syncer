# Library Performance

Library tabs now use windowed rendering for artists, albums, and songs.

- Only visible artist/album cards render, plus small overscan.
- Only visible/overscanned album artwork requests fire on Albums tab open.
- Song rows use a virtualized list with fixed headers to cut tab-switch mount cost.
- Dev builds log `library-tab-switch-*` perf measures for before/after validation.
