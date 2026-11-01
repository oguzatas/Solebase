# Calorie Tracker (example)

Use-ready meals + macros app on Prompt2UI. Local-first; sync via Settings.

## Run

```bash
cd examples/calorie-tracker
python -m http.server 8081
```

Open http://localhost:8081 — the app opens on **Meals** (no marketing page).

## Sync

Settings (gear) → pick WebDAV / S3 / Drive → passphrase → Save. Same passphrase on each device.

## Customize

Edit `app/calorie-tracker.js` only. Do not touch `core/`. To refresh engines from the blank starter:

```powershell
..\..\scripts\copy-core.ps1 -Target .
```
