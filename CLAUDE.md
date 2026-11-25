# ClaimPhoto – project rules

Offline photo-report app for field insurance adjusters. Builds to ONE self-contained HTML file.

## Layout
- `src/camera.jsx`  – in-app camera (live viewfinder, multi-shot, flip, GPS stamp) – written in JSX
- `src/app.js`      – all React components (compiled-style JS using React.createElement; new code may use JSX)
- `src/styles.css`  – all CSS
- `src/globals.js`, `src/main.js` – entry (exposes React globals)
- `build.mjs`       – esbuild bundler -> `dist/ClaimPhoto.html` (single file) + `dist/site` and `docs/` (installable web app)
- `src/sw.js`, `src/manifest.webmanifest`, `src/icons/` – PWA files; `tools/make-icons.py` regenerates icons
- `tests/smoke.cjs` – real-browser (Playwright/Chromium) end-to-end tests

## Workflow (always)
1. Edit files in `src/` ONLY. Never hand-edit `dist/`.
2. Run `npm test` (builds, then runs every test). Do not say a change works until it passes.
3. Fixing a bug? Add a failing test for it first, then fix.
4. Keep the app single-file and offline: no CDN scripts, no network needed at runtime.

## Setup
`npm install` then `npx playwright install chromium` (first time only).

## Known limits
- Photos are stored as base64 data URLs in IndexedDB (~33% bigger than binary). Planned: store Blobs.
- In-app camera is built and tested with Chromium's FAKE camera only; verify on a real phone. getUserMedia needs https (or localhost): opening the .html from phone file storage will fall back to the phone's camera app.
- Installable offline PWA is built (manifest, service worker, icons). `docs/` is the committed build output served by GitHub Pages; `npm run build` refreshes it. Backup/export is not built yet.
