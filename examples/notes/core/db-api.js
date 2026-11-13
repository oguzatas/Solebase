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
 * Optional Layer 1 S3/R2 sync (E2EE changesets) reads credentials from browser
 * localStorage only — never commit secrets.
 */

import { Solebase } from '../../../packages/solebase/dist/index.js';
import { loadSettings } from './prompt-storage.js';

const APP_ID = 'notes';
const DEVICE_KEY = 'solebase:notes:deviceKey';
/** Known collections for vault export / import. */
const KNOWN = ['notes', 'folders'];

/** Prefill for Cloudflare R2 (account 7701962a7c1ef34d73878ef8650ef733). */
export const R2_DEFAULTS = {
  endpoint: 'https://7701962a7c1ef34d73878ef8650ef733.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'solebase-sync-test',
  prefix: 'solebase-changesets',
};

/** @type {import('../../../packages/solebase/dist/index.js').Solebase | null} */
let solebase = null;
/** @type {Promise<import('../../../packages/solebase/dist/index.js').Solebase> | null} */
let initPromise = null;
/** Fingerprint of last applied sync options (detect credential changes). */
let lastSyncFingerprint = '';

export function getAppId() {
  return APP_ID;
}

/**
 * Device / shared encryption key (localStorage). Same key required on every device.
 * @returns {string}
 */
export function getEncryptionKey() {
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
 * Persist a shared encryption key (e.g. pasted from another device).
 * @param {string} key
 */
export function setEncryptionKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) throw new Error('encryptionKey must be a non-empty string');
  localStorage.setItem(DEVICE_KEY, trimmed);
  return trimmed;
}

/**
 * Build Layer 1 sync config from browser settings (no secrets in source).
 * @param {ReturnType<typeof loadSettings>} [settings]
 * @returns {{ provider: 's3', options: object } | undefined}
 */
export function buildS3SyncConfig(settings = loadSettings()) {
  const endpoint = (settings.s3Endpoint || R2_DEFAULTS.endpoint).replace(/\/$/, '');
  const region = settings.s3Region || R2_DEFAULTS.region;
  const bucket = settings.s3Bucket || R2_DEFAULTS.bucket;
  const accessKeyId = (settings.s3AccessKeyId || '').trim();
  const secretAccessKey = settings.s3SecretAccessKey || '';
  const prefix = (settings.s3Prefix || R2_DEFAULTS.prefix).trim() || R2_DEFAULTS.prefix;

  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }

  return {
    provider: 's3',
    options: {
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      prefix,
      autoSync: settings.solebaseAutoSync !== false,
      allowMemoryFallback: false,
    },
  };
}

function syncFingerprint(sync) {
  if (!sync?.options) return '';
  const o = sync.options;
  return [
    o.endpoint,
    o.region,
    o.bucket,
    o.accessKeyId,
    o.secretAccessKey,
    o.prefix,
    o.autoSync === false ? '0' : '1',
  ].join('|');
}

/**
 * Start Solebase (worker + OPFS). Idempotent until credentials change.
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<import('../../../packages/solebase/dist/index.js').Solebase>}
 */
export async function ready(opts = {}) {
  const sync = buildS3SyncConfig();
  const fp = syncFingerprint(sync);

  if (solebase && !opts.force && fp === lastSyncFingerprint) {
    return solebase;
  }

  if (solebase && (opts.force || fp !== lastSyncFingerprint)) {
    try {
      await solebase.close();
    } catch {
      /* ignore close races */
    }
    solebase = null;
    initPromise = null;
  }

  if (!initPromise) {
    if (!globalThis.isSecureContext) {
      throw new Error('Solebase needs a secure context (localhost or https)');
    }
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS is not available in this browser');
    }
    const workerUrl = new URL('../../../core/db-worker.js', import.meta.url);
    const encryptionKey = getEncryptionKey();
    /** @type {import('../../../packages/solebase/dist/index.js').SolebaseConfig} */
    const config = {
      appId: APP_ID,
      encryptionKey,
      workerUrl,
    };
    if (sync) {
      config.sync = sync;
    }
    initPromise = Solebase.init(config).then((instance) => {
      solebase = instance;
      lastSyncFingerprint = fp;
      return instance;
    });
  }
  return initPromise;
}

/**
 * Re-init Solebase after Settings save (picks up new R2 credentials).
 * @returns {Promise<import('../../../packages/solebase/dist/index.js').Solebase>}
 */
export async function reconfigure() {
  return ready({ force: true });
}

/**
 * Layer 1 syncNow — no-op shaped result when sync is not configured.
 * @param {string} [reason]
 */
export async function syncNow(reason = 'manual') {
  const sb = await ready();
  if (!sb.getSync()) {
    return {
      ok: false,
      reason: 'idle',
      detail: 'Paste R2 Access Key ID + Secret in Settings, then Save.',
    };
  }
  return sb.syncNow(reason);
}

/** @returns {boolean} */
export function hasSolebaseSync() {
  return Boolean(solebase?.getSync?.() || buildS3SyncConfig());
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
  reconfigure,
  syncNow,
  hasSolebaseSync,
  getAppId,
  getEncryptionKey,
  setEncryptionKey,
  buildS3SyncConfig,
  R2_DEFAULTS,

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
