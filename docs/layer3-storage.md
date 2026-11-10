# Layer 3 — Storage (OPFS + cr-sqlite)

Local relational storage for Prompt2UI. This layer is **new**; the notes/calorie examples still use the legacy IndexedDB `PromptDB` path until a later migration.

## Rules

- **cr-sqlite** WASM via [`@vlcn.io/crsqlite-wasm`](https://www.npmjs.com/package/@vlcn.io/crsqlite-wasm)
- Persisted in **OPFS** with wa-sqlite **AccessHandlePoolVFS** (not the package’s default IndexedDB VFS)
- All SQLite I/O runs in a **Web Worker** — never on the main thread
- No IndexedDB / localStorage / Postgres / Firebase / Supabase for this layer

## Files

| File | Role |
|------|------|
| [`core/db-protocol.js`](../core/db-protocol.js) | Shared request/response types + pinned CDN URLs |
| [`core/db-worker.js`](../core/db-worker.js) | Module worker: init OPFS db, `exec`/`run`/`select` |
| [`core/db-client.js`](../core/db-client.js) | Main-thread Promise RPC over `postMessage` |
| [`core/yjs-sqlite-provider.js`](../core/yjs-sqlite-provider.js) | Yjs doc persistence in `yjs_documents` (see [`yjs-provider.md`](yjs-provider.md)) |

## CDN / zero-build

No npm install required. The worker loads:

- WASM: `cdn.jsdelivr.net/npm/@vlcn.io/crsqlite-wasm@0.16.0/dist/crsqlite.wasm`
- Factory + wa-sqlite + AccessHandlePoolVFS via **esm.sh** (see `CRS_WASM_CDN` in `db-protocol.js`)

Stock `initWasm()` from `@vlcn.io/crsqlite-wasm` registers **IDBBatchAtomicVFS**. Layer 3 deliberately bypasses that and registers **AccessHandlePoolVFS** so app data lands in OPFS.

## Browser requirements

- **Secure context**: `https://` or `http://localhost` (not `file://`, not plain LAN `http://192.168…` for OPFS)
- **OPFS**: `navigator.storage.getDirectory`
- Module workers (`new Worker(url, { type: 'module' })`)

## Smoke

Serve the repo root, then open:

```text
http://localhost:8080/examples/smoke-db/
```

```bash
python -m http.server 8080
```

Click **Run smoke** — CREATE → INSERT → SELECT → UPDATE → SELECT. Expect `SMOKE_DB_OK`.

Headless (Chrome/Edge + localhost server):

```bash
python -m http.server 8765 --bind 127.0.0.1
node scripts/smoke-db-worker.mjs
```

## Main-thread usage

```js
import { createDbClient } from '../core/db-client.js';

const client = createDbClient({
  workerUrl: new URL('../core/db-worker.js', import.meta.url),
});
await client.init();
await client.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)');
await client.insert('INSERT INTO notes (body) VALUES (?)', ['hello']);
const rows = await client.select('SELECT * FROM notes');
```

Layer 1 facades (`useCollection`, etc.) should wrap this client later — app code must not talk to the worker or OPFS directly.

## Yjs documents

Rich-text / CRDT docs use the same worker DB via [`YjsSqliteProvider`](yjs-provider.md) (`openYDoc`). Smoke: `examples/smoke-yjs/` → `SMOKE_YJS_OK`.
