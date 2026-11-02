/**
 * app/notes.js — Personal Markdown vault (editor-first, push sidebars)
 *
 * Collections only — never adapters or sync:
 *   import { db } from '../core/db-api.js';
 *
 * Note shape: { title, body, folder, tags: string[], pinned?: boolean }
 * Folder shape: { path: string }
 */

import { basicSetup, EditorView } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { db } from '../core/db-api.js';
import {
  collectTags,
  escapeHtml,
  extractOutline,
  extractWikiLinks,
  renderMarkdown,
} from './markdown.js';

const NOTES = 'notes';
const FOLDERS = 'folders';

const I = {
  menu: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  plus: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  folder: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2"/></svg>`,
  calendar: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  search: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16.5 16.5 21 21"/></svg>`,
  panel: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>`,
  edit: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M4 20h4L18 10l-4-4L4 16v4z"/><path d="m14 6 4 4"/></svg>`,
  split: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>`,
  eye: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
  star: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="m12 3 2.7 5.5 6 .9-4.4 4.3 1 6L12 16.8 6.7 19.7l1-6L3.4 9.4l6-.9L12 3z"/></svg>`,
  trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M8 7l.6 12h6.8L16 7"/></svg>`,
  gear: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
};

function todayTitle() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function snippet(body) {
  const t = String(body || '')
    .replace(/^---[\s\S]*?---\r?\n?/, '')
    .replace(/^#+\s+/gm, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, 72) || 'Empty note';
}

function normalizeFolder(f) {
  return String(f || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
}

function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q);
  let ti = 0;
  let score = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    score += 10 - Math.min(found - ti, 9);
    ti = found + 1;
  }
  return score;
}

function parseQuery(raw) {
  const tokens = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const tags = [];
  let path = '';
  const text = [];
  for (const tok of tokens) {
    if (tok.startsWith('#') && tok.length > 1) {
      tags.push(tok.slice(1).toLowerCase());
    } else if (/^path:/i.test(tok)) {
      path = normalizeFolder(tok.slice(5)).toLowerCase();
    } else {
      text.push(tok.toLowerCase());
    }
  }
  return { tags, path, text: text.join(' ') };
}

/**
 * @param {HTMLElement} root
 */
