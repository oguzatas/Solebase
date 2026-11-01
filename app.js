/**
 * app.js — Thin Prompt2UI shell
 *
 * Views: opening (brand-first) → app (sample under app/).
 * Mounts the personal app and wires Settings. No sync UI here.
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
let appMounted = false;

function setView(view) {
  document.body.dataset.view = view;
  if (view === 'app') {
    history.replaceState(null, '', '#/app');
  } else {
    history.replaceState(null, '', '#/');
    document.body.classList.remove('sidebar-open');
  }
}

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
  appMounted = true;
  const title = activeHandle?.title || 'App';
  const titleEl = $('#topbar-title');
  if (titleEl) titleEl.textContent = title;
}

async function openApp() {
  setView('app');
  if (!appMounted) {
    try {
      await mountMainApp();
    } catch (err) {
      toast(err.message || 'Failed to open app', 'err');
    }
  } else {
    mainPane.classList.remove('pane-enter');
    void mainPane.offsetWidth;
    mainPane.classList.add('pane-enter');
  }
  mainPane?.focus?.({ preventScroll: true });
}

function showOpening() {
  setView('opening');
}

function wireChrome() {
  $('#btn-open-app')?.addEventListener('click', () => {
    openApp().catch((err) => toast(err.message, 'err'));
  });

  $('#btn-home')?.addEventListener('click', () => {
    showOpening();
  });

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
      if (document.body.dataset.view === 'app') {
        mountMainApp().catch((err) => toast(err.message, 'err'));
      } else {
        appMounted = false;
      }
    },
  });

  wireChrome();

  // Clean OAuth redirect query if we landed with ?code=
  const params = new URLSearchParams(location.search);
  if (params.get('code') && params.get('scope')?.includes('drive')) {
    history.replaceState({}, '', location.pathname + location.hash);
  }

  const hash = location.hash.replace(/^#/, '');
  if (hash === '/app' || hash === 'app') {
    await openApp();
  } else {
    setView('opening');
  }

  document.documentElement.classList.add('booted');
}

boot().catch((err) => {
  console.error(err);
  toast(err.message || 'Boot failed', 'err');
});
