# Local Qwen3-TTS on iOS

- Decision date: 2026-07-28
- Status: Accepted for an implementation spike; prohibited in production until the device gates below pass
- Owners: Lantern iOS

## Decision

Lantern will use a hybrid iOS architecture: the existing reader UI and EPUB logic run in a `WKWebView`, while a native Swift service owns Qwen3-TTS inference, model installation, audio buffering, playback, interruption handling, and background audio.

The primary spike is pinned to:

| Component | Immutable pin | License | Expected runtime bytes |
| --- | --- | --- | ---: |
| Swift runtime | [`soniqo/speech-swift@555bede026f6663cef998c2458af7daf04aa79f2`](https://github.com/soniqo/speech-swift/tree/555bede026f6663cef998c2458af7daf04aa79f2), product `Qwen3TTS` | Apache-2.0 | App binary; measure in the built archive |
| Main model | [`aufklarer/Qwen3-TTS-12Hz-0.6B-CustomVoice-MLX-bf16@3affbf656d9d6aa9255ec0b31cc90055605170bc`](https://huggingface.co/aufklarer/Qwen3-TTS-12Hz-0.6B-CustomVoice-MLX-bf16/tree/3affbf656d9d6aa9255ec0b31cc90055605170bc) | Apache-2.0 | 1,816,117,698 |
| Speech codec | [`Qwen/Qwen3-TTS-Tokenizer-12Hz@7dd38ad4e9bad454aae9cd937d0cd577604fe229`](https://huggingface.co/Qwen/Qwen3-TTS-Tokenizer-12Hz/tree/7dd38ad4e9bad454aae9cd937d0cd577604fe229) | Apache-2.0 | 682,295,738 |

The combined required download is 2,498,413,436 bytes. The model must be selected explicitly; `Qwen3TTSModel.fromPretrained()` defaults to a 1.7B BF16 model and is not permitted without a `modelId` argument.

This is a binary product decision, not an endorsement of immediate release. Production builds must keep local Qwen disabled until a signed device-gate report records every mandatory result as passing on a physical iPhone 15 Pro. Kokoro may be removed from the shipping iOS product only after that report passes. Until then, the existing web application remains the rollback path.

## Architecture boundary

```text
WKWebView reader
  -> sentence/control messages
Native QwenEngine actor
  -> MLX generation and codec decode
Native bounded PCM queue
  -> AVAudioEngine / AVAudioSession
  -> playback-state and sentence-boundary events
WKWebView reader
```

The bridge carries commands and small state events, never PCM buffers or model tensors. Native Swift is responsible for:

- serializing all model access in a single actor because the selected runtime is not thread-safe;
- emitting 24 kHz mono Float32 PCM into a bounded 3–5 second playback queue;
- prefetching at most three sentence jobs and preserving the EPUB sentence identifier on every job and chunk;
- rejecting chunks whose session identifier no longer matches after pause, seek, skip, chapter change, or book close;
- adding cooperative cancellation checks at least once per autoregressive step; upstream calls `Task.cancel()` but does not currently observe cancellation inside its synchronous generation loop;
- owning the `.playback` audio session, remote controls, interruptions, route changes, and the audio background mode;
- sending only the version-1 bridge events `model.progress`, `model.ready`, `tts.buffering`, `tts.started`, `tts.position`, `tts.ended`, `reader.sentenceStarted`, and structured `error` to the web layer. `tts.ended` means the native playback queue is drained; it does not close the bridge session. The session remains valid for later enqueue, pause, or resume commands and ends only when `tts.stop` succeeds or a newer `tts.start` supersedes it.

`model.download` acknowledges that installation was initiated and returns promptly. Download progress and completion are reported asynchronously through `model.progress`, `model.ready`, and `error`; the reply must not remain pending for the full multi-gigabyte transfer.

No network request may contain EPUB text during local mode. Network access in local mode is limited to the explicit model-install flow.

## Production gate: iPhone 15 Pro

All measurements use a physical iPhone 15 Pro, an optimized Release build, Low Power Mode off, no debugger attached, airplane mode after installation, battery at or above 80%, and a nominal thermal state at test start. Run each latency case 30 times and report p50, p95, and maximum. Averages cannot satisfy percentile gates.

Every item below is mandatory:

| Area | Pass condition |
| --- | --- |
| Installation | With at least 4,000,000,000 free bytes, an interrupted download resumes and installs successfully; corrupt, short, unpinned, or checksum-mismatched files never become active. An offline relaunch uses the installed revision without a network attempt. |
| Model load | From an installed model after process launch, `QwenEngine.ready` occurs within 20.0 seconds at p95. |
| First audio | From a warm ready engine, first non-silent PCM is scheduled within 1.0 second at p95. On the first request after a cold model load, measured from `ready`, it is within 3.0 seconds at p95. |
| Throughput | Over 30 continuous minutes, sentence-level real-time factor has p95 at or below 0.75 and maximum at or below 1.0. |
| Playback | The bounded queue stays between 3 and 5 seconds whenever input is available; there are zero engine underruns and no unintended output gap longer than 100 ms. Authored punctuation pauses are excluded and must be labeled in the trace. |
| Memory | Peak process physical footprint is at or below 3,200,000,000 bytes; there are zero memory warnings, GPU allocation failures, watchdog terminations, or jetsam exits in five consecutive 30-minute runs. |
| Thermal | Thermal state never reaches `critical`. If it reaches `serious`, rolling 60-second RTF remains at or below 1.0 and queued audio never falls below 1.0 second. |
| Battery | A screen-locked, unplugged 60-minute run consumes no more than 20 battery percentage points. Record starting/ending percentage and thermal-state transitions. |
| Background | Screen-locked playback runs for 30 minutes with zero underruns; lock/unlock, one phone-call interruption, and one Bluetooth route change resume at the correct sentence without replaying more than one second. |
| Cancellation | Pause, skip, seek, chapter change, and book close stop scheduling old-session audio within 250 ms at p95, with zero stale chunks afterward. |
| Corpus completion | All 100 entries in `ios/LanternBench/Fixtures/benchmark-sentences.json` finish in three seeded runs using `aiden`; every supported speaker completes a ten-sentence smoke subset. There are zero crashes, NaNs, silent outputs, token-cap runaways, or clipped runs. |
| Intelligibility | Automatic transcription word-error rate is no more than five relative percentage points worse than the same seeded corpus rendered by the pinned official BF16 reference path. Human review finds no boundary click in any corpus item; stitch discontinuity is below 0.1 full scale. |
| State integrity | One hour containing 100 random pause/skip/seek operations ends on the expected EPUB sentence and offset after force-quit/relaunch, with no cross-book audio. |

If any hard gate fails, the production decision is **no-go**. Changing a threshold requires a new architecture decision; it cannot be waived in a test report.

## Model installation and storage

The manifest at `ios/LanternApp/Resources/ModelManifests/qwen-bf16.json` is the source of truth. The installer must obey these rules:

1. Download only `resolve/<40-character revision>/<path>` URLs. Branches, tags, redirects to an unverified revision, and user-supplied mirrors are forbidden in production.
2. Before downloading, require the manifest to contain a 64-character SHA-256 and exact byte count for every required file. A `null` digest with `required_before_download` status deliberately makes this development manifest non-installable.
3. Preflight at least 4,000,000,000 available bytes. Recheck space before promoting the completed installation.
4. Store durable weights under `Application Support/Lantern/Models/<manifest-id>/<manifest-revision>/`, mark them excluded from iCloud backup, and use file protection compatible with playback after the user has unlocked once.
5. Write partial files only under a sibling `.staging/<UUID>/` directory on the same volume. Resume with HTTP Range only when the pinned revision, expected byte count, and validator metadata still match; otherwise discard that partial file.
6. Stream bytes to disk while calculating SHA-256. Never load a complete weight file into a `Data` buffer merely to hash or move it.
7. Verify every file's length and digest, parse the JSON configuration files, instantiate and warm the model, and write a completion record containing the manifest digest before activation.
8. Promote the completed directory with a same-volume atomic rename, then atomically replace a small `current.json` pointer. A crash may leave staging data, but it must never expose a partial model.
9. Keep the previously active revision until the replacement has been promoted and opened successfully. Cleanup may remove only unreferenced staging or retired revision directories.
10. On any mismatch, delete only that staging directory, retain the active model, emit a structured installation error, and require an explicit retry.

## Accepted and rejected alternatives

| Alternative | Decision | Reason |
| --- | --- | --- |
| Hybrid `WKWebView` plus native Swift/MLX | Accepted for gated spike | Preserves Lantern's EPUB/UI implementation while giving Qwen direct Metal access and native audio/background lifecycle control. The selected runtime already emits incremental PCM. |
| Safari/PWA WebGPU or ONNX Runtime Web | Rejected for production | Safari 26 exposes WebGPU, but ONNX Runtime's published iOS Safari matrix does not support its WebGPU or WebNN execution providers, and Qwen publishes no browser-ready ONNX graph. The official assets also create unacceptable browser-memory risk. |
| `Qwen3TTSCoreML` as primary | Rejected as primary; retain as benchmark | Its current protocol conformance returns a complete waveform rather than true PCM chunks, has a fixed 256-position cache, and lacks a published Qwen iPhone benchmark. |
| `AtomGradient/swift-qwen3-tts` and its 808 MB model | Rejected as primary; compression research only | The pinned runtime emits token events followed by one final PCM buffer, lacks cooperative cancellation, and reports performance only on a 36 GB M-series Mac. Its vocabulary pruning is English-oriented and its repository license/provenance must be audited before reuse. |
| Remote Qwen server | Rejected as the local engine | It does not meet the offline or on-device privacy requirement. It may remain a separately labeled compatibility feature, not an automatic fallback that uploads book text. |
| Complete SwiftUI rewrite | Rejected | It adds unrelated product risk. Only the inference, installation, and audio lifecycle require a native boundary. |

## License and provenance requirements

- Preserve the Apache-2.0 license and notices for `soniqo/speech-swift`, the Qwen3-TTS model, and the Qwen speech tokenizer in the application acknowledgements and source distribution.
- Record each immutable repository revision, downloaded path, byte count, and SHA-256 in the shipped manifest and generated third-party notice. Runtime downloading does not remove attribution obligations.
- Do not imply endorsement by Qwen, Alibaba Cloud, Soniqo, Hugging Face, or model converters.
- The AtomGradient code describes itself as MIT in its README but the inspected pinned repository contains no standalone license file. Neither its code nor derived weights may ship until counsel or the project owner confirms the applicable license and the derived-model provenance is documented.
- The benchmark fixture contains newly constructed test sentences and no book excerpts. It is dedicated to CC0-1.0 for redistribution with the test suite.

## Evidence and known limitations

- Qwen's reported 97 ms first-packet result was measured with an internal vLLM engine, `torch.compile`, and CUDA Graphs on an unspecified compute resource, not an iPhone: [Qwen3-TTS Technical Report](https://arxiv.org/html/2601.15621v1).
- Safari 26 WebGPU availability does not establish ONNX Runtime Web support: [WebKit Safari 26 WebGPU](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#webgpu) and [ONNX Runtime Web support matrix](https://onnxruntime.ai/docs/get-started/with-javascript/web.html#supported-versions).
- The selected MLX runtime declares iOS 18 support but publishes no Qwen3-TTS benchmark on an iPhone. Its M2 Max figures are useful only for smoke-test expectations, not acceptance.
- The selected BF16 model and full codec are intentionally conservative for fidelity, but their download and memory footprint may fail the gates. A failed gate is a product result, not permission to silently substitute an unvalidated quantized model.

## Consequences

Lantern gains a credible path to private, offline Qwen speech without rewriting the reader. It also acquires a native iOS target, a multi-gigabyte optional installation, Apple audio/background obligations, model-license notices, and a physical-device release gate. Until the gate passes, local Qwen remains experimental and cannot be advertised as production-ready or real-time on iPhone 15 Pro.
