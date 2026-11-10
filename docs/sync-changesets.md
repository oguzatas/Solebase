# Sync changesets + E2EE crypto

Extract cr-sqlite change rows and encrypt them in the browser for store-and-forward (S3 / Drive) and P2P. Transport (upload / WebRTC / merge) lives in [`sync-transport.md`](sync-transport.md).

## Files

| File | Role |
|------|------|
| [`core/sync-changesets.js`](../core/sync-changesets.js) | `getChangesSince` / `applyChangeset` over Layer 3 `db-client` |
| [`core/sync-crypto.js`](../core/sync-crypto.js) | AES-GCM + PBKDF2 `encryptChangeset` / `decryptChangeset` |
| [`examples/smoke-sync-changesets/`](../examples/smoke-sync-changesets/) | Browser smoke |

## Cursor semantics

cr-sqlite exposes a database-wide Lamport clock as `db_version` on [`crsql_changes`](https://vlcn.io/docs/cr-sqlite/api-methods/crsql_changes).

- **Cursor** = last seen `db_version` (number). Start at `0`.
- **Extract**: `WHERE db_version > :cursor`, ordered by `db_version`, `seq`.
- **New cursor** = `max(db_version)` in the returned batch (unchanged if empty).

Optional `excludeSiteIdB64` skips a peer’s own site (reduces echo on live sync later).

## Payload

```js
{
  v: 1,
  changes: [
    {
      table, pk, cid, val, col_version, db_version,
      site_id, // base64 of BLOB (or null)
      cl, seq
    }
  ],
  cursor: 12, // new cursor
  since: 0    // query cursor
}
```

Binary `pk` / `val` / `site_id` values are wire-safe (`site_id` as base64; binary `pk`/`val` as `{ $b64 }`).

## Apply

`applyChangeset(dbClient, payload)` inserts each row into `crsql_changes` with **bound parameters** (required by cr-sqlite). Peers must share the same CRR schema (`SELECT crsql_as_crr('table')` after `CREATE TABLE`).

## Crypto

```js
import { encryptChangeset, decryptChangeset, packCiphertextPackage } from '../core/sync-crypto.js';

const pkg = await encryptChangeset(payload, passphrase); // or CryptoKey
const again = await decryptChangeset(pkg, passphrase);
const blob = packCiphertextPackage(pkg); // Uint8Array for future S3/Drive
```

- PBKDF2 (210k, SHA-256) → AES-256-GCM when given a passphrase (same iteration count as legacy `prompt-crypto.js`).
- Wrong passphrase → clear error; no plaintext logging.
- Upload / WebRTC / worker merge: see [`sync-transport.md`](sync-transport.md).

## Smoke

```text
http://localhost:8080/examples/smoke-sync-changesets/
```

```bash
python -m http.server 8765 --bind 127.0.0.1
node scripts/smoke-sync-changesets.mjs
```

Expect `SMOKE_SYNC_CHANGESETS_OK`.
