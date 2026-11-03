# Browser compilation

Choose **Browser (offline pdfLaTeX)** in the editor and click **Prepare offline compiler (~137 MB)** while connected. Preparation verifies six pinned BusyTeX/TeX Live assets with SHA-256 and stores them in versioned Cache Storage. It also loads PDF.js and holds its worker in memory for this open editor. Preparation can be cancelled; failed/cancelled downloads remove the incomplete compiler cache. **Clear compiler cache** removes the engine assets. Browser storage eviction requires preparing again.

After preparation, the current editor compiles current local files or open account drafts without the API, authentication, or a network connection. Each compile starts and terminates a fresh classic worker. Compilation has a 60-second timeout, can be cancelled, uses shared project source limits, and bounds returned PDF/log sizes. Failures retain source and show the previous successful PDF with a stale label. The basic pack contains geometry, hyperref, amsmath, graphics, and BibTeX; the upstream pipeline detects BibTeX commands automatically. Additional packages, Biber, XeLaTeX and LuaLaTeX are unavailable in browser mode. Missing packages report a compile failure; there is no online package fallback.

Keep the current editor open: this is not an offline app-shell/PWA installation. Account sign-in, loading another account project, or reloading the application still needs network access. This feature does not change account draft synchronization.

## Hosting and provenance

Run `npm run compiler:assets` from the repository root (requires `curl` for downloads). Web `predev`/`prebuild` run the same installer, skipping already verified assets. It downloads the pinned release in `scripts/offline-compiler-manifest.json` into ignored `apps/web/public/compiler/<version>/`; deploy those generated assets with the web build. They are approximately 137 MB (131 MiB), not committed to Git. For a predownloaded mirror, set `OFFLINE_COMPILER_ASSET_DIR` to a directory containing the six exact files; hashes and sizes are still checked. Installer failures fail the build rather than silently promising an unavailable engine.

The root-scoped service worker handles GETs for only those six exact same-origin versioned asset paths. It never caches API requests, project data, or app pages. HTTPS (or localhost), workers, WebAssembly, Service Worker, and Cache Storage are required.

[Third-party notices and corresponding source](../apps/web/public/compiler/NOTICE.txt) identify the unmodified BusyTeX release, pinned source/build recipes, TeX Live 2023 sources and dependencies. BusyTeX's MIT script license does not cover all linked binaries or TeX packages; GPL/LGPL, LPPL and other upstream terms remain applicable. The pack includes `/texlive/LICENSE.TL` and `/texlive/LICENSE.CTAN`. The project license is unchanged.

The focused browser test is `npx playwright test tests/offline-compile.spec.ts` with the web server running and `pdftotext` installed. It prepares real assets, disconnects Chromium before the first PDF, compiles nested TeX and a PNG, edits a unique marker and recompiles with a fresh worker, checks PDF text and changed hash, then checks invalid TeX and zero `/api/compile` requests.
