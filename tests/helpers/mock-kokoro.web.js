/* Mock of kokoro-js's browser build, served in place of
   https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js during tests.
   Implements exactly the API surface Lantern uses:
     - KokoroTTS.from_pretrained(id, { dtype, device, progress_callback })
     - tts.stream(splitter, { voice, speed })  -> async iterator of { text, phonemes, audio }
     - TextSplitterStream with push()/close()
   Behavior is configurable per-test through window.__TTS_MOCK__ (set via
   addInitScript before the page loads):
     loadDelay      ms before from_pretrained resolves (default 30)
     loadFail       reject from_pretrained (default false)
     progressSteps  number of progress_callback batches (default 3)
     chunkDelay     ms of "synthesis time" per sentence (default 100)
     chunkSeconds   seconds of audio per sentence (default 0.5)
     streamFailAfter throw after N chunks yielded; -1 = never (default -1)
     emptyChunkAt   yield a zero-length Float32Array for chunk N; -1 = never (default -1)
*/

const CFG = () =>
  Object.assign(
    {
      loadDelay: 30,
      loadFail: false,
      progressSteps: 3,
      chunkDelay: 100,
      chunkSeconds: 0.5,
      streamFailAfter: -1,
      emptyChunkAt: -1,
    },
    globalThis.__TTS_MOCK__ || {}
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TextSplitterStream {
  constructor() {
    this._text = "";
    this._closed = false;
  }
  push(t) {
    this._text += t;
  }
  close() {
    this._closed = true;
  }
}

export class KokoroTTS {
  static async from_pretrained(id, opts = {}) {
    const cfg = CFG();
    globalThis.__TTS_LOADS = (globalThis.__TTS_LOADS || 0) + 1;
    const pc = opts.progress_callback;
    const files = [
      { file: "onnx/model_quantized.onnx", total: 90 * 1048576 },
      { file: "tokenizer.json", total: 2 * 1048576 },
    ];
    for (let s = 1; s <= cfg.progressSteps; s++) {
      await sleep(cfg.loadDelay / cfg.progressSteps);
      if (pc)
        for (const f of files)
          pc({ status: "progress", file: f.file, loaded: (f.total * s) / cfg.progressSteps, total: f.total });
    }
    if (cfg.loadFail) throw new Error("mock: model download failed");
    return new KokoroTTS();
  }

  async *stream(splitter, { voice, speed } = {}) {
    const cfg = CFG();
    globalThis.__TTS_STREAMS = (globalThis.__TTS_STREAMS || 0) + 1;
    while (!splitter._closed) await sleep(5);
    const sentences = splitter._text
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    let i = 0;
    for (const text of sentences) {
      await sleep(cfg.chunkDelay);
      if (cfg.streamFailAfter >= 0 && i >= cfg.streamFailAfter) throw new Error("mock: synthesis failed");
      let f32;
      if (i === cfg.emptyChunkAt) {
        f32 = new Float32Array(0);
      } else {
        const n = Math.round(24000 * cfg.chunkSeconds);
        f32 = new Float32Array(n);
        const freq = 220 + 40 * (i % 5);
        for (let j = 0; j < n; j++) f32[j] = Math.sin((2 * Math.PI * freq * j) / 24000) * 0.3;
      }
      i++;
      globalThis.__TTS_CHUNKS = (globalThis.__TTS_CHUNKS || 0) + 1;
      yield { text, phonemes: "", audio: { audio: f32, sampling_rate: 24000 } };
    }
  }
}

export default KokoroTTS;