export async function mount(root) {
  const notes = db.collection(NOTES);
  const foldersCol = db.collection(FOLDERS);
  /** @type {string|null} */
  let activeId = null;
  /** Note id currently shown in the editor. Saves must not run against a different id. */
  let boundNoteId = null;
  let query = '';
  /** @type {'edit'|'preview'|'split'} */
  let viewMode = 'edit';
  let saveTimer = null;
  let unsubNotes = null;
  let unsubFolders = null;
  /** @type {object[]} */
  let cache = [];
  /** @type {string[]} */
  let folderPaths = [];
  let treeCollapsed = new Set();
  /** @type {EditorView|null} */
  let cmView = null;
  let applyingDoc = false;
  let vaultOpen = true;
  let contextOpen = false;
  /** @type {{ kind: 'note'|'folder'|'blank', id?: string, path?: string } | null} */
  let menuTarget = null;

  root.innerHTML = `
    <div class="vault vault-open" data-app="notes">
      <header class="vault-bar" role="toolbar" aria-label="Notes">
        <div class="vault-bar-left">
          <button type="button" class="icon-btn" id="n-toggle-vault" aria-label="Notes list" title="Notes list" aria-expanded="true">${I.menu}</button>
          <button type="button" class="icon-btn" id="n-new" aria-label="New note" title="New note (Ctrl/Cmd+N)">${I.plus}</button>
          <button type="button" class="icon-btn" id="n-new-folder" aria-label="New folder" title="New folder">${I.folder}</button>
          <button type="button" class="icon-btn" id="n-daily" aria-label="Daily note" title="Today’s note">${I.calendar}</button>
          <button type="button" class="icon-btn" id="n-switcher" aria-label="Quick switcher" title="Quick switcher (Ctrl/Cmd+P)">${I.search}</button>
        </div>
        <div class="vault-bar-center">
          <input type="text" id="n-title" class="title-input" placeholder="Untitled" maxlength="160" />
        </div>
        <div class="vault-bar-right">
          <div class="view-toggle" role="group" aria-label="Editor view">
            <button type="button" class="icon-btn view-btn" data-view="edit" aria-label="Edit" title="Edit">${I.edit}</button>
            <button type="button" class="icon-btn view-btn" data-view="split" aria-label="Split" title="Split">${I.split}</button>
            <button type="button" class="icon-btn view-btn" data-view="preview" aria-label="Preview" title="Preview">${I.eye}</button>
          </div>
          <button type="button" class="icon-btn" id="n-pin" aria-label="Pin note" title="Pin">${I.star}</button>
          <button type="button" class="icon-btn" id="n-delete" aria-label="Delete note" title="Delete">${I.trash}</button>
          <button type="button" class="icon-btn" id="n-toggle-context" aria-label="Outline and links" title="Outline &amp; links" aria-expanded="false">${I.panel}</button>
          <button type="button" class="icon-btn" id="n-settings" data-open-settings aria-label="Settings" title="Settings · Share / install / sync">${I.gear}</button>
        </div>
      </header>

      <div class="vault-meta" id="n-meta">
        <input type="text" id="n-folder" placeholder="path/folder" maxlength="120" list="n-folder-list" />
        <datalist id="n-folder-list"></datalist>
        <input type="text" id="n-tags" placeholder="tags" maxlength="160" />
        <span class="vault-save-hint" id="n-hint">Ready</span>
      </div>

      <div class="vault-stage">
        <div class="drawer-backdrop" id="drawer-backdrop" hidden></div>

        <aside class="vault-drawer" id="vault-drawer" aria-label="Vault" aria-hidden="false">
          <div class="drawer-head">
            <span class="drawer-label">Notes</span>
            <div class="drawer-head-actions">
              <button type="button" class="icon-btn" id="n-drawer-new" aria-label="New note" title="New note">${I.plus}</button>
              <button type="button" class="icon-btn" id="n-drawer-folder" aria-label="New folder" title="New folder">${I.folder}</button>
              <button type="button" class="icon-btn" id="n-close-vault" aria-label="Close list">${I.close}</button>
            </div>
          </div>
          <div class="drawer-search">
            <input type="search" id="n-search" placeholder="Search · #tag · path:folder" autocomplete="off" />
          </div>
          <div class="vault-tree" id="n-tree" role="tree"></div>
        </aside>

        <section class="vault-editor" id="n-editor" aria-label="Editor">
          <div class="vault-empty" id="n-empty">
            <p class="vault-empty-title">No note open</p>
            <p class="vault-empty-copy">New note with <kbd>+</kbd>, folder with the folder icon, or <kbd>Ctrl</kbd>+<kbd>P</kbd> to jump. Gear → Share for install / QR; notes stay on this device unless you enable sync.</p>
          </div>
          <div class="vault-form hidden" id="n-form">
            <div class="vault-panes" id="n-panes" data-mode="edit">
              <div class="vault-cm-wrap" id="n-cm-wrap">
                <div id="n-cm" class="vault-cm"></div>
              </div>
              <div class="vault-preview" id="n-preview" aria-live="polite"></div>
            </div>
          </div>
        </section>

        <aside class="context-drawer" id="context-drawer" aria-label="Note context" aria-hidden="true">
          <div class="drawer-head">
            <span class="drawer-label">Context</span>
            <button type="button" class="icon-btn" id="n-close-context" aria-label="Close context">${I.close}</button>
          </div>
          <div class="side-block">
            <h3 class="side-title">Outline</h3>
            <ul class="side-list" id="n-outline"></ul>
          </div>
          <div class="side-block">
            <h3 class="side-title">Backlinks</h3>
            <ul class="side-list" id="n-backlinks"></ul>
          </div>
          <div class="side-block">
            <h3 class="side-title">Outgoing</h3>
            <ul class="side-list" id="n-outgoing"></ul>
          </div>
        </aside>
      </div>
    </div>

    <div class="ctx-menu" id="ctx-menu" hidden role="menu">
      <button type="button" role="menuitem" data-act="rename">Rename</button>
      <button type="button" role="menuitem" data-act="delete">Delete</button>
      <button type="button" role="menuitem" data-act="new-note">New note here</button>
      <button type="button" role="menuitem" data-act="new-folder">New folder</button>
    </div>

    <div class="switcher-backdrop" id="switcher-backdrop" hidden></div>
    <div class="switcher" id="switcher" role="dialog" aria-modal="true" aria-label="Quick switcher" hidden>
      <input type="search" id="switcher-input" placeholder="Jump to note…" autocomplete="off" />
      <ul class="switcher-list" id="switcher-list"></ul>
      <p class="switcher-hint">↑↓ · Enter · Esc</p>
    </div>
  `;

  const treeEl = root.querySelector('#n-tree');
  const searchEl = root.querySelector('#n-search');
  const emptyEl = root.querySelector('#n-empty');
  const formEl = root.querySelector('#n-form');
  const titleEl = root.querySelector('#n-title');
  const folderEl = root.querySelector('#n-folder');
  const tagsEl = root.querySelector('#n-tags');
  const previewEl = root.querySelector('#n-preview');
  const panesEl = root.querySelector('#n-panes');
  const cmHost = root.querySelector('#n-cm');
  const hintEl = root.querySelector('#n-hint');
  const folderListEl = root.querySelector('#n-folder-list');
  const outlineEl = root.querySelector('#n-outline');
  const backlinksEl = root.querySelector('#n-backlinks');
  const outgoingEl = root.querySelector('#n-outgoing');
  const pinBtn = root.querySelector('#n-pin');
  const vaultEl = root.querySelector('.vault');
  const vaultDrawer = root.querySelector('#vault-drawer');
  const contextDrawer = root.querySelector('#context-drawer');
  const drawerBackdrop = root.querySelector('#drawer-backdrop');
  const toggleVaultBtn = root.querySelector('#n-toggle-vault');
  const toggleContextBtn = root.querySelector('#n-toggle-context');
  const switcherEl = root.querySelector('#switcher');
  const switcherBackdrop = root.querySelector('#switcher-backdrop');
  const switcherInput = root.querySelector('#switcher-input');
  const switcherList = root.querySelector('#switcher-list');
  const metaEl = root.querySelector('#n-meta');
  const ctxMenu = root.querySelector('#ctx-menu');

  let switcherIndex = 0;
  /** @type {object[]} */
  let switcherRows = [];

  function noteTitlesSet() {
    return new Set(cache.map((n) => String(n.title || '').toLowerCase()).filter(Boolean));
  }

  function findByTitle(title) {
    const key = String(title || '').trim().toLowerCase();
    return cache.find((n) => String(n.title || '').toLowerCase() === key);
  }

  function getBody() {
    return cmView ? cmView.state.doc.toString() : '';
  }

  function setBody(text, { focus = false } = {}) {
    if (!cmView) return;
    applyingDoc = true;
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: text || '' },
    });
    applyingDoc = false;
    if (focus) cmView.focus();
  }

  function resolveTags(n) {
    return collectTags(n.body || '', Array.isArray(n.tags) ? n.tags : []);
  }

  function allFolderPaths() {
    const set = new Set(folderPaths.map(normalizeFolder).filter(Boolean));
    for (const n of cache) {
      const f = normalizeFolder(n.folder);
      if (!f) continue;
      set.add(f);
      const parts = f.split('/');
      let acc = '';
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        set.add(acc);
      }
    }
    return [...set].sort();
  }

  function filtered() {
    const { tags, path, text } = parseQuery(query);
    return cache
      .filter((n) => {
        if (path) {
          const folder = normalizeFolder(n.folder).toLowerCase();
          if (!(folder === path || folder.startsWith(`${path}/`))) return false;
        }
        if (tags.length) {
          const noteTags = resolveTags(n);
          if (!tags.every((t) => noteTags.includes(t))) return false;
        }
        if (!text) return true;
        const hay = `${n.title || ''} ${n.body || ''} ${n.folder || ''} ${(n.tags || []).join(' ')}`.toLowerCase();
        return hay.includes(text);
      })
      .sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
  }

  function refreshFolderList() {
    const folders = allFolderPaths();
    folderListEl.innerHTML = folders.map((f) => `<option value="${escapeHtml(f)}"></option>`).join('');
  }

  function patchCache(id, patch) {
    const i = cache.findIndex((n) => n.id === id);
    if (i < 0) return;
    cache[i] = { ...cache[i], ...patch };
  }

  function buildTree(rows) {
    const rootNode = { name: '', path: '', children: new Map(), notes: [] };

    function ensureFolder(path) {
      if (!path) return rootNode;
      const parts = path.split('/');
      let node = rootNode;
      let acc = '';
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, path: acc, children: new Map(), notes: [] });
        }
        node = node.children.get(part);
      }
      return node;
    }

    for (const path of allFolderPaths()) ensureFolder(path);
    for (const n of rows) ensureFolder(normalizeFolder(n.folder)).notes.push(n);
    return rootNode;
  }

  function renderTreeNode(node, depth = 0) {
    const parts = [];
    const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of folders) {
      const collapsed = treeCollapsed.has(folder.path);
      parts.push(`
        <div class="tree-folder">
          <button type="button" class="tree-folder-btn" style="--depth:${depth}" data-toggle-folder="${escapeHtml(folder.path)}" data-folder-path="${escapeHtml(folder.path)}" aria-expanded="${collapsed ? 'false' : 'true'}">
            <span class="tree-chevron">${collapsed ? '▸' : '▾'}</span>
            <span class="tree-folder-name">${escapeHtml(folder.name)}</span>
          </button>
          <div class="tree-folder-body${collapsed ? ' is-collapsed' : ''}">
            ${renderTreeNode(folder, depth + 1)}
          </div>
        </div>
      `);
    }
    const notesHtml = node.notes
      .slice()
      .sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return String(a.title || '').localeCompare(String(b.title || ''));
      })
      .map((n) => {
        const active = n.id === activeId ? ' is-active' : '';
        const pin = n.pinned ? '<span class="tree-pin" title="Pinned">★</span>' : '';
        return `
          <button type="button" class="tree-note${active}" data-id="${n.id}" style="--depth:${depth}" role="treeitem">
            <span class="tree-note-title">${pin}${escapeHtml(n.title || 'Untitled')}</span>
            <span class="tree-note-snip">${escapeHtml(snippet(n.body))}</span>
          </button>`;
      })
      .join('');
    return parts.join('') + notesHtml;
  }

  function renderTree() {
    const rows = filtered();
    const parsed = parseQuery(query);
    if (!rows.length && !allFolderPaths().length) {
      treeEl.innerHTML = `<p class="tree-empty">Empty vault. New note or folder to start.</p>`;
      return;
    }
    if (parsed.text || parsed.tags.length || parsed.path) {
      if (!rows.length) {
        treeEl.innerHTML = `<p class="tree-empty">No matches.</p>`;
        return;
      }
      treeEl.innerHTML = rows
        .map((n) => {
          const active = n.id === activeId ? ' is-active' : '';
          const pin = n.pinned ? '<span class="tree-pin" title="Pinned">★</span>' : '';
          const folder = normalizeFolder(n.folder);
          return `
            <button type="button" class="tree-note${active}" data-id="${n.id}" style="--depth:0" role="treeitem">
              <span class="tree-note-title">${pin}${escapeHtml(n.title || 'Untitled')}</span>
              <span class="tree-note-snip">${escapeHtml(folder ? `${folder} · ` : '')}${escapeHtml(snippet(n.body))}</span>
            </button>`;
        })
        .join('');
      return;
    }
    treeEl.innerHTML = renderTreeNode(buildTree(rows));
  }

  function showEditor(show) {
    emptyEl.classList.toggle('hidden', show);
    formEl.classList.toggle('hidden', !show);
    metaEl.classList.toggle('is-idle', !show);
    titleEl.disabled = !show;
  }

  function applyViewMode() {
    panesEl.dataset.mode = viewMode;
    root.querySelectorAll('.view-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-view') === viewMode);
    });
    if (viewMode !== 'edit') refreshPreview();
  }

  function refreshPreview() {
    previewEl.innerHTML = renderMarkdown(getBody(), { noteTitles: noteTitlesSet() });
  }

  function refreshSidePanels() {
    const note = cache.find((n) => n.id === activeId);
    if (!note) {
      outlineEl.innerHTML = '<li class="side-empty">—</li>';
      backlinksEl.innerHTML = '<li class="side-empty">—</li>';
      outgoingEl.innerHTML = '<li class="side-empty">—</li>';
      return;
    }

    const body = activeId === note.id ? getBody() || note.body || '' : note.body || '';
    const outline = extractOutline(body);
    outlineEl.innerHTML = outline.length
      ? outline
          .map(
            (h) =>
              `<li><button type="button" class="side-link outline-l${h.level}" data-outline="${escapeHtml(h.id)}">${escapeHtml(h.text)}</button></li>`,
          )
          .join('')
      : '<li class="side-empty">No headings</li>';

    const titleKey = String(note.title || '').toLowerCase();
    const backs = cache.filter((n) => {
      if (n.id === note.id) return false;
      return extractWikiLinks(n.body || '').some((t) => t.toLowerCase() === titleKey);
    });
    backlinksEl.innerHTML = backs.length
      ? backs
          .map(
            (n) =>
              `<li><button type="button" class="side-link" data-id="${n.id}">${escapeHtml(n.title || 'Untitled')}</button></li>`,
          )
          .join('')
      : '<li class="side-empty">No backlinks</li>';

    const outgoing = extractWikiLinks(body);
    outgoingEl.innerHTML = outgoing.length
      ? outgoing
          .map((t) => {
            const exists = !!findByTitle(t);
            return `<li><button type="button" class="side-link${exists ? '' : ' is-missing'}" data-wiki="${escapeHtml(t)}">${escapeHtml(t)}</button></li>`;
          })
          .join('')
      : '<li class="side-empty">No wiki-links</li>';
  }

  function isMobile() {
    return window.matchMedia('(max-width: 720px)').matches;
  }

  function setVaultOpen(open) {
    vaultOpen = open;
    vaultEl.classList.toggle('vault-open', open);
    vaultDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    toggleVaultBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncBackdrop();
  }

  function setContextOpen(open) {
    contextOpen = open;
    vaultEl.classList.toggle('context-open', open);
    contextDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    toggleContextBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncBackdrop();
  }

  function syncBackdrop() {
    // Backdrop only for overlay mode on small screens
    drawerBackdrop.hidden = !(isMobile() && (vaultOpen || contextOpen));
  }

  function loadActive() {
    const note = cache.find((n) => n.id === activeId);
    if (!note) {
      showEditor(false);
      titleEl.value = '';
      refreshSidePanels();
      return;
    }
    showEditor(true);
    titleEl.value = note.title || '';
    folderEl.value = note.folder || '';
    tagsEl.value = (Array.isArray(note.tags) ? note.tags : []).join(', ');
    setBody(note.body || '');
    pinBtn.classList.toggle('is-on', !!note.pinned);
    boundNoteId = note.id;
    applyViewMode();
    refreshSidePanels();
    hintEl.textContent = 'Saved';
  }

  function scheduleSave() {
    hintEl.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistActive().catch((err) => {
        hintEl.textContent = err.message || 'Save failed';
      });
    }, 280);
  }

  async function persistActive() {
    clearTimeout(saveTimer);
    if (!activeId || boundNoteId !== activeId) return;
    const body = getBody();
    const explicit = String(tagsEl.value || '')
      .split(/[,#\s]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const tags = collectTags(body, explicit);
    const patch = {
      title: titleEl.value.trim() || 'Untitled',
      body,
      folder: normalizeFolder(folderEl.value),
      tags,
      pinned: !!pinBtn.classList.contains('is-on'),
    };
    patchCache(activeId, patch);
    renderTree();
    await notes.update(activeId, patch);
    if (patch.folder) await ensureFolderRecord(patch.folder);
    hintEl.textContent = 'Saved';
    refreshPreview();
    refreshSidePanels();
  }

  async function ensureFolderRecord(path) {
    const p = normalizeFolder(path);
    if (!p) return;
    if (folderPaths.includes(p)) return;
    const parts = p.split('/');
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!folderPaths.includes(acc)) {
        await foldersCol.add({ path: acc });
      }
    }
  }

  async function createNote(seed = {}) {
    const folder = normalizeFolder(seed.folder || '');
    if (folder) await ensureFolderRecord(folder);
    const row = await notes.add({
      title: seed.title || 'Untitled',
      body: seed.body || '',
      folder,
      tags: seed.tags || [],
      pinned: !!seed.pinned,
    });
    activeId = row.id;
    clearTimeout(saveTimer);
    showEditor(true);
    titleEl.value = row.title || 'Untitled';
    folderEl.value = row.folder || '';
    tagsEl.value = (Array.isArray(row.tags) ? row.tags : []).join(', ');
    setBody(row.body || '');
    pinBtn.classList.toggle('is-on', !!row.pinned);
    boundNoteId = row.id;
    return row;
  }

  async function createFolder(pathHint = '') {
    const raw = window.prompt('Folder path', pathHint || 'projects');
    if (raw == null) return;
    const path = normalizeFolder(raw);
    if (!path) return;
    await ensureFolderRecord(path);
    treeCollapsed.delete(path);
    setVaultOpen(true);
  }

  async function renameNote(id) {
    const note = cache.find((n) => n.id === id);
    if (!note) return;
    const next = window.prompt('Rename note', note.title || 'Untitled');
    if (next == null) return;
    const title = next.trim() || 'Untitled';
    patchCache(id, { title });
    if (id === activeId) titleEl.value = title;
    renderTree();
    await notes.update(id, { title });
    hintEl.textContent = 'Saved';
  }

  async function renameFolder(path) {
    const next = window.prompt('Rename folder path', path);
    if (next == null) return;
    const newPath = normalizeFolder(next);
    if (!newPath || newPath === path) return;

    const affected = cache.filter((n) => {
      const f = normalizeFolder(n.folder);
      return f === path || f.startsWith(`${path}/`);
    });
    for (const n of affected) {
      const f = normalizeFolder(n.folder);
      const updated = f === path ? newPath : `${newPath}${f.slice(path.length)}`;
      patchCache(n.id, { folder: updated });
      await notes.update(n.id, { folder: updated });
    }

    const folderRows = await foldersCol.get();
    for (const row of folderRows) {
      const f = normalizeFolder(row.path);
      if (f === path || f.startsWith(`${path}/`)) {
        const updated = f === path ? newPath : `${newPath}${f.slice(path.length)}`;
        await foldersCol.update(row.id, { path: updated });
      }
    }
    await ensureFolderRecord(newPath);
    if (activeId) {
      const active = cache.find((n) => n.id === activeId);
      if (active) folderEl.value = active.folder || '';
    }
    renderTree();
  }

  async function deleteFolder(path) {
    const affected = cache.filter((n) => {
      const f = normalizeFolder(n.folder);
      return f === path || f.startsWith(`${path}/`);
    });
    if (affected.length) {
      if (!confirm(`Delete folder “${path}” and ${affected.length} note(s)?`)) return;
      for (const n of affected) {
        if (n.id === activeId) activeId = null;
        await notes.remove(n.id);
      }
    } else if (!confirm(`Remove empty folder “${path}”?`)) {
      return;
    }
    const folderRows = await foldersCol.get();
    for (const row of folderRows) {
      const f = normalizeFolder(row.path);
      if (f === path || f.startsWith(`${path}/`)) {
        await foldersCol.remove(row.id);
      }
    }
  }

  async function openOrCreateByTitle(title, { folder = '', body } = {}) {
    const existing = findByTitle(title);
    if (existing) {
      if (activeId) await persistActive();
      activeId = existing.id;
      renderTree();
      loadActive();
      return existing;
    }
    if (activeId) await persistActive();
    await createNote({
      title,
      folder,
      body: body ?? `# ${title}\n\n`,
      tags: [],
    });
    return null;
  }

  function paintNotes(all) {
    cache = all;
    refreshFolderList();
    if (activeId && !cache.some((n) => n.id === activeId)) {
      activeId = null;
    }
    if (!activeId && cache.length) {
      activeId = filtered()[0]?.id || cache[0].id;
    }
    renderTree();
    const note = cache.find((n) => n.id === activeId);
    if (!note) {
      showEditor(false);
      titleEl.value = '';
      refreshSidePanels();
      return;
    }
    const editing =
      boundNoteId === activeId &&
      (document.activeElement === titleEl ||
        document.activeElement === folderEl ||
        document.activeElement === tagsEl ||
        (cmView && cmView.hasFocus));
    if (editing) {
      // Keep typed title; still refresh tree from cache (optimistic patches included)
      showEditor(true);
      renderTree();
      refreshSidePanels();
      if (viewMode !== 'edit') refreshPreview();
      return;
    }
    loadActive();
  }

  function paintFolders(rows) {
    folderPaths = rows.map((r) => normalizeFolder(r.path)).filter(Boolean);
    refreshFolderList();
    renderTree();
  }

  function hideCtxMenu() {
    ctxMenu.hidden = true;
    menuTarget = null;
  }

  let menuGuardUntil = 0;

  function showCtxMenu(x, y, target) {
    menuTarget = target;
    const renameBtn = ctxMenu.querySelector('[data-act="rename"]');
    const deleteBtn = ctxMenu.querySelector('[data-act="delete"]');
    renameBtn.hidden = !(target.kind === 'note' || target.kind === 'folder');
    deleteBtn.hidden = !(target.kind === 'note' || target.kind === 'folder');
    renameBtn.textContent = target.kind === 'folder' ? 'Rename folder' : 'Rename';
    deleteBtn.textContent = target.kind === 'folder' ? 'Delete folder' : 'Delete';

    if (ctxMenu.parentElement !== document.body) document.body.appendChild(ctxMenu);
    ctxMenu.hidden = false;
    menuGuardUntil = Date.now() + 400;
    const rect = ctxMenu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - Math.max(rect.width, 180) - 8);
    const top = Math.min(y, window.innerHeight - Math.max(rect.height, 160) - 8);
    ctxMenu.style.left = `${Math.max(8, left)}px`;
    ctxMenu.style.top = `${Math.max(8, top)}px`;
  }

  function initEditor() {
    const saveKey = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          persistActive().catch(() => {});
          return true;
        },
      },
    ]);

    cmView = new EditorView({
      parent: cmHost,
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup,
          markdown(),
          oneDark,
          cmPlaceholder('Markdown… [[links]], #tags, - [ ] tasks'),
          saveKey,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (applyingDoc) return;
            if (update.docChanged) {
              scheduleSave();
              if (viewMode !== 'edit') refreshPreview();
              refreshSidePanels();
            }
          }),
          EditorView.theme({
            '&': {
              height: '100%',
              fontSize: '0.95rem',
              backgroundColor: 'transparent',
            },
            '.cm-scroller': {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              lineHeight: '1.55',
            },
            '.cm-content': {
              padding: '1rem 1.25rem',
              caretColor: '#a3bfb0',
            },
            '&.cm-focused': { outline: 'none' },
            '.cm-gutters': {
              backgroundColor: 'transparent',
              border: 'none',
              color: '#6b7380',
            },
            '.cm-activeLineGutter': { backgroundColor: 'transparent' },
            '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
          }),
        ],
      }),
    });
  }

  function openSwitcher() {
    switcherEl.hidden = false;
    switcherBackdrop.hidden = false;
    switcherInput.value = '';
    switcherIndex = 0;
    paintSwitcher();
    switcherInput.focus();
  }

  function closeSwitcher() {
    switcherEl.hidden = true;
    switcherBackdrop.hidden = true;
  }

  function paintSwitcher() {
    const q = switcherInput.value.trim();
    switcherRows = cache
      .map((n) => ({
        n,
        score: fuzzyScore(q, `${n.title || ''} ${n.folder || ''}`),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.n.updatedAt || 0) - (a.n.updatedAt || 0))
      .slice(0, 40)
      .map((x) => x.n);

    if (!switcherRows.length) {
      switcherList.innerHTML = `<li class="switcher-empty">No matches</li>`;
      return;
    }
    if (switcherIndex >= switcherRows.length) switcherIndex = 0;
    switcherList.innerHTML = switcherRows
      .map((n, i) => {
        const sel = i === switcherIndex ? ' is-selected' : '';
        const folder = normalizeFolder(n.folder);
        return `<li class="switcher-item${sel}" data-index="${i}" data-id="${n.id}">
          <span class="switcher-title">${escapeHtml(n.title || 'Untitled')}</span>
          <span class="switcher-meta">${escapeHtml(folder || 'root')}</span>
        </li>`;
      })
      .join('');
  }

  async function selectSwitcher(id) {
    closeSwitcher();
    if (activeId) await persistActive();
    activeId = id;
    renderTree();
    loadActive();
  }

  initEditor();
  unsubNotes = notes.subscribe(paintNotes);
  unsubFolders = foldersCol.subscribe(paintFolders);
  applyViewMode();
  showEditor(false);
  setVaultOpen(true);

  toggleVaultBtn.addEventListener('click', () => setVaultOpen(!vaultOpen));
  root.querySelector('#n-close-vault').addEventListener('click', () => setVaultOpen(false));

  toggleContextBtn.addEventListener('click', () => setContextOpen(!contextOpen));
  root.querySelector('#n-close-context').addEventListener('click', () => setContextOpen(false));
  drawerBackdrop.addEventListener('click', () => {
    if (!isMobile()) return;
    setVaultOpen(false);
    setContextOpen(false);
  });
  window.addEventListener('resize', syncBackdrop);

  treeEl.addEventListener('click', async (e) => {
    hideCtxMenu();
    const toggle = e.target.closest('[data-toggle-folder]');
    if (toggle) {
      const path = toggle.getAttribute('data-toggle-folder');
      if (treeCollapsed.has(path)) treeCollapsed.delete(path);
      else treeCollapsed.add(path);
      renderTree();
      return;
    }
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    if (activeId) await persistActive();
    activeId = btn.getAttribute('data-id');
    renderTree();
    loadActive();
    // Keep vault open; only collapse on mobile overlay to give editor room
    if (isMobile()) setVaultOpen(false);
  });

  treeEl.addEventListener('contextmenu', (e) => {
    const noteBtn = e.target.closest('.tree-note[data-id]');
    const folderBtn = e.target.closest('[data-folder-path]');
    e.preventDefault();
    if (noteBtn) {
      showCtxMenu(e.clientX, e.clientY, { kind: 'note', id: noteBtn.getAttribute('data-id') });
      return;
    }
    if (folderBtn) {
      showCtxMenu(e.clientX, e.clientY, {
        kind: 'folder',
        path: folderBtn.getAttribute('data-folder-path'),
      });
      return;
    }
    showCtxMenu(e.clientX, e.clientY, { kind: 'blank' });
  });

  ctxMenu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !menuTarget) return;
    const act = btn.getAttribute('data-act');
    const target = menuTarget;
    hideCtxMenu();

    if (act === 'rename' && target.kind === 'note') {
      await renameNote(target.id);
    } else if (act === 'rename' && target.kind === 'folder') {
      await renameFolder(target.path);
    } else if (act === 'delete' && target.kind === 'note') {
      const note = cache.find((n) => n.id === target.id);
      if (!confirm(`Delete “${note?.title || 'note'}”?`)) return;
      if (activeId === target.id) activeId = null;
      await notes.remove(target.id);
    } else if (act === 'delete' && target.kind === 'folder') {
      await deleteFolder(target.path);
    } else if (act === 'new-note') {
      clearTimeout(saveTimer);
      if (activeId && boundNoteId === activeId) await persistActive();
      const folder = target.kind === 'folder' ? target.path : '';
      await createNote({ title: 'Untitled', folder, body: '', tags: [] });
      setVaultOpen(true);
      titleEl.focus();
      titleEl.select();
    } else if (act === 'new-folder') {
      const base = target.kind === 'folder' ? `${target.path}/` : '';
      await createFolder(base);
    }
  });

  function onPointerDown(e) {
    if (ctxMenu.hidden) return;
    if (Date.now() < menuGuardUntil) return;
    if (ctxMenu.contains(e.target)) return;
    hideCtxMenu();
  }
  document.addEventListener('pointerdown', onPointerDown, true);

  searchEl.addEventListener('input', () => {
    query = searchEl.value;
    renderTree();
  });

  async function onNewNote() {
    clearTimeout(saveTimer);
    if (activeId && boundNoteId === activeId) await persistActive();
    const folder = normalizeFolder(folderEl.value);
    await createNote({
      title: 'Untitled',
      folder,
      body: '',
      tags: [],
    });
    setVaultOpen(true);
    titleEl.focus();
    titleEl.select();
  }

  root.querySelector('#n-new').addEventListener('click', onNewNote);
  root.querySelector('#n-drawer-new').addEventListener('click', onNewNote);
  root.querySelector('#n-new-folder').addEventListener('click', () => createFolder(''));
  root.querySelector('#n-drawer-folder').addEventListener('click', () => createFolder(''));

  root.querySelector('#n-daily').addEventListener('click', async () => {
    const title = todayTitle();
    const existing = findByTitle(title);
    if (existing) {
      if (activeId) await persistActive();
      activeId = existing.id;
      if (normalizeFolder(existing.folder) !== 'daily') {
        patchCache(existing.id, { folder: 'daily' });
        await notes.update(existing.id, { folder: 'daily' });
        await ensureFolderRecord('daily');
      }
      renderTree();
      loadActive();
      return;
    }
    if (activeId) await persistActive();
    await createNote({
      title,
      folder: 'daily',
      tags: ['daily'],
      body: `# ${title}\n\n## Notes\n\n- [ ] \n\n## Log\n\n`,
    });
  });

  root.querySelector('#n-switcher').addEventListener('click', openSwitcher);

  root.querySelector('#n-delete').addEventListener('click', async () => {
    if (!activeId) return;
    const note = cache.find((n) => n.id === activeId);
    const label = note?.title || 'this note';
    if (!confirm(`Delete “${label}”?`)) return;
    const id = activeId;
    activeId = null;
    await notes.remove(id);
  });

  pinBtn.addEventListener('click', () => {
    if (!activeId) return;
    pinBtn.classList.toggle('is-on');
    scheduleSave();
  });

  root.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      viewMode = /** @type {'edit'|'preview'|'split'} */ (btn.getAttribute('data-view') || 'edit');
      applyViewMode();
    });
  });

  titleEl.addEventListener('input', () => {
    if (!activeId) return;
    const title = titleEl.value.trim() || 'Untitled';
    patchCache(activeId, { title });
    renderTree();
    scheduleSave();
  });

  folderEl.addEventListener('input', () => {
    if (!activeId) return;
    patchCache(activeId, { folder: normalizeFolder(folderEl.value) });
    renderTree();
    scheduleSave();
  });

  tagsEl.addEventListener('input', scheduleSave);

  previewEl.addEventListener('click', async (e) => {
    const a = e.target.closest('a[data-wiki], a[href^="#wiki:"]');
    if (!a) return;
    e.preventDefault();
    const title =
      a.getAttribute('data-wiki') ||
      decodeURIComponent((a.getAttribute('href') || '').replace(/^#wiki:/, ''));
    if (!title) return;
    await openOrCreateByTitle(title);
  });

  contextDrawer.addEventListener('click', async (e) => {
    const outline = e.target.closest('[data-outline]');
    if (outline) {
      const id = outline.getAttribute('data-outline');
      if (viewMode === 'edit') {
        viewMode = 'preview';
        applyViewMode();
      }
      const el = previewEl.querySelector(`#${CSS.escape(id)}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const wiki = e.target.closest('[data-wiki]');
    if (wiki) {
      await openOrCreateByTitle(wiki.getAttribute('data-wiki') || '');
      return;
    }
    const link = e.target.closest('[data-id]');
    if (link) {
      if (activeId) await persistActive();
      activeId = link.getAttribute('data-id');
      renderTree();
      loadActive();
    }
  });

  switcherInput.addEventListener('input', () => {
    switcherIndex = 0;
    paintSwitcher();
  });

  switcherInput.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      switcherIndex = Math.min(switcherIndex + 1, Math.max(switcherRows.length - 1, 0));
      paintSwitcher();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      switcherIndex = Math.max(switcherIndex - 1, 0);
      paintSwitcher();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = switcherRows[switcherIndex];
      if (row) await selectSwitcher(row.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSwitcher();
    }
  });

  switcherList.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    await selectSwitcher(item.getAttribute('data-id'));
  });

  switcherBackdrop.addEventListener('click', closeSwitcher);

  function onGlobalKey(e) {
    const mod = e.metaKey || e.ctrlKey;

    if (e.key === 'Escape') {
      if (!ctxMenu.hidden) {
        e.preventDefault();
        hideCtxMenu();
        return;
      }
      if (!switcherEl.hidden) {
        e.preventDefault();
        closeSwitcher();
        return;
      }
      if (contextOpen) {
        e.preventDefault();
        setContextOpen(false);
      }
      return;
    }

    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      persistActive().catch(() => {});
      return;
    }
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      onNewNote();
      return;
    }
    if (mod && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openSwitcher();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      setVaultOpen(!vaultOpen);
    }
  }

  window.addEventListener('keydown', onGlobalKey);

  return {
    title: 'Notes',
    unmount() {
      clearTimeout(saveTimer);
      window.removeEventListener('keydown', onGlobalKey);
      window.removeEventListener('resize', syncBackdrop);
      document.removeEventListener('pointerdown', onPointerDown, true);
      if (unsubNotes) unsubNotes();
      if (unsubFolders) unsubFolders();
      if (cmView) {
        cmView.destroy();
        cmView = null;
      }
      ctxMenu.remove();
      root.innerHTML = '';
    },
  };
}
