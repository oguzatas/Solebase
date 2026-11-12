/**
 * prompt-storage.js — Pluggable sync adapters for Prompt2UI
 *
 * Unified interface every adapter implements:
 *   async pull()            → returns remote blob (object | null)
 *   async push(payload)     → uploads payload (already encrypted if E2EE on)
 *   async status()          → { ok, label, detail? }
 *   async connect?()        → optional auth / handshake
 *   async disconnect?()     → optional teardown
 *
 * Adapters:
 *   LocalOnlyAdapter      — no network; data stays in Solebase (OPFS)
 *   GoogleDriveAdapter    — encrypted JSON in Drive appDataFolder (OAuth PKCE)
 *   WebDAVAdapter         — Nextcloud / ownCloud / NAS via HTTP Basic Auth
 *   S3CompatibleAdapter   — R2 / MinIO / AWS S3-compatible PUT/GET
 *
 * Credentials live in Settings (localStorage). Never hardcode secrets.
 * Fill placeholders in Settings → Cloud Sync before enabling a remote adapter.
 */

import { encryptPayload, decryptPayload, isEncryptedEnvelope } from './prompt-crypto.js';

const SETTINGS_KEY = 'prompt2ui:settings';
const DEVICE_KEY = 'prompt2ui:deviceId';
const CLOUD_BLOB_NAME = 'prompt2ui-vault.json';
export const SCHEMA_VERSION = 1;

/* ─── Settings helpers ─────────────────────────────────────────────── */

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaultSettings(), ...JSON.parse(raw) } : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial, updatedAt: Date.now() };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function defaultSettings() {
  return {
    adapter: 'local',
    passphrase: '', // held in memory preference only — user re-enters; we store a flag
    passphraseSet: false,
    // Google Drive OAuth (create at https://console.cloud.google.com/)
    googleClientId: '', // e.g. "123456789-xxxx.apps.googleusercontent.com"
    googleAccessToken: '',
    googleRefreshToken: '',
    googleTokenExpiry: 0,
    // WebDAV
    webdavUrl: '', // e.g. "https://cloud.example.com/remote.php/dav/files/USER/Prompt2UI/"
    webdavUsername: '',
    webdavPassword: '',
    // S3-compatible
    s3Endpoint: '', // e.g. "https://<account>.r2.cloudflarestorage.com" or MinIO URL
    s3Region: 'auto',
    s3Bucket: '',
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    s3ObjectKey: CLOUD_BLOB_NAME,
    lastSyncAt: null,
    lastSyncStatus: null,
  };
}

