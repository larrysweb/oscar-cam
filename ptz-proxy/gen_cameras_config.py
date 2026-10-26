#!/usr/bin/env python3
"""Build the Oscar Cam PTZ proxy's camera config ON THE NAS.

Reads /volume1/docker/go2rtc/go2rtc.yaml, extracts the camera admin
credentials from the stream URLs, and writes
/volume1/docker/oscarcam-ptz/cameras.json (mode 0600).

MASKED OUTPUT ONLY: this script prints camera keys, PTZ URLs, and whether
credentials were found — never usernames or passwords. Run it on the NAS;
its output is safe to show.

Stream URLs in go2rtc.yaml carry credentials in one of two forms:
  rtsp://user:pass@host/...            (standard URL userinfo), or
  ...?user=user%26password%3Dpass...   (percent-encoded user= token,
                                        separators double-escaped)
Both are handled.
"""
import html
import json
import os
import re
import sys
from urllib.parse import unquote, urlparse

GO2RTC_YAML = "/volume1/docker/go2rtc/go2rtc.yaml"
OUT_DIR = "/volume1/docker/oscarcam-ptz"
OUT_PATH = os.path.join(OUT_DIR, "cameras.json")

# Camera key -> (IP, PTZ service URL, device service URL), from the Oct 2026 ONVIF probe.
CAMERAS = {
    "cam1": ("192.168.0.24", "http://192.168.0.24:8999/onvif/ptz_service",
             "http://192.168.0.24:8999/onvif/device_service"),
    "cam5": ("192.168.0.92", "http://192.168.0.92:8899/onvif/PTZ",
             "http://192.168.0.92:8899/onvif/device_service"),
    "cam6": ("192.168.0.32", "http://192.168.0.32:8899/onvif/PTZ",
             "http://192.168.0.32:8899/onvif/device_service"),
    "cam7": ("192.168.0.145", "http://192.168.0.145:8899/onvif/PTZ",
             "http://192.168.0.145:8899/onvif/device_service"),
    "cam8": ("192.168.0.31", "http://192.168.0.31:8899/onvif/PTZ",
             "http://192.168.0.31:8899/onvif/device_service"),
}


def amp_decode(s):
    prev = None
    while prev != s:
        prev = s
        s = html.unescape(s)
    return s


def creds_from_token(tok):
    """Try the standard userinfo form, then Hiseeu's path form
    (/user=admin&password=...) and the percent-encoded user= token form."""
    try:
        p = urlparse(tok)
        if p.hostname and p.username:
            return unquote(p.username), unquote(p.password or "")
    except ValueError:
        pass
    s = amp_decode(tok).replace(";amp;", "&")
    s = unquote(s)
    m = re.search(r"user=([^&\s'\"]+)", s)
    if not m:
        return None
    user = m.group(1)
    pm = re.search(r"password=([^&\s'\"]+)", s)
    password = pm.group(1) if pm else ""
    return user, password


def main():
    with open(GO2RTC_YAML, "r", encoding="utf-8") as f:
        text = f.read()
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9+.\-]*://[^\s'\"]+", text)
    found = {}
    for tok in tokens:
        for key, (ip, _ptz, _dev) in CAMERAS.items():
            if key in found:
                continue
            if ip not in tok:
                continue
            creds = creds_from_token(tok)
            if creds and creds[0]:
                found[key] = creds
    os.makedirs(OUT_DIR, exist_ok=True)
    out = {}
    for key, (ip, ptz_url, device_url) in CAMERAS.items():
        user, password = found.get(key, ("", ""))
        out[key] = {"ptz_url": ptz_url, "device_url": device_url,
                    "user": user, "password": password}
        print("%s: ptz_url=%s creds=%s" % (key, ptz_url, "yes" if user else "no"))
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    os.chmod(OUT_PATH, 0o600)
    print("wrote %s (0600)" % OUT_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
