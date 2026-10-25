#!/usr/bin/env python3
"""Generate Homebrew Channel manifests for Oscar Cam.

Usage:
    python3 gen-manifest.py <ipk-path> <base-url> <source-url> <site-dir>

- <base-url> is the repository root the TV will add, e.g.
  https://larrysweb.github.io/oscar-cam/
- <source-url> is the GitHub project URL, e.g.
  https://github.com/larrysweb/oscar-cam
- Writes into <site-dir>:
    manifest.json                          (repository listing, keyed by app id)
    com.larrysweb.oscarcam.manifest.json   (per-app manifest)
  Copy the site dir's contents into the repo's docs/ folder and enable
  GitHub Pages (main branch, /docs) to publish.

Manifest fields follow the official webosbrew catalog exactly (see
https://repo.webosbrew.org/api/apps.json): id, version, type, title,
appDescription, iconUri, sourceUrl, rootRequired, ipkUrl,
ipkHash.sha256, ipkSize, requirements.webosRelease.
"""
import hashlib
import json
import os
import sys


def main():
    ipk_path, base_url, source_url, site_dir = sys.argv[1:5]
    base_url = base_url.rstrip("/") + "/"
    appinfo = json.load(open(os.path.join(os.path.dirname(ipk_path), "..", "app", "appinfo.json"))) \
        if os.path.exists(os.path.join(os.path.dirname(ipk_path), "..", "app", "appinfo.json")) \
        else {"id": "com.larrysweb.oscarcam", "version": "0.1.0", "title": "Oscar Cam"}
    with open(ipk_path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    size = os.path.getsize(ipk_path)
    ipk_name = os.path.basename(ipk_path)
    manifest = {
        "id": appinfo["id"],
        "version": appinfo["version"],
        "type": "web",
        "title": appinfo["title"],
        "appDescription": "Free, LAN-only camera grid for rooted LG webOS TVs. "
        "Arrange IP cameras in an adjustable grid; plays go2rtc, WebRTC, "
        "MJPEG and HLS streams. No account, no cloud, no telemetry.",
        "iconUri": base_url + "icon.png",
        "sourceUrl": source_url,
        "rootRequired": False,
        "ipkUrl": base_url + ipk_name,
        "ipkHash": {"sha256": digest},
        "ipkSize": size,
        "requirements": {"webosRelease": ">=5.0"},
    }
    os.makedirs(site_dir, exist_ok=True)
    per_app = dict(manifest)
    per_app["manifestUrl"] = base_url + appinfo["id"] + ".manifest.json"
    with open(os.path.join(site_dir, appinfo["id"] + ".manifest.json"), "w") as f:
        json.dump(per_app, f, indent=2)
        f.write("\n")
    root = {appinfo["id"]: per_app}
    with open(os.path.join(site_dir, "manifest.json"), "w") as f:
        json.dump(root, f, indent=2)
        f.write("\n")
    print("wrote manifests for", appinfo["id"], appinfo["version"])
    print("sha256:", digest)
    print("size:", size)


if __name__ == "__main__":
    main()
