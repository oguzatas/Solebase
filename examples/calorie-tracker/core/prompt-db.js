/**
 * prompt-db.js — Local-first reactive store for Prompt2UI
 *
 * Persistence: IndexedDB (primary) with localStorage fallback.
 * Reactivity: subscribe/emit so UIs re-render on every mutation.
 *
 * Records always get `id` + `updatedAt`. Deletes are soft (tombstones:
 * `{ id, updatedAt, _deleted: true }`) so sync can LWW-merge across devices.
 * App-facing get/subscribe hide tombstones unless asked.
 */

const IDB_NAME = 'prompt2ui';
const IDB_VERSION = 1;
const STORE = 'collections';
const LS_PREFIX = 'prompt2ui:db:';

/** Generate a compact unique id */
export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Detect IndexedDB availability */
function canUseIDB() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Open (or create) the shared IndexedDB database */
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

/** Read a collection document from IDB */
async function idbGet(name) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(name);
    req.onsuccess = () => resolve(req.result?.items ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Write a collection document to IDB */
async function idbSet(name, items) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ name, items, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** List all collection names stored in IndexedDB */
async function idbListNames() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** localStorage fallback helpers */
function lsGet(name) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + name);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function lsSet(name, items) {
  localStorage.setItem(LS_PREFIX + name, JSON.stringify(items));
}

function lsListNames() {
  const names = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(LS_PREFIX)) {
      names.push(key.slice(LS_PREFIX.length));
    }
  }
  return names;
}

function cloneItem(item) {
  return { ...item };
}

function isTombstone(item) {
  return Boolean(item && item._deleted);
}

function liveOnly(items) {
  return items.filter((i) => !isTombstone(i)).map(cloneItem);
}

/**
 * PromptDB — reactive collection store
 *
 * Data shape: an array of objects, each with at least `{ id, updatedAt }`.
 * Mutations always persist then notify subscribers.
 */
export class PromptDB {
  /**
   * @param {string} collectionName - Unique key for this app's collection
   * @param {{ useIDB?: boolean, onChange?: () => void }} [options]
   */
  constructor(collectionName, options = {}) {
    if (!collectionName || typeof collectionName !== 'string') {
      throw new Error('PromptDB requires a collection name');
    }
    this.name = collectionName;
    this._items = [];
    this._listeners = new Set();
    this._useIDB = options.useIDB !== false && canUseIDB();
    this._onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this._ready = false;
  }

  /**
   * Open (load) a collection. Call once before other methods,
   * or use the static `PromptDB.open()` helper.
   * @returns {Promise<PromptDB>}
   */
  async ready() {
    if (this._ready) return this;
    let items = null;
    if (this._useIDB) {
      try {
        items = await idbGet(this.name);
      } catch (err) {
        console.warn('[PromptDB] IndexedDB read failed, falling back to localStorage', err);
        this._useIDB = false;
      }
    }
    if (items === null) {
      items = lsGet(this.name) ?? [];
    }
    this._items = Array.isArray(items) ? items : [];
    this._ready = true;
    return this;
  }

  /**
   * Factory: open a named collection and return a ready PromptDB.
   * @param {string} collectionName
   * @param {object} [options]
   * @returns {Promise<PromptDB>}
   */
  static async open(collectionName, options) {
    const db = new PromptDB(collectionName, options);
    await db.ready();
    return db;
  }

  /** Persist current items to IndexedDB or localStorage */
  async _persist() {
    if (this._useIDB) {
      try {
        await idbSet(this.name, this._items);
        try {
          lsSet(this.name, this._items);
        } catch {
          /* quota ok to ignore */
        }
        return;
      } catch (err) {
        console.warn('[PromptDB] IndexedDB write failed, using localStorage', err);
        this._useIDB = false;
      }
    }
    lsSet(this.name, this._items);
  }

  _notifyChange() {
    if (this._onChange) {
      try {
        this._onChange(this.name);
      } catch (err) {
        console.error('[PromptDB] onChange error', err);
      }
    }
  }

  /** Notify all subscribers with a shallow copy of live items */
  _emit() {
    const snapshot = this.get();
    for (const fn of this._listeners) {
      try {
        fn(snapshot);
      } catch (err) {
        console.error('[PromptDB] subscriber error', err);
      }
    }
  }

  /**
   * Subscribe to changes. Returns an unsubscribe function.
   * Immediately invokes the listener with the current live snapshot.
   * @param {(items: object[]) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('subscribe expects a function');
    }
    this._listeners.add(listener);
    if (this._ready) listener(this.get());
    return () => this._listeners.delete(listener);
  }

  /**
   * Get a shallow copy of live (non-tombstone) items.
   * @returns {object[]}
   */
  get() {
    return liveOnly(this._items);
  }

  /**
   * Export all records including tombstones (for sync / backup).
   * @returns {object[]}
   */
  exportAll() {
    return this._items.map(cloneItem);
  }

