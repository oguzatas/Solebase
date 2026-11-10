/**
 * db-worker.js — Layer 3 storage worker
 *
 * Runs cr-sqlite (SQLite WASM + crsqlite extension) on OPFS via
 * AccessHandlePoolVFS. All DB I/O stays off the main thread.
 *
 * Protocol: see db-protocol.js
 *   init   → open OPFS db (once)
 *   exec / run / EXEC → parameterized SQL (CREATE / INSERT / UPDATE / DELETE / …)
 *   select / QUERY → parameterized SELECT → array of row objects
 *   collection_* → Layer 1 JSON-doc CRRs + NOTIFY
 *   changeset_apply → merge remote crsql_changes + NOTIFY affected collections
 *   close  → close db handle
 *
 * Responses: { id, requestId?, ok: true, result? } | { id, requestId?, ok: false, error }
 * Pushes:    { type: 'NOTIFY', collection, op, id, doc? }
 *
 * Requirements: secure context (https / localhost) + OPFS
 *   (navigator.storage.getDirectory).
 */

import {
  CRS_WASM_CDN,
  DEFAULT_DB_FILENAME,
  COLLECTION_TABLE_PREFIX,
  collectionTableName,
  collectionNameFromTable,
} from './db-protocol.js';
import { b64ToBuf } from './sync-crypto.js';

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

/** @type {Set<string>} */
const ensuredCollections = new Set();

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
 * @param {import('./db-protocol.js').DbRequest} msg
 * @returns {string|number}
 */
function requestKey(msg) {
  if (msg.requestId != null) return msg.requestId;
  if (msg.id != null) return msg.id;
  return -1;
}

/**
 * @param {string|number} key
 * @param {boolean} ok
 * @param {unknown} [resultOrError]
 */
function respond(key, ok, resultOrError) {
  if (ok) {
    return { id: key, requestId: key, ok: true, result: resultOrError };
  }
  return {
    id: key,
    requestId: key,
    ok: false,
    error: typeof resultOrError === 'string' ? resultOrError : String(resultOrError),
  };
}

/**
 * @param {string} collection
 * @param {'insert'|'update'|'delete'|'merge'} op
 * @param {string} id
 * @param {unknown} [doc]
 */
function emitNotify(collection, op, id, doc) {
  /** @type {import('./db-protocol.js').DbNotify} */
  const payload = { type: 'NOTIFY', collection, op, id };
  if (doc !== undefined) payload.doc = toCloneable(doc);
  self.postMessage(payload);
}

/**
 * Decode wire values from sync-changesets (base64 site_id / { $b64 } val).
 * @param {unknown} value
 * @returns {unknown}
 */
function fromWireValue(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof /** @type {{ $b64?: string }} */ (value).$b64 === 'string'
  ) {
    return b64ToBuf(/** @type {{ $b64: string }} */ (value).$b64);
  }
  return value;
}

/**
 * @param {string|null|undefined} siteIdB64
 * @returns {Uint8Array|null}
 */
function siteIdFromB64(siteIdB64) {
  if (siteIdB64 == null || siteIdB64 === '') return null;
  return b64ToBuf(siteIdB64);
}

/**
 * Apply a remote changeset and notify Layer 1 subscribers for affected
 * `sb_*` collections.
 * @param {unknown} payload
 * @returns {Promise<{ applied: number, collections: string[] }>}
 */
