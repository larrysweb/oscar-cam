# Oscar Cam PTZ proxy

The TV app cannot call cameras' ONVIF PTZ services directly (the cameras
answer CORS preflights with 405 and no CORS headers), and go2rtc has no
PTZ-send API. So the TV sends small JSON actions here, and this proxy
issues the ONVIF calls with the camera logins held server-side. Camera
passwords never touch the TV app.

## Run (Docker, on the machine that runs go2rtc)

```sh
# 1. Generate the camera config from your go2rtc.yaml (it extracts the
#    camera logins; the output prints only keys and URLs, never passwords):
python3 gen_cameras_config.py
#    → writes cameras.json (mode 0600) next to this file.
#    NEVER commit cameras.json. It contains passwords.

# 2. Build and run, bound to your LAN address only:
docker build -t oscarcam-ptz:0.1.4 .
docker run -d --restart unless-stopped --name oscarcam-ptz \
  -p 192.168.0.58:1985:1985 \
  -v /volume1/docker/oscarcam-ptz:/config:ro \
  oscarcam-ptz:0.1.4
```

The TV app finds the proxy automatically when the PTZ proxy URL in
Settings is blank: it uses the go2rtc host on port 1985.

## Endpoints (all JSON, LAN only)

- `GET /health` — `{"ok": true, "cameras": [...]}`
- `GET /status?camera=cam1` — ONVIF GetStatus; read-only, never moves a camera
- `POST /ptz` — `{"camera": "cam1", "action": "pulse", "pan": 0.5,
  "duration_ms": 1000}`; one TV button press. The proxy starts a velocity
  move, waits, and stops it server-side, so a lost message can never
  leave a camera panning. The older actions (`left`, `right`, `up`,
  `down`, `zoom_in`, `zoom_out`) send bounded relative moves and are
  still accepted; `home` sends GotoHomePosition. The `camera` value may
  be a config key (`cam1`), a go2rtc stream name
  (`cam1_front_street_sub`), a camera IP, or a name containing the key —
  the proxy matches by IP, then stream-name prefix, then name.
- Cameras whose pan axis is inverted get a per-camera pan flip
  (`INVERT_PAN` in `ptz_proxy.py`; `cam7` in testing answers positive
  pan with a left move), so the TV's arrows match the picture. Tilt
  and zoom are never flipped.

## Safety rules

- Moves are velocity pulses (0.5 speed, about 1 second, stopped
  server-side). A lost message can never send a camera spinning.
- A transport error (dropped connection, timeout) is never retried: the
  command may already have executed. Some cameras (notably a generic-OEM
  back-fence camera in testing) drop their ONVIF service on writes and
  recover after ~60 seconds; the proxy reports that as a 502, it does
  not retry.
- An authentication failure is retried once with a plaintext password
  instead of a digest — a failed-auth attempt cannot have moved
  anything, so that retry is safe.
- The proxy logs camera keys and actions only, never credentials.
- Anyone on your LAN can send PTZ moves to the proxy — the same trust
  class as go2rtc's unauthenticated API. If that bothers you, bind it
  to a host firewall rule instead of a bare port mapping.

## How it resolves cameras

`gen_cameras_config.py` reads `go2rtc.yaml` and handles both credential
forms found in the wild: standard `rtsp://user:pass@host/...` URLs and
Hiseeu's path form `/user=admin&password=...`. It writes `cameras.json`
with each camera's PTZ service URL, device service URL, and login. The
proxy resolves each camera's media service URL from its device service
(GetProfiles is a media-service call, not a PTZ one) and prefers the
media profile that carries a PTZ configuration.
