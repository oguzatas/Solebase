# Prompt2UI

**Cloneable · Zero-build · Local-first · E2EE** starter for personal hobby apps.

One folder = one personal app. The **root** is a blank canvas. **examples/** are use-ready apps you can copy or serve alone.

No npm bundler. Pure ES modules, Tailwind CDN, IndexedDB, Web Crypto, installable PWA.

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

## Smoke

```bash
node --check app.js
node --check app/blank.js
node --check examples/calorie-tracker/app/calorie-tracker.js
node --check examples/notes/app/notes.js
node scripts/smoke-local.mjs
```

## License

Open source — use and fork freely for personal apps.