/** Stable device id for snapshot metadata (generated once per browser profile). */
export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID
        ? crypto.randomUUID()
        : `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'unknown-device';
  }
}

/* ─── Shared: wrap / unwrap with optional E2EE ─────────────────────── */

/**
 * Prepare a payload for cloud upload.
 * If passphrase is provided, encrypts with AES-GCM.
 */
export async function wrapForCloud(data, passphrase) {
  const envelope = {
    kind: 'prompt2ui-vault',
    schemaVersion: SCHEMA_VERSION,
    deviceId: getDeviceId(),
    updatedAt: Date.now(),
    exportedAt: new Date().toISOString(),
    data,
  };
  if (passphrase) {
    return encryptPayload(envelope, passphrase);
  }
  return envelope;
}

/**
 * Unwrap a cloud blob. Decrypts if it looks like an encrypted envelope.
 * @returns {Promise<{ data: unknown, meta: object }|null>}
 */
export async function unwrapFromCloud(blob, passphrase) {
  if (!blob) return null;
  let envelope = blob;
  if (isEncryptedEnvelope(blob)) {
    if (!passphrase) throw new Error('Encrypted vault — enter your passphrase in Settings');
    envelope = await decryptPayload(blob, passphrase);
  }
  const data = envelope?.data ?? envelope;
  return {
    data,
    meta: {
      kind: envelope?.kind,
      schemaVersion: envelope?.schemaVersion ?? SCHEMA_VERSION,
      deviceId: envelope?.deviceId ?? null,
      updatedAt: envelope?.updatedAt ?? null,
      exportedAt: envelope?.exportedAt ?? null,
    },
  };
}

/* ─── LocalOnlyAdapter ─────────────────────────────────────────────── */

export class LocalOnlyAdapter {
  id = 'local';
  label = 'Local only (OPFS / Solebase)';

  async pull() {
    return null; // local data is owned by PromptDB; nothing to pull
  }

  async push(_payload) {
    // No-op — persistence is handled by PromptDB
    return { ok: true };
  }

  async status() {
    return { ok: true, label: 'Local only — no network sync' };
  }
}

/* ─── GoogleDriveAdapter (OAuth 2.0 PKCE → appDataFolder) ──────────── */

/**
 * Stores a single encrypted JSON file in the Drive application data folder.
 * Requires a Google Cloud OAuth 2.0 Client ID (Web application) with:
 *   - Authorized JavaScript origins: your origin (e.g. http://localhost:3000)
 *   - Scope: https://www.googleapis.com/auth/drive.appdata
 *
 * Set `googleClientId` in Settings. Tokens are stored in localStorage after login.
 */
export class GoogleDriveAdapter {
  id = 'google-drive';
  label = 'Google Drive (appDataFolder)';

  constructor(settings = loadSettings()) {
    this.settings = settings;
  }

  get clientId() {
    return this.settings.googleClientId?.trim();
  }

  async status() {
    if (!this.clientId) {
      return {
        ok: false,
        label: 'Missing Google Client ID',
        detail: 'Create an OAuth Web client in Google Cloud Console and paste the Client ID in Settings.',
      };
    }
    if (!this.settings.googleAccessToken) {
      return { ok: false, label: 'Not signed in — click Connect in Settings' };
    }
    if (this.settings.googleTokenExpiry && Date.now() > this.settings.googleTokenExpiry) {
      return { ok: false, label: 'Access token expired — reconnect' };
    }
    return { ok: true, label: 'Connected to Google Drive' };
  }

  /** Generate PKCE verifier + challenge */
  async _pkce() {
    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const verifier = bufToB64Url(verifierBytes);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = bufToB64Url(new Uint8Array(digest));
    return { verifier, challenge };
  }

  /**
   * Start OAuth PKCE flow in a popup. Resolves when tokens are stored.
   * Call from a user gesture (button click).
   */
  async connect() {
    if (!this.clientId) throw new Error('Set googleClientId in Settings first');

    const { verifier, challenge } = await this._pkce();
    sessionStorage.setItem('prompt2ui:pkce_verifier', verifier);

    const redirectUri = window.location.origin + window.location.pathname;
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.appdata',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    const popup = window.open(authUrl, 'prompt2ui-google', 'width=500,height=650');
    if (!popup) throw new Error('Popup blocked — allow popups for OAuth');

    // Listen for redirect back with ?code= (same origin)
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 5 * 60_000;
      const timer = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('OAuth timed out'));
          return;
        }
        try {
          const url = popup.location?.href;
          if (!url || url === 'about:blank') return;
          const u = new URL(url);
          const code = u.searchParams.get('code');
          const err = u.searchParams.get('error');
          if (err) {
            clearInterval(timer);
            popup.close();
            reject(new Error(`OAuth error: ${err}`));
            return;
          }
          if (code) {
            clearInterval(timer);
            popup.close();
            await this._exchangeCode(code, redirectUri, verifier);
            resolve(true);
          }
        } catch {
          // Cross-origin until redirect lands on our origin — ignore
        }
      }, 400);
    });
  }

  async _exchangeCode(code, redirectUri, verifier) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed: ${res.status} ${text}`);
    }
    const json = await res.json();
    this.settings = saveSettings({
      googleAccessToken: json.access_token,
      googleRefreshToken: json.refresh_token || this.settings.googleRefreshToken,
      googleTokenExpiry: Date.now() + (json.expires_in || 3600) * 1000 - 30_000,
    });
    sessionStorage.removeItem('prompt2ui:pkce_verifier');
  }

  async disconnect() {
    this.settings = saveSettings({
      googleAccessToken: '',
      googleRefreshToken: '',
      googleTokenExpiry: 0,
    });
  }

  _authHeaders() {
    if (!this.settings.googleAccessToken) throw new Error('Not signed in to Google');
    return { Authorization: `Bearer ${this.settings.googleAccessToken}` };
  }

  /** Find existing vault file in appDataFolder */
  async _findFile() {
    const q = encodeURIComponent(`name='${CLOUD_BLOB_NAME}'`);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`,
      { headers: this._authHeaders() }
    );
    if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
    const json = await res.json();
    return json.files?.[0] ?? null;
  }

  async pull() {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const file = await this._findFile();
    if (!file) return null;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      { headers: this._authHeaders() }
    );
    if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
    return res.json();
  }

  async push(payload) {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const body = JSON.stringify(payload);
    const existing = await this._findFile();

    if (existing) {
      const res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            ...this._authHeaders(),
            'Content-Type': 'application/json',
          },
          body,
        }
      );
      if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
      return { ok: true, fileId: existing.id };
    }

    // Multipart create in appDataFolder
    const meta = JSON.stringify({
      name: CLOUD_BLOB_NAME,
      parents: ['appDataFolder'],
    });
    const boundary = 'prompt2ui_' + Date.now();
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n` +
      `--${boundary}--`;

    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          ...this._authHeaders(),
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipart,
      }
    );
    if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
    const json = await res.json();
    return { ok: true, fileId: json.id };
  }
}

