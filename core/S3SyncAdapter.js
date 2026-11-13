/**
 * S3SyncAdapter.js — Solebase Layer 2 zero-LIST cloud mailbox sync (browser ESM).
 *
 * Class B poll: GET manifest.json with If-None-Match (304 → []).
 * Atomic push: PUT chunk → GET manifest → append → PUT with If-Match (412 retry).
 * Never calls ListObjectsV2.
 *
 * Typed source: S3SyncAdapter.ts + manifest.types.ts
 */

import { signAwsV4 } from './sync-blob-store.js';
import { decryptChangeset } from './sync-crypto.js';
import {
  S3SyncError,
  chunkAppliedKey,
  emptyManifest,
  isSyncManifest,
} from './manifest.types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETENTION_DAYS = 30;

export class S3SyncAdapter {
  id = 's3-manifest';

  /**
   * @param {import('./manifest.types.ts').S3SyncAdapterOptions} options
   */
  constructor(options = {}) {
    this.endpoint = String(options.endpoint || '').replace(/\/$/, '');
    this.bucket = String(options.bucket || '');
    this.accessKeyId = String(options.accessKeyId || '');
    this.secretAccessKey = String(options.secretAccessKey || '');
    this.region = String(options.region || 'auto');
    this.prefix = String(options.prefix || '').replace(/^\/+|\/+$/g, '');
    this.encryptionKey = String(options.encryptionKey || '');
    this.localSiteId = String(options.localSiteId || '');
    this.retentionDays =
      options.retentionDays === 0
        ? 0
        : Number(options.retentionDays ?? DEFAULT_RETENTION_DAYS);
    this.timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxRetries = Number(options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
    this.decryptFn =
      options.decrypt ||
      ((pkg, key) => decryptChangeset(pkg, key));

    /** @type {string|null} */
    this.lastETag = null;
    /** @type {Set<string>} */
    this.applied = new Set();

    if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.secretAccessKey) {
      throw new S3SyncError(
        'S3SyncAdapter requires endpoint, bucket, accessKeyId, secretAccessKey',
        'CONFIG',
      );
    }
    if (!this.prefix) {
      throw new S3SyncError(
        'S3SyncAdapter requires a non-empty prefix (room namespace)',
        'CONFIG',
      );
    }
  }

  manifestKey() {
    return `${this.prefix}/manifest.json`;
  }

  /** @param {string} siteId */
  setLocalSiteId(siteId) {
    this.localSiteId = String(siteId || '');
  }

  /**
   * @param {string} siteId
   * @param {number} dbVersion
   * @param {string} [chunkId]
   */
  markApplied(siteId, dbVersion, chunkId) {
    this.applied.add(chunkAppliedKey(siteId, dbVersion));
    if (chunkId) this.applied.add(chunkId);
  }

  async status() {
    return {
      ok: true,
      label: `S3 manifest → ${this.endpoint}/${this.bucket}/${this.manifestKey()}`,
      detail: `etag=${this.lastETag || 'none'} applied=${this.applied.size}`,
    };
  }

