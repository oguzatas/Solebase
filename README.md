# Solebase

> **Rename note:** Product and GitHub repo are **Solebase** (`oguzatas/Solebase`). A local disk folder may still be named `prompt2ui`.

**Cloneable · Zero-build · Local-first · E2EE** starter for personal hobby apps.

One folder = one personal app. The **root** is a Solebase how-to / library welcome page. **examples/** are use-ready apps you can copy or serve alone.

**Live (GitHub Pages):** [https://oguzatas.github.io/Solebase/](https://oguzatas.github.io/Solebase/) — welcome + examples without cloning. If that 404s, enable once: **[Settings → Pages](https://github.com/oguzatas/Solebase/settings/pages)** → Build and deployment → Source: **GitHub Actions**, then push to `main` (workflow: [`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

No npm bundler for apps. Pure ES modules, Tailwind CDN, Web Crypto, installable PWA. The Layer 1 library is TypeScript under `packages/solebase/` (compile with `npx tsc`; browsers import `packages/solebase/dist/`).

**Layer 1 (Developer API):** `Solebase.init` / `collection()` — see [`docs/solebase-layer1.md`](docs/solebase-layer1.md) (`examples/smoke-solebase/`).

**Layer 3 (storage):** OPFS-backed **cr-sqlite** in a Web Worker — see [`docs/layer3-storage.md`](docs/layer3-storage.md) (`examples/smoke-db/`), Yjs persistence in [`docs/yjs-provider.md`](docs/yjs-provider.md) (`examples/smoke-yjs/`), and changeset extract + E2EE in [`docs/sync-changesets.md`](docs/sync-changesets.md) (`examples/smoke-sync-changesets/`). Example apps still use legacy IndexedDB until migration.

## Host vs sync vs offline (product truth)

| Concept | What it is | What it is not |
|---------|------------|----------------|
| **Host** | A static file server (HTML/JS/CSS) — Cloudflare Pages, Netlify, any static origin | A shared database. Opening the same URL on two phones does **not** auto-sync notes. |
| **Offline** | After first visit: service worker + **per-device IndexedDB**. Losing internet ≠ losing the app once installed/cached | Cross-device memory. Each browser profile has its own DB. |
| **Sync** | Optional encrypted snapshot to Drive / WebDAV / S3 with a passphrase | Part of hosting. Configure it separately in Settings. |
| **QR / Share** | Opens the **same origin** on another device | A native binary install. After open: configure sync **or** stay local-only on that device. |

Ship guide (GitHub Pages, free tiers, tunnels, why LAN install fails): **[docs/SHIP.md](docs/SHIP.md)**. Settings → **Share** shows the current URL, Copy, and a QR code. Push to `main` auto-publishes via GitHub Actions once Pages source is **GitHub Actions** (see live URL above).

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
cd Solebase   # or local folder still named prompt2ui
python -m http.server 8080
```

Open http://localhost:8080 — Solebase how-to welcome (what it is, `Solebase.init`, `collection`, sync overview, links to docs/smoke).

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
Solebase/                       # how-to welcome (local folder may still be prompt2ui)
  packages/solebase/            # Layer 1 TypeScript API → dist/ ESM
  core/                         # Layer 3 engines (worker, crypto, sync)
  app/blank.js                  # optional personal-app canvas stub
  index.html, app.js, sw.js …   # static docs landing at /
examples/
  smoke-solebase/               # Layer 1 smoke
  calorie-tracker/              # self-contained (own core/) — legacy IDB
  notes/                        # self-contained (own core/) — legacy IDB
```

AI (or you) edits `app/` for a personal app. New apps should use **Solebase** Layer 1; persistence stays in the worker.

## Design (quiet utility)

Dark charcoal base, soft sage accent, Bricolage Grotesque + Figtree. Dense calm chrome. Settings / Sync stay in the drawer — never invent sync UI in `app/`.

## App API (never call adapters)

**Preferred (Solebase Layer 1 — OPFS / cr-sqlite):**

```js
import { Solebase } from '../packages/solebase/dist/index.js';

const db = await Solebase.init({
  appId: 'meals',
  encryptionKey: '…',
  workerUrl: new URL('../core/db-worker.js', import.meta.url),
});
await db.collection('meals').insert({ name, calories });
db.collection('meals').subscribe((rows) => render(rows));
await db.collection('meals').delete(id);
```

**Legacy examples** still use IndexedDB via `core/db-api.js` (`add` / `remove` + soft tombstones) until migration.

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

Layer 1 Solebase API: [`examples/smoke-solebase/`](examples/smoke-solebase/) or `node scripts/smoke-solebase.mjs` — details [`docs/solebase-layer1.md`](docs/solebase-layer1.md).

Layer 3 OPFS/cr-sqlite: [`examples/smoke-db/`](examples/smoke-db/) or `node scripts/smoke-db-worker.mjs` — [`docs/layer3-storage.md`](docs/layer3-storage.md).

## License

Open source — use and fork freely for personal apps.
