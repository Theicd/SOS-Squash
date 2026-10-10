/**
 * Squash QA bench: real Chrome + WebCodecs, measures size / time / A-V sync / SSIM.
 *   node qa/run-bench.mjs [configA,configB] [videoFilter]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIDEOS = path.join(ROOT, 'qa-videos');
const OUT = path.join(ROOT, 'qa', 'out');
const PORT = 8898;

export const CONFIGS = {
  // Exact Squash default screen: Web + Original + AAC 128k + keyframe 2s
  'squash-web': { quality: 'web', resolution: 'original', audio: 'aac', audioBitrate: 128000, keyFrameInterval: 2 },
  'web-copy-kf5': { quality: 'web', resolution: 'original', audio: 'copy', keyFrameInterval: 5 },
  'web-auto-kf5': { quality: 'web', resolution: 'original', audio: 'auto', audioBitrate: 128000, keyFrameInterval: 5 },
  // 30fps cap + on-device encoder speed probe that lowers fps/resolution to fit 80s.
  'fast-1080-b80': { quality: 'web', resolution: '1080p', audio: 'auto', audioBitrate: 128000, keyFrameInterval: 5, maxFps: 30, timeBudgetSec: 80 },
  'fast-720-b80': { quality: 'web', resolution: '720p', audio: 'auto', audioBitrate: 128000, keyFrameInterval: 5, maxFps: 30, timeBudgetSec: 80 },
  // SOS app default: same as fast-720 plus skip-already-compressed
  'sos-fast': {
    quality: 'web',
    resolution: '720p',
    audio: 'auto',
    audioBitrate: 128000,
    keyFrameInterval: 5,
    maxFps: 30,
    timeBudgetSec: 80,
    keepOriginalIfLarger: true,
    skipAlreadyCompressed: true
  }
};

/** Hard per-compression wall-clock limit, independent of video length. */
const LIMIT_MS = 120000;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/upload') {
      const name = path.basename(url.searchParams.get('name') || 'out.mp4');
      const ws = fs.createWriteStream(path.join(OUT, name));
      req.pipe(ws);
      ws.on('finish', () => res.end('ok'));
      return;
    }
    let p = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname === '/') p = path.join(ROOT, 'index.html');
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.statusCode = 404;
      return res.end('nf');
    }
    res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

function ratio(s) {
  const [a, b] = String(s || '').split('/').map(Number);
  return a && b ? a / b : null;
}

function probe(file) {
  const j = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,codec_name,start_time,duration,width,height,sample_rate,bit_rate,avg_frame_rate',
      '-of', 'json', file]).toString()
  );
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const n = (x) => (x == null || x === 'N/A' ? null : Number(x));
  return {
    duration: n(j.format.duration),
    v: v && { codec: v.codec_name, fps: ratio(v.avg_frame_rate), start: n(v.start_time), dur: n(v.duration), w: v.width, h: v.height },
    a: a && { codec: a.codec_name, start: n(a.start_time), dur: n(a.duration), rate: n(a.sample_rate), br: n(a.bit_rate) }
  };
}

/** A/V alignment: start offset and end offset (audio minus video), in ms. */
function avOffsets(p) {
  if (!p.v || !p.a) return null;
  const start = (p.a.start - p.v.start) * 1000;
  const end = (p.a.start + p.a.dur - (p.v.start + p.v.dur)) * 1000;
  return { start, end };
}

/** SSIM on the first 20s; both sides resampled to the output fps so frames pair up. */
function ssim(outFile, inFile, fps, duration) {
  const f = fps && Number.isFinite(fps) ? 'fps=' + fps.toFixed(3) + ',' : '';
  // Stop just before the shorter stream ends: ffmpeg asserts (no SSIM line) when an fps-filtered input runs dry.
  const frames = Math.max(1, Math.floor((Math.min(20, duration || 20) - 0.3) * (fps || 30)));
  const graph = '[0:v]' + f + 'setpts=PTS-STARTPTS[o];[1:v]' + f + 'setpts=PTS-STARTPTS[i];' +
    '[o][i]scale2ref=flags=bicubic[a][b];[a][b]ssim';
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-an', '-t', '20', '-i', outFile, '-an', '-t', '20', '-i', inFile,
    '-lavfi', graph, '-frames:v', String(frames), '-an', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
  return parseSsim(String(r.stderr || '') + String(r.stdout || ''));
}

