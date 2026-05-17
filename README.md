# Snipette

**Cut local. Stay private. Go viral.**

A video editor for people making short-form stuff (TikTok, Reels, Shorts) who would rather not ship their footage to someone else's GPU. It runs 100% on your machine. No accounts, no upload, no telemetry, no "we noticed you opened the app" emails. Think CapCut, but the bytes never leave your laptop.

## Stack

* Electron desktop shell
* React 18 with TypeScript on the renderer
* electron-vite for the build pipeline
* better-sqlite3 for the local project database
* ffmpeg-static and ffprobe-static for video work
* Zustand for global state, Tailwind for styling, Framer Motion for the bouncy bits

## Develop

```bash
npm install          # postinstall runs electron-builder install-app-deps
                     # so better-sqlite3 gets rebuilt against Electron's ABI
npm run dev          # Electron plus Vite dev server with HMR
npm run typecheck    # tsc --noEmit across main and renderer
npm run build        # production build into out/
npm run rebuild      # re-run the native rebuild manually if something drifts
```

If `npm install` blows up trying to compile better-sqlite3 against your system Node, do `npm install --ignore-scripts` and then `npm run rebuild`. That defers the native compile to Electron's headers, which is the only ABI that actually matters here.

## Whisper for local captions (optional but very cool)

Captions are powered by [whisper.cpp](https://github.com/ggerganov/whisper.cpp) running locally. No API calls, your audio stays on disk. The Captions menu lights up the moment the right files exist in `resources/`. Until then everything else in the app still works.

### What goes in resources/

Snipette looks for the binary at `resources/whisper` (or `resources\whisper.exe` on Windows) and the English model at `resources/ggml-base.en.bin`. The model filename is hardcoded right now, so if you grab a different size, rename it.

**On macOS, the binary needs its friends in the same folder** because whisper.cpp ships as a CLI plus a bunch of shared libs. Drop these next to `whisper`:

```
resources/
  whisper                       the CLI binary (rename whisper-cli to whisper)
  ggml-base.en.bin              the English model, about 148 MB
  libwhisper.1.dylib
  libggml.0.dylib
  libggml-base.0.dylib
  libggml-cpu.0.dylib
  libggml-blas.0.dylib
  libggml-metal.0.dylib         the Metal backend, gives you GPU acceleration
```

You can grab the dylibs straight out of a fresh whisper.cpp build at `build/src/` and `build/ggml/src/`. If you build it yourself, the rpaths point at `/tmp` style build dirs, so either patch them with `install_name_tool -change ... @loader_path/...` or just keep the libs alongside the binary and re-sign with `codesign --force --sign - resources/*.dylib resources/whisper`.

On Linux it is the same idea but with `.so` files. On Windows you ship the `.dll` files next to `whisper.exe`. PRs welcome from anyone who actually runs this on Windows, the build there is a whole adventure.

### Which model file to download

The renderer expects `ggml-base.en.bin` specifically. If you want a different tradeoff, grab one of these and rename it to `ggml-base.en.bin` (yes, even if it is not actually base, the path is hardcoded for now):

| File | Size | Vibe |
|---|---|---|
| ggml-tiny.en.bin | ~75 MB | Fast and rough, great for first-pass timing |
| ggml-base.en.bin | ~148 MB | The default. Good enough for most short-form work |
| ggml-small.en.bin | ~466 MB | Noticeably better, still real-time-ish on Apple Silicon |
| ggml-medium.en.bin | ~1.5 GB | Crispy. Slower but worth it for hero clips |

The `.en` variants are English-only and quite a bit smaller than the multilingual ones. If you need other languages, swap to `ggml-base.bin`, `ggml-small.bin`, etc., but expect a bigger download and worse accuracy on English.

Models live at [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main). Direct download with curl:

```bash
curl -L -o resources/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

### Sanity check

If everything is wired up correctly, this should print a transcript:

```bash
resources/whisper -m resources/ggml-base.en.bin -f some-audio.wav
```

If it complains about a missing dylib, the libs are not next to the binary. If it complains about the model, you either misnamed it or the download got truncated, the model file should weigh in around 148 MB.

## Architecture

```
electron/        main process, preload, IPC handlers, services (db, ffmpeg, whisper, ...)
src/             React renderer with routes, components, stores, hooks, types, utils
shared/          types shared between main and renderer (IPC contracts live here)
assets/          bundled fonts, LUTs, sounds
resources/       runtime binaries (ffmpeg, whisper, models)
```

Every renderer to main hop goes through the typed IPC bridge in `electron/preload.ts`. The renderer never touches Node directly. `contextIsolation` is on, `nodeIntegration` is off, and that is non-negotiable.

## Privacy

* Zero network calls in the hot path. No telemetry, no analytics, no accounts.
* All project data lives in `app.getPath('userData')` on your machine.
* Update checks are opt-in and off by default. You decide when the app phones home, and right now the answer is never.
