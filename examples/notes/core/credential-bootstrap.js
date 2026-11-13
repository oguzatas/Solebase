/**
 * credential-bootstrap.js — Desktop → phone QR credential handoff for Notes
 *
 * Flow:
 *   1. Desktop (Settings → Share to another device) builds a bootstrap payload
 *      (appId, encryptionKey, R2 endpoint/region/bucket/keys/prefix).
 *   2. Prefer short-lived R2 blob: encrypt JSON, PUT under a one-time id, QR
 *      encodes only `?bootstrap=r.<id>.<key>` (TTL ~20 min). Public GET via
 *      r2.dev on the dedicated solebase-bootstrap bucket when the token can
 *      write there; otherwise fall back to compact `?bootstrap=c.<b64>`.
 *   3. Phone opens URL → consumeBootstrapToken → localStorage + Solebase.init.
 *   4. Delete-after-read when feasible (authenticated DELETE with applied keys).
 *
 * Never commit real secrets. Credentials live in browser localStorage only.
 */

import { encryptPayload, decryptPayload, isEncryptedEnvelope } from './prompt-crypto.js';
import {
  loadSettings,
  saveSettings,
  createS3AdapterFor,
  S3CompatibleAdapter,
} from './prompt-storage.js';
import { getAppId, getEncryptionKey, setEncryptionKey, R2_DEFAULTS } from './db-api.js';

/** Bootstrap blob TTL (20 minutes). */
export const BOOTSTRAP_TTL_MS = 20 * 60 * 1000;

/** Prefer compact QR when token length exceeds this (scannability). */
export const COMPACT_QR_MAX_CHARS = 1400;

export const BOOTSTRAP_KIND = 'solebase-notes-bootstrap';

/**
 * Dedicated public R2 bucket for one-time encrypted bootstrap blobs.
 * Public GET: https://pub-5dc0fd3d77ff435c941a0567b42f4005.r2.dev/<key>
 * Write still requires the user's S3 API token (same account).
 */
export const BOOTSTRAP_R2 = {
  endpoint: 'https://7701962a7c1ef34d73878ef8650ef733.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'solebase-bootstrap',
  publicBase: 'https://pub-5dc0fd3d77ff435c941a0567b42f4005.r2.dev',
  keyPrefix: 'b/',
};

function bytesToB64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8ToB64Url(text) {
  return bytesToB64Url(new TextEncoder().encode(text));
}

function b64UrlToUtf8(b64url) {
  return new TextDecoder().decode(b64UrlToBytes(b64url));
}

function randomToken(bytes = 18) {
  return bytesToB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Build the plaintext bootstrap payload from current device settings.
 * @param {object} [settings]
 * @param {string} [encryptionKey]
 */
export function buildBootstrapPayload(settings = loadSettings(), encryptionKey = getEncryptionKey()) {
  const accessKeyId = String(settings.s3AccessKeyId || '').trim();
  const secretAccessKey = String(settings.s3SecretAccessKey || '');
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Paste R2 Access Key ID + Secret and Save before sharing to another device.');
  }
  const enc = String(encryptionKey || '').trim();
  if (!enc) throw new Error('Encryption key is missing — open Settings and Save once.');

  const createdAt = Date.now();
  return {
    v: 1,
    kind: BOOTSTRAP_KIND,
    appId: getAppId(),
    encryptionKey: enc,
    s3Endpoint: (settings.s3Endpoint || R2_DEFAULTS.endpoint).replace(/\/$/, ''),
    s3Region: settings.s3Region || R2_DEFAULTS.region,
    s3Bucket: settings.s3Bucket || R2_DEFAULTS.bucket,
    s3AccessKeyId: accessKeyId,
    s3SecretAccessKey: secretAccessKey,
    s3Prefix: (settings.s3Prefix || R2_DEFAULTS.prefix).trim() || R2_DEFAULTS.prefix,
    solebaseAutoSync: settings.solebaseAutoSync !== false,
    rememberOnDevice: true,
    createdAt,
    expiresAt: createdAt + BOOTSTRAP_TTL_MS,
  };
}

/**
 * Notes page URL with a bootstrap query param (strips prior bootstrap/hash).
 * @param {string} token
 * @param {string} [baseHref]
 */
export function buildBootstrapUrl(token, baseHref = location.href) {
  const url = new URL(baseHref);
  url.hash = '';
  // Keep path; drop prior bootstrap / oauth noise
  url.search = '';
  url.searchParams.set('bootstrap', token);
  return url.toString();
}

function compactTokenFromPayload(payload) {
  return `c.${utf8ToB64Url(JSON.stringify(payload))}`;
}

