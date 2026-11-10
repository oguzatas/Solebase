/**
 * db-client.js — Main-thread interface to the Layer 3 db worker.
 *
 *   import { createDbClient } from '../core/db-client.js';
 *   const client = createDbClient({ workerUrl: new URL('./db-worker.js', import.meta.url) });
 *   await client.init();
 *   await client.exec('CREATE TABLE …');
 *   await client.insert('INSERT INTO t (name) VALUES (?)', ['Ada']);
 *   const rows = await client.select('SELECT * FROM t');
 *
 * Layer 1 callers should use this client (or a future useCollection facade) —
 * never Worker / postMessage / OPFS / cr-sqlite directly.
 */

import { DEFAULT_DB_FILENAME } from './db-protocol.js';

/**
 * @typedef {object} CreateDbClientOptions
 * @property {string|URL} workerUrl  Absolute URL to db-worker.js (module worker)
 * @property {string} [filename]     OPFS db filename (default prompt2ui.db)
 * @property {string} [wasmUrl]      Optional override for crsqlite.wasm
 */

/**
 * @typedef {object} DbClient
 * @property {(opts?: { filename?: string, wasmUrl?: string }) => Promise<{ filename: string, vfs: string, storage: string }>} init
 * @property {(sql: string, params?: unknown[]) => Promise<{ changes: number, lastInsertRowid: unknown }>} exec
 * @property {(sql: string, params?: unknown[]) => Promise<{ changes: number, lastInsertRowid: unknown }>} run
 * @property {(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>} select
 * @property {(sql: string, params?: unknown[]) => Promise<{ changes: number, lastInsertRowid: unknown }>} insert
 * @property {(sql: string, params?: unknown[]) => Promise<{ changes: number, lastInsertRowid: unknown }>} update
 * @property {() => Promise<{ closed: boolean }>} close
 * @property {() => void} terminate
 */

/**
 * @param {CreateDbClientOptions} options
 * @returns {DbClient}
 */
export function createDbClient(options) {
  if (!options?.workerUrl) {
    throw new Error('createDbClient requires { workerUrl }');
  }

  const defaultFilename = options.filename || DEFAULT_DB_FILENAME;
  const defaultWasmUrl = options.wasmUrl;

  const worker = new Worker(options.workerUrl, { type: 'module' });

  /** @type {Map<string|number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  let nextId = 1;
  let terminated = false;

  worker.onmessage = (event) => {
    const msg = event.data;
    // Boot ping — ignore (no id correlation).
    if (msg && msg.type === 'worker-ready') return;

    if (!msg || msg.id == null) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);

    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error || 'db worker error'));
  };

  worker.onerror = (event) => {
    const err = new Error(event.message || 'db worker crashed');
    for (const [, waiter] of pending) waiter.reject(err);
    pending.clear();
  };

  /**
   * @param {string} type
   * @param {Record<string, unknown>} [extra]
   * @returns {Promise<any>}
   */
  function call(type, extra = {}) {
    if (terminated) return Promise.reject(new Error('db client terminated'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, type, ...extra });
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** @type {DbClient} */
  const client = {
    async init(opts = {}) {
      return call('init', {
        filename: opts.filename || defaultFilename,
        wasmUrl: opts.wasmUrl || defaultWasmUrl,
      });
    },

    async exec(sql, params) {
      return call('exec', { sql, params: params || [] });
    },

    async run(sql, params) {
      return call('run', { sql, params: params || [] });
    },

    async select(sql, params) {
      return call('select', { sql, params: params || [] });
    },

    async insert(sql, params) {
      return call('exec', { sql, params: params || [] });
    },

    async update(sql, params) {
      return call('exec', { sql, params: params || [] });
    },

    async close() {
      return call('close');
    },

    terminate() {
      terminated = true;
      for (const [, waiter] of pending) {
        waiter.reject(new Error('db client terminated'));
      }
      pending.clear();
      worker.terminate();
    },
  };

  return client;
}

export { DEFAULT_DB_FILENAME };
