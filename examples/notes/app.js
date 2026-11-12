/**
 * app.js — Solebase Notes shell (editor-first; settings drawer only)
 */

import { mount as mountApp } from './app/notes.js';
import { initSettingsPanel } from './core/settings-panel.js';

const $ = (sel, el = document) => el.querySelector(sel);

const mainPane = $('#main-pane');
const toastEl = $('#toast');

function toast(message, type = 'info') {
  toastEl.textContent = message;
  toastEl.dataset.type = type;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 3200);
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