/* ─── WebDAVAdapter ────────────────────────────────────────────────── */

/**
 * Syncs a single JSON file via WebDAV (Nextcloud, ownCloud, Synology, etc.).
 * Settings: webdavUrl (folder ending with /), webdavUsername, webdavPassword.
 * Uses HTTP Basic Auth. Prefer HTTPS endpoints.
 */
export class WebDAVAdapter {
  id = 'webdav';
  label = 'WebDAV (Nextcloud / NAS)';

  constructor(settings = loadSettings()) {
    this.settings = settings;
  }

  get fileUrl() {
    const base = (this.settings.webdavUrl || '').replace(/\/?$/, '/');
    return base + CLOUD_BLOB_NAME;
  }

  _headers(extra = {}) {
    const user = this.settings.webdavUsername || '';
    const pass = this.settings.webdavPassword || '';
    const token = btoa(`${user}:${pass}`);
    return {
      Authorization: `Basic ${token}`,
      ...extra,
    };
  }

  async status() {
    if (!this.settings.webdavUrl) {
      return { ok: false, label: 'Missing WebDAV URL' };
    }
    if (!this.settings.webdavUsername) {
      return { ok: false, label: 'Missing WebDAV username' };
    }
    return { ok: true, label: `WebDAV → ${this.fileUrl}` };
  }

