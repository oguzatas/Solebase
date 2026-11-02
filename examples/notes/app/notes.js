/**
 * app/notes.js — Obsidian-like personal vault (quiet utility)
 *
 * Collections only — never adapters or sync:
 *   import { db } from '../core/db-api.js';
 *
 * Note shape: { title, body, folder, tags: string[], pinned?: boolean }
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

/**
 * @param {HTMLElement} root
 */
export async function mount(root) {
  const notes = db.collection(NOTES);
  /** @type {string|null} */
  let activeId = null;
  let query = '';
  let folderFilter = '';
  let tagFilter = '';
  /** @type {'edit'|'preview'|'split'} */
  let viewMode = 'split';
  let saveTimer = null;
  let unsub = null;
  /** @type {object[]} */
  let cache = [];
  let treeCollapsed = new Set();
  let mobileShowList = true;
  /** @type {EditorView|null} */
  let cmView = null;
  let applyingDoc = false;

  root.innerHTML = `
    <div class="vault" data-app="notes">
      <aside class="vault-rail" id="vault-rail" aria-label="Vault">
        <div class="vault-rail-head">
          <div class="vault-actions">
            <button type="button" class="btn btn-primary btn-sm" id="n-new" title="New note (Ctrl/Cmd+N)">New</button>
            <button type="button" class="btn btn-ghost btn-sm" id="n-daily" title="Today’s daily note">Daily</button>
            <button type="button" class="btn btn-ghost btn-sm" id="n-switcher" title="Quick switcher (Ctrl/Cmd+P)">Find</button>
          </div>
          <input type="search" id="n-search" placeholder="Search vault…" autocomplete="off" />
        </div>
        <div class="vault-filters">
          <label>
            <span>Folder</span>
            <select id="n-folder-filter">
              <option value="">All</option>
            </select>
          </label>
          <label>
            <span>Tag</span>
            <select id="n-tag-filter">
              <option value="">All</option>
            </select>
          </label>
        </div>
        <div class="vault-tree" id="n-tree" role="tree"></div>
      </aside>

      <section class="vault-editor" id="n-editor" aria-label="Editor">
        <div class="vault-empty" id="n-empty">
          <p class="vault-empty-title">Vault</p>
          <p class="vault-empty-copy">Create a note, open today’s daily, or press <kbd>Ctrl</kbd>+<kbd>P</kbd> to jump.</p>
        </div>
        <div class="vault-form hidden" id="n-form">
          <div class="vault-form-top">
            <button type="button" class="btn btn-ghost btn-sm vault-mobile-back" id="n-back-list" aria-label="Back to list">Notes</button>
            <input type="text" id="n-title" placeholder="Note title" maxlength="160" />
            <div class="vault-form-actions">
              <div class="view-toggle" role="group" aria-label="Editor view">
                <button type="button" class="btn btn-ghost btn-sm view-btn" data-view="edit">Edit</button>
                <button type="button" class="btn btn-ghost btn-sm view-btn" data-view="split">Split</button>
                <button type="button" class="btn btn-ghost btn-sm view-btn" data-view="preview">Preview</button>
              </div>
              <button type="button" class="btn-icon" id="n-pin" aria-label="Pin note" title="Pin">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5l1.2 3.6H13l-3 2.4.9 3.5L8 9.2l-2.9 1.8.9-3.5-3-2.4h3.8L8 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
              </button>
              <button type="button" class="btn-icon" id="n-delete" aria-label="Delete note" title="Delete">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="vault-meta-row">
            <label>
              <span>Path / folder</span>
              <input type="text" id="n-folder" placeholder="journal / projects/alpha" maxlength="120" list="n-folder-list" />
              <datalist id="n-folder-list"></datalist>
            </label>
            <label>
              <span>Tags</span>
              <input type="text" id="n-tags" placeholder="ideas, reading — or use #tags / frontmatter" maxlength="160" />
            </label>
          </div>
          <div class="vault-panes" id="n-panes" data-mode="split">
            <div class="vault-cm-wrap" id="n-cm-wrap">
              <div id="n-cm" class="vault-cm"></div>
            </div>
            <div class="vault-preview" id="n-preview" aria-live="polite"></div>
          </div>
          <p class="vault-save-hint" id="n-hint">Saved locally</p>
        </div>
      </section>

      <aside class="vault-side" id="vault-side" aria-label="Note context">
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

    <div class="switcher-backdrop" id="switcher-backdrop" hidden></div>
    <div class="switcher" id="switcher" role="dialog" aria-modal="true" aria-label="Quick switcher" hidden>
      <input type="search" id="switcher-input" placeholder="Jump to note…" autocomplete="off" />
      <ul class="switcher-list" id="switcher-list"></ul>
      <p class="switcher-hint">↑↓ navigate · Enter open · Esc close</p>
    </div>
  `;

  const treeEl = root.querySelector('#n-tree');
  const searchEl = root.querySelector('#n-search');
  const folderFilterEl = root.querySelector('#n-folder-filter');
  const tagFilterEl = root.querySelector('#n-tag-filter');
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
  const switcherEl = root.querySelector('#switcher');
  const switcherBackdrop = root.querySelector('#switcher-backdrop');
  const switcherInput = root.querySelector('#switcher-input');
  const switcherList = root.querySelector('#switcher-list');

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

  function filtered() {
    const q = query.trim().toLowerCase();
    return cache
      .filter((n) => {
        if (folderFilter && normalizeFolder(n.folder) !== folderFilter) return false;
        if (tagFilter) {
          const tags = resolveTags(n);
          if (!tags.includes(tagFilter)) return false;
        }
        if (!q) return true;
        const hay = `${n.title || ''} ${n.body || ''} ${n.folder || ''} ${(n.tags || []).join(' ')}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
  }

  function resolveTags(n) {
    return collectTags(n.body || '', Array.isArray(n.tags) ? n.tags : []);
  }

  function allFolders() {
    return [...new Set(cache.map((n) => normalizeFolder(n.folder)).filter(Boolean))].sort();
  }

  function allTags() {
    return [...new Set(cache.flatMap((n) => resolveTags(n)))].sort();
  }

  function refreshFilterOptions() {
    const folders = allFolders();
    const tags = allTags();
    const keepFolder = folderFilter;
    const keepTag = tagFilter;
    folderFilterEl.innerHTML =
      `<option value="">All</option>` +
      folders.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
    tagFilterEl.innerHTML =
      `<option value="">All</option>` +
      tags.map((t) => `<option value="${escapeHtml(t)}">#${escapeHtml(t)}</option>`).join('');
    folderFilterEl.value = keepFolder;
    tagFilterEl.value = keepTag;
    folderListEl.innerHTML = folders.map((f) => `<option value="${escapeHtml(f)}"></option>`).join('');
  }

  function buildTree(rows) {
    /** @type {Map<string, { name: string, path: string, children: Map<string, any>, notes: object[] }>} */
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

    for (const n of rows) {
      const folder = normalizeFolder(n.folder);
      const node = ensureFolder(folder);
      node.notes.push(n);
    }
    return rootNode;
  }

  function renderTreeNode(node, depth = 0) {
    const parts = [];
    const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of folders) {
      const collapsed = treeCollapsed.has(folder.path);
      parts.push(`
        <div class="tree-folder" style="--depth:${depth}">
          <button type="button" class="tree-folder-btn" data-toggle-folder="${escapeHtml(folder.path)}" aria-expanded="${collapsed ? 'false' : 'true'}">
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
            ${pin}
            <span class="tree-note-title">${escapeHtml(n.title || 'Untitled')}</span>
            <span class="tree-note-snip">${escapeHtml(snippet(n.body))}</span>
          </button>`;
      })
      .join('');
    return parts.join('') + notesHtml;
  }

  function renderTree() {
    const rows = filtered();
    if (!rows.length) {
      const emptyMsg =
        cache.length === 0
          ? 'No notes yet — New or Daily to start.'
          : 'No notes match.';
      treeEl.innerHTML = `<p class="tree-empty">${emptyMsg}</p>`;
      return;
    }
    if (query.trim() || tagFilter) {
      // Flat list when searching / tagging — clearer than a sparse tree
      treeEl.innerHTML = rows
        .map((n) => {
          const active = n.id === activeId ? ' is-active' : '';
          const pin = n.pinned ? '<span class="tree-pin" title="Pinned">★</span>' : '';
          const folder = normalizeFolder(n.folder);
          return `
            <button type="button" class="tree-note${active}" data-id="${n.id}" style="--depth:0" role="treeitem">
              ${pin}
              <span class="tree-note-title">${escapeHtml(n.title || 'Untitled')}</span>
              <span class="tree-note-snip">${escapeHtml(folder ? folder + ' · ' : '')}${escapeHtml(snippet(n.body))}</span>
            </button>`;
        })
        .join('');
      return;
    }
    const tree = buildTree(rows);
    treeEl.innerHTML = renderTreeNode(tree);
  }

  function showEditor(show) {
    emptyEl.classList.toggle('hidden', show);
    formEl.classList.toggle('hidden', !show);
  }

  function applyViewMode() {
    panesEl.dataset.mode = viewMode;
    root.querySelectorAll('.view-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-view') === viewMode);
    });
    if (viewMode !== 'edit') refreshPreview();
  }

  function refreshPreview() {
    const body = getBody();
    previewEl.innerHTML = renderMarkdown(body, { noteTitles: noteTitlesSet() });
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

  function loadActive() {
    const note = cache.find((n) => n.id === activeId);
    if (!note) {
      showEditor(false);
      refreshSidePanels();
      return;
    }
    showEditor(true);
    titleEl.value = note.title || '';
    folderEl.value = note.folder || '';
    tagsEl.value = (Array.isArray(note.tags) ? note.tags : []).join(', ');
    setBody(note.body || '');
    pinBtn.classList.toggle('is-on', !!note.pinned);
    applyViewMode();
    refreshSidePanels();
    hintEl.textContent = 'Saved locally';
    mobileShowList = false;
    updateMobileLayout();
  }

  function updateMobileLayout() {
    vaultEl.classList.toggle('show-list', mobileShowList);
    vaultEl.classList.toggle('show-editor', !mobileShowList);
  }

  function scheduleSave() {
    hintEl.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistActive().catch((err) => {
        hintEl.textContent = err.message || 'Save failed';
      });
    }, 320);
  }

  async function persistActive() {
    if (!activeId) return;
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
    await notes.update(activeId, patch);
    hintEl.textContent = 'Saved locally';
    refreshPreview();
    refreshSidePanels();
  }

  async function createNote(seed = {}) {
    const row = await notes.add({
      title: seed.title || 'Untitled',
      body: seed.body || '',
      folder: normalizeFolder(seed.folder || ''),
      tags: seed.tags || [],
      pinned: !!seed.pinned,
    });
    activeId = row.id;
    viewMode = viewMode || 'split';
    mobileShowList = false;
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

  function paint(all) {
    cache = all;
    refreshFilterOptions();
    if (activeId && !cache.some((n) => n.id === activeId)) {
      activeId = null;
    }
    if (!activeId && cache.length) {
      activeId = filtered()[0]?.id || cache[0].id;
    }
    renderTree();
    // Avoid stomping in-progress edits when subscription fires after our own save
    const note = cache.find((n) => n.id === activeId);
    if (!note) {
      showEditor(false);
      refreshSidePanels();
      return;
    }
    const editing =
      document.activeElement === titleEl ||
      document.activeElement === folderEl ||
      document.activeElement === tagsEl ||
      (cmView && cmView.hasFocus);
    if (editing) {
      showEditor(true);
      renderTree();
      refreshSidePanels();
      if (viewMode !== 'edit') refreshPreview();
      return;
    }
    loadActive();
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
          cmPlaceholder('Write in Markdown… [[wiki-links]], #tags, and - [ ] tasks'),
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
              padding: '0.75rem 0.85rem',
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

  /* —— Quick switcher —— */
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

  /* —— Events —— */
  initEditor();
  unsub = notes.subscribe(paint);
  updateMobileLayout();
  applyViewMode();

  treeEl.addEventListener('click', async (e) => {
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
  });

  searchEl.addEventListener('input', () => {
    query = searchEl.value;
    renderTree();
  });

  folderFilterEl.addEventListener('change', () => {
    folderFilter = folderFilterEl.value;
    renderTree();
  });

  tagFilterEl.addEventListener('change', () => {
    tagFilter = tagFilterEl.value;
    renderTree();
  });

  root.querySelector('#n-new').addEventListener('click', async () => {
    if (activeId) await persistActive();
    await createNote({ title: 'Untitled', body: '' });
  });

  root.querySelector('#n-daily').addEventListener('click', async () => {
    const title = todayTitle();
    const existing = findByTitle(title);
    if (existing) {
      if (activeId) await persistActive();
      activeId = existing.id;
      // Keep dailies under daily/
      if (normalizeFolder(existing.folder) !== 'daily') {
        await notes.update(existing.id, { folder: 'daily' });
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
  root.querySelector('#n-back-list').addEventListener('click', () => {
    mobileShowList = true;
    updateMobileLayout();
  });

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
    pinBtn.classList.toggle('is-on');
    scheduleSave();
  });

  root.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      viewMode = /** @type {'edit'|'preview'|'split'} */ (btn.getAttribute('data-view') || 'edit');
      applyViewMode();
    });
  });

  for (const el of [titleEl, folderEl, tagsEl]) {
    el.addEventListener('input', scheduleSave);
  }

  // Title rename is just updating the title field (wiki targets match by title)
  titleEl.addEventListener('change', scheduleSave);

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

  root.querySelector('#vault-side').addEventListener('click', async (e) => {
    const outline = e.target.closest('[data-outline]');
    if (outline) {
      const id = outline.getAttribute('data-outline');
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
    const target = e.target;
    const typing =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);

    if (e.key === 'Escape') {
      if (!switcherEl.hidden) {
        e.preventDefault();
        closeSwitcher();
        return;
      }
    }

    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      persistActive().catch(() => {});
      return;
    }
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      root.querySelector('#n-new').click();
      return;
    }
    if (mod && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openSwitcher();
      return;
    }

    // Don't steal keys while typing in unrelated fields except Mod combos above
    void typing;
  }

  window.addEventListener('keydown', onGlobalKey);

  return {
    title: 'Notes',
    unmount() {
      clearTimeout(saveTimer);
      window.removeEventListener('keydown', onGlobalKey);
      if (unsub) unsub();
      if (cmView) {
        cmView.destroy();
        cmView = null;
      }
      root.innerHTML = '';
    },
  };
}