function parseSsim(log) {
  const m = /All:([0-9.]+)/.exec(log);
  return m ? Number(m[1]) : null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cfgNames = process.argv[2] ? process.argv[2].split(',') : Object.keys(CONFIGS);
  const filter = process.argv[3] || '';
  const videos = fs.readdirSync(VIDEOS).filter((f) => f.endsWith('.mp4') && f.includes(filter)).sort();
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
  await page.goto('http://127.0.0.1:' + PORT + '/');
  const caps = await page.evaluate(() => window.SquashLab.caps);
  console.log('[caps]', JSON.stringify(caps));

  const partial = path.join(ROOT, 'qa', 'results-partial.json');
  // Failed runs are retried on resume, so their old error rows are dropped.
  const rows = (fs.existsSync(partial) ? JSON.parse(fs.readFileSync(partial, 'utf8')) : []).filter((r) => !r.error);
  const done = new Set(rows.map((r) => r.vid + '|' + r.cfg));
  for (const vid of videos) {
    const inFile = path.join(VIDEOS, vid);
    const inSize = fs.statSync(inFile).size;
    const inProbe = probe(inFile);
    const inAv = avOffsets(inProbe);
    for (const cfg of cfgNames) {
      const outName = vid.replace('.mp4', '') + '__' + cfg + '.mp4';
      const outFile = path.join(OUT, outName);
      if (done.has(vid + '|' + cfg)) continue;
      let r;
      let timer;
      await page.reload();
      await page.waitForFunction(() => window.SquashLab && window.SquashLab.caps);
      try {
        r = await Promise.race([
          page.evaluate(async ({ vid, opts, outName }) => {
            const blob = await (await fetch('/qa-videos/' + vid)).blob();
            const file = new File([blob], vid, { type: 'video/mp4' });
            return window.SquashLab.runQa(file, opts, '/upload?name=' + encodeURIComponent(outName));
          }, { vid, opts: CONFIGS[cfg], outName }),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('over-120s')), LIMIT_MS); })
        ]);
      } catch (e) {
        console.log('FAIL', vid, cfg, String(e.message || e).slice(0, 200));
        rows.push({ vid, cfg, error: String(e.message || e).slice(0, 200) });
        fs.writeFileSync(partial, JSON.stringify(rows, null, 2));
        await page.reload();
        await page.waitForFunction(() => window.SquashLab && window.SquashLab.caps);
        continue;
      } finally {
        clearTimeout(timer);
      }
      const outProbe = probe(outFile);
      const outAv = avOffsets(outProbe);
      const syncStart = inAv && outAv ? Math.abs(outAv.start - inAv.start) : null;
      const syncEnd = inAv && outAv ? Math.abs(outAv.end - inAv.end) : null;
      const q = ssim(outFile, inFile, outProbe.v && outProbe.v.fps, inProbe.duration);
      const row = {
        vid, cfg,
        inMB: +(inSize / 1048576).toFixed(2),
        outMB: +(r.size / 1048576).toFixed(2),
        saved: +(100 - (r.size / inSize) * 100).toFixed(1),
        sec: +(r.ms / 1000).toFixed(1),
        rt: +((inProbe.duration || 1) / (r.ms / 1000)).toFixed(1),
        syncStartMs: syncStart == null ? null : +syncStart.toFixed(1),
        syncEndMs: syncEnd == null ? null : +syncEnd.toFixed(1),
        durDiffMs: +(Math.abs((outProbe.duration || 0) - (inProbe.duration || 0)) * 1000).toFixed(0),
        ssim: q == null ? null : +q.toFixed(4),
        res: outProbe.v ? outProbe.v.w + 'x' + outProbe.v.h : '',
        fps: outProbe.v && outProbe.v.fps ? +outProbe.v.fps.toFixed(1) : null,
        keptOriginal: !!r.keptOriginal,
        skipped: !!r.skipped,
        skipReason: r.skipReason || null,
        budget: r.info && r.info.budget ? r.info.budget : undefined,
        already: r.info && r.info.already ? r.info.already : undefined,
        audio: outProbe.a ? outProbe.a.codec + (outProbe.a.br ? '@' + Math.round(outProbe.a.br / 1000) + 'k' : '') : 'none'
      };
      rows.push(row);
      fs.writeFileSync(partial, JSON.stringify(rows, null, 2));
      console.log(
        [row.vid.padEnd(18), row.cfg.padEnd(17), (row.inMB + '→' + row.outMB + 'MB').padEnd(16),
          ('-' + row.saved + '%').padEnd(8), (row.sec + 's x' + row.rt).padEnd(12),
          'sync ' + row.syncStartMs + '/' + row.syncEndMs + 'ms', 'ssim ' + row.ssim, row.res + '@' + row.fps, row.audio,
          row.budget ? 'plan ' + JSON.stringify({ m: row.budget.measuredFps, est: row.budget.estSec, a: row.budget.adapted }) : ''].join(' ')
      );
    }
  }
  await browser.close();
  server.close();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(ROOT, 'qa', 'results-' + stamp + '.json'), JSON.stringify(rows, null, 2));
  fs.rmSync(partial, { force: true });
  summarize(rows);
}

