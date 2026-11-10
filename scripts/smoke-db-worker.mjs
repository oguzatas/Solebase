/**
 * Headless browser smoke for Layer 3 (OPFS + cr-sqlite worker).
 *
 * Requires: secure-context localhost server + Chrome/Edge (via puppeteer-core).
 *
 *   python -m http.server 8765 --bind 127.0.0.1
 *   node scripts/smoke-db-worker.mjs
 *
 * Env:
 *   SMOKE_BASE   default http://127.0.0.1:8765
 *   CHROME_PATH  optional path to chrome/msedge
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.SMOKE_BASE || 'http://127.0.0.1:8765';
const pageUrl = `${base.replace(/\/$/, '')}/examples/smoke-db/`;

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('SMOKE_DB_SKIP: no Chrome/Edge found (OPFS smoke needs a real browser)');
    process.exit(0);
  }

  // Load puppeteer-core from a temp install so the zero-build repo stays clean.
  let puppeteer;
  try {
    const require = createRequire(import.meta.url);
    puppeteer = require('puppeteer-core');
  } catch {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2ui-puppeteer-'));
    console.log('Installing puppeteer-core into', tmp);
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', 'puppeteer-core@23.11.1', '--prefix', tmp],
        { stdio: 'inherit', shell: true },
      );
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('npm install failed'))));
    });
    const requireTmp = createRequire(path.join(tmp, 'package.json'));
    puppeteer = requireTmp('puppeteer-core');
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2ui-smoke-'));
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
    await page.click('#run');

    // Wait for success or failure text.
    const deadline = Date.now() + 90_000;
    let text = '';
    while (Date.now() < deadline) {
      text = await page.$eval('#out', (el) => el.textContent || '');
      if (text.includes('SMOKE_DB_OK') || text.includes('FAIL:')) break;
      await sleep(500);
    }

    if (!text.includes('SMOKE_DB_OK')) {
      console.error('SMOKE_DB_FAIL');
      console.error(text);
      if (errors.length) console.error('page errors:', errors);
      process.exit(1);
    }
    console.log('SMOKE_DB_OK');
    console.log(text.trim());
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
