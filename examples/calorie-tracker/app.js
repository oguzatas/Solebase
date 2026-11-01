/**
 * app.js — Calorie Tracker example shell
 *
 * Opens straight into the app. Settings for sync only.
 */

import { mount as mountApp } from './app/calorie-tracker.js';
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

/** @type {{ unmount?: () => void, title?: string } | null} */
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
  const title = activeHandle?.title || 'Calorie Tracker';
  const titleEl = $('#topbar-title');
  if (titleEl) titleEl.textContent = title;
}

function wireChrome() {
  $('#btn-menu')?.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
  });

  $('#btn-expand-sidebar')?.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-expanded');
  });
}

async function boot() {
  initSettingsPanel({
    toast,
    onImported: () => {
      mountMainApp().catch((err) => toast(err.message, 'err'));
    },
  });

  wireChrome();

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