export function summarize(rows) {
  const by = {};
  for (const r of rows) (by[r.cfg] ||= []).push(r);
  console.log('\n=== summary per config ===');
  for (const [cfg, all] of Object.entries(by)) {
    const list = all.filter((r) => !r.error);
    const over120 = all.filter((r) => r.error === 'over-120s').length;
    const otherErr = all.filter((r) => r.error && r.error !== 'over-120s').length;
    const vals = (k) => list.map((r) => r[k]).filter((x) => x != null);
    const avg = (k) => { const v = vals(k); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
    const maxOf = (k) => Math.max(0, ...vals(k));
    const totalIn = list.reduce((s, r) => s + r.inMB, 0);
    const totalOut = list.reduce((s, r) => s + r.outMB, 0);
    console.log(
      cfg.padEnd(15),
      ('n=' + list.length).padEnd(5),
      (totalIn.toFixed(1) + '→' + totalOut.toFixed(1) + 'MB').padEnd(16),
      ('-' + (100 - (totalOut / totalIn) * 100).toFixed(1) + '%').padEnd(7),
      'avg ' + avg('sec').toFixed(1) + 's',
      'max ' + maxOf('sec').toFixed(1) + 's',
      '>60s ' + list.filter((r) => r.sec > 60).length,
      '>120s ' + over120,
      'drift ' + Math.max(maxOf('syncStartMs'), maxOf('syncEndMs')).toFixed(1) + 'ms',
      'ssim ' + avg('ssim').toFixed(4),
      'grew ' + list.filter((r) => r.saved < 0).length,
      otherErr ? 'err ' + otherErr : ''
    );
  }
  console.log('\n=== max time per video (s) ===');
  const vids = [...new Set(rows.map((r) => r.vid))].sort();
  for (const v of vids) {
    const cells = Object.keys(by).map((cfg) => {
      const r = by[cfg].find((x) => x.vid === v);
      return cfg + ':' + (!r ? '-' : r.error ? 'FAIL' : r.sec);
    });
    console.log(v.padEnd(18), cells.join('  '));
  }
}

if (process.argv[2] === '--resssim') {
  const f = path.join(ROOT, 'qa', 'results-partial.json');
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const r of rows.filter((x) => !x.error)) {
    const outFile = path.join(OUT, r.vid.replace('.mp4', '') + '__' + r.cfg + '.mp4');
    const inFile = path.join(VIDEOS, r.vid);
    const op = probe(outFile);
    r.fps = op.v && op.v.fps ? +op.v.fps.toFixed(1) : null;
    const q = ssim(outFile, inFile, op.v && op.v.fps, probe(inFile).duration);
    r.ssim = q == null ? null : +q.toFixed(4);
    console.log(r.vid, r.cfg, r.ssim);
  }
  fs.writeFileSync(f, JSON.stringify(rows, null, 2));
} else if (process.argv[2] === '--summary') {
  const f = process.argv[3] || path.join(ROOT, 'qa', 'results-partial.json');
  summarize(JSON.parse(fs.readFileSync(f, 'utf8')));
} else main().catch((e) => {
  console.error(e);
  process.exit(1);
});
