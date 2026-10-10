import {
  squashVideo,
  probeCapabilities,
  isSupported,
  SOS_FAST_DEFAULTS
} from './squash-core.js';

const $ = (id) => document.getElementById(id);
const el = {
  cap: $('capBadge'),
  drop: $('dropZone'),
  input: $('fileInput'),
  compress: $('btnCompress'),
  list: $('fileList')
};

/** Always auto: smallest useful file, fast, keep audio, skip already-lean sources. */
const settings = Object.assign({}, SOS_FAST_DEFAULTS);

/** @type {{id:string,file:File,status:string,card:HTMLElement,url:string,outUrl?:string}[]} */
const items = [];
let busy = false;

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(bytes < 10485760 ? 2 : 1) + 'MB';
}

function fmtSec(ms) {
  return (ms / 1000).toFixed(1) + 'ש׳';
}

function makeCard(file) {
  const card = document.createElement('article');
  card.className = 'card';
  const url = URL.createObjectURL(file);
  card.innerHTML =
    '<video muted playsinline preload="metadata"></video>' +
    '<div class="body">' +
    '<div class="name"></div>' +
    '<div class="meta"></div>' +
    '<div class="progress"><i></i></div>' +
    '<div class="result"></div>' +
    '<div class="actions"></div>' +
    '</div>';
  card.querySelector('video').src = url;
  card.querySelector('.name').textContent = file.name;
  card.querySelector('.meta').textContent = fmtMB(file.size) + ' · ממתין';
  el.list.prepend(card);
  return { card, url };
}

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(
    (f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)
  );
  for (const file of files) {
    const { card, url } = makeCard(file);
    items.push({ id: String(Date.now() + Math.random()), file, status: 'pending', card, url });
  }
  refreshButton();
}

function refreshButton() {
  const pending = items.some((i) => i.status === 'pending');
  el.compress.disabled = busy || !pending || !isSupported();
  el.compress.textContent = busy ? 'מכווץ…' : 'כווץ';
}

function setCard(item, meta, pct) {
  item.card.querySelector('.meta').textContent = meta;
  if (pct != null) item.card.querySelector('.progress > i').style.width = pct + '%';
}

async function compressItem(item) {
  item.status = 'working';
  setCard(item, fmtMB(item.file.size) + ' · מתחיל…', 0);
  try {
    const r = await squashVideo(item.file, settings, (p) => {
      const stage =
        p.stage === 'planning' ? 'מתכנן…' : p.stage === 'skipped' ? 'דולג' : p.pct + '%';
      setCard(item, fmtMB(item.file.size) + ' · ' + stage, p.pct);
    });
    item.status = 'done';
    item.result = r;
    const saved = 100 - (r.blob.size / item.file.size) * 100;
    const res = item.card.querySelector('.result');
    res.classList.toggle('bad', saved < 0 && !r.skipped && !r.keptOriginal);
    let note;
    if (r.skipped) {
      note = 'כבר היה מכווץ — לא נגענו';
    } else if (r.keptOriginal) {
      note = 'הכיווץ לא שיפר — נשמר המקור';
    } else if (saved >= 0) {
      note = 'חסכון ' + saved.toFixed(0) + '%';
    } else {
      note = 'גדל ב־' + (-saved).toFixed(0) + '%';
    }
    res.innerHTML =
      fmtMB(item.file.size) +
      ' → <b>' +
      fmtMB(r.blob.size) +
      '</b> · ' +
      note +
      ' · ' +
      fmtSec(r.ms);
    setCard(item, 'הושלם', 100);
    item.outUrl = URL.createObjectURL(r.blob);
    const a = document.createElement('a');
    a.href = item.outUrl;
    a.download = item.file.name.replace(/\.[^.]+$/, '') + '-squash.mp4';
    a.textContent = 'הורד';
    a.setAttribute('data-testid', 'download-link');
    const actions = item.card.querySelector('.actions');
    actions.innerHTML = '';
    actions.appendChild(a);
    item.card.querySelector('video').src = item.outUrl;
  } catch (err) {
    item.status = 'error';
    const m = String((err && err.message) || err);
    setCard(item, 'שגיאה', 0);
    const res = item.card.querySelector('.result');
    res.classList.add('bad');
    res.textContent = m;
    console.error('[squash]', err);
  }
}

el.compress.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  refreshButton();
  for (const item of items) {
    if (item.status === 'pending') await compressItem(item);
  }
  busy = false;
  refreshButton();
});

el.input.addEventListener('change', () => {
  addFiles(el.input.files);
  el.input.value = '';
});
['dragenter', 'dragover'].forEach((t) =>
  el.drop.addEventListener(t, (e) => {
    e.preventDefault();
    el.drop.classList.add('is-over');
  })
);
['dragleave', 'drop'].forEach((t) =>
  el.drop.addEventListener(t, (e) => {
    e.preventDefault();
    el.drop.classList.remove('is-over');
  })
);
el.drop.addEventListener('drop', (e) => addFiles(e.dataTransfer && e.dataTransfer.files));

async function initCaps() {
  const caps = await probeCapabilities();
  if (!caps.supported) {
    el.cap.textContent = 'הדפדפן לא תומך · נסה Chrome / Edge';
    el.cap.classList.add('bad');
  } else {
    el.cap.textContent = 'מוכן';
    el.cap.classList.add('ok');
  }
  refreshButton();
  return caps;
}

/** QA hook: compress with explicit options and optionally POST the result. */
window.SquashLab = {
  caps: initCaps(),
  getSettings: () => Object.assign({}, settings),
  async runQa(file, opts, uploadUrl) {
    const r = await squashVideo(file, opts);
    if (uploadUrl) {
      const res = await fetch(uploadUrl, { method: 'POST', body: r.blob });
      if (!res.ok) throw new Error('upload failed ' + res.status);
    }
    return {
      ms: r.ms,
      size: r.blob.size,
      encodedSize: r.encodedSize,
      keptOriginal: r.keptOriginal,
      skipped: !!r.skipped,
      skipReason: r.skipReason || null,
      info: r.info
    };
  }
};

refreshButton();
