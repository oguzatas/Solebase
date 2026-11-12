# Solebase sync transport (WebRTC P2P + S3/Drive blobs)

Production path for exchanging **E2EE changesets** between devices. Builds on [changeset extract + crypto](sync-changesets.md) and plugs into [Layer 1](solebase-layer1.md).

## Two-device checklist

Hosting is **not** sync. Same URL on two phones ≠ shared data. To sync:

1. **Same `appId`** and **same `encryptionKey`** on every device (Layer 1 `Solebase.init`).
2. Pick a path:
   - **S3** — real bucket credentials on both devices; `syncNow()` / `autoSync` push/pull ciphertext blobs.
   - **P2P** — `options.p2p: true`; exchange SDP via QR/clipboard (`createP2POffer` → `acceptP2POffer` → `acceptP2PAnswer`).
   - **Drive** — config stub only today (see below); not live OAuth/Drive API yet.
3. Success: peer decrypts, worker applies, `collection.subscribe` refreshes. Plaintext never leaves the device.

App authors stay on Layer 1 (`Solebase` / `collection` / `getSync()`). Smokes under `examples/smoke-*` are eng harnesses, not product apps — see root welcome → Engineers / [SHIP.md](SHIP.md).

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

### S3 second device

1. Device A: init with S3 options + shared `appId` / `encryptionKey` → mutate → `await db.syncNow()` (or rely on `autoSync`).
2. What lands in the bucket: **E2EE blobs only** (`packCiphertextPackage` / AES-GCM), keyed as `{prefix}/{appId}/{siteId}/{cursor}-{uuid}.changeset`.
3. Device B: identical `appId`, `encryptionKey`, and S3 options → `syncNow()` / `autoSync` downloads unseen blobs → decrypt → `changeset_apply` → UI via `subscribe`.

`memory: true` is for single-process smoke/dev only — it does **not** cross devices.

### Drive provider (stub)

`provider: 'drive'` uses the **same blob interface** as S3. **Live Drive API + OAuth is not wired yet**; the default backend is in-memory so the config path is real for apps and smoke. Pass `memory: true` (default) or inject `blobStore`. Do not expect Google Drive to sync two phones today.

### Incomplete S3 credentials

If `endpoint` / `bucket` / keys are missing and `allowMemoryFallback` is not `false`, Solebase falls back to `MemoryBlobStore` so local/dev does not hard-fail.

## WebRTC P2P (signaling)

**Temporary assumption (zero-backend):** peers exchange SDP offer/answer out-of-band (clipboard / QR / Share URL). There is **no** Solebase signaling server.

```js
// Both devices: sync: { provider: 's3', options: { p2p: true, … } }  (or memory + p2p for local)
const syncA = dbA.getSync();
const syncB = dbB.getSync();

const { payload: offerText } = await syncA.createP2POffer();
// …carry offerText to B (QR / clipboard)…

const { payload: answerText } = await syncB.acceptP2POffer(offerText);
// …carry answerText back to A…

await syncA.acceptP2PAnswer(answerText);
// Success: DataChannel open → encrypted changesets → decrypt/apply → subscribe
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
