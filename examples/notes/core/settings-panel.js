/**
 * settings-panel.js — Settings UI (backend, passphrase, export/import)
 *
 * Extracted from the old multi-app shell. Choosing a remote adapter +
 * passphrase enables SyncEngine automatically (debounced pull/merge/push).
 */

import { encryptPayload, decryptPayload } from './prompt-crypto.js';
import {
  loadSettings,
  saveSettings,
  createAdapter,
  listAdapters,
} from './prompt-storage.js';
import { db } from './db-api.js';
import { syncEngine } from './sync-engine.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** @type {string} session-only passphrase */
let sessionPassphrase = '';

/** @type {(msg: string, type?: string) => void} */
let toastFn = (msg) => console.log('[settings]', msg);

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

  // Delegate so gear works even when vault mounts after init (editor-first shell)
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
    readSettingsFromForm();
    toastFn('Settings saved', 'ok');
    await updateSyncStatus();
    // Choosing adapter + passphrase enables sync automatically
    if (syncEngine.isEnabled()) {
      const result = await syncEngine.syncNow('settings-save');
      if (result.ok) toastFn('Cloud sync enabled', 'ok');
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
  $('#cfg-google-client').value = s.googleClientId || '';
  $('#cfg-webdav-url').value = s.webdavUrl || '';
  $('#cfg-webdav-user').value = s.webdavUsername || '';
  $('#cfg-webdav-pass').value = s.webdavPassword || '';
  $('#cfg-s3-endpoint').value = s.s3Endpoint || '';
  $('#cfg-s3-region').value = s.s3Region || 'auto';
  $('#cfg-s3-bucket').value = s.s3Bucket || '';
  $('#cfg-s3-key').value = s.s3AccessKeyId || '';
  $('#cfg-s3-secret').value = s.s3SecretAccessKey || '';
  $('#cfg-s3-object').value = s.s3ObjectKey || 'prompt2ui-vault.json';

  updateAdapterPanels(s.adapter);
  updateSyncStatus();
}

function updateAdapterPanels(adapterId) {
  $$('[data-adapter-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.adapterPanel !== adapterId;
  });
}

async function updateSyncStatus() {
  const adapter = createAdapter(loadSettings());
  const st = await adapter.status();
  const el = $('#cfg-sync-status');
  if (!el) return;
  const enabled = syncEngine.isEnabled();
  const syncHint = enabled
    ? ' · auto-sync on'
    : loadSettings().adapter === 'local'
      ? ' · auto-sync idle (local only)'
      : ' · auto-sync idle (enter passphrase)';
  const last = loadSettings().lastSyncAt
    ? ` · last ${new Date(loadSettings().lastSyncAt).toLocaleString()}`
    : '';
  el.textContent = st.label + (st.detail ? ` — ${st.detail}` : '') + syncHint + last;
  el.dataset.ok = st.ok ? '1' : '0';
}

function readSettingsFromForm() {
  sessionPassphrase = $('#cfg-passphrase')?.value || '';
  return saveSettings({
    adapter: $('#cfg-adapter')?.value || 'local',
    passphraseSet: Boolean(sessionPassphrase),
    googleClientId: $('#cfg-google-client')?.value.trim() || '',
    webdavUrl: $('#cfg-webdav-url')?.value.trim() || '',
    webdavUsername: $('#cfg-webdav-user')?.value.trim() || '',
    webdavPassword: $('#cfg-webdav-pass')?.value || '',
    s3Endpoint: $('#cfg-s3-endpoint')?.value.trim() || '',
    s3Region: $('#cfg-s3-region')?.value.trim() || 'auto',
    s3Bucket: $('#cfg-s3-bucket')?.value.trim() || '',
    s3AccessKeyId: $('#cfg-s3-key')?.value.trim() || '',
    s3SecretAccessKey: $('#cfg-s3-secret')?.value || '',
    s3ObjectKey: $('#cfg-s3-object')?.value.trim() || 'prompt2ui-vault.json',
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
