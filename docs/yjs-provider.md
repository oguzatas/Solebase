# Yjs SQLite provider (Layer 3)

Persist a [Yjs](https://docs.yjs.dev/) `Y.Doc` in the OPFS-backed **cr-sqlite** database — not IndexedDB.

## File

[`core/yjs-sqlite-provider.js`](../core/yjs-sqlite-provider.js) — `YjsSqliteProvider` + `openYDoc`.

## Schema

```sql
CREATE TABLE IF NOT EXISTS yjs_documents (
  document_id TEXT PRIMARY KEY NOT NULL,
  update_blob BLOB NOT NULL
);
```

Created automatically on `load()`.

## Persistence choice

Each `document_id` stores **one merged blob**: `Y.encodeStateAsUpdate(doc)`. Incremental `doc.on('update')` events only schedule a debounced rewrite of that full state (default 250ms). Simpler than an append-only update log; fine for local-first single-device docs until Layer 1 / sync needs something richer.

Binary transfer: `Uint8Array` params and SELECT cells via `postMessage` structured clone. The worker’s `toCloneable` preserves `ArrayBuffer` views so BLOBs are not mangled into plain objects.

## Usage

```js
import { createDbClient } from '../core/db-client.js';
import { openYDoc } from '../core/yjs-sqlite-provider.js';

const db = createDbClient({
  workerUrl: new URL('../core/db-worker.js', import.meta.url),
});
await db.init();

const { doc, provider } = await openYDoc(db, 'note:abc');
doc.getText('body').insert(0, 'hello');
await provider.flush();   // optional; debounce also writes
await provider.destroy(); // unsubscribe + final save + doc.destroy()
```

Or construct `new YjsSqliteProvider({ dbClient, documentId })` and call `load()` yourself.

Layer 1 document helpers should wrap this later — app code should not open the worker or touch OPFS directly.

## Smoke

```text
http://localhost:8080/examples/smoke-yjs/
```

```bash
python -m http.server 8765 --bind 127.0.0.1
node scripts/smoke-yjs-provider.mjs
```

Expect `SMOKE_YJS_OK`.

## Out of scope

Notes / calorie example migration off IndexedDB — later reconstruction work.
