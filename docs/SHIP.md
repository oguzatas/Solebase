# Ship Prompt2UI

How to host, install, go offline, and share — without confusing **host** with **sync**.

## Host ≠ sync ≠ offline

```
┌─────────────────────────────────────────────────────────────┐
│  HOST (static file server)                                  │
│  Serves HTML / JS / CSS only. Not a database.               │
│  Same URL on two phones ≠ shared notes.                     │
└───────────────────────────┬─────────────────────────────────┘
                            │ first visit loads app
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  OFFLINE (per device)                                       │
│  Service worker caches the shell. IndexedDB holds your data.│
│  After first visit, losing internet ≠ losing the app.       │
└───────────────────────────┬─────────────────────────────────┘
                            │ optional (Settings)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  SYNC (encrypted snapshot)                                  │
│  Drive / WebDAV / S3 + passphrase. Separate from hosting.   │
│  Same adapter + same passphrase on each device to merge.    │
└─────────────────────────────────────────────────────────────┘
```

**QR / Share** only opens the same origin on another device. Then that device either stays local-only or you configure Sync in Settings.

## Deploy static

Any static host works (no Node server required).

### Cloudflare Pages

1. Connect the repo (or upload the folder you want to ship: repo root, or `examples/notes`, etc.).
2. Build command: leave empty / none. Output directory: `/` (or the example folder if that is the project root).
3. Publish. You get an `https://…pages.dev` URL.

### Netlify

1. Drag-and-drop the folder, or connect the repo.
2. Publish directory = site root (blank starter or one example).
3. No build command.

Serve over **HTTPS**. Localhost URLs are not useful on a phone for real E2EE workflows — deploy or tunnel first (see below).

## PWA install

After the site is on HTTPS:

| Platform | How |
|----------|-----|
| **Desktop (Chrome / Edge)** | Address bar install icon, or menu → *Install app* / *Install Prompt2UI* |
| **Android (Chrome)** | Menu → *Install app* / *Add to Home screen* |
| **iOS (Safari)** | Share → *Add to Home Screen* |

This installs the **web app** (manifest + service worker) — not a native App Store binary. Settings → **Share** says the same.

## Offline behavior

1. First online visit: browser downloads assets; service worker caches them; IndexedDB stores your records.
2. Later, offline: the shell loads from cache; reads/writes stay in IndexedDB on **that** device.
3. Cloud sync pauses while offline; resumes when online if a remote adapter + passphrase are configured.

Clearing site data / uninstalling the PWA can wipe the local DB. Export a vault from Settings if you need a backup file.

## Sync vs host (checklist)

| Goal | Do this |
|------|---------|
| Just use the app on one phone | Open the HTTPS URL once; optionally Add to Home Screen |
| Same app URL on a second device | Settings → Share → Copy or scan QR |
| Same **notes/data** on both devices | On each device: same adapter + same passphrase → Save (or Pull & merge) |
| No cloud | Leave adapter on **Local only** |

Opening the same URL never auto-syncs. Hosting is dumb files; sync is optional E2EE snapshots.

## Dev share (tunnel + QR)

To try Share / QR from a laptop to a phone **before** a real deploy:

1. Serve locally: `python -m http.server 8080` (or 8082 for notes).
2. Expose HTTPS:
   - **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8080`
   - **ngrok**: `ngrok http 8080`
3. Open the printed `https://…` URL on the laptop.
4. Settings → **Share** → scan the QR (localhost tip hides once you are on the tunnel host).

Do not expect a phone to reach `http://localhost:…` on your PC.

## Related

- Product overview: [README.md](../README.md)
- Notes example: [examples/notes/README.md](../examples/notes/README.md)
