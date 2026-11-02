# Notes (example)

Editor-first Markdown vault on Prompt2UI — local-first PKM with optional E2EE sync. Zero npm build; ES modules + CDN (`marked`, CodeMirror 6).

## Run

```bash
cd examples/notes
python -m http.server 8082
```

Open http://localhost:8082 — editor opens immediately (no app shell rail).

Needs network once for CDN imports (CodeMirror, marked).

## Features

| Area | What you get |
|------|----------------|
| Layout | Full-bleed editor; vault list + context as drawers; gear for Settings |
| Editor | CodeMirror 6 Markdown; Edit / Split / Preview (icons) |
| Markdown | GFM: headings, lists, fences, tables, blockquotes, tasks, images by URL |
| Wiki-links | `[[Note Title]]` — open or create; outline / backlinks / outgoing in context drawer |
| Search | One field: text, `#tag`, `path:folder` (no filter dropdowns) |
| Vault | Nested paths, pin, new / rename / delete |
| Daily | Calendar icon → `YYYY-MM-DD` under `daily/` |
| Shortcuts | `Ctrl/Cmd+S` save, `+N` new, `+P` switcher, `+O` vault drawer, `Esc` closes drawers |
| Persistence | `db.collection('notes')` + `updatedAt`; Settings sync unchanged |

## Note shape

```js
{ title, body, folder, tags: string[], pinned?: boolean }
```

## Customize

Edit `app/notes.js` and `app/markdown.js`. Refresh engines:

```powershell
..\..\scripts\copy-core.ps1 -Target .
```

## Out of scope

Plugins marketplace, full canvas, sync-engine replacement, Electron. Graph view can wait.
