/**
 * app.js — Solebase Notes shell (editor-first; settings drawer only)
 */

import { mount as mountApp } from './app/notes.js';
import { initSettingsPanel } from './core/settings-panel.js';
import { db } from './core/db-api.js';
import {
  readBootstrapParam,
  consumeBootstrapToken,
  clearBootstrapParamFromUrl,
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
 * If URL has ?bootstrap=, apply credentials then reconfigure Solebase before mount.
 * @returns {Promise<boolean>} true when a bootstrap token was handled
 */
async function maybeConsumeBootstrap() {
  const token = readBootstrapParam();
  if (!token) return false;

  toast('Applying device bootstrap…', 'info');
  try {
    const result = await consumeBootstrapToken(token);
    clearBootstrapParamFromUrl();
    await db.reconfigure();
    toast(
      result.mode === 'r2'
        ? 'Credentials imported from QR — Solebase sync ready'
        : 'Credentials imported — Solebase sync ready',
      'ok'
    );
    try {
      const sync = await db.syncNow('bootstrap');
      if (sync?.ok !== false && sync?.reason !== 'idle') {
        toast('Synced with Solebase (R2)', 'ok');
      }
    } catch {
      /* sync is best-effort after bootstrap */
    }
    return true;
  } catch (err) {
    clearBootstrapParamFromUrl();
    toast(err.message || 'Bootstrap failed', 'err');
    return false;
  }
}

async function boot() {
  initSettingsPanel({
    toast,
    onImported: () => {
      mountMainApp().catch((err) => toast(err.message, 'err'));
    },
  });

  const params = new URLSearchParams(location.search);
  if (params.get('code') && params.get('scope')?.includes('drive')) {
    history.replaceState({}, '', location.pathname + location.hash);
  }

  await maybeConsumeBootstrap();

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
