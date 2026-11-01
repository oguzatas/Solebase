# Prompt2UI

**Cloneable · Zero-build · Local-first · E2EE** boilerplate for personal hobby apps.

One clone = one personal app. AI (or you) edits `app/` only. Persistence, encryption, and cloud sync live in `core/` and stay invisible to UI code.

No npm bundler. No TinyBase / RxDB. Pure ES modules, Tailwind CDN, IndexedDB, Web Crypto, installable PWA.

## Quick start

```bash
cd prompt2ui
python -m http.server 8080
# or: npx --yes serve -l 8080
```

Open **http://localhost:8080** (use `localhost`, not `file://`).

First load shows the **opening page** (Prompt2UI brand + Open app / Settings). **Open app** enters the sample under `app/`.

### Workflow

1. **Clone** this folder  
2. **Replace `app/`** with your screens (start from the Calorie Tracker sample)  
3. **Configure cloud** in Settings (optional) — WebDAV or S3 recommended  
4. Serve / host as static files; install as PWA on your devices  

## Design (quiet utility)

Visual direction is **quiet utility**: dark charcoal base, soft sage accent, Bricolage Grotesque + Figtree, dense calm chrome.

| Surface | Owns |
|---------|------|
| Opening page | Brand-first first viewport — `index.html` |
| App view | Personal utility UI after Open — `app/` |
| Settings / Sync | Drawer only — `core/settings-panel.js` |

Tokens and spacing live as CSS variables on `:root` in `index.html`. When AI replaces `app/`, follow **PROMPT.md** (quiet-utility tokens; never invent sync/backend UI). Do not restyle the opening page unless you intend a shell redesign.

## Architecture

```
index.html              Thin shell + Settings drawer
app.js                  Mounts app/ + wires Settings
app/                    ← YOU EDIT THIS (sample: calorie-tracker.js)
core/
  db-api.js             Collections facade (what app code imports)
  prompt-db.js          IndexedDB + localStorage reactive store
  prompt-crypto.js      AES-GCM + PBKDF2
  prompt-storage.js     Local / Google Drive / WebDAV / S3 adapters
  sync-engine.js        Debounced LWW snapshot sync
  settings-panel.js     Backend + passphrase + export/import UI
sw.js + manifest.json   Offline + installability
```

### App API (never call adapters)

```js
import { db } from '../core/db-api.js';

await db.collection('meals').add({ name, calories });
db.collection('meals').subscribe((rows) => render(rows));
await db.collection('meals').remove(id);
```

Records get `id` + `updatedAt` automatically. Deletes are soft (tombstones) so sync can merge across devices.

### Sync model

| Piece | Behavior |
|-------|----------|
| Local truth | IndexedDB via PromptDB |
| Cloud object | One encrypted JSON snapshot (+ `updatedAt`, `deviceId`, `schemaVersion`) |
| Merge | Per-record **last-write-wins** on `updatedAt` |
| Deletes | Tombstones |
| Triggers | Debounced after local writes, `online`, `visibilitychange` |
| Idle when | Adapter = Local only, **or** no session passphrase |

Saving a remote adapter + passphrase in Settings **enables sync automatically**.

## Storage adapters

| Adapter | Recommendation | Credentials |
|--------|----------------|-------------|
| **Local only** | Default / offline | None |
| **WebDAV** | **Recommended** (Nextcloud / NAS) | Folder URL, user, password |
| **S3-compatible** | **Recommended** (R2 / MinIO / AWS) | Endpoint, bucket, keys; CORS |
| **Google Drive** | Optional | OAuth Client ID per origin (PKCE → `appDataFolder`) |

### Second device setup

On each device you own:

1. Open the same hosted origin (or serve the same files).  
2. Settings → same **adapter** config (WebDAV URL / S3 bucket / Drive Client ID).  
3. Enter the **same passphrase**.  
4. Connect (Drive) if needed → Save. Sync pulls, LWW-merges, then pushes.  
5. Data appears after the first successful sync.

**WebDAV:** folder URL like  
`https://cloud.example.com/remote.php/dav/files/USERNAME/Prompt2UI/`  
Use an app password when available. Ensure the folder exists and CORS/proxy allows browser PUT/GET if you host the app elsewhere.

**S3 / R2 / MinIO:** path-style `{endpoint}/{bucket}/{objectKey}`. Bucket CORS must allow `GET`, `PUT`, `HEAD` from your app origin. Region is often `auto` for R2.

**Google Drive:** each origin usually needs its own OAuth Web client (authorized JavaScript origin). Enable Drive API; scope `drive.appdata`. This is the highest-friction path — prefer WebDAV/S3 for multi-device.

## Honest limits

- **Not multiplayer CRDT** — concurrent edits to the same record: one side wins (LWW). Fine for personal notebooks/trackers.  
- **OAuth / CORS** — Drive needs a Client ID per origin; S3/WebDAV need CORS. This is the main real-world friction, not crypto.  
- **Passphrase loss** — forgot passphrase = encrypted cloud data unrecoverable (by design).  
- **Snapshot size** — whole-vault sync suits KB–low-MB hobby data; photos/huge histories are out of scope.  
- **IndexedDB, not TinyBase** — thin collections API; zero-build by design.  
- **Personal / hobby** — no auth server, sharing roles, or App Store wrapper. PWA install is enough for most cases.

## Sample app

`app/calorie-tracker.js` — Calorie & Macro Tracker using `db.collection('meals')`.

## Security notes

- Encryption is client-side (AES-GCM). Cloud adapters never see plaintext when a passphrase is set.  
- Passphrase stays in memory for the session only.  
- Cloud credentials live in `localStorage` (`prompt2ui:settings`) — treat the device as trusted.

## File tree

```
prompt2ui/
├── index.html
├── app.js
├── app/
│   └── calorie-tracker.js
├── core/
│   ├── db-api.js
│   ├── prompt-db.js
│   ├── prompt-crypto.js
│   ├── prompt-storage.js
│   ├── sync-engine.js
│   └── settings-panel.js
├── sw.js
├── manifest.json
├── README.md
├── PROMPT.md
└── icons/
```

## License

Open source — use and fork freely for personal apps.
