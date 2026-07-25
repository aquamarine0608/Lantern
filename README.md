# Lantern — on-device English TTS (Kokoro-82M)

A single-page web app that reads any pasted text aloud using Kokoro-82M, running entirely on your device via WebAssembly. After the first run, it works fully offline — airplane mode included.

**Files:** `index.html` · `sw.js` · `manifest.webmanifest` · `icon-180.png` · `icon-512.png`

## Get it on your iPhone (~3 minutes)

Lantern needs to be served over HTTPS (that's what lets the browser cache the 90 MB model and run offline). GitHub Pages is the fastest free way:

1. On github.com, create a new public repo (e.g. `lantern`).
2. Upload all 5 files ("Add file → Upload files" works — no git needed).
3. Repo **Settings → Pages** → Source: "Deploy from a branch" → `main`, `/ (root)` → Save.
4. Wait ~1 minute, open `https://<you>.github.io/lantern/` in **Safari** on your phone.
5. Tap **Share → Add to Home Screen**. It installs like an app with the Lantern icon.
6. First tap of "Read aloud" downloads the model (~90 MB) once. After that: fully offline.

Netlify Drop or Cloudflare Pages work identically if you prefer (drag the folder in).

## Quick test on your PC first (optional)

```
cd lantern
python -m http.server 8000
```

Open http://localhost:8000. Note: viewing it from your phone over LAN (`http://<pc-ip>:8000`) will run, but the model won't be cached between visits — browsers only allow that over HTTPS/localhost. Use the GitHub Pages URL for real phone use.

## Using it

- Paste text → pick a voice → pick a speed → **Read aloud**.
- Audio starts after the first sentence is synthesized and continues while the rest generates. Keep the app in the foreground until the status says "Finished generating" — iOS pauses background computation (already-generated audio keeps playing).
- Once finished, the waveform becomes a scrubber, playback works with the screen locked (lock-screen controls included), and **Save WAV** exports the audio to Files.
- Your text, voice, and speed are remembered between visits. Nothing ever leaves the device.

## Notes & knobs

- Voices are the top-graded Kokoro voices; `af_heart` ("Heart") is the best. Full list: hexgrad/Kokoro-82M on Hugging Face — add more `<option>`s in `index.html` if you want them.
- Model: `onnx-community/Kokoro-82M-v1.0-ONNX`, 8-bit quantized, WASM backend — the reliable path on iOS Safari. English only (Kokoro's CJK support needs a different phonemizer pipeline and isn't in the web build).
- To update the app after editing files, bump `SHELL` in `sw.js` (e.g. `v1` → `v2`) so installed phones pick up the change.
