/**
 * app/wiki.js — Solebase local-first wiki (Layer 1 collection API)
 *
 * Pages live in OPFS via cr-sqlite worker. No IndexedDB / localStorage DB.
 */

/**
 * @typedef {{ id: string, title?: string, body?: string, updatedAt?: number }} WikiPage
 */

/**
 * @param {HTMLElement} root
 * @param {{ pages: { insert: Function, update: Function, delete: Function, find: Function, subscribe: Function } }} opts
 */
export async function mount(root, { pages }) {
  root.innerHTML = `
    <div class="wiki" data-app="wiki">
      <aside class="wiki-rail" aria-label="Pages">
        <div class="wiki-rail-head">
          <h2 class="wiki-rail-title">Pages</h2>
          <button type="button" class="btn btn-primary" id="wiki-new">New</button>
        </div>
        <ul class="wiki-list" id="wiki-list" role="list"></ul>
        <p class="wiki-empty" id="wiki-empty" hidden>No pages yet. Create one.</p>
      </aside>
      <section class="wiki-editor" aria-label="Editor">
        <div class="wiki-editor-toolbar">
          <input
            type="text"
            id="wiki-title"
            class="wiki-title"
            placeholder="Page title"
            autocomplete="off"
            spellcheck="true"
            disabled
          />
          <div class="wiki-actions">
            <button type="button" class="btn btn-primary" id="wiki-save" disabled>Save</button>
            <button type="button" class="btn btn-ghost" id="wiki-delete" disabled>Delete</button>
          </div>
        </div>
        <textarea
          id="wiki-body"
          class="wiki-body"
          placeholder="Write your page…"
          spellcheck="true"
          disabled
        ></textarea>
        <p class="wiki-status" id="wiki-status" role="status">Select or create a page.</p>
      </section>
    </div>
  `;

  const listEl = /** @type {HTMLUListElement} */ (root.querySelector('#wiki-list'));
  const emptyEl = /** @type {HTMLElement} */ (root.querySelector('#wiki-empty'));
  const titleEl = /** @type {HTMLInputElement} */ (root.querySelector('#wiki-title'));
  const bodyEl = /** @type {HTMLTextAreaElement} */ (root.querySelector('#wiki-body'));
  const statusEl = /** @type {HTMLElement} */ (root.querySelector('#wiki-status'));
  const btnNew = /** @type {HTMLButtonElement} */ (root.querySelector('#wiki-new'));
  const btnSave = /** @type {HTMLButtonElement} */ (root.querySelector('#wiki-save'));
  const btnDelete = /** @type {HTMLButtonElement} */ (root.querySelector('#wiki-delete'));

  /** @type {WikiPage[]} */
  let docs = [];
  /** @type {string | null} */
  let activeId = null;
  let dirty = false;

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function setEditorEnabled(on) {
    titleEl.disabled = !on;
    bodyEl.disabled = !on;
    btnSave.disabled = !on;
    btnDelete.disabled = !on;
  }

  function sortDocs(rows) {
    return [...rows].sort((a, b) => {
      const ta = String(a.title || '').toLowerCase();
      const tb = String(b.title || '').toLowerCase();
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  function renderList() {
    listEl.innerHTML = '';
    const sorted = sortDocs(docs);
    emptyEl.hidden = sorted.length > 0;
    for (const doc of sorted) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wiki-list-item' + (doc.id === activeId ? ' is-active' : '');
      btn.textContent = (doc.title && String(doc.title).trim()) || 'Untitled';
      btn.addEventListener('click', () => {
        void openPage(doc.id);
      });
      li.appendChild(btn);
      listEl.appendChild(li);
    }
  }

  function loadEditor(doc) {
    titleEl.value = doc?.title ?? '';
    bodyEl.value = doc?.body ?? '';
    dirty = false;
  }

  async function openPage(id) {
    if (dirty && activeId && activeId !== id) {
      const leave = confirm('Discard unsaved changes?');
      if (!leave) return;
    }
    const doc = docs.find((d) => d.id === id) || (await pages.findById(id));
    if (!doc) {
      setStatus('Page not found.');
      activeId = null;
      setEditorEnabled(false);
      loadEditor(null);
      renderList();
      return;
    }
    activeId = doc.id;
    setEditorEnabled(true);
    loadEditor(doc);
    renderList();
    setStatus('Editing · saved locally in OPFS');
    titleEl.focus();
  }

  async function createPage() {
    if (dirty && activeId) {
      const leave = confirm('Discard unsaved changes?');
      if (!leave) return;
    }
    const now = Date.now();
    const created = await pages.insert({
      title: 'Untitled',
      body: '',
      updatedAt: now,
    });
    activeId = created.id;
    setEditorEnabled(true);
    loadEditor(created);
    setStatus('Created · edit and Save');
    titleEl.focus();
    titleEl.select();
  }

  async function savePage() {
    if (!activeId) return;
    const title = titleEl.value.trim() || 'Untitled';
    const body = bodyEl.value;
    const updated = await pages.update(activeId, {
      title,
      body,
      updatedAt: Date.now(),
    });
    dirty = false;
    loadEditor(updated);
    setStatus('Saved');
  }

  async function deletePage() {
    if (!activeId) return;
    const title = titleEl.value.trim() || 'Untitled';
    if (!confirm(`Delete “${title}”?`)) return;
    const id = activeId;
    await pages.delete(id);
    activeId = null;
    dirty = false;
    setEditorEnabled(false);
    loadEditor(null);
    setStatus('Deleted');
  }

  const onTitleInput = () => {
    dirty = true;
    setStatus('Unsaved changes');
  };
  const onBodyInput = () => {
    dirty = true;
    setStatus('Unsaved changes');
  };

  titleEl.addEventListener('input', onTitleInput);
  bodyEl.addEventListener('input', onBodyInput);
  btnNew.addEventListener('click', () => {
    void createPage().catch((err) => setStatus(err.message || 'Create failed'));
  });
  btnSave.addEventListener('click', () => {
    void savePage().catch((err) => setStatus(err.message || 'Save failed'));
  });
  btnDelete.addEventListener('click', () => {
    void deletePage().catch((err) => setStatus(err.message || 'Delete failed'));
  });

  const unsub = pages.subscribe((next) => {
    docs = Array.isArray(next) ? next : [];
    renderList();
    if (activeId) {
      const current = docs.find((d) => d.id === activeId);
      if (!current) {
        activeId = null;
        dirty = false;
        setEditorEnabled(false);
        loadEditor(null);
        setStatus('Page removed.');
      } else if (!dirty) {
        loadEditor(current);
      }
    }
  });

  return {
    title: 'Wiki',
    unmount() {
      unsub();
      root.innerHTML = '';
    },
  };
}
