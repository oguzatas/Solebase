/**
 * yjs-sqlite-provider.js — Persist a Y.Doc in Layer 3 cr-sqlite (OPFS).
 *
 * One row per document_id; the update_blob is the full merged state from
 * Y.encodeStateAsUpdate(doc) (not a log of incremental updates). Writes are
 * debounced; call flush() / destroy() for a final save.
 *
 * All SQL goes through createDbClient → db-worker (no IndexedDB / localStorage).
 *
 *   import { openYDoc, YjsSqliteProvider } from '../core/yjs-sqlite-provider.js';
 *   const { doc, provider } = await openYDoc(dbClient, 'note:1');
 *   doc.getText('body').insert(0, 'hello');
 *   await provider.destroy();
 */

import * as Y from 'https://esm.sh/yjs@13.6.27';

/** Schema created once per provider load (IF NOT EXISTS). */
export const YJS_DOCUMENTS_DDL = `
CREATE TABLE IF NOT EXISTS yjs_documents (
  document_id TEXT PRIMARY KEY NOT NULL,
  update_blob BLOB NOT NULL
)
`;

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * @typedef {import('./db-client.js').DbClient} DbClient
 */

/**
 * @typedef {object} YjsSqliteProviderOptions
 * @property {DbClient} dbClient
 * @property {string} documentId
 * @property {Y.Doc} [doc]  Existing doc; default new Y.Doc()
 * @property {number} [debounceMs]  Persist debounce (default 250)
 */

/**
 * Main-thread Yjs ↔ SQLite adapter. Layer 1 can wrap this later.
 */
export class YjsSqliteProvider {
  /**
   * @param {YjsSqliteProviderOptions} options
   */
  constructor(options) {
    if (!options?.dbClient) throw new Error('YjsSqliteProvider requires { dbClient }');
    if (!options?.documentId || typeof options.documentId !== 'string') {
      throw new Error('YjsSqliteProvider requires { documentId: string }');
    }

    this.dbClient = options.dbClient;
    this.documentId = options.documentId;
    this.doc = options.doc || new Y.Doc();
    this.debounceMs =
      typeof options.debounceMs === 'number' && options.debounceMs >= 0
        ? options.debounceMs
        : DEFAULT_DEBOUNCE_MS;

    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
    /** @type {((update: Uint8Array, origin: unknown) => void)|null} */
    this._onUpdate = null;
    this._dirty = false;
    this._loaded = false;
    this._destroyed = false;
    /** @type {Promise<void>} */
    this._writeChain = Promise.resolve();
  }

  /**
   * Ensure schema, load blob for document_id, apply into doc, subscribe for saves.
   * @returns {Promise<Y.Doc>}
   */
  async load() {
    this._assertAlive();
    await this.dbClient.exec(YJS_DOCUMENTS_DDL);

    const rows = await this.dbClient.select(
      'SELECT update_blob FROM yjs_documents WHERE document_id = ?',
      [this.documentId],
    );

    if (rows.length > 0) {
      const blob = coerceToUint8Array(rows[0].update_blob);
      if (blob && blob.byteLength > 0) {
        // Origin marks this apply so we do not treat it as a local edit to persist.
        Y.applyUpdate(this.doc, blob, this);
      }
    }

    this._onUpdate = (_update, origin) => {
      if (origin === this) return;
      this._dirty = true;
      this._schedulePersist();
    };
    this.doc.on('update', this._onUpdate);
    this._loaded = true;
    return this.doc;
  }

  /**
   * Write the current full document state immediately (cancels pending debounce).
   * @returns {Promise<void>}
   */
  async flush() {
    this._assertAlive();
    if (this._timer != null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._loaded) return;
    this._writeChain = this._writeChain.then(() => this._persistNow());
    await this._writeChain;
  }

  /**
   * Unsubscribe, flush if dirty, destroy the Y.Doc.
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._destroyed) return;
    if (this._timer != null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._onUpdate) {
      this.doc.off('update', this._onUpdate);
      this._onUpdate = null;
    }
    try {
      if (this._loaded && this._dirty) {
        this._writeChain = this._writeChain.then(() => this._persistNow());
      }
      await this._writeChain;
    } finally {
      this._destroyed = true;
      this.doc.destroy();
    }
  }

  /** @private */
  _schedulePersist() {
    if (this._destroyed) return;
    if (this._timer != null) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._writeChain = this._writeChain
        .then(() => this._persistNow())
        .catch((err) => {
          console.error('[yjs-sqlite-provider] persist failed:', err);
        });
    }, this.debounceMs);
  }

  /** @private */
  async _persistNow() {
    this._assertAlive();
    const update = Y.encodeStateAsUpdate(this.doc);
    await this.dbClient.exec(
      `INSERT INTO yjs_documents (document_id, update_blob) VALUES (?, ?)
       ON CONFLICT(document_id) DO UPDATE SET update_blob = excluded.update_blob`,
      [this.documentId, update],
    );
    this._dirty = false;
  }

  /** @private */
  _assertAlive() {
    if (this._destroyed) throw new Error('YjsSqliteProvider destroyed');
  }
}

/**
 * Open (or create) a Y.Doc backed by cr-sqlite for the given document id.
 *
 * @param {DbClient} dbClient
 * @param {string} documentId
 * @param {Omit<YjsSqliteProviderOptions, 'dbClient'|'documentId'>} [options]
 * @returns {Promise<{ doc: Y.Doc, provider: YjsSqliteProvider }>}
 */
export async function openYDoc(dbClient, documentId, options = {}) {
  const provider = new YjsSqliteProvider({
    dbClient,
    documentId,
    ...options,
  });
  const doc = await provider.load();
  return { doc, provider };
}

/**
 * Normalize SELECT blob cells to Uint8Array for Y.applyUpdate.
 * Supports Uint8Array, ArrayBuffer, number[] (mangled clone), and base64 string.
 * @param {unknown} value
 * @returns {Uint8Array|null}
 */
export function coerceToUint8Array(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') {
    // base64 fallback if a future path stores text
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    const keys = Object.keys(value);
    if (!keys.length) return new Uint8Array(0);
    const numeric = keys.every((k) => /^\d+$/.test(k));
    if (numeric) {
      const len = Math.max(...keys.map((k) => Number(k))) + 1;
      const out = new Uint8Array(len);
      for (const k of keys) out[Number(k)] = Number(/** @type {any} */ (value)[k]) & 0xff;
      return out;
    }
  }
  throw new Error('yjs update_blob: unsupported type ' + Object.prototype.toString.call(value));
}

export { Y };
