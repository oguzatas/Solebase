# Notes (example)

Obsidian-style personal notes on Prompt2UI: list + editor, folders, tags, search, light markdown preview. Local CRUD via `db.collection('notes')`.

## Run

```bash
cd examples/notes
python -m http.server 8082
```

Open http://localhost:8082 — workspace opens immediately.

## Sync

Settings (gear) → WebDAV / S3 / Drive → passphrase → Save.

## Customize

Edit `app/notes.js`. Refresh engines from the blank starter:

```powershell
..\..\scripts\copy-core.ps1 -Target .
```
