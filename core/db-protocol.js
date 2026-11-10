/**
 * db-protocol.js — Shared message types for Layer 3 (main ↔ db worker).
 *
 * Requests and responses are plain JSON-serializable objects over postMessage.
 * Every request carries an `id` (Layer 1 WorkerBridge may send `requestId` —
 * the worker accepts either and echoes both).
 *
 * Layer 1 also uses uppercase aliases: EXEC → exec, QUERY → select.
 * Collection CRUD uses dedicated types that emit unsolicited NOTIFY events.
 *
 * ## Collection schema (CRR JSON docs)
 *
 * One SQLite table per collection, named `sb_<safeName>`:
 *
 *   CREATE TABLE IF NOT EXISTS "sb_<name>" (
 *     id TEXT PRIMARY KEY NOT NULL,
 *     doc TEXT NOT NULL,           -- JSON document (includes id)
 *     updated_at INTEGER NOT NULL  -- unix ms
 *   );
 *   SELECT crsql_as_crr('sb_<name>');  -- best-effort CRDT registration
 *
 * Safe names: /^[A-Za-z][A-Za-z0-9_]*$/ (max 64). Apps never touch these tables
 * directly — use Solebase.collection() / WorkerBridge.
 */

/** @typedef {'init'|'exec'|'run'|'select'|'close'|'EXEC'|'QUERY'|'collection_ensure'|'collection_insert'|'collection_update'|'collection_delete'|'collection_findById'|'collection_find'} DbRequestType */

/**
 * @typedef {object} DbRequest
 * @property {string|number} [id]
 * @property {string|number} [requestId]  Layer 1 alias for id
 * @property {DbRequestType} type
 * @property {string} [sql]
 * @property {unknown[]} [params]
 * @property {string} [filename]  init only — OPFS-backed db name
 * @property {string} [wasmUrl]   init only — override crsqlite.wasm URL
 * @property {string} [name]      collection ops — logical collection name
 * @property {string} [docId]     collection ops — document id
 * @property {unknown} [doc]      collection insert/update — plain object
 */

/**
 * @typedef {object} DbSuccess
 * @property {string|number} id
 * @property {string|number} [requestId]
 * @property {true} ok
 * @property {unknown} [result]
 */

/**
 * @typedef {object} DbFailure
 * @property {string|number} id
 * @property {string|number} [requestId]
 * @property {false} ok
 * @property {string} error
 */

/**
 * Unsolicited push from worker after collection mutations (local or future remote merges).
 * @typedef {object} DbNotify
 * @property {'NOTIFY'} type
 * @property {string} collection
 * @property {'insert'|'update'|'delete'} op
 * @property {string} id
 * @property {unknown} [doc]
 */

/** @typedef {DbSuccess|DbFailure} DbResponse */

export const DB_REQUEST_TYPES = Object.freeze([
  'init',
  'exec',
  'run',
  'select',
  'close',
  'EXEC',
  'QUERY',
  'collection_ensure',
  'collection_insert',
  'collection_update',
  'collection_delete',
  'collection_findById',
  'collection_find',
]);

/** Prefix for per-collection CRR tables. */
export const COLLECTION_TABLE_PREFIX = 'sb_';

/**
 * Validate + map a logical collection name to a SQLite table identifier.
 * @param {string} name
 * @returns {string}
 */
export function collectionTableName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new Error(
      `invalid collection name "${name}": use /^[A-Za-z][A-Za-z0-9_]{0,63}$/`,
    );
  }
  return `${COLLECTION_TABLE_PREFIX}${name}`;
}

/** Default OPFS database filename used by createDbClient / worker init. */
export const DEFAULT_DB_FILENAME = 'solebase.db';

/**
 * Pinned CDN URLs for zero-build browser usage.
 * Worker loads @vlcn.io/crsqlite-wasm (wasm) + @vlcn.io/wa-sqlite AccessHandlePoolVFS (OPFS).
 * Stock initWasm() registers IndexedDB — we deliberately do NOT use that path.
 */
export const CRS_WASM_CDN = Object.freeze({
  /** Asyncify cr-sqlite wasm binary */
  wasm: 'https://cdn.jsdelivr.net/npm/@vlcn.io/crsqlite-wasm@0.16.0/dist/crsqlite.wasm',
  /** ESM factory that loads the wasm */
  factory: 'https://esm.sh/@vlcn.io/crsqlite-wasm@0.16.0/dist/crsqlite.mjs',
  /** wa-sqlite JS API */
  waSqlite: 'https://esm.sh/@vlcn.io/wa-sqlite@0.22.0',
  /** OPFS AccessHandlePool VFS (dedicated worker only) */
  accessHandlePoolVfs:
    'https://esm.sh/@vlcn.io/wa-sqlite@0.22.0/src/examples/AccessHandlePoolVFS.js',
});
