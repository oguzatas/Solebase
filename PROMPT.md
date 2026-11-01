# PROMPT.md — Turn the blank starter into any personal app

Clone this repo (root = blank starter), then ask an AI to **replace `app/` only**. Do not reimplement sync, adapters, or crypto — those live in `core/`.

---

## Blank → your app

1. Serve the root: `python -m http.server 8080`
2. You see an empty canvas and a Settings gear (sync). One quiet line: `edit app/`.
3. Replace `app/blank.js` (or add `app/<name>.js` and point `app.js` at it).
4. Export `mount(root)` → `{ unmount(), title? }` using `db.collection(...)`.
5. Configure cloud later in Settings — never inside `app/`.

### Copy a use-ready example instead

Prefer starting from a working UI?

```bash
# PowerShell — copy an example folder somewhere you deploy
Copy-Item -Recurse examples\notes my-notes-app
cd my-notes-app
python -m http.server 8080
```

Or refresh `core/` into an example after root engine changes:

```powershell
.\scripts\copy-core.ps1 -Target examples\notes
```

Examples are self-contained (duplicated `core/` on Windows — no symlinks).

---

## Design method (quiet utility)

The shell owns tokens and Settings chrome. Your `app/` module is the utility surface. Match the shell; do not invent a second visual language or any sync UI.

### Tokens (from `:root` in `index.html`)

| Token | Role |
|-------|------|
| `--bg` `#0c0e11` | Page background |
| `--bg-elevated` `#161a20` | Inputs / elevated surfaces |
| `--bg-sidebar` `#111419` | Sidebar / drawer |
| `--border` `#2a323d` | Hairlines |
| `--text` `#e6e9ee` | Primary text |
| `--text-muted` `#6b7380` | Secondary text |
| `--accent` `#7a9e8a` | Primary actions |
| `--accent-2` `#a3bfb0` | Soft accent / code |
| `--warn` `#c4a574` | Non-critical highlight |
| `--danger` `#c97a7a` | Destructive |
| `--font-display` | Bricolage Grotesque — titles |
| `--font-body` | Figtree — UI copy |
| `--radius` `0.5rem` | Corners |

### Hard rules for `app/`

- Quiet utility: dense, calm, minimal chrome. One job. Instant CRUD.
- Prefer shell classes (`.btn`, `.btn-primary`, `.btn-ghost`) or the same tokens.
- **Never** build sync / adapter / passphrase / export UI in `app/`.
- **Never** invent a marketing hero selling Prompt2UI.
- Escape user text in HTML. Mobile-friendly.

---

## System prompt (copy this)

```
You are writing a Prompt2UI personal app (vanilla ES module, zero build).

Constraints:
- Edit / replace files under app/ only. Never modify core/.
- Pure ES6 module. No React, Vue, Svelte, jQuery, npm, or bundlers.
- Import the collections API only:

  import { db } from '../core/db-api.js';

- Collections API:

  await db.collection('my-collection').add({ ...fields })
  await db.collection('my-collection').get()
  await db.collection('my-collection').set(items)
  await db.collection('my-collection').update(id, patch)
  await db.collection('my-collection').remove(id)
  db.collection('my-collection').subscribe((rows) => {})
  await db.collection('my-collection').clear()

- Export:

  export async function mount(root) { ... return { unmount(), title? } }

- Styling — quiet utility tokens from index.html (:root).
  Do NOT invent sync/settings/cloud UI.
- Output ONLY the ES module source for app/ — no markdown fences unless asked.
```

---

## User prompt template

```
Replace the Prompt2UI blank app with: <NAME>.

Purpose: <one sentence>

Collections:
- <name>: fields <list>

UI (quiet utility — dense, calm, no sync chrome):
- Form to add/edit
- List with delete
- <totals / filters / empty state>

Save as: app/<file>.js
Update app.js to import mount from that file if the filename changes.
```

---

## Wiring after generation

1. Save under `app/`.  
2. Update import in root `app.js` if the filename changed.  
3. Optionally add the path to `PRECACHE` in `sw.js`.  
4. Do **not** touch adapters — configure cloud in Settings.

---

## Reminder

- Blank starter ≠ demo calorie UI. Examples live under `examples/`.  
- Local CRUD → `db.collection(...)` in `app/`.  
- Sync / E2EE → Settings + `core/` only.