/**
 * Upload encrypted bootstrap blob to the public solebase-bootstrap bucket.
 * @param {object} payload
 * @param {object} settings
 * @returns {Promise<{ id: string, key: string, objectKey: string, publicUrl: string }|null>}
 */
async function tryUploadPublicBootstrap(payload, settings) {
  const accessKeyId = String(settings.s3AccessKeyId || '').trim();
  const secretAccessKey = String(settings.s3SecretAccessKey || '');
  if (!accessKeyId || !secretAccessKey) return null;

  const id = crypto.randomUUID ? crypto.randomUUID() : randomToken(16);
  const key = randomToken(18);
  const envelope = await encryptPayload(payload, key);
  const objectKey = `${BOOTSTRAP_R2.keyPrefix}${id}.json`;
  const adapter = createS3AdapterFor({
    endpoint: BOOTSTRAP_R2.endpoint,
    region: BOOTSTRAP_R2.region,
    bucket: BOOTSTRAP_R2.bucket,
    accessKeyId,
    secretAccessKey,
  });

  try {
    await adapter.putObject(objectKey, {
      ...envelope,
      kind: BOOTSTRAP_KIND,
      expiresAt: payload.expiresAt,
    });
  } catch {
    return null;
  }

  return {
    id,
    key,
    objectKey,
    publicUrl: `${BOOTSTRAP_R2.publicBase}/${objectKey}`,
  };
}

/**
 * Also mirror under the user's sync bucket (private) for delete-after-read.
 * Best-effort; failures are ignored.
 * @param {string} id
 * @param {object} envelope
 * @param {object} settings
 */
async function tryMirrorPrivateBootstrap(id, envelope, settings) {
  try {
    const adapter = new S3CompatibleAdapter(settings);
    const st = await adapter.status();
    if (!st.ok) return null;
    const objectKey = `solebase-bootstrap/${id}.json`;
    await adapter.putObject(objectKey, envelope);
    return objectKey;
  } catch {
    return null;
  }
}

/**
 * Create a shareable bootstrap URL + QR payload for another device.
 * Prefers short `r.<id>.<key>` when public R2 upload works; else compact `c.<b64>`.
 *
 * @param {{ settings?: object, encryptionKey?: string, baseHref?: string }} [opts]
 */
export async function createBootstrapShare(opts = {}) {
  const settings = opts.settings || loadSettings();
  const payload = buildBootstrapPayload(settings, opts.encryptionKey || getEncryptionKey());
  const uploaded = await tryUploadPublicBootstrap(payload, settings);

  if (uploaded) {
    const envelope = await encryptPayload(payload, uploaded.key);
    await tryMirrorPrivateBootstrap(uploaded.id, envelope, settings);
    const token = `r.${uploaded.id}.${uploaded.key}`;
    const url = buildBootstrapUrl(token, opts.baseHref);
    return {
      mode: 'r2',
      token,
      url,
      expiresAt: payload.expiresAt,
      ttlMs: BOOTSTRAP_TTL_MS,
      objectKey: uploaded.objectKey,
      publicUrl: uploaded.publicUrl,
    };
  }

  const token = compactTokenFromPayload(payload);
  const url = buildBootstrapUrl(token, opts.baseHref);
  if (token.length > COMPACT_QR_MAX_CHARS) {
    throw new Error(
      'Bootstrap payload is too large for a reliable QR and R2 short-link upload failed. ' +
        'Ensure your R2 API token can write to bucket solebase-bootstrap (same account), then retry.'
    );
  }
  return {
    mode: 'compact',
    token,
    url,
    expiresAt: payload.expiresAt,
    ttlMs: BOOTSTRAP_TTL_MS,
    objectKey: null,
    publicUrl: null,
  };
}

function assertFreshPayload(payload) {
  if (!payload || payload.kind !== BOOTSTRAP_KIND) {
    throw new Error('Not a Solebase notes bootstrap payload');
  }
  if (payload.appId && payload.appId !== getAppId()) {
    throw new Error(`Bootstrap appId mismatch (got ${payload.appId})`);
  }
  if (payload.expiresAt && Date.now() > Number(payload.expiresAt)) {
    throw new Error('Bootstrap link expired — generate a new QR from the desktop Settings.');
  }
  return payload;
}

/**
 * Apply bootstrap credentials into localStorage + device encryption key.
 * @param {object} payload
 */
