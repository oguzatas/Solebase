/**
 * app.js — Solebase wiki shell (root starter)
 *
 * Boots Layer 1 (OPFS + cr-sqlite worker) and mounts the wiki collection UI.
 */

import { Solebase } from './packages/solebase/dist/index.js';
import { mount as mountWiki } from './app/wiki.js';

const $ = (sel, el = document) => el.querySelector(sel);

const mainPane = $('#main-pane');
const toastEl = $('#toast');
const statusEl = $('#conn-status');

function toast(message, type = 'info') {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.dataset.type = type;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

function setConnStatus(text, ok) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.ok = ok ? '1' : '0';
}

/** @type {{ unmount?: () => void } | null} */
let activeHandle = null;
/** @type {Solebase | null} */
let db = null;

function wireChrome() {
  $('#btn-menu')?.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
  });

  $('#btn-expand-sidebar')?.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-expanded');
  });
}

async function boot() {
  wireChrome();

  if (!window.isSecureContext) {
    throw new Error('Solebase needs a secure context — use http://localhost or https');
  }
  if (!navigator.storage?.getDirectory) {
    throw new Error('OPFS is not available in this browser');
  }

  setConnStatus('Opening OPFS…', false);

  const workerUrl = new URL('./core/db-worker.js', import.meta.url);
  db = await Solebase.init({
    appId: 'wiki',
    encryptionKey: 'solebase-wiki-local-key',
    workerUrl,
    filename: 'solebase-wiki.db',
  });

  setConnStatus('Local · OPFS', true);
  const titleEl = $('#topbar-title');
  if (titleEl) titleEl.textContent = 'Wiki';

  const pages = db.collection('pages');

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

  activeHandle = await mountWiki(mainPane, { pages });
  document.documentElement.classList.add('booted');
}

boot().catch((err) => {
  console.error(err);
  setConnStatus('Failed', false);
  toast(err.message || 'Boot failed', 'err');
  if (mainPane) {
    mainPane.innerHTML = `<p class="boot-error">${err.message || 'Boot failed'}</p>`;
  }
});

window.addEventListener('beforeunload', () => {
  void db?.close();
});
