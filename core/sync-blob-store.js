/**
 * sync-blob-store.js — E2EE changeset blob stores (S3 / Drive-shaped / memory)
 *
 * Shared interface for store-and-forward sync. Callers always upload
 * *already encrypted* Uint8Array packages (see sync-crypto packCiphertextPackage).
 * Never put plaintext changesets here.
 *
 * Providers:
 *   - MemoryBlobStore  — in-process Map (smoke / unit tests)
 *   - S3BlobStore      — AWS SigV4 path-style PUT/GET/LIST (R2 / MinIO / AWS)
 *   - DriveBlobStore   — Drive-shaped stub (same interface; memory until OAuth)
 */

/**
 * @typedef {object} BlobStoreStatus
 * @property {boolean} ok
 * @property {string} label
 * @property {string} [detail]
 */

/**
 * @typedef {object} BlobPutResult
 * @property {string} key
 * @property {number} bytes
 */

/**
 * @typedef {object} BlobStore
 * @property {string} id
 * @property {() => Promise<BlobStoreStatus>} status
 * @property {(key: string, bytes: Uint8Array, contentType?: string) => Promise<BlobPutResult>} put
 * @property {(key: string) => Promise<Uint8Array|null>} get
 * @property {(prefix?: string) => Promise<string[]>} list
 * @property {(key: string) => Promise<void>} [remove]
 */

/* ─── Memory ─────────────────────────────────────────────────────────── */

/** In-memory blob store for smoke tests and Drive stub backend. */
export class MemoryBlobStore {
  id = 'memory';

  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this._blobs = new Map();
  }

  async status() {
    return { ok: true, label: `Memory blob store (${this._blobs.size} objects)` };
  }

  /**
   * @param {string} key
   * @param {Uint8Array} bytes
   */
  async put(key, bytes) {
    assertKey(key);
    assertBytes(bytes);
    this._blobs.set(key, new Uint8Array(bytes));
    return { key, bytes: bytes.byteLength };
  }

  /** @param {string} key */
  async get(key) {
    assertKey(key);
    const found = this._blobs.get(key);
    return found ? new Uint8Array(found) : null;
  }

  /** @param {string} [prefix] */
  async list(prefix = '') {
    const keys = [...this._blobs.keys()];
    if (!prefix) return keys.sort();
    return keys.filter((k) => k.startsWith(prefix)).sort();
  }

  /** @param {string} key */
  async remove(key) {
    assertKey(key);
    this._blobs.delete(key);
  }

  clear() {
    this._blobs.clear();
  }
}

/* ─── S3 ─────────────────────────────────────────────────────────────── */

/**
 * S3-compatible binary blob store (path-style).
 *
 * Options:
 *   endpoint, region, bucket, accessKeyId, secretAccessKey, prefix?
 *
 * CORS must allow GET/PUT/HEAD (+ optionally ListObjects) from the app origin.
 *
 * @implements {BlobStore}
 */
export class S3BlobStore {
  id = 's3';

  /**
   * @param {object} options
   * @param {string} options.endpoint
   * @param {string} options.bucket
   * @param {string} options.accessKeyId
   * @param {string} options.secretAccessKey
   * @param {string} [options.region='auto']
   * @param {string} [options.prefix='solebase-changesets']
   */
  constructor(options = {}) {
    this.endpoint = String(options.endpoint || '').replace(/\/$/, '');
    this.bucket = String(options.bucket || '');
    this.accessKeyId = String(options.accessKeyId || '');
    this.secretAccessKey = String(options.secretAccessKey || '');
    this.region = String(options.region || 'auto');
    this.prefix = String(options.prefix || 'solebase-changesets').replace(/^\/+|\/+$/g, '');
  }

  /** @param {string} key */
  objectUrl(key) {
    assertKey(key);
    return `${this.endpoint}/${this.bucket}/${key}`;
  }

