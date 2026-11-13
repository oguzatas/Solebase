/**
 * app.js — Solebase Notes shell (editor-first; settings drawer only)
 *
 * iOS note: Safari tab storage and Add to Home Screen (standalone) are separate
 * partitions. QR bootstrap lands in Safari; reclaim the same short-lived link
 * inside the home-screen app (blob stays encrypted on R2 until TTL).
 */

import { mount as mountApp } from './app/notes.js';
import { initSettingsPanel } from './core/settings-panel.js';
import { db } from './core/db-api.js';
import {
  readBootstrapParam,
  consumeBootstrapToken,
  clearBootstrapParamFromUrl,
  extractBootstrapToken,
  saveReclaimHint,
  loadReclaimHint,
  clearReclaimHint,
  isStandaloneDisplay,
  hasSavedSyncCredentials,
} from './core/credential-bootstrap.js';

const $ = (sel, el = document) => el.querySelector(sel);

const mainPane = $('#main-pane');
const toastEl = $('#toast');

function toast(message, type = 'info') {
  toastEl.textContent = message;
  toastEl.dataset.type = type;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), type === 'err' ? 5200 : 3600);
}

/** @type {{ unmount?: () => void } | null} */
let activeHandle = null;

/** @type {{ openSettings?: (opts?: { focus?: string }) => void } | null} */
let settingsApi = null;

async function mountMainApp() {
  if (activeHandle?.unmount) {
    try {
      activeHandle.unmount();
    } catch {
      /* ignore */
    }
  }
  mainPane.innerHTML = '';
  mainPane.classList.remove('pane-enter');
  void mainPane.offsetWidth;
  mainPane.classList.add('pane-enter');
  activeHandle = await mountApp(mainPane);
}

/**
 * Apply a bootstrap token (from URL or paste), then reconfigure Solebase.
 * @param {string} token
 * @param {{ deleteArtifacts?: boolean, source?: string }} [opts]
 */
async function applyBootstrapToken(token, opts = {}) {
  const raw = String(token || '').trim();
  if (!raw) throw new Error('Paste a bootstrap link or token first');

  toast('Applying device bootstrap…', 'info');
  const standalone = isStandaloneDisplay();
  const result = await consumeBootstrapToken(raw, {
    // After home-screen reclaim, drop the public ciphertext when we can.
    deleteArtifacts: opts.deleteArtifacts === true || standalone,
  });
  clearBootstrapParamFromUrl();

  await db.reconfigure();
  toast(
    result.mode === 'r2'
      ? 'Credentials imported from QR — Solebase sync ready'
      : 'Credentials imported — Solebase sync ready',
    'ok'
  );

  try {
    const sync = await db.syncNow(opts.source || 'bootstrap');
    if (sync?.ok === false) {
      toast(sync.detail || sync.error || 'Sync failed after bootstrap', 'err');
    } else if (sync?.reason !== 'idle') {
      toast('Synced with Solebase (R2)', 'ok');
    }
  } catch (err) {
    toast(err?.message || 'Sync failed after bootstrap', 'err');
  }

  return result;
}

/**
 * If URL has ?bootstrap=, apply credentials then reconfigure Solebase before mount.
 * @returns {Promise<boolean>} true when a bootstrap token was handled
 */
async function maybeConsumeBootstrap() {
  const token = readBootstrapParam();
  if (!token) return false;

  try {
    const result = await applyBootstrapToken(token, {
      deleteArtifacts: isStandaloneDisplay(),
      source: 'bootstrap-url',
    });

    if (!isStandaloneDisplay()) {
      saveReclaimHint({
        url: result.reclaimUrl,
        expiresAt: result.expiresAt,
        mode: result.mode,
      });
      showHandoffBanner(result.reclaimUrl, result.expiresAt);
    } else {
      clearReclaimHint();
      hideHandoffBanner();
      hideReclaimBanner();
    }
    return true;
  } catch (err) {
    clearBootstrapParamFromUrl();
    toast(err.message || 'Bootstrap failed', 'err');
    return false;
  }
}

function minsLeft(expiresAt) {
  if (!expiresAt) return null;
  const m = Math.round((Number(expiresAt) - Date.now()) / 60000);
  return m > 0 ? m : 0;
}

