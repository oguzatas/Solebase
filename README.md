# Prompt2UI

**Cloneable · Zero-build · Local-first · E2EE** starter for personal hobby apps.

One folder = one personal app. The **root** is a blank canvas. **examples/** are use-ready apps you can copy or serve alone.

No npm bundler. Pure ES modules, Tailwind CDN, Web Crypto, installable PWA.

**Layer 3 (storage, in progress):** OPFS-backed **cr-sqlite** in a Web Worker — see [`docs/layer3-storage.md`](docs/layer3-storage.md) and the smoke page at `examples/smoke-db/`. Example apps still use legacy IndexedDB until migration.

## Host vs sync vs offline (product truth)

| Concept | What it is | What it is not |
|---------|------------|----------------|
| **Host** | A static file server (HTML/JS/CSS) — Cloudflare Pages, Netlify, any static origin | A shared database. Opening the same URL on two phones does **not** auto-sync notes. |
| **Offline** | After first visit: service worker + **per-device IndexedDB**. Losing internet ≠ losing the app once installed/cached | Cross-device memory. Each browser profile has its own DB. |
| **Sync** | Optional encrypted snapshot to Drive / WebDAV / S3 with a passphrase | Part of hosting. Configure it separately in Settings. |
| **QR / Share** | Opens the **same origin** on another device | A native binary install. After open: configure sync **or** stay local-only on that device. |

Ship guide (GitHub Pages, free tiers, tunnels, why LAN install fails): **[docs/SHIP.md](docs/SHIP.md)**. Settings → **Share** shows the current URL, Copy, and a QR code. Push to `main` can auto-publish via GitHub Actions Pages (enable under repo Settings → Pages).

## Clone starter vs copy example

| Goal | What to use |
|------|-------------|
| New personal app from scratch | Clone / copy the **repo root** (blank starter) |
| Start from a working UI | Copy `examples/calorie-tracker` or `examples/notes` into its own deploy folder |

Each example embeds its own `core/` copy so it runs with `python -m http.server` inside that folder (Windows-friendly — no symlinks required). Refresh engines from the root with:

```powershell
.\scripts\copy-core.ps1 -Target examples\calorie-tracker
.\scripts\copy-core.ps1 -Target examples\notes
```

## Quick start

### Blank starter (root)

```bash
cd prompt2ui
python -m http.server 8080
```

Open http://localhost:8080 — empty canvas + Settings gear. Hint: `edit app/`.

### Calorie Tracker example

```bash
cd examples/calorie-tracker
python -m http.server 8081
```

### Notes example

```bash
cd examples/notes
python -m http.server 8082
```

Use `localhost`, not `file://`.

## One-app-per-folder model

```
prompt2ui/                      # BLANK STARTER — clone this for a new app
  core/                         # engines (do not reinvent in UI)
  app/blank.js                  # replace with your app
  index.html, app.js, sw.js …
examples/
  calorie-tracker/              # self-contained (own core/)
  notes/                        # self-contained (own core/)
```

AI (or you) edits `app/` only. Persistence, encryption, and cloud sync live in `core/` and stay invisible to UI code.

## Design (quiet utility)

Dark charcoal base, soft sage accent, Bricolage Grotesque + Figtree. Dense calm chrome. Settings / Sync stay in the drawer — never invent sync UI in `app/`.

## App API (never call adapters)

```js
import { db } from '../core/db-api.js';

await db.collection('meals').add({ name, calories });
db.collection('meals').subscribe((rows) => render(rows));
await db.collection('meals').remove(id);
```

Records get `id` + `updatedAt` automatically. Deletes are soft (tombstones) so sync can merge across devices.

## Sync pipeline

| Piece | Behavior |
|-------|----------|
| Local truth | IndexedDB via PromptDB |
| Cloud object | One encrypted JSON snapshot |
| Merge | Per-record **last-write-wins** on `updatedAt` |
| Deletes | Tombstones |
| Triggers | Debounced after local writes, `online`, `visibilitychange` |
| Idle when | Adapter = Local only, **or** no session passphrase |

Saving a remote adapter + passphrase in Settings **enables sync automatically**.

### Adapters

| Adapter | Recommendation |
|--------|----------------|
| **Local only** | Default / offline |
| **WebDAV** | Recommended (Nextcloud / NAS) |
| **S3-compatible** | Recommended (R2 / MinIO / AWS) |
| **Google Drive** | Optional (highest friction) |

Second device: same origin/files → same adapter config → same passphrase → Save.

## Honest limits

- Not multiplayer CRDT — LWW for personal apps.  
- Passphrase loss = encrypted cloud data unrecoverable.  
- Snapshot sync suits KB–low-MB hobby data.  
- Personal / hobby — no auth server or App Store wrapper.  
- Static host ≠ sync; localhost QR is not phone-reachable — deploy HTTPS or use a TLS tunnel first.

## Smoke

```bash
node --check app.js
node --check app/blank.js
node --check examples/calorie-tracker/app/calorie-tracker.js
node --check examples/notes/app/notes.js
node --check core/db-client.js
node --check core/db-worker.js
node --check core/db-protocol.js
node scripts/smoke-local.mjs
```

Layer 3 OPFS/cr-sqlite (browser, secure context): serve the repo → open [`examples/smoke-db/`](examples/smoke-db/) → **Run smoke**, or `node scripts/smoke-db-worker.mjs` against a localhost static server. Details: [`docs/layer3-storage.md`](docs/layer3-storage.md).

## License

Open source — use and fork freely for personal apps.
