# Oscar Cam 0.1.1 (MVP)

A free, LAN-only camera grid for rooted LG webOS TVs. No account, no
cloud, no telemetry. Camera credentials stay on the TV.

## What the MVP does

- Manual camera add / edit / delete. Source types: go2rtc stream,
  WebRTC (ws URL), MJPEG URL, HLS URL.
- Grid layouts with presets (1, 2×2, 3×3, 4×4) plus freeform placement.
  Drag tiles with the Magic Remote pointer; with the remote alone, select
  a tile, press OK to move it, arrows to move, OK to place, Back to cancel.
  A Resize toggle resizes the focused tile with the arrows.
- Playback: go2rtc and WebRTC tiles via VideoRTC (MSE/WebRTC negotiated
  over the go2rtc websocket); MJPEG via image streaming with backoff
  retry; HLS via hls.js with native fallback.
- Fullscreen on tile select. Grid tiles are muted; fullscreen can unmute.
- Persistence in localStorage, surviving app restarts. Export/import of
  the whole configuration as JSON (Settings) — this is also the format
  the future Android companion app will send to the TV.
- Per-camera fullscreen stream: a go2rtc camera can name a grid stream
  (usually the substream) and a different fullscreen stream (usually the
  main stream).

## Proven on the C3 (Phase 0, 2026-10-25)

- ONVIF discovery + profiles work unauthenticated on all 5 LAN cameras.
- Raw RTSP does NOT play in the TV browser (NO SIGNAL) — hence go2rtc.
- 9 simultaneous go2rtc substreams play smooth, no freezing/stuttering.
  Grid cap is at least 9; 4×4 (16 tiles) is untested and flagged as such.

## Files

- `index.html`, `app.js`, `style.css` — the app.
- `video-rtc.js` — VideoRTC v1.6.0 by AlexxIT (go2rtc project, MIT),
  included verbatim for go2rtc/WebRTC playback.
- `hls.min.js` — hls.js (Apache-2.0) for HLS playback.
- `appinfo.json`, `icon.png`, `largeIcon.png` — webOS packaging.

## Configuration format (localStorage key `oscarcam-v1`)

```json
{
  "settings": { "go2rtcBase": "http://192.168.0.58:1984" },
  "cameras": [
    { "id": "…", "name": "CAM1 front street", "type": "go2rtc",
      "stream": "cam1_front_street_sub", "mainStream": "cam1_front_street",
      "url": "", "username": "", "password": "" }
  ],
  "layouts": [
    { "id": "…", "name": "All", "cols": 3, "rows": 3,
      "cells": [ { "cameraId": "…", "x": 0, "y": 0, "w": 1, "h": 1 } ] }
  ],
  "activeLayoutId": "…"
}
```

## Install paths

- Homebrew Channel custom repo (CHOSEN 2026-10-25): publish kit in
  `../homebrew-repo/` (manifests, IPK, icon, publish + TV steps).
  Repo `larrysweb/oscar-cam` (public); text files pushed 2026-10-25
  (commit `d0980932`). Binaries (IPK, icons) and the Pages switch are
  still to do by hand — see `../homebrew-repo/README.md`.
- webOS Dev Mode + `ares-install` from a PC with the webOS SDK (fallback).
- A rooted-TV shell install is possible in principle (SSH port 22 is
  open on the C3) but no SSH login is known — do not guess credentials.

## Known MVP limitations (honest list)

- On-TV run of this exact package is not yet tested; the playback path
  is the same one proven by go2rtc's own stream page on the C3, but the
  packaged-app origin (vs. a page served by go2rtc) still needs its
  first on-TV run to confirm LAN websocket access from the app.
- MJPEG and HLS tiles are implemented but not yet tested on the TV.
- No ONVIF discovery yet (Phase 2) — cameras are manual-only.
- No PTZ yet (Phase 3). PTZ was confirmed offered by all 5 cameras.
- localStorage persists across restarts but is lost if the app is
  uninstalled; use Settings export for backup.
