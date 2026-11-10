# Solebase Layer 1 — Developer API

**Solebase** (formerly Prompt2UI) Layer 1 is the only surface app code should use for local data. It wraps the Layer 3 OPFS + cr-sqlite Web Worker. Vanilla TypeScript — no React/Vue/Svelte.

## Install / import (zero-build)

Sources live under `packages/solebase/src/`. Compile once:

```bash
cd packages/solebase
npm install
npm run build
```

Browser apps import the compiled ESM (committed under `packages/solebase/dist/`):

```js
import { Solebase } from '../packages/solebase/dist/index.js';

const db = await Solebase.init({
  appId: 'myApp',
  encryptionKey: 'device-secret',
  // workerUrl optional — defaults to core/db-worker.js relative to the package dist
  workerUrl: new URL('../core/db-worker.js', import.meta.url),
  sync: {
    provider: 's3', // or 'drive'
    options: {
      // Real S3: endpoint, bucket, accessKeyId, secretAccessKey, region
      // Smoke: memory: true
      // Optional: p2p: true (manual SDP / QR signaling)
    },
  },
});

const notes = db.collection('notes');
const row = await notes.insert({ title: 'Hello' }); // auto UUID if id omitted
notes.subscribe((docs) => render(docs));            // immediate + on NOTIFY
await notes.update(row.id, { title: 'Hi' });
const one = await notes.findById(row.id);
const hits = await notes.find({ title: 'Hi' });
```

## Layout

| Path | Role |
|------|------|
| `packages/solebase/src/types.ts` | Config, RPC, Document, ConnectionStatus |
| `packages/solebase/src/WorkerBridge.ts` | Promise RPC (`requestId`) + NOTIFY subscription |
| `packages/solebase/src/Collection.ts` | `insert` / `update` / `delete` / `findById` / `find` / `subscribe` |
| `packages/solebase/src/Solebase.ts` | `Solebase.init`, `collection()`, encryption key + sync stub |
| `packages/solebase/src/index.ts` | Public exports |
| `packages/solebase/dist/*` | Built ESM + `.d.ts` for browsers |
| `core/db-worker.js` | Layer 3 worker (collection CRUD + NOTIFY) |
| `core/db-protocol.js` | Shared protocol + collection table naming |

## Collection schema

One CRR table per collection: `sb_<name>`

```sql
CREATE TABLE IF NOT EXISTS "sb_notes" (
  id TEXT PRIMARY KEY NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',           -- JSON document (includes id)
  updated_at INTEGER NOT NULL DEFAULT 0    -- unix ms (DEFAULT required by cr-sqlite CRR)
);
SELECT crsql_as_crr('sb_notes');
```

Logical names must match `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`. Apps never open these tables — use `collection()`.

## RPC

WorkerBridge sends `{ id, requestId, type, … }` and awaits a matching response. Types:

- `INIT` / `CLOSE` — handshake / teardown  
- `EXEC` / `QUERY` — raw SQL (Layer 3 aliases)  
- `collection_*` — ensure / insert / update / delete / findById / find  

Unsolicited pushes:

```json
{ "type": "NOTIFY", "collection": "notes", "op": "insert", "id": "…", "doc": { } }
```

Connection status: `connecting` | `connected` | `disconnected` | `error`.

## Sync transport

`sync: { provider: 'drive' | 's3', options? }` starts [`SolebaseSyncTransport`](sync-transport.md) after INIT:

- Encrypts extracted changesets with `encryptionKey`
- Uploads to S3 or Drive-shaped blob store; optional WebRTC P2P
- Applies remote packages via worker `changeset_apply` → `NOTIFY` → `collection.subscribe`

```js
db.getSync();           // transport handle or null
await db.syncNow();     // manual push/pull
await db.encryptForSync(payload);
```

See [`sync-transport.md`](sync-transport.md) for S3 credentials, Drive stub, and SDP signaling.

## Smoke

```text
http://localhost:8080/examples/smoke-solebase/
http://localhost:8080/examples/smoke-sync-transport/
```

```bash
python -m http.server 8765 --bind 127.0.0.1
node scripts/smoke-solebase.mjs
node scripts/smoke-sync-transport.mjs
```

Expect `SMOKE_SOLEBASE_OK` / `SMOKE_SYNC_TRANSPORT_OK`.

## Rules reminder

- No IndexedDB / localStorage for Solebase app data  
- No main-thread SQLite / OPFS  
- No React — Vanilla JS/TS only  