  /**
   * Class B poll. 304 → []. 200 → download unseen chunks, decrypt, return raw JSON buffers.
   * @param {number} lastKnownDbVersion
   * @returns {Promise<Uint8Array[]>}
   */
  async pull(lastKnownDbVersion) {
    const result = await this._getManifest({
      ifNoneMatch: this.lastETag || undefined,
    });

    if (result.status === 304) return [];
    if (result.status === 404 || !result.manifest) {
      this.lastETag = null;
      return [];
    }

    if (result.etag) this.lastETag = result.etag;

    const pending = result.manifest.chunks.filter((chunk) => {
      if (this.applied.has(chunk.id)) return false;
      if (this.applied.has(chunkAppliedKey(chunk.siteId, chunk.dbVersion))) return false;
      if (
        this.localSiteId &&
        chunk.siteId === this.localSiteId &&
        chunk.dbVersion <= lastKnownDbVersion
      ) {
        return false;
      }
      return true;
    });

    if (!pending.length) return [];

    const encrypted = await Promise.all(
      pending.map(async (chunk) => {
        const bytes = await this._getObject(chunk.key);
        return { chunk, bytes };
      }),
    );

    /** @type {Uint8Array[]} */
    const out = [];
    for (const { chunk, bytes } of encrypted) {
      if (!bytes) {
        this.markApplied(chunk.siteId, chunk.dbVersion, chunk.id);
        continue;
      }
      try {
        if (this.encryptionKey) {
          const payload = await this.decryptFn(bytes, this.encryptionKey);
          const raw =
            payload instanceof Uint8Array
              ? payload
              : new TextEncoder().encode(JSON.stringify(payload));
          out.push(raw);
        } else {
          out.push(bytes);
        }
        this.markApplied(chunk.siteId, chunk.dbVersion, chunk.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/decryption failed|wrong key|passphrase|corrupted data/i.test(message)) {
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  /**
   * Atomic push with optimistic locking (If-Match / If-None-Match *).
   * @param {Uint8Array} encryptedChangeset
   * @param {{ siteId: string, dbVersion: number }} meta
   */
  async push(encryptedChangeset, meta) {
    if (!(encryptedChangeset instanceof Uint8Array) && !ArrayBuffer.isView(encryptedChangeset)) {
      throw new S3SyncError('push requires Uint8Array encrypted changeset', 'CONFIG');
    }
    const siteId = String(meta?.siteId || '').trim();
    const dbVersion = Number(meta?.dbVersion);
    if (!siteId || !Number.isFinite(dbVersion)) {
      throw new S3SyncError('push meta requires siteId and numeric dbVersion', 'CONFIG');
    }

    const bytes =
      encryptedChangeset instanceof Uint8Array
        ? encryptedChangeset
        : new Uint8Array(
            encryptedChangeset.buffer,
            encryptedChangeset.byteOffset,
            encryptedChangeset.byteLength,
          );

    const now = Date.now();
    const chunkId = randomId();
    const safeSite = sanitize(siteId);
    const chunkKey = `${this.prefix}/chunks/${now}-${safeSite}.bin`;

    await this._putObject(chunkKey, bytes, 'application/octet-stream');

    /** @type {import('./manifest.types.js').SyncManifestChunk} */
    const chunk = {
      id: chunkId,
      key: chunkKey,
      siteId,
      dbVersion,
      size: bytes.byteLength,
      createdAt: now,
    };

    let attempt = 0;
    while (attempt < this.maxRetries) {
      attempt += 1;
      try {
        await this._appendChunkToManifest(chunk);
        this.markApplied(siteId, dbVersion, chunkId);
        return;
      } catch (err) {
        if (err instanceof S3SyncError && err.code === 'PRECONDITION_FAILED') {
          if (attempt >= this.maxRetries) {
            throw new S3SyncError(
              `manifest If-Match conflict after ${this.maxRetries} retries`,
              'RETRY_EXHAUSTED',
              412,
              err,
            );
          }
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /* ─── Manifest ─────────────────────────────────────────────────────── */

  /** @param {import('./manifest.types.js').SyncManifestChunk} chunk */
  async _appendChunkToManifest(chunk) {
    const got = await this._getManifest({});
    /** @type {import('./manifest.types.js').SyncManifest} */
    let manifest;
    let etag = got.etag;
    let creating = false;

    if (got.status === 404 || !got.manifest) {
      manifest = emptyManifest();
      creating = true;
      etag = null;
    } else {
      manifest = got.manifest;
    }

    if (!manifest.chunks.some((c) => c.key === chunk.key || c.id === chunk.id)) {
      manifest.chunks.push(chunk);
    }
    manifest.version = Number(manifest.version || 0) + 1;
    manifest.updatedAt = Date.now();

    if (this.retentionDays > 0) {
      await this._gcManifest(manifest);
    }

    const body = new TextEncoder().encode(JSON.stringify(manifest));
    /** @type {Record<string, string>} */
    const extraHeaders = creating
      ? { 'if-none-match': '*' }
      : etag
        ? { 'if-match': etag }
        : {};

    const res = await this._signedFetch({
      method: 'PUT',
      key: this.manifestKey(),
      body,
      contentType: 'application/json',
      extraHeaders,
    });

    if (res.status === 412 || res.status === 409) {
      throw new S3SyncError('manifest precondition failed', 'PRECONDITION_FAILED', res.status);
    }
    if (!res.ok) {
      throw new S3SyncError(`manifest PUT failed: ${res.status}`, 'HTTP', res.status);
    }
    const newEtag = res.headers.get('etag');
    if (newEtag) this.lastETag = newEtag;
  }

  /** @param {import('./manifest.types.js').SyncManifest} manifest */
  async _gcManifest(manifest) {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    /** @type {import('./manifest.types.js').SyncManifestChunk[]} */
    const keep = [];
    /** @type {import('./manifest.types.js').SyncManifestChunk[]} */
    const drop = [];
    for (const chunk of manifest.chunks) {
      const created =
        typeof chunk.createdAt === 'number'
          ? chunk.createdAt
          : parseTimestampFromChunkKey(chunk.key);
      if (created != null && created < cutoff) drop.push(chunk);
      else keep.push(chunk);
    }
    manifest.chunks = keep;
    await Promise.all(
      drop.map((c) =>
        this._deleteObject(c.key).catch(() => {
          /* ignore */
        }),
      ),
    );
  }

  /**
   * @param {{ ifNoneMatch?: string }} opts
   */
  async _getManifest(opts) {
    /** @type {Record<string, string>} */
    const extraHeaders = {};
    if (opts.ifNoneMatch) extraHeaders['if-none-match'] = opts.ifNoneMatch;

    const res = await this._signedFetch({
      method: 'GET',
      key: this.manifestKey(),
      body: '',
      extraHeaders,
    });

    if (res.status === 304) {
      return { status: 304, etag: this.lastETag, manifest: null };
    }
    if (res.status === 404) {
      return { status: 404, etag: null, manifest: null };
    }
    if (!res.ok) {
      throw new S3SyncError(`manifest GET failed: ${res.status}`, 'HTTP', res.status);
    }

    const etag = res.headers.get('etag');
    let parsed;
    try {
      parsed = JSON.parse(await res.text());
    } catch (err) {
      throw new S3SyncError('manifest.json is not valid JSON', 'MANIFEST_INVALID', 200, err);
    }
    if (!isSyncManifest(parsed)) {
      throw new S3SyncError('manifest.json has invalid schema', 'MANIFEST_INVALID', 200);
    }
    parsed.chunks = (parsed.chunks || []).filter(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.key === 'string' &&
        typeof c.siteId === 'string' &&
        typeof c.dbVersion === 'number',
    );
    return { status: 200, etag, manifest: parsed };
  }

  /* ─── Object I/O ───────────────────────────────────────────────────── */

  /** @param {string} key */
  objectUrl(key) {
    return `${this.endpoint}/${this.bucket}/${key}`;
  }

  /** @param {string} key */
  async _getObject(key) {
    const res = await this._signedFetch({ method: 'GET', key, body: '' });
    if (res.status === 404) return null;
    if (!res.ok) throw new S3SyncError(`S3 GET failed: ${res.status}`, 'HTTP', res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * @param {string} key
   * @param {Uint8Array} bytes
   * @param {string} contentType
   */
  async _putObject(key, bytes, contentType) {
    const body = new Uint8Array(bytes);
    const res = await this._signedFetch({
      method: 'PUT',
      key,
      body,
      contentType,
    });
    if (!res.ok) throw new S3SyncError(`S3 PUT failed: ${res.status}`, 'HTTP', res.status);
  }

  /** @param {string} key */
  async _deleteObject(key) {
    const res = await this._signedFetch({ method: 'DELETE', key, body: '' });
    if (!res.ok && res.status !== 404) {
      throw new S3SyncError(`S3 DELETE failed: ${res.status}`, 'HTTP', res.status);
    }
  }

  /**
   * @param {{
   *   method: string,
   *   key: string,
   *   body: string|Uint8Array,
   *   contentType?: string,
   *   extraHeaders?: Record<string, string>,
   * }} opts
   */
  async _signedFetch(opts) {
    const url = this.objectUrl(opts.key);
    const { headers } = await signAwsV4({
      method: opts.method,
      url,
      body: opts.body,
      contentType: opts.contentType,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      extraHeaders: opts.extraHeaders,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body:
          opts.method === 'GET' || opts.method === 'HEAD' || opts.method === 'DELETE'
            ? undefined
            : opts.body,
        signal: controller.signal,
      });
      return res;
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
        throw new S3SyncError(`S3 request timed out after ${this.timeoutMs}ms`, 'TIMEOUT');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** @param {string} value */
function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'x';
}

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** @param {number} attempt */
function backoffMs(attempt) {
  const base = Math.min(8_000, 200 * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * base * 0.4);
  return base + jitter;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} key */
function parseTimestampFromChunkKey(key) {
  const m = /\/chunks\/(\d+)-/.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export {
  S3SyncError,
  emptyManifest,
  chunkAppliedKey,
  isSyncManifest,
};

export default S3SyncAdapter;