  async status() {
    if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.secretAccessKey) {
      return {
        ok: false,
        label: 'Incomplete S3 settings',
        detail: 'Need endpoint, bucket, accessKeyId, secretAccessKey',
      };
    }
    return { ok: true, label: `S3 → ${this.endpoint}/${this.bucket}/${this.prefix}/…` };
  }

  /**
   * @param {string} key
   * @param {Uint8Array} bytes
   * @param {string} [contentType='application/octet-stream']
   */
  async put(key, bytes, contentType = 'application/octet-stream') {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    assertBytes(bytes);
    const url = this.objectUrl(key);
    const body = bytes;
    const { headers } = await signAwsV4({
      method: 'PUT',
      url,
      body,
      contentType,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
    });
    const res = await fetch(url, { method: 'PUT', headers, body });
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status}`);
    return { key, bytes: bytes.byteLength };
  }

  /** @param {string} key */
  async get(key) {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const url = this.objectUrl(key);
    const { headers } = await signAwsV4({
      method: 'GET',
      url,
      body: '',
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
    });
    const res = await fetch(url, { method: 'GET', headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * List object keys under prefix via ListObjectsV2 (path-style).
   * @param {string} [prefix]
   */
  async list(prefix) {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const listPrefix = prefix != null && prefix !== '' ? prefix : this.prefix ? `${this.prefix}/` : '';
    const url = new URL(`${this.endpoint}/${this.bucket}`);
    url.searchParams.set('list-type', '2');
    if (listPrefix) url.searchParams.set('prefix', listPrefix);

    const { headers } = await signAwsV4({
      method: 'GET',
      url: url.toString(),
      body: '',
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      signQuery: true,
    });
    const res = await fetch(url.toString(), { method: 'GET', headers });
    if (!res.ok) throw new Error(`S3 LIST failed: ${res.status}`);
    const xml = await res.text();
    return parseS3ListKeys(xml).sort();
  }

  /** @param {string} key */
  async remove(key) {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const url = this.objectUrl(key);
    const { headers } = await signAwsV4({
      method: 'DELETE',
      url,
      body: '',
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
    });
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE failed: ${res.status}`);
  }
}

/* ─── Drive (stub) ───────────────────────────────────────────────────── */

/**
 * Google Drive–shaped blob store.
 *
 * Same interface as S3. Until OAuth + Drive API are wired, defaults to an
 * in-memory backend so `provider: 'drive'` is a real config path for smoke.
 * Pass `{ memory: false, accessToken }` later for a live implementation.
 *
 * @implements {BlobStore}
 */
export class DriveBlobStore {
  id = 'drive';

  /**
   * @param {object} [options]
   * @param {boolean} [options.memory=true]
   * @param {string} [options.accessToken]
   * @param {string} [options.folderId]
   * @param {string} [options.prefix='solebase-changesets']
   * @param {BlobStore} [options.backend]  inject for tests
   */
  constructor(options = {}) {
    this.options = options;
    this.prefix = String(options.prefix || 'solebase-changesets').replace(/^\/+|\/+$/g, '');
    this.accessToken = options.accessToken || '';
    this.folderId = options.folderId || 'appDataFolder';
    /** @type {BlobStore} */
    this._backend =
      options.backend ||
      (options.memory === false && this.accessToken
        ? null
        : new MemoryBlobStore());
  }

  async status() {
    if (this._backend) {
      const inner = await this._backend.status();
      return {
        ok: true,
        label: `Drive stub → ${inner.label}`,
        detail: 'Live Drive API not wired; using memory backend',
      };
    }
    return {
      ok: false,
      label: 'Drive live API not implemented',
      detail: 'Use memory:true (default) or wait for OAuth adapter',
    };
  }

  /** @param {string} key @param {Uint8Array} bytes */
  async put(key, bytes) {
    await this._requireBackend();
    return this._backend.put(key, bytes);
  }

  /** @param {string} key */
  async get(key) {
    await this._requireBackend();
    return this._backend.get(key);
  }

  /** @param {string} [prefix] */
  async list(prefix) {
    await this._requireBackend();
    return this._backend.list(prefix);
  }

  /** @param {string} key */
  async remove(key) {
    await this._requireBackend();
    if (typeof this._backend.remove === 'function') {
      await this._backend.remove(key);
    }
  }