  /**
   * Replace the entire collection (including optional tombstones).
   * Ensures every record has id + updatedAt.
   * @param {object[]} data
   * @returns {Promise<object[]>} live items
   */
  async set(data) {
    if (!Array.isArray(data)) throw new Error('set() expects an array');
    const now = Date.now();
    this._items = data.map((item) => ({
      ...item,
      id: item.id ?? uid(),
      updatedAt: item.updatedAt ?? now,
    }));
    await this._persist();
    this._emit();
    this._notifyChange();
    return this.get();
  }

  /**
   * Append one item (auto-assigns `id`, `createdAt`, `updatedAt`).
   * @param {object} item
   * @returns {Promise<object>} The stored live item
   */
  async add(item) {
    if (!item || typeof item !== 'object') throw new Error('add() expects an object');
    const now = Date.now();
    const stored = {
      ...item,
      id: item.id ?? uid(),
      createdAt: item.createdAt ?? now,
      updatedAt: item.updatedAt ?? now,
      _deleted: false,
    };
    delete stored._deleted;
    this._items.push(stored);
    await this._persist();
    this._emit();
    this._notifyChange();
    return { ...stored };
  }

  /**
   * Update an existing item by id (shallow merge). Touches updatedAt.
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object|null>}
   */
  async update(id, patch) {
    const idx = this._items.findIndex((i) => i.id === id && !isTombstone(i));
    if (idx === -1) return null;
    const next = {
      ...this._items[idx],
      ...patch,
      id,
      updatedAt: Date.now(),
    };
    delete next._deleted;
    this._items[idx] = next;
    await this._persist();
    this._emit();
    this._notifyChange();
    return { ...this._items[idx] };
  }

  /**
   * Soft-delete an item by id (tombstone for sync).
   * @param {string} id
   * @returns {Promise<boolean>} true if something was tombstoned
   */
  async remove(id) {
    const idx = this._items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    if (isTombstone(this._items[idx])) return false;
    this._items[idx] = {
      id,
      updatedAt: Date.now(),
      _deleted: true,
    };
    await this._persist();
    this._emit();
    this._notifyChange();
    return true;
  }

  /**
   * Find one live item by id.
   * @param {string} id
   * @returns {object|undefined}
   */
  find(id) {
    const item = this._items.find((i) => i.id === id && !isTombstone(i));
    return item ? { ...item } : undefined;
  }

  /**
   * Clear the collection (tombstone every live row).
   * @returns {Promise<void>}
   */
  async clear() {
    const now = Date.now();
    this._items = this._items.map((item) =>
      isTombstone(item)
        ? item
        : { id: item.id, updatedAt: now, _deleted: true }
    );
    await this._persist();
    this._emit();
    this._notifyChange();
  }

  /**
   * Replace local rows with a remote snapshot using per-record LWW on updatedAt.
   * @param {object[]} remoteItems
   * @returns {Promise<{ changed: boolean, live: object[] }>}
   */
  async mergeLWW(remoteItems) {
    if (!Array.isArray(remoteItems)) {
      throw new Error('mergeLWW expects an array');
    }
    const byId = new Map(this._items.map((i) => [i.id, i]));
    let changed = false;

    for (const remote of remoteItems) {
      if (!remote || typeof remote !== 'object') continue;
      const id = remote.id ?? uid();
      const incoming = {
        ...remote,
        id,
        updatedAt: Number(remote.updatedAt) || 0,
      };
      const local = byId.get(id);
      if (!local) {
        byId.set(id, incoming);
        changed = true;
        continue;
      }
      const localTs = Number(local.updatedAt) || 0;
      const remoteTs = Number(incoming.updatedAt) || 0;
      if (remoteTs > localTs) {
        byId.set(id, incoming);
        changed = true;
      }
    }

    if (!changed) {
      return { changed: false, live: this.get() };
    }

    this._items = [...byId.values()];
    await this._persist();
    this._emit();
    // Do not notify sync engine — this write came from a pull/merge
    return { changed: true, live: this.get() };
  }

  /**
   * Import items, optionally merging with existing (id-based, not LWW).
   * @param {object[]} items
   * @param {{ merge?: boolean }} [opts]
   * @returns {Promise<object[]>}
   */
  async importAll(items, opts = {}) {
    if (!Array.isArray(items)) throw new Error('importAll expects an array');
    if (opts.merge) {
      const byId = new Map(this._items.map((i) => [i.id, i]));
      const now = Date.now();
      for (const item of items) {
        const id = item.id ?? uid();
        byId.set(id, {
          ...byId.get(id),
          ...item,
          id,
          updatedAt: item.updatedAt ?? now,
        });
      }
      return this.set([...byId.values()]);
    }
    return this.set(items);
  }

  /** Which backend is active */
  get backend() {
    return this._useIDB ? 'indexeddb' : 'localstorage';
  }
}

/**
 * Discover all known collection names (IDB + localStorage mirrors).
 * @returns {Promise<string[]>}
 */
export async function listCollectionNames() {
  const names = new Set(lsListNames());
  if (canUseIDB()) {
    try {
      for (const n of await idbListNames()) names.add(n);
    } catch (err) {
      console.warn('[PromptDB] listCollectionNames IDB failed', err);
    }
  }
  return [...names].sort();
}

export default PromptDB;