export function applyBootstrapPayload(payload) {
  const data = assertFreshPayload(payload);
  setEncryptionKey(data.encryptionKey);
  saveSettings({
    adapter: 'local',
    rememberOnDevice: true,
    encryptionKey: data.encryptionKey,
    s3Endpoint: data.s3Endpoint || R2_DEFAULTS.endpoint,
    s3Region: data.s3Region || R2_DEFAULTS.region,
    s3Bucket: data.s3Bucket || R2_DEFAULTS.bucket,
    s3AccessKeyId: data.s3AccessKeyId,
    s3SecretAccessKey: data.s3SecretAccessKey,
    s3Prefix: data.s3Prefix || R2_DEFAULTS.prefix,
    solebaseAutoSync: data.solebaseAutoSync !== false,
  });
  return loadSettings();
}

/**
 * Best-effort delete of one-time bootstrap objects after successful apply.
 * @param {{ id?: string, objectKey?: string, settings?: object }} info
 */
export async function deleteBootstrapArtifacts(info = {}) {
  const settings = info.settings || loadSettings();
  const id = info.id;
  const results = [];

  if (info.objectKey || id) {
    const objectKey = info.objectKey || `${BOOTSTRAP_R2.keyPrefix}${id}.json`;
    try {
      const adapter = createS3AdapterFor({
        endpoint: BOOTSTRAP_R2.endpoint,
        region: BOOTSTRAP_R2.region,
        bucket: BOOTSTRAP_R2.bucket,
        accessKeyId: settings.s3AccessKeyId,
        secretAccessKey: settings.s3SecretAccessKey,
      });
      results.push(await adapter.deleteObject(objectKey));
    } catch (err) {
      results.push({ ok: false, where: 'public', error: err.message });
    }
  }

  if (id) {
    try {
      const adapter = new S3CompatibleAdapter(settings);
      results.push(await adapter.deleteObject(`solebase-bootstrap/${id}.json`));
    } catch (err) {
      results.push({ ok: false, where: 'private', error: err.message });
    }
  }

  return results;
}

/**
 * Resolve a bootstrap token (`r.*` or `c.*`) to a payload.
 * @param {string} token
 */
export async function resolveBootstrapToken(token) {
  const raw = String(token || '').trim();
  if (!raw) throw new Error('Missing bootstrap token');

  if (raw.startsWith('c.')) {
    const json = b64UrlToUtf8(raw.slice(2));
    return assertFreshPayload(JSON.parse(json));
  }

  if (raw.startsWith('r.')) {
    const rest = raw.slice(2);
    const dot = rest.indexOf('.');
    if (dot <= 0) throw new Error('Invalid R2 bootstrap token');
    const id = rest.slice(0, dot);
    const key = rest.slice(dot + 1);
    if (!id || !key) throw new Error('Invalid R2 bootstrap token');

    const objectKey = `${BOOTSTRAP_R2.keyPrefix}${id}.json`;
    const publicUrl = `${BOOTSTRAP_R2.publicBase}/${objectKey}`;
    const res = await fetch(publicUrl, { method: 'GET', cache: 'no-store' });
    if (res.status === 404) {
      throw new Error('Bootstrap blob not found (already used or expired). Generate a new QR.');
    }
    if (!res.ok) throw new Error(`Bootstrap fetch failed: ${res.status}`);
    const envelope = await res.json();
    if (envelope?.expiresAt && Date.now() > Number(envelope.expiresAt)) {
      throw new Error('Bootstrap link expired — generate a new QR from the desktop Settings.');
    }
    if (!isEncryptedEnvelope(envelope)) {
      throw new Error('Bootstrap blob is not an encrypted envelope');
    }
    const payload = assertFreshPayload(await decryptPayload(envelope, key));
    payload._bootstrapMeta = { id, objectKey, mode: 'r2' };
    return payload;
  }

  // Bare UUID → treat as r-id without key (unsupported)
  throw new Error('Unrecognized bootstrap token. Use a QR / link from Settings → Share to another device.');
}

/**
 * Full consume: resolve → apply → delete-after-read.
 * @param {string} token
 */
export async function consumeBootstrapToken(token) {
  const payload = await resolveBootstrapToken(token);
  const meta = payload._bootstrapMeta || {};
  delete payload._bootstrapMeta;
  const settings = applyBootstrapPayload(payload);
  const deleted = await deleteBootstrapArtifacts({
    id: meta.id,
    objectKey: meta.objectKey,
    settings,
  });
  return { settings, payload, deleted, mode: meta.mode || 'compact' };
}

/**
 * Read `?bootstrap=` from the current URL (if any).
 * @param {string} [search]
 */
export function readBootstrapParam(search = location.search) {
  const params = new URLSearchParams(search);
  return params.get('bootstrap') || '';
}

/**
 * Strip bootstrap query from the address bar without reloading.
 */
export function clearBootstrapParamFromUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has('bootstrap')) return;
  url.searchParams.delete('bootstrap');
  const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash;
  history.replaceState({}, '', next);
}
