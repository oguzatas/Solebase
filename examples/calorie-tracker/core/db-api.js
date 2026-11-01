/**
 * db-api.js — Collections facade for Prompt2UI apps
 *
 * App code never talks to adapters, crypto, or sync directly:
 *
 *   import { db } from '../core/db-api.js';
 *   await db.collection('meals').add({ name, calories });
 *   db.collection('meals').subscribe((rows) => render(rows));
 *
 * Local source of truth is IndexedDB (via PromptDB). SyncEngine listens
 * for writes and pushes encrypted snapshots when Settings has a remote
 * adapter + passphrase.
 */

import { PromptDB, listCollectionNames } from './prompt-db.js';
import { syncEngine } from './sync-engine.js';

/** @type {Map<string, PromptDB>} */
const openCollections = new Map();

function onCollectionChange(_name) {
  syncEngine.notifyLocalWrite();
}

/**
 * Ensure a collection is open and cached.
 * @param {string} name
 * @returns {Promise<PromptDB>}
 */
async function ensureCollection(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('collection name is required');
  }
  let col = openCollections.get(name);
  if (col) {
    await col.ready();
    return col;
  }
  col = await PromptDB.open(name, { onChange: onCollectionChange });
  openCollections.set(name, col);
  return col;
}

/**
 * Handle returned by db.collection(name). Lazy-opens on first use.
 */
class CollectionHandle {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    /** @type {PromptDB|null} */
    this._db = null;
  }

  async _ready() {
    if (!this._db) this._db = await ensureCollection(this.name);
    return this._db;
  }

  /** @returns {Promise<object[]>} live rows */
  async get() {
    const col = await this._ready();
    return col.get();
  }

  /**
   * @param {object} item
   * @returns {Promise<object>}
   */
  async add(item) {
    const col = await this._ready();
    return col.add(item);
  }

  /**
   * Replace entire collection (array of records).
   * @param {object[]} items
   * @returns {Promise<object[]>}
   */
  async set(items) {
    const col = await this._ready();
    return col.set(items);
  }

  /**
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object|null>}
   */
  async update(id, patch) {
    const col = await this._ready();
    return col.update(id, patch);
  }

  /**
   * Soft-delete (tombstone) by id.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    const col = await this._ready();
    return col.remove(id);
  }

  /**
   * Subscribe to live rows. Opens the collection if needed.
   * @param {(rows: object[]) => void} listener
   * @returns {() => void} unsubscribe (sync; pending open is cancelled)
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('subscribe expects a function');
    }
    let unsub = null;
    let cancelled = false;
    this._ready().then((col) => {
      if (cancelled) return;
      unsub = col.subscribe(listener);
    });
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }

  /** @param {string} id */
  async find(id) {
    const col = await this._ready();
    return col.find(id);
  }

  async clear() {
    const col = await this._ready();
    return col.clear();
  }
}

/**
 * Public db facade.
 */
export const db = {
  /**
   * @param {string} name
   * @returns {CollectionHandle}
   */
  collection(name) {
    return new CollectionHandle(name);
  },

  /**
   * Export every known collection including tombstones (for sync / backup).
   * @returns {Promise<Record<string, object[]>>}
   */
  async exportSnapshot() {
    const names = await listCollectionNames();
    // Include any already-open collections that might not be listed yet
    for (const name of openCollections.keys()) names.push(name);
    const unique = [...new Set(names)];
    const out = {};
    for (const name of unique) {
      const col = await ensureCollection(name);
      out[name] = col.exportAll();
    }
    return out;
  },

  /**
   * Apply a remote collections map with per-record LWW merge.
   * @param {Record<string, object[]>} collections
   * @returns {Promise<boolean>} true if anything changed
   */
  async applyRemoteSnapshot(collections) {
    if (!collections || typeof collections !== 'object') return false;
    let changed = false;
    for (const [name, items] of Object.entries(collections)) {
      if (!Array.isArray(items)) continue;
      const col = await ensureCollection(name);
      const result = await col.mergeLWW(items);
      if (result.changed) changed = true;
    }
    return changed;
  },

  /** @returns {Promise<string[]>} */
  async listCollections() {
    const names = await listCollectionNames();
    for (const name of openCollections.keys()) names.push(name);
    return [...new Set(names)].sort();
  },
};

export default db;
