/**
 * db-protocol.js — Shared message types for Layer 3 (main ↔ db worker).
 *
 * Requests and responses are plain JSON-serializable objects over postMessage.
 * Every request carries an `id`; every response echoes that `id`.
 */

/** @typedef {'init'|'exec'|'run'|'select'|'close'} DbRequestType */

/**
 * @typedef {object} DbRequest
 * @property {string|number} id
 * @property {DbRequestType} type
 * @property {string} [sql]
 * @property {unknown[]} [params]
 * @property {string} [filename]  init only — OPFS-backed db name
 * @property {string} [wasmUrl]   init only — override crsqlite.wasm URL
 */

/**
 * @typedef {object} DbSuccess
 * @property {string|number} id
 * @property {true} ok
 * @property {unknown} [result]
 */

/**
 * @typedef {object} DbFailure
 * @property {string|number} id
 * @property {false} ok
 * @property {string} error
 */

/** @typedef {DbSuccess|DbFailure} DbResponse */

export const DB_REQUEST_TYPES = Object.freeze([
  'init',
  'exec',
  'run',
  'select',
  'close',
]);

/** Default OPFS database filename used by createDbClient / worker init. */
export const DEFAULT_DB_FILENAME = 'prompt2ui.db';

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
