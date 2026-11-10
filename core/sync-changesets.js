/**
 * sync-changesets.js — Extract / apply cr-sqlite changesets via Layer 3 db-client
 *
 * Uses the documented `crsql_changes` virtual table:
 *   https://vlcn.io/docs/cr-sqlite/api-methods/crsql_changes
 *
 * Cursor = last seen `db_version` (Lamport clock for the whole DB).
 * Pull:  SELECT … FROM crsql_changes WHERE db_version > :cursor
 * Apply: INSERT INTO crsql_changes (…) VALUES (?,?,?,?,?,?,?,?,?) with bind params
 *
 * All SQL goes through db-client → worker. No IndexedDB. No main-thread SQLite.
 */

import { bufToB64, b64ToBuf } from './sync-crypto.js';

/** Payload format version for encrypted / stored changesets. */
export const CHANGESET_FORMAT_V = 1;

/**
 * @typedef {number} SyncCursor
 * Last fully-seen `db_version`. Use `0` to read from the beginning.
 */

/**
 * @typedef {object} ChangeRow
 * @property {string} table
 * @property {unknown} pk  string or `{ $b64 }` for binary cr-sqlite PK blob
 * @property {string} cid
 * @property {unknown} val
 * @property {number} col_version
 * @property {number} db_version
 * @property {string|null} site_id  base64 of site_id BLOB (or null)
 * @property {number} cl
 * @property {number} seq
 */

/**
 * @typedef {object} ChangesetPayload
 * @property {number} v
 * @property {ChangeRow[]} changes
 * @property {SyncCursor} cursor   max db_version in this batch (unchanged if empty)
 * @property {SyncCursor} since    cursor used for the query
 */

/**
 * Mark a binary value for JSON / encrypt round-trips.
 * @param {unknown} value
 * @returns {unknown}
 */
