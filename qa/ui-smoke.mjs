/** UI smoke: auto-only UI, SOS_FAST defaults, no page errors. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8897, r));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://127.0.0.1:8897/');
await page.waitForFunction(() => window.SquashLab);
const def = await page.evaluate(() => window.SquashLab.getSettings());
const hasSettings = await page.$('#settingsPanel');
const hasQuality = await page.$('#qualityChips');
const compress = await page.$('[data-testid="btn-compress"]');
const ok =
  !hasSettings &&
  !hasQuality &&
  !!compress &&
  def.skipAlreadyCompressed === true &&
  def.keepOriginalIfLarger === true &&
  def.timeBudgetSec === 80 &&
  def.audio === 'auto';
console.log(JSON.stringify({ def, hasSettings: !!hasSettings, hasQuality: !!hasQuality, ok, errors }, null, 1));
await browser.close();
server.close();
process.exit(errors.length || !ok ? 1 : 0);
