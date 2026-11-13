/**
 * prompt-storage.js — Notes settings + S3 helpers for Solebase R2 / bootstrap
 *
 * Solebase Layer 1 owns vault sync (OPFS + changeset blobs). This module only
 * stores browser credentials and provides S3 PUT/GET/DELETE for QR bootstrap.
 */

/** Canonical settings key (Solebase-only). */
export const SETTINGS_KEY = 'solebase:notes:settings';
/** Canonical device id key. */
export const DEVICE_ID_KEY = 'solebase:notes:deviceId';

const LEGACY_SETTINGS_KEYS = ['prompt2ui:settings'];
const LEGACY_DEVICE_ID_KEYS = ['prompt2ui:deviceId'];
const LEGACY_IDB_NAME = 'Prompt2UI';
const LEGACY_LS_DB_PREFIX = 'prompt2ui:db:';

export const SCHEMA_VERSION = 1;

let legacyCleanupDone = false;

/* ─── Settings helpers ─────────────────────────────────────────────── */

function migrateLegacySettingsOnce() {
  try {
    if (localStorage.getItem(SETTINGS_KEY)) {
      for (const k of LEGACY_SETTINGS_KEYS) localStorage.removeItem(k);
      return;
    }
    for (const k of LEGACY_SETTINGS_KEYS) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      localStorage.setItem(SETTINGS_KEY, raw);
      localStorage.removeItem(k);
      return;
    }
  } catch {
    /* ignore */
  }
}

function migrateLegacyDeviceIdOnce() {
  try {
    if (localStorage.getItem(DEVICE_ID_KEY)) {
      for (const k of LEGACY_DEVICE_ID_KEYS) localStorage.removeItem(k);
      return;
    }
    for (const k of LEGACY_DEVICE_ID_KEYS) {
      const id = localStorage.getItem(k);
      if (!id) continue;
      localStorage.setItem(DEVICE_ID_KEY, id);
      localStorage.removeItem(k);
      return;
    }
  } catch {
    /* ignore */
  }
}

/** Drop superseded Prompt2UI IndexedDB + localStorage vault mirrors (one-shot). */
export function eraseLegacyBrowserStores() {
  if (legacyCleanupDone) return;
  legacyCleanupDone = true;
  migrateLegacySettingsOnce();
  migrateLegacyDeviceIdOnce();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_LS_DB_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof indexedDB?.deleteDatabase === 'function') {
      indexedDB.deleteDatabase(LEGACY_IDB_NAME);
    }
  } catch {
    /* ignore */
  }
}

eraseLegacyBrowserStores();

export function loadSettings() {
  migrateLegacySettingsOnce();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaultSettings(), ...JSON.parse(raw) } : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial, updatedAt: Date.now() };
  // Drop legacy snapshot fields if present from migrated JSON.
  delete next.adapter;
  delete next.passphrase;
  delete next.passphraseSet;
  delete next.googleClientId;
  delete next.googleAccessToken;
  delete next.googleRefreshToken;
  delete next.googleTokenExpiry;
  delete next.webdavUrl;
  delete next.webdavUsername;
  delete next.webdavPassword;
  delete next.s3ObjectKey;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/**
 * Merge Settings from the form without wiping saved secrets when password
 * inputs are left blank (masked placeholders / browser cleared fields).
 * @param {object} partial
 * @param {{ preserveSecrets?: boolean }} [opts]
 */
export function saveSettingsPreservingSecrets(partial, opts = {}) {
  const prev = loadSettings();
  const preserve = opts.preserveSecrets !== false && prev.rememberOnDevice !== false;
  const next = { ...partial };
  if (preserve) {
    if (!String(next.s3AccessKeyId || '').trim() && prev.s3AccessKeyId) {
      next.s3AccessKeyId = prev.s3AccessKeyId;
    }
    if (!String(next.s3SecretAccessKey || '') && prev.s3SecretAccessKey) {
      next.s3SecretAccessKey = prev.s3SecretAccessKey;
    }
    if (!String(next.encryptionKey || '').trim() && prev.encryptionKey) {
      next.encryptionKey = prev.encryptionKey;
    }
  }
  if (next.rememberOnDevice === false) {
    next.s3AccessKeyId = String(next.s3AccessKeyId || '').trim();
    next.s3SecretAccessKey = String(next.s3SecretAccessKey || '');
  }
  return saveSettings(next);
}

export function defaultSettings() {
  return {
    /** When true, persist R2 secrets on this device (localStorage). */
    rememberOnDevice: true,
    /** Optional mirror of Solebase encryptionKey (canonical: solebase:notes:deviceKey). */
    encryptionKey: '',
    s3Endpoint: 'https://7701962a7c1ef34d73878ef8650ef733.r2.cloudflarestorage.com',
    s3Region: 'auto',
    s3Bucket: 'solebase-sync-test',
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    s3Prefix: 'solebase-changesets',
    solebaseAutoSync: true,
    lastSyncAt: null,
    lastSyncStatus: null,
  };
}