async function applyChangesetPayload(payload) {
  const changes = Array.isArray(payload)
    ? payload
    : Array.isArray(/** @type {{ changes?: unknown }} */ (payload)?.changes)
      ? /** @type {{ changes: object[] }} */ (payload).changes
      : null;

  if (!changes) {
    throw new Error('changeset_apply: expected ChangesetPayload or ChangeRow[]');
  }

  /** @type {Set<string>} */
  const collections = new Set();
  let applied = 0;

  for (const row of changes) {
    const table = /** @type {{ table?: string }} */ (row).table;
    if (!table) throw new Error('changeset_apply: change row missing table');

    try {
      await runSql(
        `INSERT INTO crsql_changes
          ("table", "pk", "cid", "val", "col_version", "db_version", "site_id", "cl", "seq")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          table,
          fromWireValue(row.pk),
          row.cid,
          fromWireValue(row.val),
          row.col_version,
          row.db_version,
          siteIdFromB64(row.site_id),
          row.cl,
          row.seq,
        ],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `changeset_apply failed on ${table}.${row.cid} @db_version=${row.db_version}: ${msg}`,
      );
    }
    applied += 1;

    const collection = collectionNameFromTable(table);
    if (collection) {
      collections.add(collection);
      ensuredCollections.add(collection);
    } else if (
      typeof table === 'string' &&
      table.startsWith(COLLECTION_TABLE_PREFIX)
    ) {
      // Unknown / invalid suffix — still mark prefix awareness.
    }
  }

  const list = [...collections];
  for (const name of list) {
    emitNotify(name, 'merge', '*');
  }

  return { applied, collections: list };
}

/**
 * OPFS AccessHandlePoolVFS directory/name must be unique per open DB.
 * Two workers sharing one pool name fight over sync-access handles.
 * @param {string} filename
 */
function vfsNameForFilename(filename) {
  const safe = String(filename || DEFAULT_DB_FILENAME)
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `solebase-${safe || 'db'}`;
}

/**
 * @param {string} [wasmUrl]
 * @param {string} [vfsName]
 */
async function loadSqlite(wasmUrl, vfsName = 'solebase-crsqlite') {
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
  const vfs = new AccessHandlePoolVFS(vfsName);
  await vfs.isReady;
  api.vfs_register(vfs, false);
  return { api, SQLiteModule: SQLite, vfsName };
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
    const vfsName = vfsNameForFilename(filename);
    const { api, SQLiteModule } = await loadSqlite(opts.wasmUrl, vfsName);
    sqlite3 = api;
    SQLiteConsts = SQLiteModule;

    const flags =
      SQLiteModule.SQLITE_OPEN_CREATE |
      SQLiteModule.SQLITE_OPEN_READWRITE |
      SQLiteModule.SQLITE_OPEN_URI;

    // AccessHandlePoolVFS always exposes zName "AccessHandlePool"; the
    // constructor arg is only the OPFS directory (unique per DB above).
    dbPtr = await api.open_v2(filename, flags, 'AccessHandlePool');
    openFilename = filename;
    ensuredCollections.clear();

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
 * @param {string} name
 */
async function ensureCollection(name) {
  const table = collectionTableName(name);
  if (ensuredCollections.has(name)) return table;

  // cr-sqlite requires DEFAULT on non-PK NOT NULL columns for forwards/backwards schema compat.
  await runSql(
    `CREATE TABLE IF NOT EXISTS "${table}" (
      id TEXT PRIMARY KEY NOT NULL,
      doc TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0
    )`,
    [],
  );

  try {
    // Table name is validated by collectionTableName(); crsql_as_crr needs a literal.
    // Must collect rows so the SELECT side-effect fully runs under wa-sqlite.
    await runSql(`SELECT crsql_as_crr('${table}') AS ok`, [], { rows: true });
  } catch (err) {
    // Plain SQL still works if CRR registration fails (older wasm / already CRR).
    console.warn('[db-worker] crsql_as_crr failed for', table, err);
  }

  ensuredCollections.add(name);
  return table;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
function parseDoc(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return /** @type {Record<string, unknown>} */ (raw);
  }
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {import('./db-protocol.js').DbRequest} msg
 * @returns {Promise<import('./db-protocol.js').DbResponse>}
 */
async function handleMessage(msg) {
  const key = requestKey(msg);
  const type = msg.type;
  if (key === -1 || !type) {
    return respond(key, false, 'invalid message: need id/requestId and type');
  }

  try {
    switch (type) {
      case 'init': {
        await enqueue(() => ensureInit({ filename: msg.filename, wasmUrl: msg.wasmUrl }));
        return respond(key, true, {
          filename: openFilename,
          vfs: 'AccessHandlePool',
          storage: 'opfs',
        });
      }

      case 'exec':
      case 'run':
      case 'EXEC': {
        if (!msg.sql || typeof msg.sql !== 'string') {
          return respond(key, false, 'exec/run/EXEC requires sql string');
        }
        await enqueue(() => ensureInit());
        const result = await enqueue(() =>
          runSql(msg.sql, Array.isArray(msg.params) ? msg.params : [], { rows: false }),
        );
        return respond(key, true, toCloneable(result));
      }

      case 'select':
      case 'QUERY': {
        if (!msg.sql || typeof msg.sql !== 'string') {
          return respond(key, false, 'select/QUERY requires sql string');
        }
        await enqueue(() => ensureInit());
        const result = await enqueue(() =>
          runSql(msg.sql, Array.isArray(msg.params) ? msg.params : [], { rows: true }),
        );
        return respond(key, true, toCloneable(result.rows));
      }

      case 'collection_ensure': {
        if (!msg.name) return respond(key, false, 'collection_ensure requires name');
        await enqueue(() => ensureInit());
        const table = await enqueue(() => ensureCollection(msg.name));
        return respond(key, true, { name: msg.name, table });
      }

      case 'collection_insert': {
        if (!msg.name) return respond(key, false, 'collection_insert requires name');
        const doc = parseDoc(msg.doc);
        if (!doc) return respond(key, false, 'collection_insert requires doc object');
        const docId = typeof msg.docId === 'string' ? msg.docId : typeof doc.id === 'string' ? doc.id : null;
        if (!docId) return respond(key, false, 'collection_insert requires docId / doc.id');
        const stored = { ...doc, id: docId };
        const json = JSON.stringify(stored);
        const now = Date.now();

        await enqueue(() => ensureInit());
        await enqueue(async () => {
          const table = await ensureCollection(msg.name);
          await runSql(
            `INSERT INTO "${table}" (id, doc, updated_at) VALUES (?, ?, ?)`,
            [docId, json, now],
          );
        });
        emitNotify(msg.name, 'insert', docId, stored);
        return respond(key, true, stored);
      }

      case 'collection_update': {
        if (!msg.name || typeof msg.docId !== 'string') {
          return respond(key, false, 'collection_update requires name and docId');
        }
        const patch = parseDoc(msg.doc);
        if (!patch) return respond(key, false, 'collection_update requires doc object');

        await enqueue(() => ensureInit());
        const updated = await enqueue(async () => {
          const table = await ensureCollection(msg.name);
          const { rows } = await runSql(
            `SELECT doc FROM "${table}" WHERE id = ?`,
            [msg.docId],
            { rows: true },
          );
          if (!rows.length) {
            throw new Error(`document not found: ${msg.docId}`);
          }
          const existing = parseDoc(rows[0].doc) || {};
          const stored = { ...existing, ...patch, id: msg.docId };
          const json = JSON.stringify(stored);
          const now = Date.now();
          await runSql(
            `UPDATE "${table}" SET doc = ?, updated_at = ? WHERE id = ?`,
            [json, now, msg.docId],
          );
          return stored;
        });
        emitNotify(msg.name, 'update', msg.docId, updated);
        return respond(key, true, updated);
      }

      case 'collection_delete': {
        if (!msg.name || typeof msg.docId !== 'string') {
          return respond(key, false, 'collection_delete requires name and docId');
        }
        await enqueue(() => ensureInit());
        await enqueue(async () => {
          const table = await ensureCollection(msg.name);
          await runSql(`DELETE FROM "${table}" WHERE id = ?`, [msg.docId]);
        });
        emitNotify(msg.name, 'delete', msg.docId);
        return respond(key, true, { id: msg.docId, deleted: true });
      }

      case 'collection_findById': {
        if (!msg.name || typeof msg.docId !== 'string') {
          return respond(key, false, 'collection_findById requires name and docId');
        }
        await enqueue(() => ensureInit());
        const doc = await enqueue(async () => {
          const table = await ensureCollection(msg.name);
          const { rows } = await runSql(
            `SELECT doc FROM "${table}" WHERE id = ?`,
            [msg.docId],
            { rows: true },
          );
          if (!rows.length) return null;
          return parseDoc(rows[0].doc);
        });
        return respond(key, true, toCloneable(doc));
      }

      case 'collection_find': {
        if (!msg.name) return respond(key, false, 'collection_find requires name');
        await enqueue(() => ensureInit());
        const docs = await enqueue(async () => {
          const table = await ensureCollection(msg.name);
          const { rows } = await runSql(
            `SELECT doc FROM "${table}" ORDER BY updated_at ASC, id ASC`,
            [],
            { rows: true },
          );
          /** @type {Record<string, unknown>[]} */
          const out = [];
          for (const row of rows) {
            const d = parseDoc(row.doc);
            if (d) out.push(d);
          }
          return out;
        });
        return respond(key, true, toCloneable(docs));
      }

      case 'changeset_apply': {
        if (msg.payload == null) {
          return respond(key, false, 'changeset_apply requires payload');
        }
        await enqueue(() => ensureInit());
        const result = await enqueue(() => applyChangesetPayload(msg.payload));
        return respond(key, true, toCloneable(result));
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
          ensuredCollections.clear();
        });
        return respond(key, true, { closed: true });
      }

      default:
        return respond(key, false, `unknown type: ${type}`);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return respond(key, false, error);
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
