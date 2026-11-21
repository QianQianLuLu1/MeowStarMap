# Synthetic Live rotation test assets

Before building/running `LivePhotoRotationInstrumentedTest`, generate the two binary assets from the repository root:

```sh
python -m pip install Pillow
# Install ffmpeg separately if it is not already on PATH.
python tools/livephoto/generate-fixtures.py
```

This writes `corners.jpg` and `corners-audio.mp4` here. They are deliberately generated rather than copied from private player/device photos. The JPEG has red/green/blue/yellow quadrants; the MP4 is 320x180, 24 video frames, one second, H.264 + an AAC 440 Hz test tone.

The generator was executed in the authoring environment and ffprobe confirmed those stream properties. This does NOT mean Android rotation or OEM gallery playback has passed. Re-generating with different FFmpeg versions may produce different binary hashes without changing the required fixture behavior.

After generation, run from `apps/mobile`:

```sh
./gradlew testDebugUnitTest assembleDebug assembleDebugAndroidTest
./gradlew connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=app.nikkisync.mobile.media.live.LivePhotoRotationInstrumentedTest
```

The second command runs on connected Android hardware/emulator and must be explicitly authorized for the selected device. Do not silently skip tests when the assets or codec are missing. The test never inserts fixtures into the user's gallery.

The same generated assets are used by `app.nikkisync.mobile.ui.chrome.LivePhotoPlaybackInstrumentedTest` (added 2026-10-18). It exercises actual TextureView rendering, muted autoplay/loop, pause and lifecycle decoder release using a private synthetic Saved-format file. It requires initial consent to have been accepted manually on a dedicated test install. It never inserts a gallery item or changes Saved history. Do not uninstall an existing official-signed installation to replace it with a differently signed debug build. This test was compiled but not run when no Android device was connected.
