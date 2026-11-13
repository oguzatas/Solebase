/**
 * sync-transport.js — Solebase sync orchestrator (P2P + S3/Drive blobs)
 *
 * Pipeline:
 *   local mutate → extract crsql_changes → encrypt (encryptionKey) →
 *     upload blob / send WebRTC → peer download/receive → decrypt →
 *     worker changeset_apply → NOTIFY → collection.subscribe
 *
 * Never sends plaintext. encryptionKey comes from SolebaseConfig.
 */

import {
  getChangesSince,
  getSiteIdB64,
  getDbVersion,
} from './sync-changesets.js';
import {
  encryptChangeset,
  decryptChangeset,
  packCiphertextPackage,
  unpackCiphertextPackage,
} from './sync-crypto.js';
import {
  createBlobStore,
  changesetBlobKey,
} from './sync-blob-store.js';
import {
  SolebaseP2PSession,
  connectP2PLoopback,
  encodeSignalPayload,
  decodeSignalPayload,
} from './sync-p2p.js';

const DEFAULT_DEBOUNCE_MS = 800;
const DEFAULT_POLL_MS = 15_000;

/**
 * @typedef {object} SyncTransportOptions
 * @property {string} appId
 * @property {string} encryptionKey
 * @property {'s3'|'drive'} provider
 * @property {Record<string, unknown>} [options]
 * @property {{ select: Function, exec: Function, request?: Function }} db
 *   db-client or bridge-shaped adapter (select/exec). Prefer request('changeset_apply')
 *   when available so NOTIFY fires for collections.
 * @property {(msg: string, type?: string) => void} [onStatus]
 * @property {(info: object) => void} [onMerge]
 */

export class SolebaseSyncTransport {
  /** @param {SyncTransportOptions} opts */
  constructor(opts) {
    if (!opts?.appId) throw new Error('SolebaseSyncTransport requires appId');
    if (!opts?.encryptionKey) throw new Error('SolebaseSyncTransport requires encryptionKey');
    if (!opts?.db) throw new Error('SolebaseSyncTransport requires db adapter');
    if (opts.provider !== 's3' && opts.provider !== 'drive') {
      throw new Error('provider must be "s3" or "drive"');
    }

    this.appId = opts.appId;
    this.encryptionKey = opts.encryptionKey;
    this.provider = opts.provider;
    this.options = { ...(opts.options || {}) };
    this.db = opts.db;
    this._onStatus = opts.onStatus || (() => {});
    this._onMerge = opts.onMerge || (() => {});

    this.blobStore = createBlobStore(this.provider, this.options);
    this.prefix = String(this.options.prefix || 'solebase-changesets').replace(/^\/+|\/+$/g, '');

    /** @type {number} */
    this.pushCursor = Number(this.options.pushCursor || 0);
    /** @type {Set<string>} */
    this._seenBlobKeys = new Set();
    /** @type {SolebaseP2PSession|null} */
    this.p2p = null;
    /** @type {ReturnType<typeof connectP2PLoopback>|null} */
    this._loopback = null;

    this._timer = null;
    this._pollTimer = null;
    this._running = false;
    this._started = false;
    this._siteIdB64 = null;

    this.debounceMs = Number(this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.pollIntervalMs = Number(this.options.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.autoSync = this.options.autoSync !== false;
  }

  async status() {
    const blob = await this.blobStore.status();
    return {
      ok: blob.ok,
      provider: this.provider,
      blob,
      p2p: this.p2p ? (this.p2p.connected ? 'connected' : 'pending') : 'off',
      pushCursor: this.pushCursor,
      seenBlobs: this._seenBlobKeys.size,
    };
  }

  /** Attach online / visibility / optional poll. Idempotent. */
  start() {
    if (this._started) return;
    this._started = true;
    if (typeof window !== 'undefined') {
      this._boundOnline = () => {
        void this.syncNow('online');
      };
      this._boundVisibility = () => {
        if (document.visibilityState === 'visible') void this.syncNow('visibility');
      };
      window.addEventListener('online', this._boundOnline);
      document.addEventListener('visibilitychange', this._boundVisibility);
    }
    if (this.autoSync && this.pollIntervalMs > 0) {
      this._pollTimer = setInterval(() => {
        void this.syncNow('poll');
      }, this.pollIntervalMs);
    }
    if (this.options.p2p) {
      void this._ensureP2P();
    }
    this._onStatus('sync started', 'ok');
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (typeof window !== 'undefined') {
      if (this._boundOnline) window.removeEventListener('online', this._boundOnline);
      if (this._boundVisibility) {
        document.removeEventListener('visibilitychange', this._boundVisibility);
      }
    }
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this.p2p?.close();
    this.p2p = null;
    this._loopback?.close();
    this._loopback = null;
    this._onStatus('sync stopped');
  }

  /** Debounced local-write hook (from Solebase after mutations). */
  notifyLocalWrite() {
    if (!this.autoSync) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.syncNow('local-write');
    }, this.debounceMs);
  }

