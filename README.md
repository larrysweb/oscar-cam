# Oscar Cam

A free, LAN-only camera grid for rooted LG webOS TVs. No account, no cloud,
no telemetry. Camera credentials stay on the TV.

## What you need

- A rooted LG TV running webOS 5 or later, with the Homebrew Channel installed.
- A machine on your home network to run [go2rtc](https://github.com/AlexxIT/go2rtc)
  (a NAS, a Raspberry Pi, an old PC, or a mini-PC — as a plain binary or a
  Docker container). go2rtc does NOT run on the TV itself, and the TV app
  cannot host it: Oscar Cam is only the viewer, and go2rtc is the server
  that restreams your cameras into a form the TV browser can play. That
  machine needs to be on while you are watching. If you do not have a
  server of any kind, a Raspberry Pi or any old computer will do — it does
  not have to be a Synology.
- ONVIF cameras, or any camera go2rtc can already stream. Cameras that
  natively serve MJPEG or HLS work without go2rtc, but most IP cameras are
  RTSP-only, and raw RTSP does not play in the TV browser — that is why
  go2rtc is in the stack.

## Install

In the Homebrew Channel, add this repository URL:

```
https://raw.githubusercontent.com/larrysweb/oscar-cam/main/docs/manifest.json
```

Install Oscar Cam, open it, and set your go2rtc server URL in Settings
(for example `http://192.168.0.58:1984`). Then add cameras by hand in
Cameras, or use **Discover cameras** to find ONVIF cameras on your network
and add them with a tap. Arrange them in Edit layout, including a 4x4 grid
(16 tiles is untested — 9 simultaneous substreams is the proven cap).

## First run on the TV

1. Settings → go2rtc server URL (for example
   `http://192.168.0.58:1984` on a home LAN running go2rtc).
2. Cameras → add cameras by hand (go2rtc stream, WebRTC ws URL, MJPEG URL,
   or HLS URL), or Discover cameras to find ONVIF cameras and pick a grid
   stream (usually the substream) and a fullscreen stream (usually the
   main stream). If Discover finds nothing (a camera without ONVIF, or
   with ONVIF disabled), look up your brand and model in the iSpyConnect
   camera connection database for its RTSP or MJPEG URL, then feed that
   URL to go2rtc (RTSP) or add it directly (MJPEG/HLS):
   https://www.ispyconnect.com/cameras — entries are crowdsourced, so a
   listed URL may be wrong for your exact model.
3. Edit layout → pick a preset (1, 2×2, 3×3, 4×4) or drag tiles into a
   freeform grid. With the remote alone: select a tile, press OK to move
   it, arrows to move, OK to place, Back to cancel.

## Burn-in protection (OLED)

Grids left up for hours can burn into an OLED panel. Oscar Cam has three
protections, all on by default and adjustable in Settings:

- Hide the interface after 10 seconds without remote input.
- Shift the whole picture a few pixels every 5 minutes (this also moves the
  cameras' on-screen timestamps).
- Dim after 15 minutes idle, blank after 30.

Any remote key or pointer movement wakes everything back up. These help, but
they are not a substitute for turning the grid off when you are done watching.

## Proven on an LG C3 (2026-10-25)

- 0.1.1 plays all five home cameras live on the TV (front street, back
  deck, carport, back fence, side yard).
- 9 simultaneous go2rtc substreams play smooth, no freezing/stuttering.
  Grid cap is at least 9; 4×4 (16 tiles) is untested.
- Raw RTSP does NOT play in the TV browser — use go2rtc or a
  camera-native browser-playable stream. LG's own spec lists only
  HTTP/HTTPS and HLS as supported streaming protocols for webOS TV, and
  states that anything unmentioned is "not supported or not recommended":
  https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm
- ONVIF discovery (via go2rtc) is included from 0.1.2.

## Security notes, stated plainly

- Everything stays on your LAN. Nothing is uploaded anywhere.
- Camera usernames and passwords are stored on the TV itself, effectively in
  plaintext (webOS app storage). That is the tradeoff for a no-account app:
  anyone with access to your TV can read them. Do not reuse a password that
  protects anything else.
- If your go2rtc is reachable beyond your LAN, set its own authentication.
  Oscar Cam does not add any.

## Testers wanted

Oscar Cam is proven on one TV (an LG C3) and one set of cameras. If you try
it on a different TV or camera, please report back — good or bad — using the
test report template (`.github/ISSUE_TEMPLATE/test-report.md`): your TV model
and webOS version, your go2rtc setup, your camera makes and models, what you
did, and what happened. The Diagnostics block in Settings (run the connection
tests and copy what each line says) is the most useful thing you can include
when something does not play.

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
   <repo-url> docs/` to regenerate both manifests (or sync the version,
   ipkUrl, hash, and size by hand — both manifests must match).
3. Copy the new IPK + manifests into `docs/` and commit.

## Status

Version 0.1.2. ONVIF discovery included. No PTZ yet. License: MIT (see
`LICENSE`).
