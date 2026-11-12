/**
 * db-api.js — Solebase Layer 1 facade for the Notes example
 *
 * App code never talks to OPFS, cr-sqlite, or the worker directly:
 *
 *   import { db } from '../core/db-api.js';
 *   await db.ready();
 *   await db.collection('notes').add({ title, body });
 *   db.collection('notes').subscribe((rows) => render(rows));
 *
 * Local source of truth: OPFS-backed cr-sqlite via Solebase.init + collection().
 * Optional Settings sync still exports/imports collection snapshots (E2EE).
 */

import { Solebase } from '../../../packages/solebase/dist/index.js';

const APP_ID = 'notes';
const DEVICE_KEY = 'solebase:notes:deviceKey';
/** Known collections for vault export / import. */
const KNOWN = ['notes', 'folders'];

/** @type {import('../../../packages/solebase/dist/index.js').Solebase | null} */
let solebase = null;
/** @type {Promise<import('../../../packages/solebase/dist/index.js').Solebase> | null} */
let initPromise = null;

function deviceEncryptionKey() {
  try {
    let key = localStorage.getItem(DEVICE_KEY);
    if (!key) {
      key = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      localStorage.setItem(DEVICE_KEY, key);
    }
    return key;
  } catch {
    return 'solebase-notes-fallback-device-key';
  }
}

/**
 * Start Solebase (worker + OPFS). Idempotent.
 * @returns {Promise<import('../../../packages/solebase/dist/index.js').Solebase>}
 */
export async function ready() {
  if (solebase) return solebase;
  if (!initPromise) {
    if (!globalThis.isSecureContext) {
      throw new Error('Solebase needs a secure context (localhost or https)');
    }
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS is not available in this browser');
    }
    const workerUrl = new URL('../../../core/db-worker.js', import.meta.url);
    initPromise = Solebase.init({
      appId: APP_ID,
      encryptionKey: deviceEncryptionKey(),
      workerUrl,
    }).then((instance) => {
      solebase = instance;
      return instance;
    });
  }
  return initPromise;
}

/**
 * Compatibility handle — mirrors the old PromptDB-shaped API used by notes.js
 * and settings-panel, backed by Solebase Collection.
 */
class CollectionHandle {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }

  async _col() {
    const sb = await ready();
    return sb.collection(this.name);
  }

  /** @returns {Promise<object[]>} */
  async get() {
    const col = await this._col();
    return col.find();
  }

  /**
   * @param {object} item
   * @returns {Promise<object>}
   */
  async add(item) {
    const col = await this._col();
    const now = Date.now();
    const doc = {
      ...item,
      updatedAt: item?.updatedAt || now,
    };
    return col.insert(doc);
  }

  /**
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object|null>}
   */
  async update(id, patch) {
    const col = await this._col();
    return col.update(id, { ...patch, updatedAt: Date.now() });
  }

  /**
   * Hard-delete (Solebase has no tombstones).
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    const col = await this._col();
    await col.delete(id);
    return true;
  }

  /**
   * @param {(rows: object[]) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('subscribe expects a function');
    }
    let unsub = null;
    let cancelled = false;
    this._col().then((col) => {
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
    const col = await this._col();
    return col.findById(id);
  }
}

/**
 * Public db facade (Solebase Layer 1).
 */
export const db = {
  ready,

  /**
   * @param {string} name
   * @returns {CollectionHandle}
   */
  collection(name) {
    return new CollectionHandle(name);
  },

  /**
   * Export every known collection (for Settings backup / legacy sync adapters).
   * @returns {Promise<Record<string, object[]>>}
   */
  async exportSnapshot() {
    await ready();
    const out = {};
    for (const name of KNOWN) {
      out[name] = await this.collection(name).get();
    }
    return out;
  },

  /**
   * Apply a remote collections map with per-record LWW on `updatedAt`.
   * @param {Record<string, object[]>} collections
   * @returns {Promise<boolean>} true if anything changed
   */
  async applyRemoteSnapshot(collections) {
    if (!collections || typeof collections !== 'object') return false;
    await ready();
    let changed = false;
    for (const [name, items] of Object.entries(collections)) {
      if (!Array.isArray(items)) continue;
      const col = await this.collection(name)._col();
      for (const item of items) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
        const existing = await col.findById(item.id);
        const remoteTs = Number(item.updatedAt) || 0;
        if (!existing) {
          await col.insert({ ...item, id: item.id });
          changed = true;
          continue;
        }
        const localTs = Number(existing.updatedAt) || 0;
        if (remoteTs >= localTs) {
          const { id, ...rest } = item;
          await col.update(id, rest);
          changed = true;
        }
      }
    }
    return changed;
  },

  /** @returns {Promise<string[]>} */
  async listCollections() {
    return [...KNOWN];
  },

  /** Underlying Solebase instance (after ready). */
  get solebase() {
    return solebase;
  },
};

export default db;
