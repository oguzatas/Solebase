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
│  SYNC (Solebase E2EE changesets)                            │
│  WebRTC P2P + S3/Drive encrypted blobs. Separate from host. │
│  Same sync.provider options + encryptionKey on each device. │
│  Legacy examples may still use snapshot adapters (IndexedDB)│
└─────────────────────────────────────────────────────────────┘
```

**QR / Share** opens the same origin on another device and can carry WebRTC SDP for P2P. Hosting never syncs data by itself — see [`sync-transport.md`](sync-transport.md).

Browsers **cannot** remotely push-install a PWA onto a phone. Closest flow: deploy once → open the HTTPS URL (or scan Share QR) → *Add to Home Screen* / *Install app* on that device.

## Free vs paid (honest)

| Option | Free tier? | Good for | Notes |
|--------|------------|----------|--------|
| **[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)** | Yes (public repos) | Permanent HTTPS URL for this repo | Yes — works as well as Cloudflare/Netlify for static PWAs. This repo can auto-deploy via Actions (see below). |
| **[Cloudflare Pages](https://developers.cloudflare.com/pages/get-started/git-integration/)** | Yes (generous) | Same | Connect repo; no build command. |
| **[Netlify](https://docs.netlify.com/get-started/)** | Yes (hobby) | Drag-drop or git | Free tier has bandwidth/build limits; fine for personal apps. |
| **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)** (`cloudflared tunnel --url …`) | Yes (quick tunnels) | Dev share laptop → phone | Temporary public HTTPS URL; no account required for trycloudflare. |
| **[ngrok](https://ngrok.com/docs/getting-started/)** | Yes (limited) | Same as tunnel | Free: random URL, session limits; reserved domains / always-on usually paid. |

You do **not** need a paid plan to ship or try Share/QR. Prefer **GitHub Pages** (or Cloudflare/Netlify) for something you keep; use a **tunnel** only while developing.

## Why same-WiFi “broadcast install” is not easier

It sounds simpler to stay on the LAN (`http://192.168.x.x:8080`) and “send” the app to phones. In practice:

1. There is **no** Wi‑Fi broadcast / AirDrop-style **PWA install**. Someone still opens a URL once.
2. Modern browsers treat only **HTTPS** and **localhost** as [secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). A plain `http://192.168…` page usually **cannot** register a service worker or become an installable PWA, and E2EE (Web Crypto in this app) expects a secure context.
3. So LAN HTTP is fine for a quick look at HTML; it is a poor path for “install + offline + E2EE”. HTTPS host or TLS tunnel is the short path that actually works.

## Deploy static (pick one)

Any static host works (no Node server required). Serve over **HTTPS**.

### GitHub Pages (recommended free default)

Yes — GitHub Pages works for Prompt2UI (static files + HTTPS).

1. In the repo: **Settings → Pages → Build and deployment → GitHub Actions**.
2. Push to `main` (this repo includes [`.github/workflows/pages.yml`](../.github/workflows/pages.yml)).
3. Site URL is typically `https://<user>.github.io/prompt2ui/` (blank starter). Notes: `…/prompt2ui/examples/notes/`.
4. On each device: open that URL → optional *Add to Home Screen* → Settings → Share QR for the next phone.

That is “automatic create on Pages”: **deploy** is automatic; **install** still needs one open per device (browser rule, not something we can bypass).

### Cloudflare Pages

1. [Create a Pages project](https://developers.cloudflare.com/pages/get-started/git-integration/) from the repo (or upload a folder).
2. Build command: empty. Output: `/` (or an example folder if that folder is the project root).
3. Publish → `https://….pages.dev`.

### Netlify

1. [Start with Netlify](https://docs.netlify.com/get-started/) — drag-and-drop or connect the repo.
2. Publish directory = site root (blank starter or one example).
3. No build command.

## PWA install

After the site is on HTTPS:

| Platform | How |
|----------|-----|
| **Desktop (Chrome / Edge)** | Address bar install icon, or menu → *Install app* |
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
2. Expose HTTPS (free quick options):
   - **Cloudflare Tunnel**: install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then `cloudflared tunnel --url http://localhost:8080`
   - **ngrok**: [getting started](https://ngrok.com/docs/getting-started/), then `ngrok http 8080`
3. Open the printed `https://…` URL on the laptop.
4. Settings → **Share** → scan the QR (localhost tip hides once you are on the tunnel host).

Do not expect a phone to reach `http://localhost:…` on your PC. Prefer GitHub Pages when you want a stable URL instead of a tunnel.

## Related

- Product overview: [README.md](../README.md)
- Notes example: [examples/notes/README.md](../examples/notes/README.md)
