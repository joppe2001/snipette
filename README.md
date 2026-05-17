# Snipette

**Cut local. Stay private. Go viral.**

A 100% local, offline-first video editor for creators making viral short-form content (TikTok, Instagram Reels, YouTube Shorts). CapCut alternative — every byte stays on your machine.

## Stack

- **Electron** — desktop shell
- **React 18 + TypeScript** — UI layer
- **electron-vite** — build tooling
- **better-sqlite3** — local project database
- **ffmpeg-static / ffprobe-static** — video processing
- **Zustand** — global state
- **Tailwind CSS** — styling
- **Framer Motion** — animations

## Develop

```bash
npm install          # postinstall runs `electron-builder install-app-deps`
                     # to rebuild better-sqlite3 against Electron's ABI
npm run dev          # launches Electron + Vite dev server with HMR
npm run typecheck    # tsc --noEmit across main + renderer
npm run build        # production build → out/
npm run rebuild      # re-run native rebuild manually if needed
```

If `npm install` fails compiling better-sqlite3 against Node directly, use
`npm install --ignore-scripts` followed by `npm run rebuild`.

## Whisper (optional, for auto-captions)

Snipette uses [whisper.cpp](https://github.com/ggerganov/whisper.cpp) for local speech-to-text.

1. Build whisper.cpp on your platform and place the binary at `resources/whisper` (macOS/Linux) or `resources\whisper.exe` (Windows).
2. Download the `ggml-base.en.bin` model and place it at `resources/ggml-base.en.bin`.

Captions menu will activate once both files are present. Otherwise the rest of the app works fully offline.

## Architecture

```
electron/        main + preload + IPC handlers + services (db, ffmpeg, whisper, …)
src/             React renderer (routes, components, stores, hooks, types, utils)
shared/          types shared between main and renderer (IPC contracts)
assets/          bundled fonts / LUTs / sounds
resources/       runtime binaries (ffmpeg, whisper, models)
```

All renderer ↔ main communication goes through the typed IPC bridge in
`electron/preload.ts`. The renderer never has direct Node access — `contextIsolation`
is on and `nodeIntegration` is off.

## Privacy

- No network calls, no telemetry, no analytics, no accounts.
- All project data lives in `app.getPath('userData')` on your machine.
- Update checks are opt-in, off by default.
