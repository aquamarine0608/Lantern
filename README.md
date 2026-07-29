# Lantern — a pocket audiobook reader with an on-device AI voice (Kokoro-82M)

A single-page web app that turns DRM-free **EPUBs** — and any pasted text — into listening material, with the AI voice (Kokoro-82M) running entirely on your device via WebAssembly. On the on-device engine nothing is uploaded anywhere, and after the first run it works fully offline, airplane mode included. (The optional Qwen3-TTS engine is the one exception — it sends each sentence to the server you configure; see [Voice engines](#voice-engines).)

**Deployable app files:** `index.html`, `sw.js`, `manifest.webmanifest`, `icon-180.png`, `icon-512.png`, `android-bridge-bootstrap.js`, `native-tts-adapter.js`, and the complete `vendor/` directory. Keep their relative paths unchanged. (The `tests/`, `android/`, and `ios/` directories are development/native-project sources and are not needed for the browser deployment.)

## Android app: local Qwen3-TTS, no Apple tooling

The `android/` directory is a native Android sibling of Lantern. It keeps the
existing EPUB library and reader UI, but intentionally disables Kokoro and the
remote Qwen server fields. Speech is generated locally with the pinned
Qwen3-TTS 0.6B Q4_K_M GGUF runtime through Android NDK/JNI.

- Android 12 or newer, `arm64-v8a` only.
- The APK contains no model weights. On first use, Lantern downloads two pinned
  files (about 884 MB total), verifies their exact sizes and SHA-256 hashes, and
  atomically installs them in private, non-backed-up app storage.
- EPUB files, text, and generated WAV audio remain on the device. Internet
  permission is used only for the explicit model download.
- The CPU runtime and model path are real, but sustained real-time performance,
  heat, and battery use still require testing on each physical Android device.
  Do not treat desktop/CUDA Qwen latency claims as phone benchmarks.

Build and sideload it from Windows—no Mac, App Store, signing subscription, or
seven-day refresh is required:

```powershell
git submodule update --init --recursive
cd android
.\gradlew.bat --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleRelease
# Align and sign the release with your private personal key, then:
adb install -r app\build\outputs\apk\release\lantern-release.apk
```

See [`android/README.md`](android/README.md) for the pinned JDK/SDK/NDK versions,
Windows setup, one-time personal signing-key steps, native revision, model
boundary, and device validation commands.

## What it does

- **Library** — import `.epub` files; the shelf shows covers, authors, and how far you are in each book. Books are stored in the browser's own database on the device.
- **Reader** — the chapter is laid out for reading; tap any sentence and Lantern starts reading aloud from exactly there. The current sentence stays highlighted and the page follows the voice. Skip back/forward a sentence, jump chapters from the table of contents, adjust the text size.
- **Keeps your place** — the reading position is saved continuously and restored after refreshes, relaunches, and reboots. Chapters advance automatically; lock-screen controls work.
- **Paste mode** — the original paste-any-text flow is still there (Library → "Read pasted text"), including **Save WAV** export.
- **Two voice engines** — the on-device Kokoro voice (default, fully offline), or **Qwen3-TTS** streamed from a server you own. Nine hand-picked Kokoro voices (American & British), speeds from 0.8× to 1.5×.

## Voice engines

The two choices below describe the browser/PWA build. The Android APK uses a
third, platform-specific path: local Qwen3-TTS 0.6B Q4 only, with Kokoro and the
remote server configuration hidden.

**On-device (default).** Kokoro-82M runs inside the browser via WebAssembly. Private, offline after the first model download, works everywhere.

**Qwen3-TTS (your server).** [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) (Apache-2.0, 0.6B/1.7B) is a much bigger, LM-based voice that **requires a CUDA GPU — it cannot run inside a phone browser** (no browser/ONNX-web runtime exists as of mid-2026). Lantern therefore streams it sentence-by-sentence from a computer you own — each sentence's text is sent to that server, and the audio comes back:

1. Run Qwen3-TTS behind any **OpenAI-compatible speech endpoint** (`POST /v1/audio/speech`, WAV output) — several community servers for it work out of the box.
2. The endpoint must be reachable from the phone over **HTTPS** with **CORS enabled** (a page served over HTTPS cannot call plain-HTTP LAN addresses). The easiest route: `tailscale serve` or a Caddy/cloudflared tunnel in front of the server.
3. In Lantern: **Voice** (library) or **Aa** (reader) → Engine → **Qwen3-TTS** → enter the server address and a voice name (e.g. `cherry`).

Reading, highlighting, resume, and the player all work identically on either engine; the status chip shows which voice is active. On-device reading keeps working offline regardless — if the server is unreachable, Lantern says so and parks for a retry, and you can switch back to the on-device engine any time.

## Get it on your iPhone (~3 minutes)

Lantern needs to be served over HTTPS (that's what lets the browser cache the 90 MB model and run offline). GitHub Pages is the fastest free way:

1. On github.com, create a new public repo (e.g. `lantern`).
2. Upload every file and directory listed under **Deployable app files** above ("Add file → Upload files" works — no git needed). Preserve the `vendor/` directory name.
3. Repo **Settings → Pages** → Source: "Deploy from a branch" → `main`, `/ (root)` → Save.
4. Wait ~1 minute, open `https://<you>.github.io/lantern/` in **Safari** on your phone.
5. Tap **Share → Add to Home Screen**. It installs like an app with the Lantern icon.
6. The first reading downloads the voice model (~90 MB) once. After that: fully offline.

Netlify Drop or Cloudflare Pages work identically if you prefer (drag the folder in).

## Quick test on your PC first (optional)

```
cd lantern
python -m http.server 8000
```

Open http://localhost:8000. Note: viewing it from your phone over LAN (`http://<pc-ip>:8000`) will run, but the model won't be cached between visits — browsers only allow that over HTTPS/localhost. Use the GitHub Pages URL for real phone use.

## Using it

- **Books:** Add a book → tap it → tap play (or tap any sentence). Generation happens sentence by sentence on-device; keep the app in the foreground while it synthesizes — iOS pauses background computation, though already-generated audio keeps playing with the screen locked. On iPhone the book's voice follows the ring/silent switch — if the highlight is moving but you hear nothing, flick the switch off silent.
- **Pasted text:** paste → pick a voice and speed → **Read aloud**. When it finishes, the waveform becomes a scrubber and **Save WAV** exports the audio to Files.
- Your books, reading positions, text, voice, speed, and text size are all remembered between visits, in the browser's own storage on this device — there is no Lantern account and no sync server. On the on-device engine no text ever leaves the device. With **Engine = Qwen3-TTS**, each sentence is sent to the `/v1/audio/speech` server you configured (so the book's text passes over that connection, and through any tunnel in front of it), and the API key you enter is kept in the browser's `localStorage`.
- EPUBs must be DRM-free (personal backups, Project Gutenberg, Standard Ebooks, purchased DRM-free books, etc.).

## Notes & knobs

- Voices are the top-graded Kokoro voices; `af_heart` ("Heart") is the best. Full list: hexgrad/Kokoro-82M on Hugging Face — add more `<option>`s in `index.html` if you want them.
- Model: `onnx-community/Kokoro-82M-v1.0-ONNX`, 8-bit quantized, WASM backend — the reliable path on iOS Safari. English only (Kokoro's CJK support needs a different phonemizer pipeline and isn't in the web build).
- EPUB parsing is done in the page with `fflate` + `DOMParser` (no server): OPF spine, EPUB 3 nav or NCX chapter titles, and covers are supported.
- Updates: `index.html` changes are picked up automatically on the next online visit (the service worker fetches page navigations network-first). When you change the icons, the manifest, or a pinned CDN library version, bump `VERSION` in `sw.js` so installed phones refresh those too.
- Memory: the reader keeps only the current chapter's audio in RAM. In paste mode the full audio is kept for WAV export, so chapter-sized pastes are the sweet spot there.

## Testing

`tests/` holds a Playwright end-to-end suite (`npm test` prints the current count) that drives the real app in Chromium against a mocked Kokoro engine, a mock OpenAI-compatible Qwen3-TTS server, and generated fixture EPUBs (no model downloads): library import/remove, the reader with sentence highlighting, tap-to-read, skips, chapter auto-advance, resume-after-reload, both voice engines (including server failures and engine switching), paste-mode generation and WAV export, every error path, refresh persistence, and true offline service-worker behavior (the local test servers can drop their sockets to simulate airplane mode).

```
cd tests
npm install
npx playwright install chromium   # once, unless a pre-installed browser is available
npm test
```

Note: the suite binds local port 443 to impersonate `cdn.jsdelivr.net` (that's how service-worker fetches get mocked too), so it needs an environment that allows that — macOS allows it by default, on Linux use root/CAP_NET_BIND_SERVICE.
