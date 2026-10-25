# Oscar Cam

Free, LAN-only camera grid for rooted LG webOS TVs. Arrange your IP
cameras in an adjustable grid and watch them on the TV — no account, no
cloud, no telemetry. Camera credentials stay on the TV.

## Install (Homebrew Channel)

1. In Homebrew Channel, go to Settings → Add repository.
2. Enter `https://larrysweb.github.io/oscar-cam/`.
3. Back in the app browser, find Oscar Cam → Install.

## First run on the TV

1. Settings → go2rtc server URL (for example
   `http://192.168.0.58:1984` on a home LAN running go2rtc).
2. Cameras → add cameras (go2rtc stream, WebRTC ws URL, MJPEG URL, or
   HLS URL). A go2rtc camera can name a grid stream (usually the
   substream) and a different fullscreen stream (usually the main stream).
3. Edit layout → pick a preset (1, 2×2, 3×3, 4×4) or drag tiles into a
   freeform grid. With the remote alone: select a tile, press OK to move
   it, arrows to move, OK to place, Back to cancel.

## Proven on an LG C3 (2026-10-25)

- 9 simultaneous go2rtc substreams play smooth, no freezing/stuttering.
  Grid cap is at least 9; 4×4 (16 tiles) is untested.
- Raw RTSP does NOT play in the TV browser — use go2rtc or a
  camera-native browser-playable stream.
- ONVIF discovery works on the test cameras but is not in this build
  yet (manual cameras only for now).

## Layout of this repo

- `app/` — the webOS app source (`index.html`, `app.js`, `style.css`,
  `appinfo.json`, icons). Playback uses VideoRTC by AlexxIT (go2rtc
  project, MIT, bundled as `video-rtc.js`) and hls.js (Apache-2.0).
- `docs/` — the Homebrew Channel repository served by GitHub Pages:
  `manifest.json`, the per-app manifest, the `.ipk`, and the icon.
- `homebrew-repo/` — the manifest generator (`gen-manifest.py`) and
  publish notes.

## Releasing a new version

1. Bump the version in `app/appinfo.json` and rebuild the `.ipk`
   (an `.ipk` is an `ar` archive of `debian-binary`, `control.tar.gz`,
   and `data.tar.gz` holding the app files).
2. Run `python3 homebrew-repo/gen-manifest.py <ipk> <pages-url>
   <repo-url> docs/` to regenerate both manifests.
3. Copy the new IPK + manifests into `docs/` and commit.

## Status

Version 0.1.0, MVP. No ONVIF discovery yet, no PTZ yet. License to be
decided (no LICENSE file yet).
