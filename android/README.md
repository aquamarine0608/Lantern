# Lantern for Android

This directory contains the complete Android host for Lantern: its Gradle and
native build, secure bundled-WebView shell, EPUB picker, versioned JavaScript
bridge, resumable model installer, serialized JNI runtime, and local WAV
synthesis endpoint.

The native integration is based on the proven Android reference project and
targets the CPU backend first. It builds one ABI, `arm64-v8a`, for Android 12
(API 31) and newer.

The root web app remains the single source of truth. Every Android build runs
`syncLanternWebAssets`, which copies an explicit allowlist into
`app/build/generated/assets/www` before Android merges assets. The allowlist
contains `index.html`, the Android bridge bootstrap, the native TTS adapter,
the web manifest and icons, and the pinned `vendor/fflate` code and license.
`sw.js` is intentionally omitted: the Android path uses packaged assets and
the page already declines to register the service worker when the native host
is present.

## Pinned toolchain

| Component | Version |
| --- | --- |
| Gradle wrapper | 8.14.2 |
| Android Gradle Plugin | 8.13.2 |
| Kotlin Gradle Plugin | 2.3.21 |
| JDK | 17 |
| Compile / target SDK | 36 |
| Minimum SDK | 31 |
| Android NDK | 28.2.13676358 (r28c) |
| CMake | 3.22.1 |

NDK r28 or newer is intentional: it produces 16 KiB-page-compatible ELF
alignment by default. The final JNI link also states the 16 KiB alignment
flags explicitly.

## Install the Windows toolchain

Install JDK 17 and Android Studio, or the Android command-line tools. With
`ANDROID_SDK_ROOT` pointing at the SDK, install the required packages:

```powershell
& "$env:ANDROID_SDK_ROOT\cmdline-tools\latest\bin\sdkmanager.bat" --install `
  "platform-tools" `
  "platforms;android-36" `
  "build-tools;35.0.0" `
  "ndk;28.2.13676358" `
  "cmake;3.22.1"
```

Accept the Android SDK licenses, then either let Android Studio create
`local.properties` or set `ANDROID_SDK_ROOT`. `local.properties` is ignored
and must never be committed.

## Initialize the native source

Lantern pins `qwen3-tts.cpp` as a Git submodule at revision
`4562731dc612cb87b4cd1eedac275a17d1078773`; its nested `ggml` dependency is
pinned recursively. Initialize both checkouts after cloning Lantern:

```powershell
git submodule update --init --recursive
```

Keep the upstream `LICENSE` files with any redistributed source or binaries.
Do not place GGUF model files in this repository or APK.

The CMake integration expects these files after checkout:

```text
external/qwen3-tts.cpp/src/qwen3_tts_jni.cpp
external/qwen3-tts.cpp/ggml/CMakeLists.txt
```

## Build and verify

From this directory:

```powershell
java -version
javac -version
.\gradlew.bat --version
.\gradlew.bat --no-daemon :app:syncLanternWebAssets
.\gradlew.bat --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The generated asset tree is build output. Do not edit or commit it; edit the
corresponding files at Lantern's repository root and rebuild instead.

The debug APK will be written to:

```text
app/build/outputs/apk/debug/app-debug.apk
```

For a personal, non-debuggable APK, assemble the unsigned release, align it,
then sign it with a keystore kept outside the repository:

```powershell
keytool -genkeypair -keystore C:\secure\lantern-release.p12 -storetype PKCS12 `
  -alias lantern-personal -keyalg RSA -keysize 4096 -validity 10000
.\gradlew.bat --no-daemon :app:assembleRelease
& "$env:ANDROID_SDK_ROOT\build-tools\35.0.0\zipalign.exe" -f -P 16 -v 4 `
  app\build\outputs\apk\release\app-release-unsigned.apk `
  app\build\outputs\apk\release\app-release-aligned.apk
& "$env:ANDROID_SDK_ROOT\build-tools\35.0.0\apksigner.bat" sign `
  --ks C:\secure\lantern-release.p12 --ks-key-alias lantern-personal `
  --out app\build\outputs\apk\release\lantern-release.apk `
  app\build\outputs\apk\release\app-release-aligned.apk
```

Back up that keystore and its password. Android will only install future
updates over the existing app when they are signed by the same key. Neither a
signing key nor its password belongs in Git.

The APK is model-free. After installing it, open **Voice settings** and tap
**Download model**. Lantern downloads approximately 884 MB, verifies both
files, and stores them in private `noBackupFilesDir` storage. A cancelled
download can resume. Uninstalling Lantern or clearing its app storage removes
the downloaded model and the local EPUB library.

Install the personally signed release APK on an authorized arm64 Android
device with:

```powershell
& "$env:ANDROID_SDK_ROOT\platform-tools\adb.exe" install -r `
  app\build\outputs\apk\release\lantern-release.apk
```

For native compatibility validation, confirm a 16 KiB device reports `16384`
and inspect the packaged library alignment:

```powershell
& "$env:ANDROID_SDK_ROOT\platform-tools\adb.exe" shell getconf PAGE_SIZE
& "$env:ANDROID_SDK_ROOT\build-tools\35.0.0\zipalign.exe" -c -P 16 -v 4 `
  app\build\outputs\apk\release\lantern-release.apk
```

## JNI contract

The upstream JNI exports are hard-coded to
`com.qwen.tts.studio.engine.QwenEngine`. Do not relocate, rename, or shrink
that class or its nested DTOs and callbacks without changing and retesting
the native exports. The included unit tests check the constructor, field, and
streaming callback descriptors that JNI resolves at runtime.

`QwenEngine` owns one native context. It is not thread-safe: serialize all
calls on one engine dispatcher, and do not re-enter it from progress or audio
callbacks. Lantern therefore keeps one runtime for the OS process; never close
or replace it from an Activity recreation.

## Current boundaries

- CPU-only GGML backend; Vulkan/OpenCL/OpenMP remain disabled until separately
  benchmarked and validated on physical devices.
- No GGUF model artifact is bundled in the APK. The adjacent installer accepts
  only the immutable revision, byte counts, and SHA-256 hashes in the pinned
  model manifest.
- No release signing configuration is committed. Keep signing keys and
  passwords outside the repository.
- One process-scoped runtime serializes all model access, so Activity recreation
  cannot load a second 884 MB native context while the first one is unwinding.
- The installer and synthesis admission gate are process-scoped too: recreated
  WebViews cannot overlap staging writes or queue a second JNI sentence.
- The manifest denies cleartext traffic and backup. The model installer uses
  same-volume staging and atomic promotion after verification.
- Synthesis is sentence-at-a-time through the existing Web Audio reader. Stop,
  timeout, and view teardown signal the native streaming callback; cancellation
  is observed at a generated-audio chunk boundary rather than instantaneously.
- Streaming cancellation lazily loads upstream's dedicated streaming decoder.
  Peak resident memory and first-sentence latency must be measured on the target
  phone; successful desktop assembly does not establish that memory headroom.
- This build does not yet add a foreground `MediaSessionService`; screen-off
  and background behavior must be validated on a physical device.
- Upstream still treats Android correctness and Snapdragon performance as open
  work. Do not call this build real-time until a physical arm64 phone sustains
  generation at least as fast as playback across long chapters without thermal
  collapse. Listen to and/or transcribe a representative English audiobook set
  as well: a valid WAV from the low-memory Q4 talker/tokenizer pair does not by
  itself establish intelligible, acceptable narration quality.