  /**
   * Full cycle: push local encrypted changesets, pull remote, merge.
   * @param {string} [reason]
   */
  async syncNow(reason = 'manual') {
    if (this._running) {
      return { ok: true, skipped: true, reason: 'busy' };
    }
    this._running = true;
    this._onStatus(`sync ${reason}…`);
    try {
      const pushed = await this.pushLocal();
      const pulled = await this.pullRemote();
      this._onStatus(
        `sync ok (push ${pushed.uploaded}, pull ${pulled.applied})`,
        'ok',
      );
      return { ok: true, reason, pushed, pulled };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._onStatus(`sync failed: ${message}`, 'err');
      return { ok: false, reason, error: message };
    } finally {
      this._running = false;
    }
  }

  /**
   * Extract → encrypt → blob put (+ optional P2P send).
   */
  async pushLocal() {
    await this._ensureSiteId();
    const payload = await getChangesSince(this.db, this.pushCursor, {
      excludeSiteIdB64: null,
    });
    if (!payload.changes.length) {
      return { uploaded: 0, cursor: this.pushCursor };
    }

    const pkg = await encryptChangeset(payload, this.encryptionKey);
    const bytes = packCiphertextPackage(pkg);
    const key = changesetBlobKey({
      prefix: this.prefix,
      appId: this.appId,
      siteId: this._siteIdB64 || 'local',
      cursor: payload.cursor,
    });

    await this.blobStore.put(key, bytes);
    this._seenBlobKeys.add(key);

    if (this.p2p?.connected) {
      await this.p2p.sendEncryptedChangeset(bytes);
    }

    this.pushCursor = payload.cursor;
    return { uploaded: 1, key, cursor: this.pushCursor, changes: payload.changes.length };
  }

