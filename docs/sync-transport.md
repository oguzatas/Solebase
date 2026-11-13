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
| [`core/S3SyncAdapter.ts`](../core/S3SyncAdapter.ts) / [`.js`](../core/S3SyncAdapter.js) | Zero-LIST mailbox sync (`pull` / `push` via `manifest.json` + ETag) |
| [`core/manifest.types.ts`](../core/manifest.types.ts) | `SyncManifest` schema + `S3SyncError` |
| [`core/sync-p2p.js`](../core/sync-p2p.js) | WebRTC DataChannel session, manual SDP, loopback helper |
| [`core/sync-transport.js`](../core/sync-transport.js) | Orchestrator: push/pull/merge + P2P hooks |
| [`core/db-worker.js`](../core/db-worker.js) | `changeset_apply` RPC → merge + `NOTIFY` |

## Zero-LIST S3 / R2 (default)

Live `provider: 's3'` **does not** call `ListObjectsV2` (Class A). Each room uses a single index:

```text
{prefix}/{appId}/manifest.json
{prefix}/{appId}/chunks/{timestamp}-{siteId}.bin
```

- **Pull:** `GET manifest.json` with `If-None-Match: <lastETag>` → **304** returns immediately; **200** downloads only unseen chunk keys in parallel, decrypts with `encryptionKey` (sync-crypto), applies.
- **Push:** PUT encrypted `.bin` → GET manifest (capture ETag) → append chunk → PUT manifest with `If-Match` (or `If-None-Match: *` when creating). **412** → re-fetch, re-append same chunk key, retry ≤5 with backoff.
- **GC:** optional prune of chunks older than `retentionDays` (default 30) during push.
- **Memory / smoke:** `options.memory: true` keeps the in-process list path (no S3). Opt out of manifest with `useManifest: false` (legacy LIST; not recommended).

### Migration from LIST-era blobs

MVP is **manifest-only going forward**. Older `{prefix}/{appId}/{siteId}/*.changeset` objects are **not** listed or migrated automatically (that would reintroduce Class A LIST). New rooms start empty manifests; re-sync from a device that still has local OPFS, or one-shot upload a bootstrap changeset under the new layout. Do not rely on ongoing LIST.

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
      // Notes Settings prefills this R2 account + solebase-sync-test bucket.
      endpoint: 'https://7701962a7c1ef34d73878ef8650ef733.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'solebase-sync-test',
      accessKeyId: '…',     // R2 → Manage API Tokens → Object Read & Write
      secretAccessKey: '…', // paste locally only; never commit
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

### R2 API token (dashboard once)

Cloudflare MCP OAuth cannot mint S3 API tokens. In the dashboard: **R2 → Overview → Manage API Tokens → Object Read & Write → bucket `solebase-sync-test`** → copy Access Key ID + Secret into Notes **Settings → Solebase sync (R2)** (or your own `Solebase.init` options). See [`examples/notes/README.md`](../examples/notes/README.md).

### S3 second device

1. Device A: init with S3 options + shared `appId` / `encryptionKey` → mutate → `await db.syncNow()` (or rely on `autoSync`).
2. What lands in the bucket: **`manifest.json` + E2EE `.bin` chunks only** (AES-GCM via sync-crypto). No folder listing.
3. Device B: identical `appId`, `encryptionKey`, and S3 options → `syncNow()` / `autoSync` ETag-polls the manifest → decrypt → `changeset_apply` → UI via `subscribe`.

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

## Blob / manifest layout

```text
{prefix}/{appId}/manifest.json
{prefix}/{appId}/chunks/{timestamp}-{siteId}.bin
```

Chunk values are packed ciphertext packages from `packCiphertextPackage` (AES-GCM).

Legacy (memory / `useManifest: false` only):

```text
{prefix}/{appId}/{siteId}/{cursor}-{uuid}.changeset
```

## Smoke

```text
http://localhost:8080/examples/smoke-sync-transport/
```

```bash
python -m http.server 8765 --bind 127.0.0.1
node scripts/smoke-sync-transport.mjs
node scripts/smoke-s3-manifest.mjs
```

Expect `SMOKE_SYNC_TRANSPORT_OK` (memory S3 path + Drive stub + WebRTC encrypt/send/decrypt + P2P merge) and `SMOKE_S3_MANIFEST_OK` (mock S3: 304, push, 412 retry, no LIST).