function toWireValue(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (value instanceof ArrayBuffer) {
    return { $b64: bufToB64(value) };
  }
  if (ArrayBuffer.isView(value)) {
    return { $b64: bufToB64(value) };
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function fromWireValue(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.$b64 === 'string'
  ) {
    return b64ToBuf(value.$b64);
  }
  return value;
}

/**
 * @param {unknown} siteId
 * @returns {string|null}
 */
function siteIdToB64(siteId) {
  if (siteId == null) return null;
  if (typeof siteId === 'string') {
    // Already base64 from a prior round-trip, or unexpected text — keep as-is if not binary.
    return siteId;
  }
  if (siteId instanceof ArrayBuffer || ArrayBuffer.isView(siteId)) {
    return bufToB64(siteId);
  }
  return null;
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
 * Normalize a raw SELECT row from crsql_changes into a serializable ChangeRow.
 * @param {Record<string, unknown>} row
 * @returns {ChangeRow}
 */
export function normalizeChangeRow(row) {
  const table = /** @type {string} */ (row.table ?? row.table_name);
  return {
    table,
    // PK is a cr-sqlite-encoded BLOB — must survive JSON/E2EE as `{ $b64 }`, not String(Uint8Array).
    pk: toWireValue(row.pk ?? ''),
    cid: String(row.cid ?? ''),
    val: toWireValue(row.val),
    col_version: Number(row.col_version ?? 0),
    db_version: Number(row.db_version ?? 0),
    site_id: siteIdToB64(row.site_id),
    cl: Number(row.cl ?? 0),
    seq: Number(row.seq ?? 0),
  };
}

/**
 * Current database Lamport clock (`crsql_db_version()`).
 * @param {import('./db-client.js').DbClient} dbClient
 * @returns {Promise<number>}
 */
export async function getDbVersion(dbClient) {
  const rows = await dbClient.select('SELECT crsql_db_version() AS v');
  return Number(rows[0]?.v ?? 0);
}

/**
 * Local site id as base64 (for peer filters / debugging — do not log in production paths).
 * @param {import('./db-client.js').DbClient} dbClient
 * @returns {Promise<string|null>}
 */
export async function getSiteIdB64(dbClient) {
  const rows = await dbClient.select('SELECT crsql_site_id() AS site_id');
  return siteIdToB64(rows[0]?.site_id);
}

/**
 * Promote a normal table to a conflict-free replicated relation.
 * Call after CREATE TABLE. Idempotent enough for smoke (re-running may error — catch in callers).
 * @param {import('./db-client.js').DbClient} dbClient
 * @param {string} tableName
 */
export async function asCrr(dbClient, tableName) {
  if (!tableName || typeof tableName !== 'string') {
    throw new Error('asCrr: tableName required');
  }
  // Documented API: SELECT crsql_as_crr('table')
  await dbClient.select('SELECT crsql_as_crr(?) AS ok', [tableName]);
}

/**
 * Query `crsql_changes` for rows after `cursor` (exclusive).
 *
 * @param {import('./db-client.js').DbClient} dbClient
 * @param {SyncCursor|{ dbVersion?: number }} cursor  last seen db_version (0 = all)
 * @param {{ excludeSiteIdB64?: string|null, table?: string }} [options]
 * @returns {Promise<ChangesetPayload>}
 */
export async function getChangesSince(dbClient, cursor = 0, options = {}) {
  if (!dbClient?.select) {
    throw new Error('getChangesSince: dbClient with select() required');
  }

  const since =
    typeof cursor === 'object' && cursor != null
      ? Number(cursor.dbVersion ?? 0)
      : Number(cursor || 0);

  /** @type {unknown[]} */
  const params = [since];
  let sql = `
    SELECT
      "table" AS table_name,
      "pk",
      "cid",
      "val",
      "col_version",
      "db_version",
      COALESCE("site_id", crsql_site_id()) AS site_id,
      "cl",
      "seq"
    FROM crsql_changes
    WHERE "db_version" > ?
  `;

  if (options.table) {
    sql += ` AND "table" = ?`;
    params.push(options.table);
  }

  if (options.excludeSiteIdB64) {
    // Compare BLOBs via bind of decoded bytes.
    sql += ` AND ("site_id" IS NULL OR "site_id" IS NOT ?)`;
    params.push(siteIdFromB64(options.excludeSiteIdB64));
  }

  sql += ` ORDER BY "db_version" ASC, "seq" ASC`;

  const raw = await dbClient.select(sql, params);
  const changes = (raw || []).map((row) => normalizeChangeRow(/** @type {Record<string, unknown>} */ (row)));

  let maxVersion = since;
  for (const ch of changes) {
    if (ch.db_version > maxVersion) maxVersion = ch.db_version;
  }

  return {
    v: CHANGESET_FORMAT_V,
    changes,
    cursor: maxVersion,
    since,
  };
}

/**
 * Apply a changeset by inserting rows into `crsql_changes` (cr-sqlite merge path).
 * Must use bind parameters — never interpolate values into SQL.
 *
 * @param {import('./db-client.js').DbClient} dbClient
 * @param {ChangesetPayload|ChangeRow[]} payload
 * @returns {Promise<{ applied: number }>}
 */
export async function applyChangeset(dbClient, payload) {
  if (!dbClient?.exec) {
    throw new Error('applyChangeset: dbClient with exec() required');
  }

  const changes = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.changes)
      ? payload.changes
      : null;

  if (!changes) {
    throw new Error('applyChangeset: expected ChangesetPayload or ChangeRow[]');
  }

  let applied = 0;
  for (const row of changes) {
    const table = row.table;
    if (!table) throw new Error('applyChangeset: change row missing table');

    await dbClient.exec(
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
    applied += 1;
  }

  return { applied };
}

/**
 * Convenience: create a minimal CRR table if missing (smoke / bootstrap).
 * @param {import('./db-client.js').DbClient} dbClient
 * @param {string} [tableName='sync_items']
 */
export async function ensureSmokeCrr(dbClient, tableName = 'sync_items') {
  await dbClient.exec(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (
      id TEXT PRIMARY KEY NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  try {
    await asCrr(dbClient, tableName);
  } catch (err) {
    // Already a CRR on re-open — ignore "already" style failures.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already|exist/i.test(msg)) throw err;
  }
}

/** @param {string} name */
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid SQL identifier: ${name}`);
  }
  return `"${name}"`;
}