  async pull() {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const res = await fetch(this.fileUrl, {
      method: 'GET',
      headers: this._headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WebDAV GET failed: ${res.status}`);
    return res.json();
  }

  async push(payload) {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const res = await fetch(this.fileUrl, {
      method: 'PUT',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`WebDAV PUT failed: ${res.status}`);
    return { ok: true };
  }
}

/* ─── S3CompatibleAdapter ──────────────────────────────────────────── */

/**
 * PUT/GET a JSON object to an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO).
 * Uses AWS Signature Version 4 (browser-side).
 *
 * Settings placeholders:
 *   s3Endpoint, s3Region, s3Bucket, s3AccessKeyId, s3SecretAccessKey, s3ObjectKey
 *
 * CORS: configure the bucket to allow GET/PUT/HEAD from your origin.
 */
export class S3CompatibleAdapter {
  id = 's3';
  label = 'S3-compatible (R2 / MinIO / AWS)';

  constructor(settings = loadSettings()) {
    this.settings = settings;
  }

  get objectUrl() {
    const endpoint = (this.settings.s3Endpoint || '').replace(/\/$/, '');
    const bucket = this.settings.s3Bucket;
    const key = this.settings.s3ObjectKey || CLOUD_BLOB_NAME;
    // Path-style: https://endpoint/bucket/key  (works for R2 + MinIO)
    return `${endpoint}/${bucket}/${key}`;
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
    return { ok: true, label: `S3 → ${this.objectUrl}` };
  }

  async pull() {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const { headers } = await this._sign('GET', '');
    const res = await fetch(this.objectUrl, { method: 'GET', headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`);
    return res.json();
  }

  async push(payload) {
    const st = await this.status();
    if (!st.ok) throw new Error(st.label);
    const body = JSON.stringify(payload);
    const { headers } = await this._sign('PUT', body, 'application/json');
    const res = await fetch(this.objectUrl, {
      method: 'PUT',
      headers,
      body,
    });
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status}`);
    return { ok: true };
  }

  /**
   * Minimal AWS SigV4 for a single object URL (path-style).
   * Sufficient for R2 / MinIO / S3 when CORS is configured.
   */
  async _sign(method, body, contentType) {
    const s = this.settings;
    const url = new URL(this.objectUrl);
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
      '', // no query
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

/* ─── Adapter factory ──────────────────────────────────────────────── */

const ADAPTERS = {
  local: LocalOnlyAdapter,
  'google-drive': GoogleDriveAdapter,
  webdav: WebDAVAdapter,
  s3: S3CompatibleAdapter,
};

/**
 * Create the adapter currently selected in Settings.
 * @param {object} [settings]
 * @returns {LocalOnlyAdapter|GoogleDriveAdapter|WebDAVAdapter|S3CompatibleAdapter}
 */
export function createAdapter(settings = loadSettings()) {
  const Ctor = ADAPTERS[settings.adapter] || LocalOnlyAdapter;
  return new Ctor(settings);
}

/** List adapters for the Settings UI */
export function listAdapters() {
  return [
    { id: 'local', label: 'Local only (OPFS / Solebase)', needs: [] },
    {
      id: 'google-drive',
      label: 'Google Drive (appDataFolder)',
      needs: ['googleClientId'],
    },
    {
      id: 'webdav',
      label: 'WebDAV (Nextcloud / NAS)',
      needs: ['webdavUrl', 'webdavUsername', 'webdavPassword'],
    },
    {
      id: 's3',
      label: 'S3-compatible (R2 / MinIO / AWS)',
      needs: ['s3Endpoint', 's3Bucket', 's3AccessKeyId', 's3SecretAccessKey'],
    },
  ];
}

/**
 * Push all local collections to the active adapter (encrypted if passphrase set).
 * Prefer SyncEngine.syncNow() from app code; this remains for manual Settings actions.
 * @param {Record<string, object[]>} collections - map of collectionName → items
 * @param {string} [passphrase]
 */
export async function syncPush(collections, passphrase) {
  const settings = loadSettings();
  const adapter = createAdapter(settings);
  const wrapped = await wrapForCloud(collections, passphrase || undefined);
  const result = await adapter.push(wrapped);
  saveSettings({ lastSyncAt: Date.now(), lastSyncStatus: 'push-ok' });
  return result;
}

/**
 * Pull remote vault and return collections map (decrypted if needed).
 * @param {string} [passphrase]
 * @returns {Promise<Record<string, object[]>|null>}
 */
export async function syncPull(passphrase) {
  const settings = loadSettings();
  const adapter = createAdapter(settings);
  const blob = await adapter.pull();
  const unwrapped = await unwrapFromCloud(blob, passphrase || undefined);
  saveSettings({ lastSyncAt: Date.now(), lastSyncStatus: 'pull-ok' });
  return unwrapped?.data ?? null;
}

/* ─── Crypto helpers for SigV4 ─────────────────────────────────────── */

function bufToB64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
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
