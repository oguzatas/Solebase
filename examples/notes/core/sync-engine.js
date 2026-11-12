/**
 * sync-engine.js — Debounced encrypted snapshot sync (LWW)
 *
 * Local source of truth: Solebase (OPFS + cr-sqlite) via db-api.
 * Cloud: one encrypted JSON snapshot per app (+ metadata).
 * Merge: per-record last-write-wins on `updatedAt`.
 *
 * Triggers:
 *   - debounced after local writes (via db-api onChange)
 *   - window `online`
 *   - document `visibilitychange` (when visible)
 *
 * Idle when adapter is LocalOnly or no session passphrase is set.
 */

import {
  loadSettings,
  saveSettings,
  createAdapter,
  wrapForCloud,
  unwrapFromCloud,
  SCHEMA_VERSION,
  getDeviceId,
} from './prompt-storage.js';

const DEBOUNCE_MS = 1200;

/**
 * @typedef {object} SyncEngineOptions
 * @property {() => string} getPassphrase - session passphrase (memory only)
 * @property {() => Promise<Record<string, object[]>>} exportSnapshot
 * @property {(collections: Record<string, object[]>) => Promise<boolean>} applyRemoteSnapshot
 * @property {(msg: string, type?: string) => void} [onStatus]
 */

export class SyncEngine {
  /** @param {SyncEngineOptions} [options] */
  constructor(options = {}) {
    this._getPassphrase = options.getPassphrase || (() => '');
    this._exportSnapshot = options.exportSnapshot || null;
    this._applyRemote = options.applyRemoteSnapshot || null;
    this._onStatus = options.onStatus || (() => {});
    this._timer = null;
    this._running = false;
    this._started = false;
    this._boundOnline = () => this.syncNow('online');
    this._boundVisibility = () => {
      if (document.visibilityState === 'visible') this.syncNow('visibility');
    };
  }

  /**
   * Wire data accessors after db-api is ready (avoids circular init issues).
   * @param {Partial<SyncEngineOptions>} options
   */
  configure(options = {}) {
    if (options.getPassphrase) this._getPassphrase = options.getPassphrase;
    if (options.exportSnapshot) this._exportSnapshot = options.exportSnapshot;
    if (options.applyRemoteSnapshot) this._applyRemote = options.applyRemoteSnapshot;
    if (options.onStatus) this._onStatus = options.onStatus;
  }

  /** Whether auto-sync should run right now. */
  isEnabled() {
    const settings = loadSettings();
    const passphrase = this._getPassphrase();
    if (!settings.adapter || settings.adapter === 'local') return false;
    if (!passphrase) return false;
    return true;
  }

  /** Attach online / visibility listeners. Idempotent. */
  start() {
    if (this._started) return;
    this._started = true;
    window.addEventListener('online', this._boundOnline);
    document.addEventListener('visibilitychange', this._boundVisibility);
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    window.removeEventListener('online', this._boundOnline);
    document.removeEventListener('visibilitychange', this._boundVisibility);
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** Called after local mutations — debounced pull/merge/push. */
  notifyLocalWrite() {
    if (!this.isEnabled()) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.syncNow('local-write');
    }, DEBOUNCE_MS);
  }

  /**
   * Immediate sync cycle: pull → LWW merge → push.
   * @param {string} [reason]
   */
  async syncNow(reason = 'manual') {
    if (!this._exportSnapshot || !this._applyRemote) {
      console.warn('[SyncEngine] not configured');
      return { ok: false, reason: 'not-configured' };
    }
    if (!this.isEnabled()) {
      return { ok: false, reason: 'idle' };
    }
    if (this._running) {
      return { ok: false, reason: 'busy' };
    }

    this._running = true;
    const passphrase = this._getPassphrase();
    const settings = loadSettings();
    const adapter = createAdapter(settings);

    try {
      const st = await adapter.status();
      if (!st.ok) {
        saveSettings({ lastSyncStatus: `error: ${st.label}` });
        this._onStatus(st.label, 'err');
        return { ok: false, reason: 'adapter', detail: st.label };
      }

      // 1) Pull remote snapshot
      let remoteCollections = null;
      try {
        const blob = await adapter.pull();
        const unwrapped = await unwrapFromCloud(blob, passphrase);
        if (unwrapped?.data && typeof unwrapped.data === 'object') {
          remoteCollections = unwrapped.data;
        }
      } catch (err) {
        // First sync / empty remote is fine; hard errors bubble
        if (!String(err.message || err).includes('404')) {
          throw err;
        }
      }

      // 2) LWW merge into IndexedDB
      if (remoteCollections) {
        await this._applyRemote(remoteCollections);
      }

      // 3) Push merged local snapshot
      const local = await this._exportSnapshot();
      const wrapped = await wrapForCloud(local, passphrase);
      await adapter.push(wrapped);

      saveSettings({
        lastSyncAt: Date.now(),
        lastSyncStatus: `ok:${reason}`,
      });
      this._onStatus(`Synced (${reason})`, 'ok');
      return {
        ok: true,
        reason,
        schemaVersion: SCHEMA_VERSION,
        deviceId: getDeviceId(),
      };
    } catch (err) {
      const msg = err?.message || String(err);
      saveSettings({ lastSyncStatus: `error: ${msg}` });
      this._onStatus(msg, 'err');
      return { ok: false, reason: 'error', detail: msg };
    } finally {
      this._running = false;
    }
  }
}

/** Singleton used by db-api and the shell / settings panel. */
export const syncEngine = new SyncEngine();

export default syncEngine;