function showHandoffBanner(reclaimUrl, expiresAt) {
  const banner = $('#device-handoff-banner');
  const urlInput = $('#handoff-reclaim-url');
  const meta = $('#handoff-meta');
  if (!banner) return;

  if (urlInput) urlInput.value = reclaimUrl || '';
  const left = minsLeft(expiresAt);
  if (meta) {
    meta.textContent =
      left == null
        ? 'Safari and the Home Screen app do not share credentials. Keep this reclaim link until the home-screen app imports it.'
        : `Safari and the Home Screen app do not share credentials. This reclaim link works for ~${left} more min (encrypted blob; key only in the URL).`;
  }
  banner.hidden = false;
}

function hideHandoffBanner() {
  const banner = $('#device-handoff-banner');
  if (banner) banner.hidden = true;
}

function showReclaimBanner() {
  const banner = $('#device-reclaim-banner');
  if (!banner) return;
  banner.hidden = false;
}

function hideReclaimBanner() {
  const banner = $('#device-reclaim-banner');
  if (banner) banner.hidden = true;
}

async function copyText(text) {
  const value = String(text || '');
  if (!value) throw new Error('Nothing to copy');
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

async function shareReclaimUrl(url) {
  if (!url) throw new Error('No reclaim link yet');
  if (typeof navigator.share === 'function') {
    await navigator.share({
      title: 'Solebase Notes reclaim',
      text: 'Open this link once inside the Solebase Home Screen app to restore sync credentials.',
      url,
    });
    return 'shared';
  }
  await copyText(url);
  return 'copied';
}

function wireHandoffBanner() {
  $('#handoff-copy')?.addEventListener('click', async () => {
    const url = $('#handoff-reclaim-url')?.value;
    try {
      await copyText(url);
      toast('Reclaim link copied — open it in the Home Screen app', 'ok');
    } catch (err) {
      toast(err.message || 'Could not copy', 'err');
    }
  });

  $('#handoff-share')?.addEventListener('click', async () => {
    const url = $('#handoff-reclaim-url')?.value;
    try {
      const mode = await shareReclaimUrl(url);
      toast(
        mode === 'shared'
          ? 'Shared — open the link from the Home Screen app'
          : 'Reclaim link copied (Share unavailable)',
        'ok'
      );
    } catch (err) {
      if (err?.name === 'AbortError') return;
      toast(err.message || 'Could not share', 'err');
    }
  });

  $('#handoff-dismiss')?.addEventListener('click', () => {
    hideHandoffBanner();
  });

  $('#handoff-open-settings')?.addEventListener('click', () => {
    settingsApi?.openSettings?.({ focus: 'bootstrap' });
  });
}

function wireReclaimBanner() {
  $('#reclaim-import')?.addEventListener('click', async () => {
    const pasted = $('#reclaim-paste')?.value || '';
    const token = extractBootstrapToken(pasted);
    if (!token) {
      toast('Paste the full bootstrap URL from the desktop QR', 'info');
      return;
    }
    try {
      await applyBootstrapToken(token, { deleteArtifacts: true, source: 'reclaim-paste' });
      clearReclaimHint();
      hideReclaimBanner();
      hideHandoffBanner();
      await mountMainApp();
    } catch (err) {
      toast(err.message || 'Import failed', 'err');
    }
  });

  $('#reclaim-open-settings')?.addEventListener('click', () => {
    settingsApi?.openSettings?.({ focus: 'bootstrap' });
  });
}

/**
 * After QR in Safari: show A2HS + reclaim guidance.
 * Empty standalone: show paste/import banner.
 */
function maybeShowCredentialBanners() {
  if (hasSavedSyncCredentials()) {
    hideReclaimBanner();
    const hint = loadReclaimHint();
    if (hint?.url && !isStandaloneDisplay()) {
      showHandoffBanner(hint.url, hint.expiresAt);
    }
    return;
  }

  if (isStandaloneDisplay()) {
    hideHandoffBanner();
    showReclaimBanner();
    return;
  }

  const hint = loadReclaimHint();
  if (hint?.url) showHandoffBanner(hint.url, hint.expiresAt);
}

async function boot() {
  settingsApi = initSettingsPanel({
    toast,
    onImported: () => {
      hideReclaimBanner();
      maybeShowCredentialBanners();
      mountMainApp().catch((err) => toast(err.message, 'err'));
    },
  });

  wireHandoffBanner();
  wireReclaimBanner();

  await maybeConsumeBootstrap();
  maybeShowCredentialBanners();

  try {
    await mountMainApp();
  } catch (err) {
    toast(err.message || 'Failed to open app', 'err');
  }

  document.documentElement.classList.add('booted');
}

boot().catch((err) => {
  console.error(err);
  toast(err.message || 'Boot failed', 'err');
});