  /**
   * List blob keys → download unseen → decrypt → apply (NOTIFY path).
   */
  async pullRemote() {
    const prefix = `${this.prefix}/${this.appId}/`;
    let keys = [];
    try {
      keys = await this.blobStore.list(prefix);
    } catch (err) {
      // Memory stores always work; S3 list may be CORS-limited — surface clearly.
      throw new Error(
        `blob list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let applied = 0;
    let decryptFailed = 0;
    /** @type {string[]} */
    const mergedKeys = [];
    for (const key of keys) {
      if (this._seenBlobKeys.has(key)) continue;
      // Skip our own uploads when key embeds our site id.
      if (this._siteIdB64 && key.includes(`/${sanitize(this._siteIdB64)}/`)) {
        this._seenBlobKeys.add(key);
        continue;
      }
      const bytes = await this.blobStore.get(key);
      if (!bytes) {
        this._seenBlobKeys.add(key);
        continue;
      }
      let result;
      try {
        result = await this.applyEncryptedBytes(bytes, { source: 'blob', key });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Stale blobs from a prior deviceKey must not fail the whole pull when
        // other peers' packages decrypt with the shared bootstrap key.
        if (/decryption failed|wrong key|passphrase|corrupted data/i.test(message)) {
          decryptFailed += 1;
          this._onStatus(
            `skip undecryptable blob (${decryptFailed}): wrong encryptionKey or stale package`,
            'info',
          );
          continue;
        }
        throw err;
      }
      this._seenBlobKeys.add(key);
      if (result.applied > 0) {
        applied += result.applied;
        mergedKeys.push(key);
      }
    }
    if (applied === 0 && decryptFailed > 0) {
      throw new Error(
        `Decryption failed for ${decryptFailed} remote changeset(s) — ` +
          'encryptionKey does not match the device that uploaded them. ' +
          'Re-scan the desktop bootstrap QR (or paste the same Encryption key), then Sync Now.',
      );
    }
    return { applied, keys: mergedKeys, decryptFailed };
  }

  /**
   * Decrypt encrypted package bytes and merge via worker (or exec fallback).
   * @param {Uint8Array} bytes
   * @param {object} [meta]
   */
  async applyEncryptedBytes(bytes, meta = {}) {
    const pkg =
      bytes instanceof Uint8Array ? unpackCiphertextPackage(bytes) : bytes;
    const payload = await decryptChangeset(pkg, this.encryptionKey);
    const result = await this.applyPayload(payload);
    this._onMerge({ ...meta, ...result });
    return result;
  }

  /**
   * Apply a plaintext changeset payload through the worker merge RPC when
   * available (emits NOTIFY), else fall back to exec inserts.
   * @param {import('./sync-changesets.js').ChangesetPayload|object} payload
   */
  async applyPayload(payload) {
    if (typeof this.db.request === 'function') {
      return this.db.request('changeset_apply', { payload });
    }
    // Fallback for raw db-client smoke without Layer 1 bridge.
    const { applyChangeset } = await import('./sync-changesets.js');
    return applyChangeset(this.db, payload);
  }

  /* ─── P2P ──────────────────────────────────────────────────────────── */

  async _ensureP2P() {
    if (this.p2p) return this.p2p;
    this.p2p = new SolebaseP2PSession({
      rtcConfig: this.options.rtcConfig,
      signal: this.options.signal || null,
      onChangeset: (bytes, meta) => {
        void this.applyEncryptedBytes(bytes, { source: 'p2p', ...meta }).catch((err) => {
          this._onStatus(
            `p2p merge failed: ${err instanceof Error ? err.message : String(err)}`,
            'err',
          );
        });
      },
      onConnectionState: (state) => this._onStatus(`p2p ${state}`),
    });
    return this.p2p;
  }

  /** Create a shareable SDP offer (QR / clipboard). */
  async createP2POffer() {
    const session = await this._ensureP2P();
    const offer = await session.createOffer();
    return { payload: encodeSignalPayload(offer), offer };
  }

  /** Accept remote offer; returns answer payload to send back. */
  async acceptP2POffer(offerTextOrObj) {
    const session = await this._ensureP2P();
    const offer =
      typeof offerTextOrObj === 'string'
        ? decodeSignalPayload(offerTextOrObj)
        : offerTextOrObj;
    const answer = await session.acceptOffer(offer);
    return { payload: encodeSignalPayload(answer), answer };
  }

  /** Finish initiator handshake with remote answer. */
  async acceptP2PAnswer(answerTextOrObj) {
    const session = await this._ensureP2P();
    const answer =
      typeof answerTextOrObj === 'string'
        ? decodeSignalPayload(answerTextOrObj)
        : answerTextOrObj;
    await session.acceptAnswer(answer);
    return { ok: true };
  }

  /**
   * Same-page dual-peer smoke helper (real WebRTC, in-memory signal bus).
   * Attaches received changesets from the remote loopback peer into this transport.
   */
  async connectLoopbackForSmoke() {
    const loop = await connectP2PLoopback({
      onB: (bytes, meta) => {
        void this.applyEncryptedBytes(bytes, { source: 'p2p-loopback', ...meta });
      },
    });
    this._loopback = loop;
    // Use peer A as our outbound channel.
    this.p2p = loop.a;
    // Route inbound on A as well (B→A).
    loop.a._onChangeset = (bytes, meta) => {
      void this.applyEncryptedBytes(bytes, { source: 'p2p-loopback', ...meta });
    };
    return loop;
  }

  async _ensureSiteId() {
    if (this._siteIdB64) return this._siteIdB64;
    try {
      this._siteIdB64 = (await getSiteIdB64(this.db)) || 'local';
    } catch {
      this._siteIdB64 = 'local';
    }
    return this._siteIdB64;
  }
}

/**
 * Adapt WorkerBridge (or similar) to the select/exec/request shape expected
 * by sync-changesets + SyncTransport.
 * @param {{ query: Function, exec: Function, request: Function }} bridge
 */
export function bridgeAsSyncDb(bridge) {
  return {
    select: (sql, params) => bridge.query(sql, params),
    exec: (sql, params) => bridge.exec(sql, params),
    request: (type, payload) => bridge.request(type, payload),
  };
}

/**
 * @param {SyncTransportOptions} opts
 * @returns {SolebaseSyncTransport}
 */
export function createSyncTransport(opts) {
  return new SolebaseSyncTransport(opts);
}

/** @param {string} value */
function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

export { getDbVersion };
