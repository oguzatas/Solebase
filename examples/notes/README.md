# Solebase Notes (example)

Obsidian-like Markdown vault on **Solebase Layer 1** (`Solebase.init` + `collection()`). Local-first PKM with optional E2EE snapshot sync. Zero npm build; ES modules + CDN (`marked`, CodeMirror 6).

## Run

From the repo root (so Solebase package + `core/db-worker.js` resolve):

```bash
python -m http.server 8080 --bind 127.0.0.1
```

Open http://127.0.0.1:8080/examples/notes/

Needs a secure context + OPFS (Chromium / modern Safari / Firefox). Network once for CDN imports (CodeMirror, marked). Hard-refresh (`Ctrl/Cmd+Shift+R`) if an old service worker caches a stale shell.

## Architecture

| Concern | Choice |
|---------|--------|
| Layer 1 | `Solebase.init({ appId: 'notes' })` → `collection('notes' \| 'folders')` |
| Storage | OPFS + cr-sqlite in a Web Worker (`core/db-worker.js`) |
| Editor | CodeMirror 6 Markdown (Yjs rich-text API not exposed in Layer 1 yet) |
| Sync | Layer 1 S3/R2 via Settings (`Solebase.init` sync) — zero-LIST `manifest.json` + ETag (no ListObjects) |

App code never opens IndexedDB as the notes database.

## Host vs sync vs offline

Serving the example is a **static file host** only. Same URL on two phones does **not** share notes. Each device keeps its own OPFS vault; offline works after the first visit (service worker + Solebase). **Sync** is optional E2EE to Drive/WebDAV/S3 — separate from hosting. Settings → **Share** copies/QR the origin (not a native install). See [docs/SHIP.md](../../docs/SHIP.md).

## Share credentials desktop → phone (QR bootstrap)

After R2 keys + encryption key are saved on the desktop:

1. Open https://solebase.pages.dev/examples/notes/ → **Settings** → **Share to another device** → **Generate bootstrap QR**
2. Scan the QR with the phone camera (or **Copy link** / **Share link**). No in-app scanner required — the URL carries `?bootstrap=…`.
3. **Safari** applies credentials into its localStorage and shows **Add to Home Screen** guidance plus a reclaim link.
4. Safari → Share → **Add to Home Screen** (manifest `start_url` is `./` under `/examples/notes/`).
5. Open the Solebase Home Screen icon. iOS gives the standalone app **empty** storage — paste/open the **same** bootstrap link (banner + Settings → Import), or scan the QR again within ~20 min.
6. After standalone import, Solebase sync is ready in the Home Screen app.

**Why the second open?** iOS partitions Safari tab storage from standalone PWA storage. Credentials from the QR do not carry into Add to Home Screen automatically.

**URL shapes**

| Mode | Example | When |
|------|---------|------|
| Short R2 | `…/examples/notes/?bootstrap=r.<id>.<key>` | Encrypted JSON on public bucket `solebase-bootstrap` (TTL ~20 min; kept until reclaim / expiry so A2HS can reuse) |
| Compact | `…/examples/notes/?bootstrap=c.<base64url>` | Fallback when short upload is unavailable — payload fits in the QR |

**Security**

- Bootstrap links contain (or unlock) R2 secrets + the vault encryption key — treat like a password until expiry.
- Public R2 holds **ciphertext only**; the AES key is only in the QR/URL.
- Prefer generating on HTTPS (`solebase.pages.dev`), not localhost.
- Never commit Access Key / Secret / encryption keys to git.
- For short links, grant the R2 API token **Object Read & Write** on bucket `solebase-bootstrap` (same account) in addition to `solebase-sync-test`.

## Sync across devices (Cloudflare R2)

There is no Solebase server for your notes. Data stays in OPFS on each browser; optional **Layer 1 E2EE changeset sync** uses an R2 bucket you control.

### One dashboard step (API token)

MCP OAuth cannot create R2 S3 API tokens (needs **API Tokens Write**). Create one once:

1. Cloudflare dashboard → **R2** → Overview → **Manage API Tokens**
2. Create token → permissions **Object Read & Write**
3. Apply to bucket **`solebase-sync-test`**
4. Copy **Access Key ID** + **Secret Access Key**

CORS on `solebase-sync-test` already allows `http://127.0.0.1:8080`, `http://localhost:8080`, `https://oguzatas.github.io`, and `https://solebase.pages.dev` (phone / HTTPS testing).

### Paste into Notes Settings

1. Open https://solebase.pages.dev/examples/notes/ (or http://127.0.0.1:8080/examples/notes/) → **Settings** (gear)
2. Prefills: endpoint `https://7701962a7c1ef34d73878ef8650ef733.r2.cloudflarestorage.com`, bucket `solebase-sync-test`, region `auto`
3. Paste Access Key ID + Secret (browser localStorage only — never commit)
4. Reuse the same **encryption key** + `appId: 'notes'` on every device
5. Leave **Remember credentials on this device** checked → **Save settings** once. Refresh keeps sync without re-entry (secret fields show `******** (saved on this device)`; blank = keep saved).
6. Storage keys: `solebase:notes:settings` (R2 fields + encryptionKey mirror), `solebase:notes:deviceKey` (encryptionKey). Both must match; QR/Save write both. Legacy `prompt2ui:*` keys are migrated once then removed.

**Save settings** → wires `Solebase.init({ sync: { provider: 's3', options } })` from localStorage → **Sync Now**

```js
// Shape actually passed (secrets omitted):
Solebase.init({
  appId: 'notes',
  encryptionKey: '…', // same on every device; shown in Settings
  workerUrl: new URL('../../../core/db-worker.js', import.meta.url),
  sync: {
    provider: 's3',
    options: {
      endpoint: 'https://7701962a7c1ef34d73878ef8650ef733.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'solebase-sync-test',
      accessKeyId: '…',     // from dashboard token
      secretAccessKey: '…', // from dashboard token
      prefix: 'solebase-changesets',
      autoSync: true,
      allowMemoryFallback: false,
    },
  },
});
await db.syncNow();
```

Legacy Drive / WebDAV / single-object S3 snapshot adapters remain under **Legacy snapshot adapters** in Settings. Manual **Export vault** / **Import vault** works offline.

## Features

| Area | What you get |
|------|----------------|
| Layout | Left vault tree (push sidebar), main editor, context drawer (outline / backlinks) |
| Editor | CodeMirror 6 Markdown; Edit / Split / Preview |
| Markdown | GFM: headings, lists, fences, tables, blockquotes, tasks, images by URL |
| Wiki-links | `[[Note Title]]` — open or create |
| Search | Text, `#tag`, `path:folder` · quick switcher `Ctrl/Cmd+P` |
| Vault | Nested folders (`parentFolderId`), pin, right-click rename/move/delete/new subfolder |
| Daily | Calendar → `YYYY-MM-DD` under `daily/` |
| Shortcuts | `Ctrl/Cmd+S` save, `+N` new, `+P` switcher, `+O` vault, `Esc` closes |

## Note / folder shape

```js
// notes collection
{ title, body, folderId: string|null, folder: string /* denormalized path */, tags: string[], pinned?: boolean, updatedAt?: number }

// folders collection — tree via parentFolderId (null = vault root)
{ name: string, parentFolderId: string|null, updatedAt?: number }
```

Legacy `folders.path` / notes with only `folder` path strings migrate to `parentFolderId` / `folderId` on load. E2EE sync stays document-opaque (extra fields are fine).

## Out of scope

Plugins marketplace, full canvas, Electron, graph view. Yjs collaborative docs when Layer 1 exposes document APIs.
