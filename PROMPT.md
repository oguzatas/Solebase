# PROMPT.md — Generate a Prompt2UI personal app with AI

Clone this repo, then ask an AI to **replace `app/` only**. Do not reimplement sync, adapters, or crypto — those live in `core/`.

---

## Design method (quiet utility)

The shell (`index.html`) owns the **opening page**, tokens, and Settings chrome. Your `app/` module is the **utility surface** shown after **Open app**. Match the shell; do not invent a second visual language or any sync UI.

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
| `--font-display` | Bricolage Grotesque — titles / brand |
| `--font-body` | Figtree — UI copy |
| `--radius` `0.5rem` | Corners (keep quiet; no pill clusters) |
| `--space-2`…`--space-5` | Prefer dense spacing over airy marketing layout |

### Hard rules for `app/`

- **Quiet utility:** dense, calm, minimal chrome. One job. Instant CRUD.
- Prefer existing shell classes (`.btn`, `.btn-primary`, `.btn-ghost`, `.micro-*`, form / list patterns) or a unique wrapper with the same tokens.
- **Never** build sync, adapter, passphrase, export/import, or cloud UI inside `app/`. That lives only in Settings (`core/settings-panel.js`).
- **Never** invent a marketing hero, cards-for-decoration, macro rings on an opening page, floating badges, or purple/cream/broadsheet themes.
- Dark quiet utility is the default. Soft sage accent — not neon glow stacks.
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

- Collections API (do not redefine; do not call adapters / crypto / sync):

  await db.collection('my-collection').add({ ...fields })
  await db.collection('my-collection').get()              // live rows
  await db.collection('my-collection').set(items)
  await db.collection('my-collection').update(id, patch)
  await db.collection('my-collection').remove(id)         // tombstone
  db.collection('my-collection').subscribe((rows) => {})  // unsubscribe fn
  await db.collection('my-collection').clear()

- Auto fields: id, createdAt, updatedAt. Prefer plain JSON-serializable objects.
- Export:

  export async function mount(root) { ... return { unmount(), title? } }

- mount() must:
  1. Use uniquely named kebab-case collection(s).
  2. Render into `root` (innerHTML or DOM APIs).
  3. Subscribe so the UI updates on every change.
  4. Return { unmount() { /* unsubscribe + clear root */ }, title?: string }.

- Styling — quiet utility (match index.html tokens):
  Prefer CSS variables: --bg #0c0e11, --bg-elevated #161a20, --text #e6e9ee,
  --text-muted #6b7380, --accent #7a9e8a, --border #2a323d, --radius 0.5rem.
  Fonts: Bricolage Grotesque (titles) / Figtree (body) via shell, or inherit.
  Dense calm UI; reuse .btn / form / list patterns when possible.
  Do NOT invent sync/settings/cloud UI. Do NOT use purple-on-white,
  cream-serif-terracotta, broadsheet, Inter/Roboto/Arial, or decorative cards.
- One job, instant CRUD, mobile-friendly. Escape user text in HTML.
- Do not fetch remote URLs unless the user explicitly asks.
- Cloud sync is automatic when the user configures Settings — your app must not import core/prompt-storage.js or core/sync-engine.js.
- Output ONLY the ES module source for app/ (e.g. app/main.js) — no markdown fences unless asked.
```

---

## User prompt template

```
Replace the Prompt2UI sample app with: <NAME>.

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

### Example

```
Replace the Prompt2UI sample app with: Habit streaks.

Purpose: Track daily habits and show a simple streak count.

Collections:
- habits: name (string), lastDone (ISO date), streak (number)

UI:
- Form: habit name
- List with "Mark done today" and delete
- Show streak count per habit (no badges/stickers)
- Empty state copy

Save as: app/habit-streaks.js
Update app.js to mount it.
```

---

## Wiring after generation

1. Save the module under `app/` (replace `calorie-tracker.js` or add a new file).  
2. If the filename changed, update the import in root `app.js`:

```js
import { mount as mountApp } from './app/habit-streaks.js';
```

3. Optionally add the new path to `PRECACHE` in `sw.js`.  
4. Do **not** touch adapters — configure cloud in Settings on each device.  
5. Do **not** replace the opening page in `index.html` unless the user asked for shell redesign — AI app work targets `app/` only.

---

## Reminder

- Opening page + Settings / Sync → shell (`index.html` + `core/settings-panel.js`).  
- Local CRUD → IndexedDB via `db.collection(...)` in `app/`.  
- Sync / E2EE / Drive / WebDAV / S3 → Settings + `core/` only.  
- Limits: last-write-wins (not CRDT), passphrase loss is permanent, snapshot sync is for small personal data.
