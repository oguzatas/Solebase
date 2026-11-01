/**
 * app/notes.js — Personal notes (Obsidian-style, quiet utility)
 *
 * Collections only — never adapters or sync:
 *   import { db } from '../core/db-api.js';
 *
 * Note shape: { title, body, folder, tags: string[] }
 */

import { db } from '../core/db-api.js';

const NOTES = 'notes';

function todayTitle() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Light markdown-ish preview (zero-build, no deps). */
function renderPreview(src) {
  const lines = String(src || '').split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];

  const flushCode = () => {
    if (!codeBuf.length) return;
    out.push(`<pre class="md-code"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
    codeBuf = [];
  };

  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }

    let line = escapeHtml(raw);
    line = line.replace(/`([^`]+)`/g, '<code>$1</code>');
    line = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    line = line.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    if (/^###\s+/.test(raw)) {
      out.push(`<h4>${line.replace(/^###\s+/, '')}</h4>`);
    } else if (/^##\s+/.test(raw)) {
      out.push(`<h3>${line.replace(/^##\s+/, '')}</h3>`);
    } else if (/^#\s+/.test(raw)) {
      out.push(`<h2>${line.replace(/^#\s+/, '')}</h2>`);
    } else if (/^[-*]\s+/.test(raw)) {
      out.push(`<li>${line.replace(/^[-*]\s+/, '')}</li>`);
    } else if (!raw.trim()) {
      out.push('<br/>');
    } else {
      out.push(`<p>${line}</p>`);
    }
  }
  if (inCode) flushCode();
  return out.join('') || '<p class="preview-empty">Nothing to preview.</p>';
}

function parseTags(raw) {
  return String(raw || '')
    .split(/[,#\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
}

function snippet(body) {
  const t = String(body || '')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, 72) || 'Empty note';
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
  let previewOn = false;
  let saveTimer = null;
  let unsub = null;
  /** @type {object[]} */
  let cache = [];

  root.innerHTML = `
    <div class="notes-app" data-app="notes">
      <aside class="notes-rail" aria-label="Notes">
        <div class="notes-rail-head">
          <input type="search" id="n-search" placeholder="Search notes…" autocomplete="off" />
          <button type="button" class="btn btn-primary btn-sm" id="n-new" title="New note">New</button>
        </div>
        <div class="notes-filters">
          <label>
            <span>Folder</span>
            <select id="n-folder-filter">
              <option value="">All folders</option>
            </select>
          </label>
          <label>
            <span>Tag</span>
            <select id="n-tag-filter">
              <option value="">All tags</option>
            </select>
          </label>
        </div>
        <ul class="notes-list" id="n-list"></ul>
        <div class="notes-rail-foot">
          <button type="button" class="btn btn-ghost btn-sm" id="n-daily">Today’s note</button>
        </div>
      </aside>

      <section class="notes-editor" id="n-editor" aria-label="Editor">
        <div class="notes-empty" id="n-empty">
          <p class="notes-empty-title">Your notes</p>
          <p class="notes-empty-copy">Pick a note or create one. Markdown-ish: headings, lists, <code>**bold**</code>, links.</p>
        </div>
        <div class="notes-form hidden" id="n-form">
          <div class="notes-form-top">
            <input type="text" id="n-title" placeholder="Title" maxlength="160" />
            <div class="notes-form-actions">
              <button type="button" class="btn btn-ghost btn-sm" id="n-toggle-preview">Preview</button>
              <button type="button" class="btn-icon" id="n-delete" aria-label="Delete note" title="Delete">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="notes-meta-row">
            <label>
              <span>Folder</span>
              <input type="text" id="n-folder" placeholder="journal / projects" maxlength="80" list="n-folder-list" />
              <datalist id="n-folder-list"></datalist>
            </label>
            <label>
              <span>Tags</span>
              <input type="text" id="n-tags" placeholder="ideas, reading" maxlength="120" />
            </label>
          </div>
          <textarea id="n-body" spellcheck="true" placeholder="Write…"></textarea>
          <div class="notes-preview hidden" id="n-preview" aria-live="polite"></div>
          <p class="notes-save-hint" id="n-hint">Saved locally</p>
        </div>
      </section>
    </div>
  `;

  const listEl = root.querySelector('#n-list');
  const searchEl = root.querySelector('#n-search');
  const folderFilterEl = root.querySelector('#n-folder-filter');
  const tagFilterEl = root.querySelector('#n-tag-filter');
  const emptyEl = root.querySelector('#n-empty');
  const formEl = root.querySelector('#n-form');
  const titleEl = root.querySelector('#n-title');
  const bodyEl = root.querySelector('#n-body');
  const folderEl = root.querySelector('#n-folder');
  const tagsEl = root.querySelector('#n-tags');
  const previewEl = root.querySelector('#n-preview');
  const hintEl = root.querySelector('#n-hint');
  const folderListEl = root.querySelector('#n-folder-list');
  const togglePreviewBtn = root.querySelector('#n-toggle-preview');

  function filtered() {
    const q = query.trim().toLowerCase();
    return cache
      .filter((n) => {
        if (folderFilter && (n.folder || '') !== folderFilter) return false;
        if (tagFilter) {
          const tags = Array.isArray(n.tags) ? n.tags : [];
          if (!tags.includes(tagFilter)) return false;
        }
        if (!q) return true;
        const hay = `${n.title || ''} ${n.body || ''} ${(n.folder || '')} ${(n.tags || []).join(' ')}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function refreshFilterOptions() {
    const folders = [...new Set(cache.map((n) => n.folder).filter(Boolean))].sort();
    const tags = [...new Set(cache.flatMap((n) => (Array.isArray(n.tags) ? n.tags : [])))].sort();

    const keepFolder = folderFilter;
    const keepTag = tagFilter;
    folderFilterEl.innerHTML =
      `<option value="">All folders</option>` +
      folders.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
    tagFilterEl.innerHTML =
      `<option value="">All tags</option>` +
      tags.map((t) => `<option value="${escapeHtml(t)}">#${escapeHtml(t)}</option>`).join('');
    folderFilterEl.value = keepFolder;
    tagFilterEl.value = keepTag;

    folderListEl.innerHTML = folders.map((f) => `<option value="${escapeHtml(f)}"></option>`).join('');
  }

  function renderList() {
    const rows = filtered();
    if (!rows.length) {
      listEl.innerHTML = `<li class="notes-list-empty">No notes match.</li>`;
      return;
    }
    listEl.innerHTML = rows
      .map((n) => {
        const active = n.id === activeId ? ' is-active' : '';
        const tags = Array.isArray(n.tags) ? n.tags : [];
        return `
          <li>
            <button type="button" class="note-item${active}" data-id="${n.id}">
              <span class="note-item-title">${escapeHtml(n.title || 'Untitled')}</span>
              <span class="note-item-snip">${escapeHtml(snippet(n.body))}</span>
              <span class="note-item-meta">
                ${n.folder ? `<span class="note-folder">${escapeHtml(n.folder)}</span>` : ''}
                ${tags.slice(0, 3).map((t) => `<span class="note-tag">#${escapeHtml(t)}</span>`).join('')}
              </span>
            </button>
          </li>`;
      })
      .join('');
  }

  function showEditor(show) {
    emptyEl.classList.toggle('hidden', show);
    formEl.classList.toggle('hidden', !show);
  }

  function loadActive() {
    const note = cache.find((n) => n.id === activeId);
    if (!note) {
      showEditor(false);
      return;
    }
    showEditor(true);
    titleEl.value = note.title || '';
    bodyEl.value = note.body || '';
    folderEl.value = note.folder || '';
    tagsEl.value = (Array.isArray(note.tags) ? note.tags : []).join(', ');
    applyPreviewMode();
    hintEl.textContent = 'Saved locally';
  }

  function applyPreviewMode() {
    previewEl.classList.toggle('hidden', !previewOn);
    bodyEl.classList.toggle('hidden', previewOn);
    togglePreviewBtn.textContent = previewOn ? 'Edit' : 'Preview';
    if (previewOn) previewEl.innerHTML = renderPreview(bodyEl.value);
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
    if (!activeId) return;
    const patch = {
      title: titleEl.value.trim() || 'Untitled',
      body: bodyEl.value,
      folder: folderEl.value.trim(),
      tags: parseTags(tagsEl.value),
    };
    await notes.update(activeId, patch);
    hintEl.textContent = 'Saved locally';
  }

  async function createNote(seed = {}) {
    const row = await notes.add({
      title: seed.title || 'Untitled',
      body: seed.body || '',
      folder: seed.folder || '',
      tags: seed.tags || [],
    });
    activeId = row.id;
    previewOn = false;
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
    renderList();
    loadActive();
  }

  unsub = notes.subscribe(paint);

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    if (activeId) await persistActive();
    activeId = btn.getAttribute('data-id');
    previewOn = false;
    renderList();
    loadActive();
    titleEl.focus();
  });

  searchEl.addEventListener('input', () => {
    query = searchEl.value;
    renderList();
  });

  folderFilterEl.addEventListener('change', () => {
    folderFilter = folderFilterEl.value;
    renderList();
  });

  tagFilterEl.addEventListener('change', () => {
    tagFilter = tagFilterEl.value;
    renderList();
  });

  root.querySelector('#n-new').addEventListener('click', async () => {
    if (activeId) await persistActive();
    await createNote({ title: 'Untitled', body: '' });
  });

  root.querySelector('#n-daily').addEventListener('click', async () => {
    if (activeId) await persistActive();
    const title = todayTitle();
    const existing = cache.find((n) => n.title === title && (n.folder || '') === 'daily');
    if (existing) {
      activeId = existing.id;
      previewOn = false;
      renderList();
      loadActive();
      return;
    }
    await createNote({
      title,
      folder: 'daily',
      tags: ['daily'],
      body: `# ${title}\n\n`,
    });
  });

  root.querySelector('#n-delete').addEventListener('click', async () => {
    if (!activeId) return;
    const id = activeId;
    activeId = null;
    await notes.remove(id);
  });

  togglePreviewBtn.addEventListener('click', () => {
    previewOn = !previewOn;
    applyPreviewMode();
  });

  for (const el of [titleEl, bodyEl, folderEl, tagsEl]) {
    el.addEventListener('input', scheduleSave);
  }

  return {
    title: 'Notes',
    unmount() {
      clearTimeout(saveTimer);
      if (unsub) unsub();
      root.innerHTML = '';
    },
  };
}
