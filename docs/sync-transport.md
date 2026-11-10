# Solebase sync transport (WebRTC P2P + S3/Drive blobs)

Production path for exchanging **E2EE changesets** between devices. Builds on [changeset extract + crypto](sync-changesets.md) and plugs into [Layer 1](solebase-layer1.md).

## Pipeline

```
local mutate (collection.insert/update/delete)
    → extract crsql_changes (cursor = db_version)
    → encrypt with SolebaseConfig.encryptionKey
    → upload blob (S3 or Drive-shaped)  and/or  send WebRTC DataChannel
    → peer download / receive
    → decrypt
    → worker changeset_apply → NOTIFY(op: merge)
    → collection.subscribe refresh
```

Plaintext changesets never leave the device.

## Files

| File | Role |
|------|------|
| [`core/sync-blob-store.js`](../core/sync-blob-store.js) | `MemoryBlobStore`, `S3BlobStore`, `DriveBlobStore` (+ factory) |
| [`core/sync-p2p.js`](../core/sync-p2p.js) | WebRTC DataChannel session, manual SDP, loopback helper |
| [`core/sync-transport.js`](../core/sync-transport.js) | Orchestrator: push/pull/merge + P2P hooks |
| [`core/db-worker.js`](../core/db-worker.js) | `changeset_apply` RPC → merge + `NOTIFY` |

## Configure (Layer 1)

```js
import { Solebase } from '../packages/solebase/dist/index.js';

const db = await Solebase.init({
  appId: 'notes',
  encryptionKey: 'shared-secret',
  sync: {
    provider: 's3', // or 'drive'
    options: {
      // S3 (R2 / MinIO / AWS) — path-style SigV4
      endpoint: 'https://xxx.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'my-bucket',
      accessKeyId: '…',
      secretAccessKey: '…',
      prefix: 'solebase-changesets',

      // Smoke / tests without a real bucket:
      // memory: true,
      // blobStore: myMemoryStore,

      p2p: true,            // enable WebRTC session scaffolding
      autoSync: true,       // debounced push/pull after local NOTIFY
      pollIntervalMs: 15000,
      debounceMs: 800,
    },
  },
});

await db.collection('notes').insert({ title: 'Hi' });
await db.syncNow(); // optional manual cycle
```

### Drive provider

`provider: 'drive'` uses the **same blob interface** as S3. Live Drive API + OAuth is not wired yet; the default backend is in-memory so the config path is real for apps and smoke. Pass `memory: true` (default) or inject `blobStore`.

### Incomplete S3 credentials

If `endpoint` / `bucket` / keys are missing and `allowMemoryFallback` is not `false`, Solebase falls back to `MemoryBlobStore` so local/dev does not hard-fail.

## WebRTC P2P (signaling)

**Temporary assumption (zero-backend):** peers exchange SDP offer/answer out-of-band (clipboard / QR / Share URL). There is **no** Solebase signaling server.

```js
const sync = db.getSync();
const { payload: offerText } = await sync.createP2POffer();
// …send offerText to peer…
const { payload: answerText } = await peer.sync.acceptP2POffer(offerText);
// …send answerText back…
await sync.acceptP2PAnswer(answerText);
```

Optional: inject a `signal` adapter `{ send(msg), onMessage(cb) }` via sync options / `SolebaseP2PSession` for a future lightweight relay. Smoke uses an in-memory bus (`createInMemorySignalBus`).

STUN: default `stun:stun.l.google.com:19302`. Override with `options.rtcConfig`.

## Worker merge / NOTIFY

`changeset_apply` inserts into `crsql_changes`, then emits:

```json
{ "type": "NOTIFY", "collection": "notes", "op": "merge", "id": "*" }
```

for each affected `sb_*` table. `Collection.subscribe` invalidates and re-fetches.

## Blob key layout

```text
{prefix}/{appId}/{siteId}/{cursor}-{uuid}.changeset
```

Values are packed ciphertext packages from `packCiphertextPackage` (AES-GCM).

## Smoke

```text
http://localhost:8080/examples/smoke-sync-transport/
```

```bash
python -m http.server 8765 --bind 127.0.0.1
node scripts/smoke-sync-transport.mjs
```

Expect `SMOKE_SYNC_TRANSPORT_OK` (memory S3 path + Drive stub + WebRTC encrypt/send/decrypt + P2P merge).
