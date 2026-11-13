/**
 * settings-panel.js — Solebase Notes Settings (R2 sync + share / QR bootstrap)
 *
 * Sync path is Solebase Layer 1 only (OPFS + E2EE changesets → R2).
 * No legacy snapshot adapters, IndexedDB PromptDB, or dual passphrase sync.
 */

import {
  loadSettings,
  saveSettingsPreservingSecrets,
} from './prompt-storage.js';
import { db, R2_DEFAULTS } from './db-api.js';
import { createBootstrapShare } from './credential-bootstrap.js';

const $ = (sel, el = document) => el.querySelector(sel);

/** CDN QR lib (zero-build). Loaded once on first Share paint. */
const QR_MODULE_URL = 'https://esm.sh/qrcode@1.5.4';

const SAVED_SECRET_PLACEHOLDER = '******** (saved on this device)';

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

/**
 * Mount / wire the Settings drawer already present in index.html.
 * @param {{
 *   toast?: (msg: string, type?: string) => void,
 *   onImported?: () => void,
 * }} [opts]
 */
export function initSettingsPanel(opts = {}) {
  if (opts.toast) toastFn = opts.toast;

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

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest?.('[data-open-settings], #btn-settings');
    if (trigger) {
      e.preventDefault();
      openSettings();
    }
  });
  $('#btn-close-settings')?.addEventListener('click', closeSettings);
  backdrop?.addEventListener('click', closeSettings);

  $('#cfg-save')?.addEventListener('click', async () => {
    try {
      readSettingsFromForm();
      // Reconfigure only on Save (credential changes). Never on Sync Now.
      await db.reconfigure();
      paintSettingsForm();
      toastFn('Settings saved on this device', 'ok');
      await updateSyncStatus();
      if (db.hasSolebaseSync() && db.solebase?.getSync()) {
        const result = await db.syncNow('settings-save');
        if (result?.ok !== false) {
          toastFn('Solebase R2 sync enabled', 'ok');
          opts.onImported?.();
        } else if (result?.detail || result?.error) {
          toastFn(result.detail || result.error, 'err');
        }
      }
    } catch (err) {
      toastFn(err.message || 'Save failed', 'err');
    }
  });

  $('#cfg-solebase-sync-now')?.addEventListener('click', async () => {
    try {
      readSettingsFromForm();
      // Reuse live OPFS worker — force reopen caused phone InvalidStateError.
      await db.ready();
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

  $('#cfg-bootstrap-generate')?.addEventListener('click', async () => {
    try {
      readSettingsFromForm();
      await paintBootstrapShare({ force: true });
      toastFn('Device bootstrap QR ready', 'ok');
    } catch (err) {
      toastFn(err.message || 'Could not create bootstrap QR', 'err');
    }
  });

  $('#cfg-bootstrap-copy')?.addEventListener('click', async () => {
    const url = $('#cfg-bootstrap-url')?.value;
    if (!url) {
      toastFn('Generate a bootstrap link first', 'info');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toastFn('Bootstrap URL copied', 'ok');
    } catch {
      const input = $('#cfg-bootstrap-url');
      if (input) {
        input.focus();
        input.select();
        document.execCommand('copy');
        toastFn('Bootstrap URL copied', 'ok');
      } else {
        toastFn('Could not copy URL', 'err');
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });

  return { openSettings, closeSettings };
}

/**
 * Paint a secret input: leave value blank, show masked placeholder when saved.
 * @param {string} sel
 * @param {string} saved
 * @param {string} emptyPlaceholder
 */
function paintSecretField(sel, saved, emptyPlaceholder) {
  const el = $(sel);
  if (!el) return;
  el.value = '';
  el.placeholder = saved ? SAVED_SECRET_PLACEHOLDER : emptyPlaceholder;
  el.dataset.hasSaved = saved ? '1' : '0';
}

function paintSettingsForm() {
  const s = loadSettings();

  $('#cfg-encryption-key').value = db.getEncryptionKey();
  $('#cfg-s3-endpoint').value = s.s3Endpoint || R2_DEFAULTS.endpoint;
  $('#cfg-s3-region').value = s.s3Region || R2_DEFAULTS.region;
  $('#cfg-s3-bucket').value = s.s3Bucket || R2_DEFAULTS.bucket;
  $('#cfg-s3-key').value = s.s3AccessKeyId || '';
  paintSecretField('#cfg-s3-secret', s.s3SecretAccessKey, 'Paste R2 secret access key');
  $('#cfg-s3-prefix').value = s.s3Prefix || R2_DEFAULTS.prefix;
  if ($('#cfg-solebase-autosync')) {
    $('#cfg-solebase-autosync').checked = s.solebaseAutoSync !== false;
  }
  if ($('#cfg-remember-device')) {
    $('#cfg-remember-device').checked = s.rememberOnDevice !== false;
  }

  updateSyncStatus();
  paintSharePanel();
  paintBootstrapPanelIdle();
}

function isLocalHostOrigin(hostname = location.hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function paintQrOnCanvas(canvas, text) {
  if (!canvas) return Promise.resolve();

  const fallback = (label = 'QR unavailable') => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#111419';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#6b7380';
    ctx.font = '12px Figtree, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  };

  return loadQrModule()
    .then((mod) => {
      const QRCode = mod.default || mod;
      return QRCode.toCanvas(canvas, text, {
        width: canvas.width || 168,
        margin: 1,
        color: { dark: '#e6e9ee', light: '#111419' },
        errorCorrectionLevel: 'M',
      });
    })
    .catch(() => fallback());
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

  paintQrOnCanvas(canvas, url);
}

function paintBootstrapPanelIdle() {
  const status = $('#cfg-bootstrap-status');
  const urlInput = $('#cfg-bootstrap-url');
  const canvas = $('#cfg-bootstrap-qr');
  if (urlInput && !urlInput.dataset.live) urlInput.value = '';
  if (status && !status.dataset.live) {
    status.textContent =
      'Generates a short-lived link that fills R2 credentials + encryption key on another device.';
  }
  if (canvas && !canvas.dataset.live) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#111419';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#6b7380';
      ctx.font = '12px Figtree, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Generate to show QR', canvas.width / 2, canvas.height / 2);
    }
  }
}

/**
 * Create (or refresh) the credential bootstrap QR / URL.
 * @param {{ force?: boolean }} [opts]
 */
async function paintBootstrapShare(opts = {}) {
  const status = $('#cfg-bootstrap-status');
  const urlInput = $('#cfg-bootstrap-url');
  const canvas = $('#cfg-bootstrap-qr');
  const localTip = $('#cfg-bootstrap-localhost-tip');

  if (localTip) localTip.hidden = !isLocalHostOrigin();

  if (!opts.force && urlInput?.dataset.live === '1') return;

  if (status) {
    status.textContent = 'Creating short-lived bootstrap…';
    status.dataset.live = '0';
  }

  const share = await createBootstrapShare({
    settings: loadSettings(),
    encryptionKey: db.getEncryptionKey(),
  });

  if (urlInput) {
    urlInput.value = share.url;
    urlInput.dataset.live = '1';
  }
  if (canvas) canvas.dataset.live = '1';

  const mins = Math.round((share.expiresAt - Date.now()) / 60000);
  const modeHint =
    share.mode === 'r2'
      ? `Short link (R2 one-time id). Expires in ~${mins || 1} min; deleted after first successful open when possible.`
      : `Compact payload in URL (R2 short-upload unavailable). Expires in ~${mins || 1} min.`;

  if (status) {
    status.textContent = modeHint;
    status.dataset.live = '1';
    status.dataset.ok = '1';
  }

  await paintQrOnCanvas(canvas, share.url);
  return share;
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

  const last = settings.lastSyncAt
    ? ` · last ${new Date(settings.lastSyncAt).toLocaleString()}`
    : '';
  el.textContent = `Paste R2 Access Key ID + Secret, then Save${last}`;
  el.dataset.ok = '0';
}

function readSettingsFromForm() {
  const prev = loadSettings();
  const rememberOnDevice = $('#cfg-remember-device')
    ? $('#cfg-remember-device').checked
    : prev.rememberOnDevice !== false;

  const encKey = $('#cfg-encryption-key')?.value?.trim();
  if (encKey) {
    try {
      db.setEncryptionKey(encKey);
    } catch (err) {
      toastFn(err.message, 'err');
    }
  }

  return saveSettingsPreservingSecrets(
    {
      rememberOnDevice,
      encryptionKey: encKey || prev.encryptionKey || db.getEncryptionKey(),
      s3Endpoint: $('#cfg-s3-endpoint')?.value.trim() || R2_DEFAULTS.endpoint,
      s3Region: $('#cfg-s3-region')?.value.trim() || R2_DEFAULTS.region,
      s3Bucket: $('#cfg-s3-bucket')?.value.trim() || R2_DEFAULTS.bucket,
      s3AccessKeyId: $('#cfg-s3-key')?.value.trim() || '',
      s3SecretAccessKey: $('#cfg-s3-secret')?.value || '',
      s3Prefix: $('#cfg-s3-prefix')?.value.trim() || R2_DEFAULTS.prefix,
      solebaseAutoSync: $('#cfg-solebase-autosync')
        ? $('#cfg-solebase-autosync').checked
        : true,
    },
    { preserveSecrets: rememberOnDevice }
  );
}

async function exportVault() {
  const collections = await db.exportSnapshot();
  const payload = {
    kind: 'solebase-notes-vault',
    exportedAt: new Date().toISOString(),
    data: collections,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `solebase-notes-vault-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toastFn('Vault downloaded', 'ok');
}

async function importVault(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const data = parsed.data ?? parsed;
  await db.applyRemoteSnapshot(data);
  toastFn('Vault imported', 'ok');
}
