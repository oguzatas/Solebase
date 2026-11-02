# Notes (example)

Obsidian-like personal vault on Prompt2UI — local-first Markdown PKM with optional E2EE cloud sync. Zero npm build; ES modules + CDN (`marked`, CodeMirror 6).

## Run

```bash
cd examples/notes
python -m http.server 8082
```

Open http://localhost:8082 — vault opens immediately.

Needs network once for CDN imports (CodeMirror, marked). Offline after the browser caches them.

## Features

| Area | What you get |
|------|----------------|
| Editor | CodeMirror 6 + Markdown language; **Edit / Preview / Split** |
| Markdown | Headings, lists, code fences, tables, blockquotes, task lists `- [ ]`, images by URL (via `marked` GFM) |
| Wiki-links | `[[Note Title]]` — click to open or **create**; backlinks + outgoing panels |
| Vault | Nested folder paths, `#tags` + frontmatter tags, full-text search, new / rename (title) / delete, pin ★ |
| Daily note | One-click today’s note (`YYYY-MM-DD` under `daily/`) |
| Shortcuts | `Ctrl/Cmd+S` save (also autosave), `Ctrl/Cmd+N` new, `Ctrl/Cmd+P` quick switcher, `Esc` close overlays |
| Persistence | `db.collection('notes')` with `updatedAt` for sync |
| Sync | Settings gear → WebDAV / S3 / Drive + passphrase (unchanged Prompt2UI `core/`) |

Right pane: outline, backlinks, outgoing wiki-links. Sidebar collapses on mobile.

## Note shape

```js
{ title, body, folder, tags: string[], pinned?: boolean }
```

`updatedAt` / `id` are managed by PromptDB.

## Customize

Edit `app/notes.js` and `app/markdown.js`. Refresh engines from the blank starter:

```powershell
..\..\scripts\copy-core.ps1 -Target .
```

## Out of scope

Plugins marketplace, full canvas, sync-engine replacement, Electron. Graph view can wait.
