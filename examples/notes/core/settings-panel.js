/**
 * settings-panel.js — Settings UI (share, backend, passphrase, export/import)
 *
 * Extracted from the old multi-app shell. Choosing a remote adapter +
 * passphrase enables SyncEngine automatically (debounced pull/merge/push).
 *
 * Share = same origin URL + QR. Host is a file server only — not a database.
 * Sync (encrypted snapshot) is optional and separate from hosting.
 */

import { encryptPayload, decryptPayload } from './prompt-crypto.js';
import {
  loadSettings,
  saveSettings,
  createAdapter,
  listAdapters,
} from './prompt-storage.js';
import { db, R2_DEFAULTS } from './db-api.js';
import { syncEngine } from './sync-engine.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** CDN QR lib (zero-build). Loaded once on first Share paint. */
const QR_MODULE_URL = 'https://esm.sh/qrcode@1.5.4';

/** @type {string} session-only passphrase */
let sessionPassphrase = '';

/** @type {(msg: string, type?: string) => void} */
let toastFn = (msg) => console.log('[settings]', msg);

/** @type {Promise<typeof import('https://esm.sh/qrcode@1.5.4')> | null} */
let qrModulePromise = null;

function loadQrModule() {
  if (!qrModulePromise) {
    qrModulePromise = import(QR_MODULE_URL).catch((err) => {
      qrModulePromise = null;
      throw err;
    });
  }
  return qrModulePromise;
}

export function getSessionPassphrase() {
  return sessionPassphrase;
}

export function setSessionPassphrase(value) {
  sessionPassphrase = value || '';
}

/**
 * Mount / wire the Settings drawer already present in index.html.
 * @param {{
 *   toast?: (msg: string, type?: string) => void,
 *   onImported?: () => void,
 * }} [opts]
 */
