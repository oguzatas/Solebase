# Notes (example)

Editor-first Markdown vault on Prompt2UI — local-first PKM with optional E2EE sync. Zero npm build; ES modules + CDN (`marked`, CodeMirror 6).

## Run

```bash
cd examples/notes
python -m http.server 8082
```

Open http://localhost:8082 — editor opens immediately (no app shell rail).

Needs network once for CDN imports (CodeMirror, marked). Hard-refresh (`Ctrl/Cmd+Shift+R`) if an old service worker caches a stale shell.

## Host vs sync vs offline

Serving `examples/notes` is a **static file host** only. Same URL on two phones does **not** share notes. Each device has its own IndexedDB; offline works after the first visit (service worker + local DB). **Sync** is optional E2EE to Drive/WebDAV/S3 — separate from hosting. Settings → **Share** copies/QR the origin (not a native install). See [docs/SHIP.md](../../docs/SHIP.md).

## Sync across devices

There is no Prompt2UI server. Your notes stay in IndexedDB on each browser; optional **encrypted** sync uses a folder/object you control.

1. Open **Settings** (gear in the top bar) — Share panel for URL/QR/install tips; Storage for sync.
2. Pick an adapter: **WebDAV** (Nextcloud etc.) or **S3-compatible** (R2/MinIO/S3). Google Drive is optional.
3. Enter the same **passphrase** on every device (encrypts the vault; forgotten = unrecoverable).
4. Fill adapter credentials → **Save settings** (turns on auto-sync).
5. On another device: open the same origin (Share QR or URL), same adapter + passphrase → **Pull & merge** (or wait for auto-sync). Or stay local-only on that device.

Manual **Export vault** / **Import vault** works offline without a cloud adapter.

## Features

| Area | What you get |
|------|----------------|
| Layout | Full-bleed editor; vault list + context as drawers; gear for Settings |
| Editor | CodeMirror 6 Markdown; Edit / Split / Preview (icons) |
| Markdown | GFM: headings, lists, fences, tables, blockquotes, tasks, images by URL |
| Wiki-links | `[[Note Title]]` — open or create; outline / backlinks / outgoing in context drawer |
| Search | One field: text, `#tag`, `path:folder` (no filter dropdowns) |
| Vault | Push sidebar (stays open); nested paths; pin; **right-click** rename/delete |
| Folders | Folder icon or right-click → New folder (`db.collection('folders')` + note paths) |
| Daily | Calendar icon → `YYYY-MM-DD` under `daily/` |
| Shortcuts | `Ctrl/Cmd+S` save, `+N` new, `+P` switcher, `+O` toggle vault, `Esc` closes menus/context |
| Persistence | `notes` + `folders` collections; Settings sync unchanged |

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
