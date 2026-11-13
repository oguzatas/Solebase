/**
 * Headless smoke: Solebase Notes example on Layer 1 (OPFS).
 *
 *   python -m http.server 8080 --bind 127.0.0.1
 *   node scripts/smoke-notes-solebase.mjs
 *
 * Env: SMOKE_BASE (default http://127.0.0.1:8080), CHROME_PATH
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.SMOKE_BASE || 'http://127.0.0.1:8080';
const pageUrl = `${base.replace(/\/$/, '')}/examples/notes/`;

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

async function loadPuppeteer() {
  try {
    const require = createRequire(import.meta.url);
    return require('puppeteer-core');
  } catch {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-puppeteer-'));
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', 'puppeteer-core@23.11.1', '--prefix', tmp],
        { stdio: 'inherit', shell: true },
      );
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('npm install failed'))));
    });
    const requireTmp = createRequire(path.join(tmp, 'package.json'));
    return requireTmp('puppeteer-core');
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('SMOKE_NOTES_SKIP: no Chrome/Edge');
    process.exit(0);
  }

  const puppeteer = await loadPuppeteer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-smoke-'));
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    userDataDir,
    args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle0' });

    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await page.evaluate(() => {
        return (
          document.title.includes('Solebase') &&
          !!document.querySelector('.vault') &&
          !!document.querySelector('.cm-editor')
        );
      });
      if (ready) break;
      await sleep(400);
    }

    if (!ready) {
      console.error('SMOKE_NOTES_FAIL: vault/editor not ready');
      console.error('errors:', errors);
      process.exit(1);
    }

    await page.click('#n-new');
    await sleep(1200);

    const state = await page.evaluate(() => ({
      title: document.title,
      brand: document.querySelector('.vault-brand')?.textContent?.trim() || null,
      formOpen: !document.querySelector('#n-form')?.classList.contains('hidden'),
      noteTitle: document.querySelector('#n-title')?.value || '',
      treeNotes: document.querySelectorAll('.tree-note').length,
      prompt2ui: /Prompt2UI/i.test(document.documentElement.innerHTML),
    }));

    if (!state.formOpen || state.treeNotes < 1) {
      console.error('SMOKE_NOTES_FAIL: new note did not open', state);
      console.error('errors:', errors);
      process.exit(1);
    }
    if (state.prompt2ui) {
      console.error('SMOKE_NOTES_FAIL: Prompt2UI still in DOM');
      process.exit(1);
    }

    // Prove Solebase OPFS insert + nested folder parentFolderId from the same origin
    const probe = await page.evaluate(async () => {
      const { Solebase } = await import('/packages/solebase/dist/index.js');
      const db = await Solebase.init({
        appId: 'notesUiSmoke',
        encryptionKey: 'notes-ui-smoke-key',
        workerUrl: new URL('/core/db-worker.js', location.href),
        filename: 'solebase-notes-ui-smoke.db',
      });
      const notes = db.collection('notes');
      const folders = db.collection('folders');
      const parent = await folders.insert({ name: 'projects', parentFolderId: null });
      const child = await folders.insert({ name: 'active', parentFolderId: parent.id });
      const row = await notes.insert({
        title: 'Smoke',
        body: 'ok',
        folderId: child.id,
        folder: 'projects/active',
        tags: [],
      });
      const found = await notes.findById(row.id);
      const childFound = await folders.findById(child.id);
      await db.close();
      return {
        id: row.id,
        title: found?.title,
        folderId: found?.folderId,
        childParent: childFound?.parentFolderId,
        nestedOk: childFound?.parentFolderId === parent.id && found?.folderId === child.id,
      };
    });

    if (!probe.nestedOk) {
      console.error('SMOKE_NOTES_FAIL: nested folder schema probe failed', probe);
      process.exit(1);
    }

    console.log('SMOKE_NOTES_SOLEBASE_OK');
    console.log(JSON.stringify({ state, probe, errors }, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