export function initSettingsPanel(opts = {}) {
  if (opts.toast) toastFn = opts.toast;

  syncEngine.configure({
    getPassphrase: () => sessionPassphrase,
    exportSnapshot: () => db.exportSnapshot(),
    applyRemoteSnapshot: (collections) => db.applyRemoteSnapshot(collections),
    onStatus: (msg, type) => {
      if (type === 'err') toastFn(msg, 'err');
    },
  });
  syncEngine.start();

  const drawer = $('#settings-drawer');
  const backdrop = $('#settings-backdrop');

  function openSettings() {
    paintSettingsForm();
    drawer.classList.add('open');
    backdrop.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
  }

  function closeSettings() {
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  // Delegate so gear works even when the app mounts after init
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest?.('[data-open-settings], #btn-settings');
    if (trigger) {
      e.preventDefault();
      openSettings();
    }
  });
  $('#btn-close-settings')?.addEventListener('click', closeSettings);
  backdrop?.addEventListener('click', closeSettings);

  $('#cfg-adapter')?.addEventListener('change', (e) => {
    updateAdapterPanels(e.target.value);
  });

  $('#cfg-save')?.addEventListener('click', async () => {
    try {
      readSettingsFromForm();
      await db.reconfigure();
      toastFn('Settings saved', 'ok');
      await updateSyncStatus();
      if (db.hasSolebaseSync() && db.solebase?.getSync()) {
        const result = await db.syncNow('settings-save');
        if (result?.ok !== false) {
          toastFn('Solebase R2 sync enabled', 'ok');
          opts.onImported?.();
        }
      } else if (syncEngine.isEnabled()) {
        const result = await syncEngine.syncNow('settings-save');
        if (result.ok) toastFn('Cloud sync enabled', 'ok');
      }
    } catch (err) {
      toastFn(err.message || 'Save failed', 'err');
    }
  });

  $('#cfg-solebase-sync-now')?.addEventListener('click', async () => {
    try {
      readSettingsFromForm();
      await db.reconfigure();
      const result = await db.syncNow('manual');
      if (result?.reason === 'idle' || result?.error === 'sync not configured') {
        toastFn(result.detail || 'Paste R2 keys, then Save.', 'info');
      } else if (result?.ok === false) {
        toastFn(result.detail || result.error || 'Sync failed', 'err');
      } else {
        toastFn('Synced via Solebase (R2)', 'ok');
        opts.onImported?.();
      }
      await updateSyncStatus();
    } catch (err) {
      toastFn(err.message || 'Sync failed', 'err');
    }
  });

  $('#cfg-connect-google')?.addEventListener('click', async () => {
    try {
      readSettingsFromForm();
      const adapter = createAdapter(loadSettings());
      if (adapter.connect) {
        await adapter.connect();
        toastFn('Google Drive connected', 'ok');
        await updateSyncStatus();
        if (syncEngine.isEnabled()) {
          await syncEngine.syncNow('google-connect');
        }
      }
    } catch (err) {
      toastFn(err.message, 'err');
    }
  });

  $('#cfg-push')?.addEventListener('click', async () => {
    try {
      readSettingsFromForm();
      if (!sessionPassphrase && loadSettings().adapter !== 'local') {
        throw new Error('Enter a passphrase to encrypt cloud sync');
      }
      const result = await syncEngine.syncNow('manual-push');
      if (result.reason === 'idle') {
        // Local-only: still allow exporting conceptually via push no-op
        toastFn('Local only — nothing to push. Pick a cloud adapter + passphrase.', 'info');
      } else if (result.ok) {
        toastFn('Synced to cloud', 'ok');
      } else if (result.detail) {
        toastFn(result.detail, 'err');
      }
      await updateSyncStatus();
    } catch (err) {
      toastFn(err.message, 'err');
    }
  });

  $('#cfg-pull')?.addEventListener('click', async () => {
    try {
      readSettingsFromForm();
      const result = await syncEngine.syncNow('manual-pull');
      if (result.reason === 'idle') {
        toastFn('Local only — nothing to pull. Pick a cloud adapter + passphrase.', 'info');
      } else if (result.ok) {
        toastFn('Pulled & merged from cloud', 'ok');
        opts.onImported?.();
      } else if (result.detail) {
        toastFn(result.detail, 'err');
      }
      await updateSyncStatus();
    } catch (err) {
      toastFn(err.message, 'err');
    }
  });

  $('#cfg-export')?.addEventListener('click', async () => {
    try {
      readSettingsFromForm();
      await exportVault();
    } catch (err) {
      toastFn(err.message, 'err');
    }
  });

  $('#cfg-import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      readSettingsFromForm();
      await importVault(file);
      opts.onImported?.();
    } catch (err) {
      toastFn(err.message, 'err');
    }
    e.target.value = '';
  });

  $('#cfg-share-copy')?.addEventListener('click', async () => {
    const url = $('#cfg-share-url')?.value || location.href;
    try {
      await navigator.clipboard.writeText(url);
      toastFn('URL copied', 'ok');
    } catch {
      // Fallback for older / insecure contexts
      const input = $('#cfg-share-url');
      if (input) {
        input.focus();
        input.select();
        document.execCommand('copy');
        toastFn('URL copied', 'ok');
      } else {
        toastFn('Could not copy URL', 'err');
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });

  return { openSettings, closeSettings, getSessionPassphrase };
}

function paintSettingsForm() {
  const s = loadSettings();
  const adapterSelect = $('#cfg-adapter');
  if (!adapterSelect) return;

  adapterSelect.innerHTML = listAdapters()
    .map((a) => `<option value="${a.id}" ${s.adapter === a.id ? 'selected' : ''}>${a.label}</option>`)
    .join('');

  $('#cfg-passphrase').value = sessionPassphrase;
  $('#cfg-encryption-key').value = db.getEncryptionKey();
  $('#cfg-google-client').value = s.googleClientId || '';
  $('#cfg-webdav-url').value = s.webdavUrl || '';
  $('#cfg-webdav-user').value = s.webdavUsername || '';
  $('#cfg-webdav-pass').value = s.webdavPassword || '';
  $('#cfg-s3-endpoint').value = s.s3Endpoint || R2_DEFAULTS.endpoint;
  $('#cfg-s3-region').value = s.s3Region || R2_DEFAULTS.region;
  $('#cfg-s3-bucket').value = s.s3Bucket || R2_DEFAULTS.bucket;
  $('#cfg-s3-key').value = s.s3AccessKeyId || '';
  $('#cfg-s3-secret').value = s.s3SecretAccessKey || '';
  $('#cfg-s3-prefix').value = s.s3Prefix || R2_DEFAULTS.prefix;
  $('#cfg-s3-object').value = s.s3ObjectKey || 'prompt2ui-vault.json';
  if ($('#cfg-solebase-autosync')) {
    $('#cfg-solebase-autosync').checked = s.solebaseAutoSync !== false;
  }

  updateAdapterPanels(s.adapter);
  updateSyncStatus();
  paintSharePanel();
}

function isLocalHostOrigin(hostname = location.hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function paintSharePanel() {
  const urlInput = $('#cfg-share-url');
  const canvas = $('#cfg-share-qr');
  const localTip = $('#cfg-share-localhost-tip');
  if (!urlInput && !canvas) return;

  const url = location.href.split('#')[0];
  if (urlInput) urlInput.value = url;

  if (localTip) {
    localTip.hidden = !isLocalHostOrigin();
  }

  if (!canvas) return;

  const fallback = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#111419';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#6b7380';
    ctx.font = '12px Figtree, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('QR unavailable', canvas.width / 2, canvas.height / 2);
  };

  loadQrModule()
    .then((mod) => {
      const QRCode = mod.default || mod;
      return QRCode.toCanvas(canvas, url, {
        width: 168,
        margin: 1,
        color: { dark: '#e6e9ee', light: '#111419' },
        errorCorrectionLevel: 'M',
      });
    })
    .catch(() => fallback());
}

function updateAdapterPanels(adapterId) {
  $$('[data-adapter-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.adapterPanel !== adapterId;
  });
}

