# Solebase Notes (example)

Obsidian-like Markdown vault on **Solebase Layer 1** (`Solebase.init` + `collection()`). Local-first PKM with optional E2EE snapshot sync. Zero npm build; ES modules + CDN (`marked`, CodeMirror 6).

## Run

From the repo root (so Solebase package + `core/db-worker.js` resolve):

```bash
python -m http.server 8080 --bind 127.0.0.1
```

Open http://127.0.0.1:8080/examples/notes/

Needs a secure context + OPFS (Chromium / modern Safari / Firefox). Network once for CDN imports (CodeMirror, marked). Hard-refresh (`Ctrl/Cmd+Shift+R`) if an old service worker caches a stale shell.

## Architecture

| Concern | Choice |
|---------|--------|
| Layer 1 | `Solebase.init({ appId: 'notes' })` → `collection('notes' \| 'folders')` |
| Storage | OPFS + cr-sqlite in a Web Worker (`core/db-worker.js`) |
| Editor | CodeMirror 6 Markdown (Yjs rich-text API not exposed in Layer 1 yet) |
| Sync | Optional encrypted snapshot via Settings (Drive / WebDAV / S3) |

App code never opens IndexedDB as the notes database.

## Host vs sync vs offline

Serving the example is a **static file host** only. Same URL on two phones does **not** share notes. Each device keeps its own OPFS vault; offline works after the first visit (service worker + Solebase). **Sync** is optional E2EE to Drive/WebDAV/S3 — separate from hosting. Settings → **Share** copies/QR the origin (not a native install). See [docs/SHIP.md](../../docs/SHIP.md).

## Sync across devices

There is no Solebase server for your notes. Data stays in OPFS on each browser; optional **encrypted** sync uses a folder/object you control.

1. Open **Settings** (gear) — Share for URL/QR; Storage for sync.
2. Pick **WebDAV** or **S3-compatible** (Google Drive optional).
3. Enter the same **passphrase** on every device.
4. **Save settings** → auto-sync; or **Pull & merge** on the other device.

Manual **Export vault** / **Import vault** works offline without a cloud adapter.

## Features

| Area | What you get |
|------|----------------|
| Layout | Left vault tree (push sidebar), main editor, context drawer (outline / backlinks) |
| Editor | CodeMirror 6 Markdown; Edit / Split / Preview |
| Markdown | GFM: headings, lists, fences, tables, blockquotes, tasks, images by URL |
| Wiki-links | `[[Note Title]]` — open or create |
| Search | Text, `#tag`, `path:folder` · quick switcher `Ctrl/Cmd+P` |
| Vault | Nested folders, pin, right-click rename/delete/new |
| Daily | Calendar → `YYYY-MM-DD` under `daily/` |
| Shortcuts | `Ctrl/Cmd+S` save, `+N` new, `+P` switcher, `+O` vault, `Esc` closes |

## Note shape

```js
{ title, body, folder, tags: string[], pinned?: boolean, updatedAt?: number }
```

## Out of scope

Plugins marketplace, full canvas, Electron, graph view. Yjs collaborative docs when Layer 1 exposes document APIs.
