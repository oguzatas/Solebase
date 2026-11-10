/**
 * db-worker.js — Layer 3 storage worker
 *
 * Runs cr-sqlite (SQLite WASM + crsqlite extension) on OPFS via
 * AccessHandlePoolVFS. All DB I/O stays off the main thread.
 *
 * Protocol: see db-protocol.js
 *   init   → open OPFS db (once)
 *   exec / run → parameterized SQL (CREATE / INSERT / UPDATE / DELETE / …)
 *   select → parameterized SELECT → array of row objects
 *   close  → close db handle
 *
 * Responses: { id, ok: true, result? } | { id, ok: false, error }
 *
 * Requirements: secure context (https / localhost) + OPFS
 *   (navigator.storage.getDirectory).
 */

import { CRS_WASM_CDN, DEFAULT_DB_FILENAME } from './db-protocol.js';

/** @type {any} */
let sqlite3 = null;
/** @type {typeof import('@vlcn.io/wa-sqlite') | null} */
let SQLiteConsts = null;
/** @type {number|null} */
let dbPtr = null;
/** @type {string|null} */
let openFilename = null;
/** @type {Promise<void>|null} */
let initPromise = null;
/** @type {boolean} */
let ready = false;

/** Serialize all SQLite work — Asyncify builds deadlock under concurrency. */
let chain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Convert values that postMessage cannot clone (BigInt, etc.).
 * Preserve binary views (Uint8Array BLOBs) — Object.entries would mangle them.
 * @param {unknown} value
 * @returns {unknown}
 */
function toCloneable(value) {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(toCloneable);
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toCloneable(v);
    return out;
  }
  return value;
}

/**
 * @param {string} [wasmUrl]
 */
async function loadSqlite(wasmUrl) {
  const SQLiteAsyncESMFactory = (await import(CRS_WASM_CDN.factory)).default;
  const SQLite = await import(CRS_WASM_CDN.waSqlite);
  const { AccessHandlePoolVFS } = await import(CRS_WASM_CDN.accessHandlePoolVfs);

  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error(
      'OPFS unavailable: need a secure context (https or localhost) with navigator.storage.getDirectory',
    );
  }

  const wasmModule = await SQLiteAsyncESMFactory({
    locateFile(file) {
      if (file.endsWith('.wasm')) return wasmUrl || CRS_WASM_CDN.wasm;
      return file;
    },
  });

  const api = SQLite.Factory(wasmModule);
  const vfs = new AccessHandlePoolVFS('prompt2ui-crsqlite');
  await vfs.isReady;
  api.vfs_register(vfs, false);
  return { api, SQLiteModule: SQLite };
}

/**
 * @param {{ filename?: string, wasmUrl?: string }} opts
 */
async function ensureInit(opts = {}) {
  if (ready && dbPtr != null) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    const filename = opts.filename || DEFAULT_DB_FILENAME;
    const { api, SQLiteModule } = await loadSqlite(opts.wasmUrl);
    sqlite3 = api;
    SQLiteConsts = SQLiteModule;

    const flags =
      SQLiteModule.SQLITE_OPEN_CREATE |
      SQLiteModule.SQLITE_OPEN_READWRITE |
      SQLiteModule.SQLITE_OPEN_URI;

    dbPtr = await api.open_v2(filename, flags, 'AccessHandlePool');
    openFilename = filename;

    // Touch crsqlite extension once so missing builds fail at init, not later.
    try {
      await runSql(`SELECT crsql_site_id()`, []);
    } catch (err) {
      // Non-fatal for plain SQL smoke; log and continue.
      console.warn('[db-worker] crsql_site_id probe failed:', err);
    }

    ready = true;
  })();

  try {
    await initPromise;
  } catch (err) {
    initPromise = null;
    ready = false;
    dbPtr = null;
    sqlite3 = null;
    throw err;
  }
}

/**
 * Execute SQL; optionally collect SELECT rows as objects.
 * @param {string} sql
 * @param {unknown[]} params
 * @param {{ rows?: boolean }} [opts]
 */
async function runSql(sql, params = [], opts = {}) {
  if (!sqlite3 || dbPtr == null) {
    throw new Error('database not initialized');
  }

  const wantRows = opts.rows === true;
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  let changes = 0;
  const SQLITE_ROW = SQLiteConsts?.SQLITE_ROW ?? 100;

  // statements() is an async generator that finalizes each stmt after yield.
  for await (const stmt of sqlite3.statements(dbPtr, sql)) {
    if (params && params.length) {
      sqlite3.bind_collection(stmt, params);
    }

    let columns = null;
    while ((await sqlite3.step(stmt)) === SQLITE_ROW) {
      if (wantRows) {
        columns = columns ?? sqlite3.column_names(stmt);
        const values = sqlite3.row(stmt);
        /** @type {Record<string, unknown>} */
        const obj = {};
        for (let i = 0; i < columns.length; i++) {
          obj[columns[i]] = values[i];
        }
        rows.push(obj);
      }
    }
  }

  if (!wantRows) {
    try {
      changes = sqlite3.changes(dbPtr);
    } catch {
      /* optional metadata */
    }
  }

  if (wantRows) return { rows };
  return { changes };
}

/**
 * @param {import('./db-protocol.js').DbRequest} msg
 * @returns {Promise<import('./db-protocol.js').DbResponse>}
 */
async function handleMessage(msg) {
  const { id, type } = msg;
  if (id == null || !type) {
    return { id: id ?? -1, ok: false, error: 'invalid message: need id and type' };
  }

  try {
    switch (type) {
      case 'init': {
        await enqueue(() => ensureInit({ filename: msg.filename, wasmUrl: msg.wasmUrl }));
        return {
          id,
          ok: true,
          result: { filename: openFilename, vfs: 'AccessHandlePool', storage: 'opfs' },
        };
      }

      case 'exec':
      case 'run': {
        if (!msg.sql || typeof msg.sql !== 'string') {
          return { id, ok: false, error: 'exec/run requires sql string' };
        }
        await enqueue(() => ensureInit());
        const result = await enqueue(() =>
          runSql(msg.sql, Array.isArray(msg.params) ? msg.params : [], { rows: false }),
        );
        return { id, ok: true, result: toCloneable(result) };
      }

      case 'select': {
        if (!msg.sql || typeof msg.sql !== 'string') {
          return { id, ok: false, error: 'select requires sql string' };
        }
        await enqueue(() => ensureInit());
        const result = await enqueue(() =>
          runSql(msg.sql, Array.isArray(msg.params) ? msg.params : [], { rows: true }),
        );
        return { id, ok: true, result: toCloneable(result.rows) };
      }

      case 'close': {
        await enqueue(async () => {
          if (sqlite3 && dbPtr != null) {
            await Promise.resolve(sqlite3.close(dbPtr));
          }
          dbPtr = null;
          sqlite3 = null;
          SQLiteConsts = null;
          openFilename = null;
          ready = false;
          initPromise = null;
        });
        return { id, ok: true, result: { closed: true } };
      }

      default:
        return { id, ok: false, error: `unknown type: ${type}` };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { id, ok: false, error };
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  handleMessage(msg).then((response) => {
    self.postMessage(response);
  });
};

// Announce worker boot (not correlated to a request id).
self.postMessage({ type: 'worker-ready', ok: true });
