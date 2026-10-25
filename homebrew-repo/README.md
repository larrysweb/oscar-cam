# Oscar Cam — Homebrew Channel publish kit

Everything needed to publish Oscar Cam 0.1.0 through the Homebrew
Channel's custom-repository route. The package itself lives in
`../phase1/`; the app source lives in `../app/`.

## What is ready in `site/` (copy this into the repo's `docs/` folder)

- `manifest.json` — repository listing, keyed by app id. This is the
  file the Homebrew Channel fetches from the repository root.
- `com.larrysweb.oscarcam.manifest.json` — per-app manifest (same fields
  the official webosbrew catalog uses: id, version, type, title,
  appDescription, iconUri, sourceUrl, rootRequired, ipkUrl,
  ipkHash.sha256, ipkSize, requirements.webosRelease).
- `com.larrysweb.oscarcam_0.1.0_all.ipk` — the installable package
  (sha256 e38c3eb9141b9ca1e906faf6cfb2ce470f5bb142d3a3a6100086fe97f89abaf8,
  206524 bytes).
- `icon.png` — the app icon.

## Publish steps (proposed repo: `larrysweb/oscar-cam`)

1. Create the repo `oscar-cam` on GitHub (public).
2. Copy `site/` contents into the repo's `docs/` folder, plus the app
   source (`../app/`) at the repo root if the source should live there too.
3. Enable GitHub Pages: repo Settings → Pages → Deploy from a branch →
   branch `main`, folder `/docs`.
4. Wait for Pages to go live, then the repository URL is
   `https://larrysweb.github.io/oscar-cam/`.

## Install on the TV

1. Open Homebrew Channel → Settings → Add repository.
2. Enter `https://larrysweb.github.io/oscar-cam/`.
3. Back in the app browser, find Oscar Cam → Install.
4. First run: Settings → go2rtc server URL
   (`http://192.168.0.58:1984` on Larry's LAN), then Cameras → add
   cameras, then Edit layout → 3×3 preset.

## Notes and honest caveats

- The per-app manifest format is proven (it mirrors the official
  webosbrew catalog entries exactly). The root `manifest.json` shape —
  an object keyed by app id — is the best-supported reading of the
  channel's "applications are merged by their package ID" behavior, but
  the channel's docs don't spell out that file's exact schema. If Oscar
  Cam doesn't appear after adding the repo, that one file is the first
  suspect, and fixing it is a manifest-only change (no rebuild).
- `rootRequired` is false: the app itself needs no root. Installing
  through Homebrew Channel still assumes the usual rooted-TV setup.
- `requirements.webosRelease` is `>=5.0` (the working floor; the app uses
  ES modules, which need Chromium 61+).
- GitHub Pages sends `Access-Control-Allow-Origin: *`, which the channel
  requires for cross-origin manifest/IPK fetches.
- License is undecided (MIT proposed). Add a LICENSE file before
  calling this a public release.

## Releasing a new version

1. Bump the version in `../app/appinfo.json`, rebuild the `.ipk`.
2. Run:
   `python3 gen-manifest.py ../phase1/<new-ipk> https://larrysweb.github.io/oscar-cam/ https://github.com/larrysweb/oscar-cam site/`
3. Copy the new IPK + regenerated manifests into `docs/`, commit.