async function updateSyncStatus() {
  const el = $('#cfg-sync-status');
  if (!el) return;
  const settings = loadSettings();
  const solebaseSync = db.buildS3SyncConfig(settings);
  const live = Boolean(db.solebase?.getSync?.());

  if (solebaseSync) {
    const o = solebaseSync.options;
    el.textContent = live
      ? `Solebase R2 sync live · ${o.bucket} @ ${o.endpoint}`
      : `Solebase R2 credentials saved · Save / Sync Now to connect · ${o.bucket}`;
    el.dataset.ok = live ? '1' : '0';
    return;
  }

  const adapter = createAdapter(settings);
  const st = await adapter.status();
  const enabled = syncEngine.isEnabled();
  const syncHint = enabled
    ? ' · legacy snapshot auto-sync on'
    : settings.adapter === 'local'
      ? ' · paste R2 Access Key ID + Secret for Solebase sync'
      : ' · legacy auto-sync idle (enter passphrase)';
  const last = settings.lastSyncAt
    ? ` · last ${new Date(settings.lastSyncAt).toLocaleString()}`
    : '';
  el.textContent = st.label + (st.detail ? ` — ${st.detail}` : '') + syncHint + last;
  el.dataset.ok = st.ok ? '1' : '0';
}

function readSettingsFromForm() {
  sessionPassphrase = $('#cfg-passphrase')?.value || '';
  const encKey = $('#cfg-encryption-key')?.value?.trim();
  if (encKey) {
    try {
      db.setEncryptionKey(encKey);
    } catch (err) {
      toastFn(err.message, 'err');
    }
  }
  return saveSettings({
    adapter: $('#cfg-adapter')?.value || 'local',
    passphraseSet: Boolean(sessionPassphrase),
    googleClientId: $('#cfg-google-client')?.value.trim() || '',
    webdavUrl: $('#cfg-webdav-url')?.value.trim() || '',
    webdavUsername: $('#cfg-webdav-user')?.value.trim() || '',
    webdavPassword: $('#cfg-webdav-pass')?.value || '',
    s3Endpoint: $('#cfg-s3-endpoint')?.value.trim() || R2_DEFAULTS.endpoint,
    s3Region: $('#cfg-s3-region')?.value.trim() || R2_DEFAULTS.region,
    s3Bucket: $('#cfg-s3-bucket')?.value.trim() || R2_DEFAULTS.bucket,
    s3AccessKeyId: $('#cfg-s3-key')?.value.trim() || '',
    s3SecretAccessKey: $('#cfg-s3-secret')?.value || '',
    s3Prefix: $('#cfg-s3-prefix')?.value.trim() || R2_DEFAULTS.prefix,
    s3ObjectKey: $('#cfg-s3-object')?.value.trim() || 'prompt2ui-vault.json',
    solebaseAutoSync: $('#cfg-solebase-autosync')
      ? $('#cfg-solebase-autosync').checked
      : true,
  });
}

async function exportVault() {
  const collections = await db.exportSnapshot();
  let payload = {
    kind: 'prompt2ui-vault',
    exportedAt: new Date().toISOString(),
    data: collections,
  };
  if (sessionPassphrase) {
    payload = await encryptPayload(payload, sessionPassphrase);
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `prompt2ui-vault-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toastFn(sessionPassphrase ? 'Encrypted vault downloaded' : 'Vault downloaded', 'ok');
}

async function importVault(file) {
  const text = await file.text();
  let parsed = JSON.parse(text);
  if (parsed.v && parsed.ciphertext) {
    if (!sessionPassphrase) throw new Error('Enter passphrase in Settings to decrypt');
    parsed = await decryptPayload(parsed, sessionPassphrase);
  }
  const data = parsed.data ?? parsed;
  await db.applyRemoteSnapshot(data);
  toastFn('Vault imported', 'ok');
}
