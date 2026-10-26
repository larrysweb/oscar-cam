#!/usr/bin/env python3
"""Oscar Cam PTZ proxy — LAN-only.

The TV app (file:// origin) cannot call the cameras' ONVIF PTZ services
directly: the cameras answer CORS preflights with 405 and no CORS headers.
So the TV sends a plain JSON action here ("step left", "home", ...), and
this proxy issues the ONVIF SOAP call with the camera credentials held
server-side. Camera passwords never touch the TV app.

Endpoints (all JSON):
  GET  /health            -> {"ok": true, "cameras": [...]}
  POST /ptz               {"camera": "<key or stream name>", "action": ...}
                          actions: left, right, up, down, zoom_in, zoom_out, home
  POST /ptz (diagnostic)  {"camera": ..., "action": "continuous",
                           "pan": 0.3, "tilt": 0, "zoom": null} then
                          {"camera": ..., "action": "stop"} — velocity moves
                          are NOT used by the TV app; they exist only to test
                          firmwares whose RelativeMove answers 200 and ignores it.
  POST /ptz (TV pulse)    {"camera": ..., "action": "pulse",
                           "pan": -0.5, "tilt": 0, "zoom": null,
                           "duration_ms": 1000} — one TV button press: the
                          proxy starts the velocity move, waits, and stops it
                          server-side, so a lost message can never leave the
                          camera panning. pan/tilt/zoom are signed velocities
                          in [-1, 1]; duration is clamped to 100–3000 ms.
  GET  /status?camera=X   -> ONVIF GetStatus (read-only, never moves a camera)

Safety rules:
  - RelativeMove only (bounded steps, no runaway if a stop is lost).
  - A transport error (dropped connection, timeout) is NEVER retried: the
    command may already have executed, and a retry could double-move.
    (CAM7's ONVIF service is known to drop connections on writes.)
  - An authentication failure is retried exactly once with a plaintext
    password instead of a digest — a failed-auth attempt cannot have moved
    anything, so that retry is safe.
  - Logs print camera keys and actions only, never credentials or SOAP
    bodies (the digest header is safe, but bodies are not logged at all).

Config: JSON at $PTZ_CONFIG (default /config/cameras.json):
  {"cam1": {"ptz_url": "http://192.168.0.24:8999/onvif/ptz_service",
            "user": "admin", "password": "..."}, ...}
Runs on Python 3 stdlib only. No third-party packages.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

CONFIG_PATH = os.environ.get("PTZ_CONFIG", "/config/cameras.json")
LISTEN_PORT = int(os.environ.get("PTZ_PORT", "1985"))
STEP = 0.1          # RelativeMove step, in normalized (-1..1) coordinates
SPEED = 0.5         # move speed, normalized
SOAP_TIMEOUT = 12   # seconds; a dropped ONVIF service recovers in ~60s

PTZ_NS = "http://www.onvif.org/ver20/ptz/wsdl"
SCHEMA_NS = "http://www.onvif.org/ver10/schema"
PAN_SPACE = "http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace"
ZOOM_SPACE = "http://www.onvif.org/ver10/tptz/ZoomSpaces/TranslationGenericSpace"
PAN_SPEED_SPACE = "http://www.onvif.org/ver10/tptz/PanTiltSpaces/GenericSpeedSpace"
ZOOM_SPEED_SPACE = "http://www.onvif.org/ver10/tptz/ZoomSpaces/GenericSpeedSpace"


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict) or not cfg:
        raise ValueError("empty or invalid PTZ config")
    return cfg


CONFIG = load_config()
PROFILE_CACHE = {}  # camera key -> profile token
MEDIA_CACHE = {}    # camera key -> media service URL


def resolve_camera(value):
    """Accept a config key ('cam1'), a go2rtc stream name
    ('cam1_front_street_sub'), a stream URL (matched by camera IP), or a
    bare camera name."""
    if not value:
        return None
    v = str(value).strip().lower()
    if v in CONFIG:
        return v
    ip_to_key = {"192.168.0.24": "cam1", "192.168.0.92": "cam5",
                 "192.168.0.32": "cam6", "192.168.0.145": "cam7",
                 "192.168.0.31": "cam8"}
    for ip, key in ip_to_key.items():
        if ip in v:
            return key
    first = v.split("_")[0].split("-")[0]
    if first in CONFIG:
        return first
    for key in CONFIG:
        if key in v:
            return key
    return None


def ws_security(user, password, use_digest=True):
    nonce_bytes = secrets.token_bytes(16)
    nonce = base64.b64encode(nonce_bytes).decode("ascii")
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    if use_digest:
        digest = base64.b64encode(
            hashlib.sha1(nonce_bytes + created.encode("utf-8") + password.encode("utf-8")).digest()
        ).decode("ascii")
        pw = (
            '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/'
            'oasis-200401-wss-username-token-profile-1.0#PasswordDigest">%s</wsse:Password>'
            % digest
        )
    else:
        pw = (
            '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/'
            'oasis-200401-wss-username-token-profile-1.0#PasswordText">%s</wsse:Password>'
            % escape(password)
        )
    return (
        '<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/'
        'oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/'
        'wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
        "<wsse:UsernameToken>"
        "<wsse:Username>%s</wsse:Username>%s"
        '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/'
        'oasis-200401-wss-soap-message-security-1.0#Base64Binary">%s</wsse:Nonce>'
        "<wsu:Created>%s</wsu:Created>"
        "</wsse:UsernameToken></wsse:Security>"
        % (escape(user), pw, nonce, created)
    )


def soap_envelope(user, password, body, use_digest=True):
    header = ""
    if user:
        header = "<s:Header>%s</s:Header>" % ws_security(user, password, use_digest)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
        + header
        + "<s:Body>" + body + "</s:Body></s:Envelope>"
    )


def soap_post(url, body, action, user, password):
    """One ONVIF call. Returns (status, text). Raises on transport errors
    (caller must NOT retry those). Auth faults are reported, not raised,
    so the caller may retry once with the other password style."""
    last_err = None
    for use_digest in (True, False):
        if user is None and not use_digest:
            break
        env = soap_envelope(user or "", password or "", body, use_digest)
        req = urllib.request.Request(url, data=env.encode("utf-8"), method="POST")
        req.add_header(
            "Content-Type",
            'application/soap+xml; charset=utf-8; action="%s"' % action,
        )
        try:
            with urllib.request.urlopen(req, timeout=SOAP_TIMEOUT) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            if e.code in (401, 403) or "NotAuthorized" in text or "not authorized" in text.lower():
                last_err = (e.code, text)
                continue  # auth failure: safe to try the other password style
            return e.code, text
        # Transport errors (URLError, RemoteDisconnected, timeout) propagate:
        # the command may have executed, so no retry.
    if last_err:
        return last_err
    return None, "no authentication method attempted"


def get_media_url(cam):
    """Resolve the camera's Media service URL from its device service
    (GetProfiles lives on Media, not on PTZ)."""
    if cam in MEDIA_CACHE:
        return MEDIA_CACHE[cam]
    entry = CONFIG[cam]
    device_url = entry.get("device_url")
    if not device_url:
        raise RuntimeError("no device_url configured for %s" % cam)
    status, text = None, ""
    for auth in (False, True):
        if auth:
            body = soap_envelope(entry.get("user") or "", entry.get("password") or "",
                                 "<tds:GetCapabilities/>", True)
        else:
            body = (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
                'xmlns:tds="http://www.onvif.org/ver10/device/wsdl">'
                "<s:Body><tds:GetCapabilities/></s:Body></s:Envelope>"
            )
        req = urllib.request.Request(device_url, data=body.encode("utf-8"), method="POST")
        req.add_header("Content-Type",
                       'application/soap+xml; charset=utf-8; action='
                       '"http://www.onvif.org/ver10/device/wsdl/GetCapabilities"')
        try:
            with urllib.request.urlopen(req, timeout=SOAP_TIMEOUT) as resp:
                status, text = resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read().decode("utf-8", "replace")
        if status == 200:
            break
    if status != 200:
        raise RuntimeError("GetCapabilities failed (HTTP %s)" % status)
    m = re.search(r"<[A-Za-z0-9]+:Media>(.*?)</[A-Za-z0-9]+:Media>", text, re.DOTALL)
    if not m:
        raise RuntimeError("no Media capability block")
    xm = re.search(r"<[^:>]+:XAddr>([^<]+)</[^:>]+:XAddr>", m.group(1))
    if not xm:
        raise RuntimeError("Media block present but no XAddr")
    MEDIA_CACHE[cam] = xm.group(1)
    return MEDIA_CACHE[cam]


def get_profile_token(cam):
    if cam in PROFILE_CACHE:
        return PROFILE_CACHE[cam]
    entry = CONFIG[cam]
    media_url = get_media_url(cam)
    body = '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>'
    status, text = soap_post(media_url, body,
                             "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
                             entry.get("user"), entry.get("password"))
    if status != 200:
        raise RuntimeError("GetProfiles failed (HTTP %s)" % status)
    opens = [(m.group(1), m.end()) for m in
             re.finditer(r"<[A-Za-z0-9]+:Profiles?\b[^>]*\stoken=\"([^\"]+)\"[^>]*>", text)]
    if not opens:
        raise RuntimeError("GetProfiles returned no profiles")
    token = opens[0][0]
    for tok, end in opens:
        if "PTZConfiguration" in text[end:end + 6000]:
            token = tok
            break
    PROFILE_CACHE[cam] = token
    return token


# Cameras whose ONVIF pan axis is inverted (positive pan moves the camera
# LEFT). Frame-confirmed for cam7 on 2026-10-26: a +0.3 pan pulse moved the
# view left. The proxy flips the pan sign for these cameras so the TV's
# arrows match the picture. Tilt and zoom are NOT flipped (untested).
INVERT_PAN = frozenset({"cam7"})


def pan_for(cam, pan):
    if pan is None or cam not in INVERT_PAN:
        return pan
    return -pan


def do_relative_move(cam, pan, tilt, zoom):
    pan = pan_for(cam, pan)
    entry = CONFIG[cam]
    token = get_profile_token(cam)
    translation = ""
    speed = ""
    if pan is not None or tilt is not None:
        translation += '<tt:PanTilt x="%s" y="%s" space="%s"/>' % (
            pan or 0, tilt or 0, PAN_SPACE)
        speed += '<tt:PanTilt x="%s" y="%s" space="%s"/>' % (
            SPEED, SPEED, PAN_SPEED_SPACE)
    if zoom is not None:
        translation += '<tt:Zoom x="%s" space="%s"/>' % (zoom, ZOOM_SPACE)
        speed += '<tt:Zoom x="%s" space="%s"/>' % (SPEED, ZOOM_SPEED_SPACE)
    body = (
        '<tptz:RelativeMove xmlns:tptz="%s" xmlns:tt="%s">'
        "<tptz:ProfileToken>%s</tptz:ProfileToken>"
        "<tptz:Translation>%s</tptz:Translation>"
        "<tptz:Speed>%s</tptz:Speed>"
        "</tptz:RelativeMove>" % (PTZ_NS, SCHEMA_NS, escape(token), translation, speed)
    )
    return soap_post(entry["ptz_url"], body, PTZ_NS + "/RelativeMove",
                     entry.get("user"), entry.get("password"))


def do_home(cam):
    entry = CONFIG[cam]
    token = get_profile_token(cam)
    body = (
        '<tptz:GotoHomePosition xmlns:tptz="%s" xmlns:tt="%s">'
        "<tptz:ProfileToken>%s</tptz:ProfileToken>"
        "<tptz:Speed><tt:PanTilt x=\"%s\" y=\"%s\" space=\"%s\"/>"
        "<tt:Zoom x=\"%s\" space=\"%s\"/></tptz:Speed>"
        "</tptz:GotoHomePosition>"
        % (PTZ_NS, SCHEMA_NS, escape(token), SPEED, SPEED, PAN_SPEED_SPACE,
           SPEED, ZOOM_SPEED_SPACE)
    )
    return soap_post(entry["ptz_url"], body, PTZ_NS + "/GotoHomePosition",
                     entry.get("user"), entry.get("password"))


def do_continuous(cam, pan, tilt, zoom):
    """Velocity move: keeps going until Stop. Used only as a diagnostic
    (some firmwares accept RelativeMove with 200 and ignore it, while
    ContinuousMove actually drives the motor)."""
    pan = pan_for(cam, pan)
    entry = CONFIG[cam]
    token = get_profile_token(cam)
    velocity = ""
    if pan is not None or tilt is not None:
        velocity += '<tt:PanTilt x="%s" y="%s" space="%s"/>' % (
            pan or 0, tilt or 0,
            "http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace")
    if zoom is not None:
        velocity += '<tt:Zoom x="%s" space="%s"/>' % (
            zoom, "http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace")
    body = (
        '<tptz:ContinuousMove xmlns:tptz="%s" xmlns:tt="%s">'
        "<tptz:ProfileToken>%s</tptz:ProfileToken>"
        "<tptz:Velocity>%s</tptz:Velocity>"
        "</tptz:ContinuousMove>" % (PTZ_NS, SCHEMA_NS, escape(token), velocity)
    )
    return soap_post(entry["ptz_url"], body, PTZ_NS + "/ContinuousMove",
                     entry.get("user"), entry.get("password"))


def do_pulse(cam, req):
    """One TV button press: velocity move for a fixed duration, then stop.
    The stop is server-side, so a lost message can never leave the camera
    panning. If the start itself fails, the stop is still attempted (the
    start may have executed despite the failure)."""
    try:
        duration_ms = int(req.get("duration_ms") or 1000)
    except (TypeError, ValueError):
        duration_ms = 1000
    duration_ms = max(100, min(3000, duration_ms))

    def vel(v):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        if f == 0:
            return 0
        return max(-1.0, min(1.0, f))

    start_err = None
    try:
        status, text = do_continuous(
            cam, vel(req.get("pan")), vel(req.get("tilt")), vel(req.get("zoom")))
        if status != 200:
            start_err = "continuous HTTP %s: %s" % (status, fault_text(text))
    except Exception as e:
        start_err = "continuous %s" % type(e).__name__
    time.sleep(duration_ms / 1000.0)
    try:
        stop_status, stop_text = do_stop(cam)
    except Exception as e:
        return 502, "pulse stop failed (%s)" % type(e).__name__
    if stop_status != 200:
        return 502, "pulse stop HTTP %s: %s" % (stop_status, fault_text(stop_text))
    if start_err:
        return 502, "pulse start failed (%s) but stop succeeded" % start_err
    return 200, "pulse ok"


def do_stop(cam):
    entry = CONFIG[cam]
    token = get_profile_token(cam)
    body = (
        '<tptz:Stop xmlns:tptz="%s">'
        "<tptz:ProfileToken>%s</tptz:ProfileToken>"
        "<tptz:PanTilt>true</tptz:PanTilt>"
        "<tptz:Zoom>true</tptz:Zoom>"
        "</tptz:Stop>" % (PTZ_NS, escape(token))
    )
    return soap_post(entry["ptz_url"], body, PTZ_NS + "/Stop",
                     entry.get("user"), entry.get("password"))


def do_status(cam):
    entry = CONFIG[cam]
    token = get_profile_token(cam)
    body = (
        '<tptz:GetStatus xmlns:tptz="%s">'
        "<tptz:ProfileToken>%s</tptz:ProfileToken>"
        "</tptz:GetStatus>" % (PTZ_NS, escape(token))
    )
    return soap_post(entry["ptz_url"], body, PTZ_NS + "/GetStatus",
                     entry.get("user"), entry.get("password"))


ACTIONS = {
    "left": lambda cam: do_relative_move(cam, -STEP, 0, None),
    "right": lambda cam: do_relative_move(cam, STEP, 0, None),
    "up": lambda cam: do_relative_move(cam, 0, STEP, None),
    "down": lambda cam: do_relative_move(cam, 0, -STEP, None),
    "zoom_in": lambda cam: do_relative_move(cam, None, None, STEP),
    "zoom_out": lambda cam: do_relative_move(cam, None, None, -STEP),
    "home": do_home,
    "continuous": None,  # special-cased in do_POST: needs a velocity vector
    "stop": do_stop,
    "pulse": None,  # special-cased in do_POST: needs the request body
}


def fault_text(text, limit=300):
    m = re.search(r"<[^:>]+:Reason>.*?<[^:>]+:Text[^>]*>(.*?)</[^:>]+:Text>",
                  text or "", re.DOTALL)
    if m:
        return re.sub(r"\s+", " ", m.group(1)).strip()[:limit]
    return (text or "")[:limit]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep stdout clean: one line per call
        pass

    def _send(self, status, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"ok": True, "cameras": sorted(CONFIG.keys())})
            return
        if parsed.path == "/status":
            cam = resolve_camera((parse_qs(parsed.query).get("camera") or [""])[0])
            if not cam:
                self._send(404, {"ok": False, "error": "unknown camera"})
                return
            try:
                status, text = do_status(cam)
            except Exception as e:
                print("status %s: transport error %s" % (cam, type(e).__name__), flush=True)
                self._send(502, {"ok": False, "error": "camera unreachable (%s)" % type(e).__name__})
                return
            if status != 200:
                print("status %s: HTTP %s %s" % (cam, status, fault_text(text)), flush=True)
                self._send(502, {"ok": False, "error": "camera HTTP %s: %s" % (status, fault_text(text))})
                return
            pan_el = re.search(r"<[A-Za-z0-9]+:PanTilt([^>]*)/?>", text)
            zoom = re.search(r"<[A-Za-z0-9]+:Zoom[^>]*\sx=\"([^\"]+)\"", text)
            pos = None
            if pan_el or zoom:
                pos = {}
                if pan_el:
                    xm = re.search(r"\sx=\"([^\"]+)\"", pan_el.group(1))
                    ym = re.search(r"\sy=\"([^\"]+)\"", pan_el.group(1))
                    if xm:
                        pos["pan"] = xm.group(1)
                    if ym:
                        pos["tilt"] = ym.group(1)
                if zoom:
                    pos["zoom"] = zoom.group(1)
            print("status %s: ok" % cam, flush=True)
            self._send(200, {"ok": True, "camera": cam, "position": pos})
            return
        self._send(404, {"ok": False, "error": "unknown path"})

    def do_POST(self):
        if self.path.split("?")[0] != "/ptz":
            self._send(404, {"ok": False, "error": "unknown path"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            req = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            self._send(400, {"ok": False, "error": "bad JSON"})
            return
        cam = resolve_camera(req.get("camera"))
        action = req.get("action")
        if not cam:
            self._send(404, {"ok": False, "error": "unknown camera"})
            return
        if action not in ACTIONS:
            self._send(400, {"ok": False, "error": "unknown action"})
            return
        try:
            if action == "pulse":
                status, text = do_pulse(cam, req)
            elif action == "continuous":
                status, text = do_continuous(
                    cam, req.get("pan"), req.get("tilt"), req.get("zoom"))
            else:
                status, text = ACTIONS[action](cam)
        except Exception as e:
            print("ptz %s %s: transport error %s" % (cam, action, type(e).__name__), flush=True)
            self._send(502, {"ok": False, "error": "camera unreachable (%s); command may not have run" % type(e).__name__})
            return
        if status != 200:
            print("ptz %s %s: HTTP %s %s" % (cam, action, status, fault_text(text)), flush=True)
            self._send(502, {"ok": False, "error": "camera HTTP %s: %s" % (status, fault_text(text))})
            return
        print("ptz %s %s: ok" % (cam, action), flush=True)
        self._send(200, {"ok": True, "camera": cam, "action": action})


if __name__ == "__main__":
    print("oscarcam-ptz listening on %d for cameras: %s"
          % (LISTEN_PORT, ", ".join(sorted(CONFIG.keys()))), flush=True)
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
