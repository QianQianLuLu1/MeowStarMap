# NikkiSync Mobile — M2.0 Android Gallery MVP

Native Android client for the local-only NikkiSync protocol. The app deliberately has no runtime dependency on a cloud SDK or third-party networking/image library.

M2.0 scope:

- discover `_nikkisync._tcp` with Android NSD/mDNS;
- accept `nikki-sync://pair?...` deep links (system camera may scan the QR) or pasted pairing URIs;
- pin the PC self-signed TLS certificate fingerprint from the pairing payload;
- generate/persist an Ed25519 device identity and sign authenticated requests;
- page the PC Asset library and lazily load the best preview resource;
- listen to `/ws/v1` and refresh from the revision journal after reconnect/events;
- multi-select assets and save byte-identical original still images to `Pictures/NikkiSync` using MediaStore, verifying SHA-256 while streaming;
- persist the paired PC and last seen library revision locally.

M2.0 intentionally does **not** package a motion-photo asset into Android Motion Photo / Apple Live Photo. Motion assets are marked `LIVE`; native live export begins in M3.0.

The project includes a standard Gradle 8.13 wrapper and a Windows build adapter at `scripts/build-android.ps1`. The adapter uses the project wrapper first, then falls back to the locally proven JBR 17, Android SDK 35 and Build Tools 35.0.1 installation without copying an SDK into this repository.

```powershell
npm run mobile:build
npm run mobile:install # requires one authorized USB-debugging device
```

The APK supports Android 11+ (`minSdk 30`, `targetSdk 35`). Android 11 keeps translucent glass chrome and readable top shading without RenderEffect; Android 12+ retains GPU blur. AndroidX provides the image-picker fallback on older systems. Java library desugaring 2.1.5 backports newer Java APIs. The build script verifies APK signing and package id before it reports success.

The current LIVE rotation implementation also requires Android NDK `28.1.13356709` and CMake `3.22.1`. Install these SDK components before building. CMake downloads the official libjpeg-turbo `3.2.0` source archive and verifies its pinned SHA-256. Large JPEG coefficient arrays use bounded RAM and anonymous export-cache files. The upstream license is bundled in the APK at `assets/licenses/libjpeg-turbo.txt`. Do not commit local SDK paths, `local.properties`, `.cxx` or generated native binaries.
