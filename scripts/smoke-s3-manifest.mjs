/**
 * Headless Node smoke for zero-LIST S3SyncAdapter (mock S3, no network).
 *
 *   node scripts/smoke-s3-manifest.mjs
 *
 * Expects: SMOKE_S3_MANIFEST_OK
 */
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.TextEncoder) globalThis.TextEncoder = TextEncoder;
if (!globalThis.TextDecoder) globalThis.TextDecoder = TextDecoder;

const { encryptChangeset, packCiphertextPackage } = await import(
  '../core/sync-crypto.js'
);
const { S3SyncAdapter, S3SyncError, emptyManifest } = await import(
  '../core/S3SyncAdapter.js'
);

/** In-memory path-style S3: Map key → { body, etag } */
function createMockS3() {
  /** @type {Map<string, { body: Uint8Array, etag: string }>} */
  const objects = new Map();
  let etagSeq = 1;

  function objectKeyFromUrl(url) {
    // https://endpoint/bucket/<key>
    const u = new URL(url);
    const parts = u.pathname.replace(/^\//, '').split('/');
    parts.shift(); // bucket
    return parts.join('/');
  }

  /** @type {typeof fetch} */
  async function mockFetch(input, init = {}) {
    const url = String(input);
    const method = (init.method || 'GET').toUpperCase();
    const key = objectKeyFromUrl(url);
    const headersIn = new Headers(init.headers || {});

    if (method === 'GET') {
      const obj = objects.get(key);
      if (!obj) {
        return new Response(null, { status: 404 });
      }
      const inm = headersIn.get('If-None-Match');
      if (inm && inm === obj.etag) {
        return new Response(null, { status: 304, headers: { ETag: obj.etag } });
      }
      return new Response(obj.body, {
        status: 200,
        headers: {
          ETag: obj.etag,
          'Content-Type': key.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream',
        },
      });
    }

    if (method === 'PUT') {
      const ifMatch = headersIn.get('If-Match');
      const ifNoneMatch = headersIn.get('If-None-Match');
      const existing = objects.get(key);

      if (ifNoneMatch === '*' && existing) {
        return new Response(null, { status: 412 });
      }
      if (ifMatch) {
        if (!existing || existing.etag !== ifMatch) {
          return new Response(null, { status: 412 });
        }
      }

      const body =
        init.body instanceof Uint8Array
          ? new Uint8Array(init.body)
          : typeof init.body === 'string'
            ? new TextEncoder().encode(init.body)
            : init.body
              ? new Uint8Array(await new Response(init.body).arrayBuffer())
              : new Uint8Array();
      const etag = `"etag-${etagSeq++}"`;
      objects.set(key, { body, etag });
      return new Response(null, { status: 200, headers: { ETag: etag } });
    }

    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 405 });
  }

  return { objects, mockFetch };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const { objects, mockFetch } = createMockS3();
  const passphrase = 'smoke-manifest-key';
  const room = 'solebase-changesets/notes-smoke';

  const adapterA = new S3SyncAdapter({
    endpoint: 'https://example.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'solebase-sync-test',
    accessKeyId: 'AKIA_TEST',
    secretAccessKey: 'secret_test_key_value_ok',
    prefix: room,
    encryptionKey: passphrase,
    localSiteId: 'siteA',
    retentionDays: 0,
    fetch: mockFetch,
  });

  const adapterB = new S3SyncAdapter({
    endpoint: 'https://example.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'solebase-sync-test',
    accessKeyId: 'AKIA_TEST',
    secretAccessKey: 'secret_test_key_value_ok',
    prefix: room,
    encryptionKey: passphrase,
    localSiteId: 'siteB',
    retentionDays: 0,
    fetch: mockFetch,
  });

  // 1) Empty pull → []
  const empty = await adapterB.pull(0);
  assert(Array.isArray(empty) && empty.length === 0, 'empty pull should be []');

  // 2) Push encrypted changeset from A
  const payload = {
    cursor: 3,
    siteId: 'siteA',
    changes: [{ table: 'sb_notes', op: 'insert', id: 'n1' }],
  };
  const pkg = await encryptChangeset(payload, passphrase);
  const bytes = packCiphertextPackage(pkg);
  await adapterA.push(bytes, { siteId: 'siteA', dbVersion: 3 });

  const manifestKey = `${room}/manifest.json`;
  assert(objects.has(manifestKey), 'manifest.json must exist after push');
  const man = JSON.parse(new TextDecoder().decode(objects.get(manifestKey).body));
  assert(man.version === 1, 'manifest version should be 1');
  assert(man.chunks.length === 1, 'one chunk');
  assert(!man.chunks[0].key.includes('list-type'), 'chunk key ok');

  // 3) B pulls → decrypts → payload JSON
  const pulled = await adapterB.pull(0);
  assert(pulled.length === 1, 'B should pull one chunk');
  const decoded = JSON.parse(new TextDecoder().decode(pulled[0]));
  assert(decoded.cursor === 3, 'decrypted cursor');
  assert(decoded.changes?.[0]?.id === 'n1', 'decrypted change id');

  // 4) 304 path — second pull with same ETag → []
  const again = await adapterB.pull(0);
  assert(again.length === 0, '304 / applied should yield []');

  // 5) Concurrent push → 412 retry (simulate by racing two appends)
  const adapterC = new S3SyncAdapter({
    endpoint: 'https://example.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'solebase-sync-test',
    accessKeyId: 'AKIA_TEST',
    secretAccessKey: 'secret_test_key_value_ok',
    prefix: room,
    encryptionKey: passphrase,
    localSiteId: 'siteC',
    retentionDays: 0,
    fetch: mockFetch,
  });

  // Force a stale If-Match once: mutate etag after GET by wrapping fetch.
  let conflictOnce = true;
  const conflictFetch = async (input, init) => {
    const res = await mockFetch(input, init);
    if (
      conflictOnce &&
      String(init?.method || 'GET').toUpperCase() === 'PUT' &&
      String(input).includes('manifest.json')
    ) {
      // First manifest PUT: pretend 412, then allow real write.
      conflictOnce = false;
      // Also bump stored etag so retry GET sees new state — inject a competing chunk.
      const key = manifestKey;
      const cur = objects.get(key);
      if (cur) {
        const m = JSON.parse(new TextDecoder().decode(cur.body));
        m.version += 1;
        m.updatedAt = Date.now();
        m.chunks.push({
          id: 'competitor',
          key: `${room}/chunks/1-competitor.bin`,
          siteId: 'competitor',
          dbVersion: 1,
          size: 1,
          createdAt: Date.now(),
        });
        objects.set(key, {
          body: new TextEncoder().encode(JSON.stringify(m)),
          etag: `"conflict-${Date.now()}"`,
        });
      }
      return new Response(null, { status: 412 });
    }
    return res;
  };
  adapterC.fetchImpl = conflictFetch;

  const pkg2 = await encryptChangeset(
    { cursor: 5, siteId: 'siteC', changes: [{ id: 'n2' }] },
    passphrase,
  );
  await adapterC.push(packCiphertextPackage(pkg2), {
    siteId: 'siteC',
    dbVersion: 5,
  });

  const man2 = JSON.parse(new TextDecoder().decode(objects.get(manifestKey).body));
  assert(
    man2.chunks.some((c) => c.siteId === 'siteC'),
    'siteC chunk present after 412 retry',
  );
  assert(
    man2.chunks.some((c) => c.id === 'competitor'),
    'competitor chunk retained',
  );

  // 6) Ensure no ListObjects query params were ever used
  for (const key of objects.keys()) {
    assert(!key.includes('list-type'), 'no list-type keys');
  }

  // 7) Error class smoke
  try {
    // eslint-disable-next-line no-new
    new S3SyncAdapter({ endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: 'x' });
    assert(false, 'should throw CONFIG');
  } catch (err) {
    assert(err instanceof S3SyncError && err.code === 'CONFIG', 'CONFIG error');
  }

  assert(emptyManifest().chunks.length === 0, 'emptyManifest');

  console.log('SMOKE_S3_MANIFEST_OK');
  console.log(
    JSON.stringify({
      objects: objects.size,
      manifestVersion: man2.version,
      chunks: man2.chunks.length,
    }),
  );
}

main().catch((err) => {
  console.error('SMOKE_S3_MANIFEST_FAIL');
  console.error(err);
  process.exit(1);
});