  async _requireBackend() {
    if (!this._backend) {
      throw new Error('Drive live API not implemented — set memory:true for stub');
    }
  }
}

/* ─── Factory ────────────────────────────────────────────────────────── */

/**
 * Build a blob store from Solebase sync config.
 *
 * @param {'s3'|'drive'} provider
 * @param {Record<string, unknown>} [options]
 * @returns {BlobStore}
 */
export function createBlobStore(provider, options = {}) {
  if (options.blobStore && typeof options.blobStore === 'object') {
    return /** @type {BlobStore} */ (options.blobStore);
  }
  if (options.memory === true) {
    return new MemoryBlobStore();
  }
  if (provider === 's3') {
    // Allow smoke without credentials when memory is implied by incomplete opts.
    if (
      !options.endpoint ||
      !options.bucket ||
      !options.accessKeyId ||
      !options.secretAccessKey
    ) {
      if (options.allowMemoryFallback !== false) {
        return new MemoryBlobStore();
      }
      throw new Error('S3 blob store requires endpoint, bucket, accessKeyId, secretAccessKey');
    }
    return new S3BlobStore(options);
  }
  if (provider === 'drive') {
    return new DriveBlobStore(options);
  }
  throw new Error(`Unknown sync provider: ${provider}`);
}

/**
 * Build a deterministic blob key for an encrypted changeset package.
 * @param {object} parts
 * @param {string} [parts.prefix='solebase-changesets']
 * @param {string} parts.appId
 * @param {string} [parts.siteId='local']
 * @param {number|string} parts.cursor
 * @param {string} [parts.id]
 */
export function changesetBlobKey(parts) {
  const prefix = String(parts.prefix || 'solebase-changesets').replace(/^\/+|\/+$/g, '');
  const appId = sanitizePathPart(parts.appId || 'app');
  const siteId = sanitizePathPart(parts.siteId || 'local');
  const cursor = String(parts.cursor ?? 0);
  const id = sanitizePathPart(parts.id || randomId());
  return `${prefix}/${appId}/${siteId}/${cursor}-${id}.changeset`;
}

/* ─── helpers ────────────────────────────────────────────────────────── */

/** @param {string} key */
function assertKey(key) {
  if (typeof key !== 'string' || !key || key.includes('..')) {
    throw new Error('blob key must be a non-empty path without ..');
  }
}

/** @param {unknown} bytes */
function assertBytes(bytes) {
  if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) {
    throw new Error('blob put requires Uint8Array');
  }
}

/** @param {string} part */
function sanitizePathPart(part) {
  return String(part).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'x';
}

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Minimal ListObjectsV2 XML key parser (no DOM dependency beyond DOMParser in browser).
 * @param {string} xml
 * @returns {string[]}
 */
export function parseS3ListKeys(xml) {
  if (!xml || typeof xml !== 'string') return [];
  /** @type {string[]} */
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml))) {
    keys.push(m[1]);
  }
  return keys;
}

/**
 * AWS Signature Version 4 for browser fetch (path-style object or list URL).
 * @param {object} opts
 */
async function signAwsV4(opts) {
  const method = opts.method;
  const url = new URL(opts.url);
  const region = opts.region || 'auto';
  const service = 's3';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const bodyBytes =
    typeof opts.body === 'string'
      ? new TextEncoder().encode(opts.body)
      : opts.body instanceof Uint8Array
        ? opts.body
        : opts.body
          ? new Uint8Array(opts.body)
          : new Uint8Array();

  const payloadHash = await sha256Hex(bodyBytes);

  /** @type {Record<string, string>} */
  const headerMap = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (opts.contentType) headerMap['content-type'] = opts.contentType;

  const sortedKeys = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headerMap[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join('\n');

  const signingKey = await getSignatureKey(opts.secretAccessKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  /** @type {Record<string, string>} */
  const headers = {
    Authorization: authorization,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  return { headers };
}

async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return hex(hash);
}

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return crypto.subtle.sign('HMAC', cryptoKey, payload);
}

async function hmacHex(key, data) {
  return hex(await hmac(key, data));
}

async function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = await hmac('AWS4' + secret, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