/** Stable device id for diagnostics (generated once per browser profile). */
export function getDeviceId() {
  migrateLegacyDeviceIdOnce();
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID
        ? crypto.randomUUID()
        : `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'unknown-device';
  }
}

/* ─── S3 helpers (bootstrap + optional object ops) ─────────────────── */

/**
 * PUT/GET/DELETE JSON objects on S3-compatible storage (R2).
 * Used by credential bootstrap — vault sync uses core/sync-blob-store.js.
 */
export class S3CompatibleAdapter {
  id = 's3';
  label = 'S3-compatible (R2)';

  constructor(settings = loadSettings()) {
    this.settings = settings;
  }

  objectUrlFor(key) {
    const endpoint = (this.settings.s3Endpoint || '').replace(/\/$/, '');
    const bucket = this.settings.s3Bucket;
    const objectKey = String(key || '').replace(/^\/+/, '');
    return `${endpoint}/${bucket}/${objectKey}`;
  }

  async status() {
    const s = this.settings;
    if (!s.s3Endpoint || !s.s3Bucket || !s.s3AccessKeyId || !s.s3SecretAccessKey) {
      return {
        ok: false,
        label: 'Incomplete S3 settings',
        detail: 'Fill endpoint, bucket, access key, and secret in Settings.',
      };
    }
    return { ok: true, label: `S3 → ${s.s3Endpoint}/${s.s3Bucket}` };
  }

  async getObject(key) {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const url = this.objectUrlFor(key);
    const { headers } = await this._sign('GET', '', undefined, url);
    const res = await fetch(url, { method: 'GET', headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`);
    return res.json();
  }

  async putObject(key, payload) {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const url = this.objectUrlFor(key);
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const { headers } = await this._sign('PUT', body, 'application/json', url);
    const res = await fetch(url, { method: 'PUT', headers, body });
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status}`);
    return { ok: true };
  }

  async deleteObject(key) {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const url = this.objectUrlFor(key);
    const { headers } = await this._sign('DELETE', '', undefined, url);
    const res = await fetch(url, { method: 'DELETE', headers });
    if (res.status === 404) return { ok: true, missing: true };
    if (!res.ok) throw new Error(`S3 DELETE failed: ${res.status}`);
    return { ok: true };
  }

  /**
   * @param {string} method
   * @param {string} body
   * @param {string} [contentType]
   * @param {string} [objectUrl]
   */
  async _sign(method, body, contentType, objectUrl) {
    const s = this.settings;
    const url = new URL(objectUrl);
    const region = s.s3Region || 'auto';
    const service = 's3';
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = await sha256Hex(body || '');

    const headerMap = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headerMap['content-type'] = contentType;
    const sortedKeys = Object.keys(headerMap).sort();
    const canonicalHeadersSorted = sortedKeys.map((k) => `${k}:${headerMap[k]}\n`).join('');
    const signedHeadersSorted = sortedKeys.join(';');

    const canonicalRequest = [
      method,
      url.pathname,
      '',
      canonicalHeadersSorted,
      signedHeadersSorted,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = await getSignatureKey(s.s3SecretAccessKey, dateStamp, region, service);
    const signature = await hmacHex(signingKey, stringToSign);

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${s.s3AccessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeadersSorted}, Signature=${signature}`;

    const headers = {
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['Content-Type'] = contentType;

    return { headers };
  }
}

/**
 * Build an S3 adapter aimed at a specific bucket/endpoint (bootstrap bucket).
 * @param {object} opts
 * @returns {S3CompatibleAdapter}
 */
export function createS3AdapterFor(opts = {}) {
  const base = loadSettings();
  return new S3CompatibleAdapter({
    ...base,
    s3Endpoint: opts.endpoint || base.s3Endpoint,
    s3Region: opts.region || base.s3Region || 'auto',
    s3Bucket: opts.bucket || base.s3Bucket,
    s3AccessKeyId: opts.accessKeyId || base.s3AccessKeyId,
    s3SecretAccessKey: opts.secretAccessKey || base.s3SecretAccessKey,
  });
}

/* ─── Crypto helpers for SigV4 ─────────────────────────────────────── */

function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return new Uint8Array();
}

async function sha256Hex(data) {
  const hash = await crypto.subtle.digest('SHA-256', toBytes(data));
  return hex(hash);
}

async function hmac(key, data) {
  const keyBytes = toBytes(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, toBytes(data));
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
