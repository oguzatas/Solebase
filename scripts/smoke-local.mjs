/**
 * LocalOnly CRUD + LWW smoke (Node, no browser IndexedDB).
 * Forces PromptDB localStorage backend via useIDB: false.
 */
import assert from 'node:assert/strict';

// Minimal browser shims for PromptDB (Node already provides globalThis.crypto)
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
globalThis.indexedDB = undefined;

const { PromptDB } = await import('../core/prompt-db.js');
const { encryptPayload, decryptPayload } = await import('../core/prompt-crypto.js');

const db = await PromptDB.open('smoke-meals', { useIDB: false });

const a = await db.add({ name: 'Oats', calories: 300, date: '2026-10-22' });
assert.ok(a.id);
assert.ok(a.updatedAt);
assert.equal(a.name, 'Oats');

await db.add({ name: 'Coffee', calories: 5, date: '2026-10-22' });
assert.equal(db.get().length, 2);

const removed = await db.remove(a.id);
assert.equal(removed, true);
assert.equal(db.get().length, 1);
assert.equal(db.exportAll().length, 2); // includes tombstone
assert.ok(db.exportAll().find((r) => r.id === a.id && r._deleted));

// LWW: remote newer row wins; older is ignored
const live = db.get()[0];
const remote = [
  { ...live, calories: 999, updatedAt: live.updatedAt + 1000 },
  { id: a.id, updatedAt: a.updatedAt - 1000, _deleted: true }, // older tombstone ignored
  { id: 'new-1', name: 'Rice', calories: 200, updatedAt: Date.now(), createdAt: Date.now() },
];
const merge = await db.mergeLWW(remote);
assert.equal(merge.changed, true);
assert.equal(db.find(live.id).calories, 999);
assert.equal(db.get().length, 2);

// Crypto round-trip
const envelope = await encryptPayload({ hello: 'world' }, 'test-passphrase');
const plain = await decryptPayload(envelope, 'test-passphrase');
assert.deepEqual(plain, { hello: 'world' });

console.log('SMOKE_LOCAL_OK', {
  backend: db.backend,
  live: db.get().length,
  withTombstones: db.exportAll().length,
});
