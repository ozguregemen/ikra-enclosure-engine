/*
 * Ikra Enclosure Engine — M0 arayüz akışı:
 * STEP yükle → (Web Worker'da OpenCascade) oku → analiz et → 3B göster + özet.
 */
import { Viewer } from './viewer.js';
import { analyzeAssembly } from './analysis.js';
import { createDesignUI } from './design-ui.js';

const APP_VERSION = '0.3.0 (M2)';
const SAMPLE_URL = 'samples/ornek-kart.step';
const LARGE_FILE_MB = 50;

const $ = (sel) => document.querySelector(sel);
const num = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('tr-TR');
const fmt = (v) => num.format(v);

const STAGE_TEXT = {
  engine: '3B motoru hazırlanıyor… (ilk açılışta ~8 MB indirilir)',
  parse: 'STEP okunuyor ve üçgen ağa çevriliyor…',
};

let worker = null;
let requestSeq = 0;
let pending = null;
let current = null;
let selectedPart = null;

const viewer = new Viewer($('#viewer'), { onPick: (id) => selectPart(id, { scroll: true }) });
$('#app-version').textContent = `Sürüm ${APP_VERSION}`;

/* ---------- Durum katmanı ---------- */

function setStatus(text, { error = false } = {}) {
  const el = $('#status');
  if (!text) { el.classList.add('hidden'); return; }
  $('#status-text').textContent = text;
  el.classList.toggle('error', error);
  $('#status-close').classList.toggle('hidden', !error);
  el.classList.remove('hidden');
}
$('#status-close').addEventListener('click', () => setStatus(null));

const designUI = createDesignUI({ viewer, setStatus });

function showError(text) {
  pending = null;
  setStatus(text, { error: true });
  setControlsBusy(false);
}

function setControlsBusy(busy) {
  $('#sample-btn').disabled = busy;
}

/* ---------- STEP okuma (Web Worker) ---------- */

function getWorker() {
  if (worker) return worker;
  worker = new Worker('js/step-worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    worker = null;
    showError('3B motoru yüklenemedi. İnternet bağlantını kontrol edip tekrar dene (motor jsDelivr CDN üzerinden gelir).');
  };
  return worker;
}

function loadBuffer(buffer, fileName, sizeBytes) {
  const id = ++requestSeq;
  pending = { id, fileName, sizeBytes, t0: performance.now() };
  setControlsBusy(true);
  setStatus(STAGE_TEXT.engine);
  getWorker().postMessage({ id, buffer }, [buffer]);
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (!pending || msg.id !== pending.id) return;
  if (msg.type === 'progress') {
    let text = STAGE_TEXT[msg.stage] || '';
    if (msg.stage === 'parse' && pending.sizeBytes > LARGE_FILE_MB * 1024 * 1024) {
      text += ' Büyük dosya, biraz sürebilir.';
    }
    setStatus(text);
    return;
  }
  if (msg.type === 'error') { showError(msg.message); return; }
  if (msg.type === 'result') {
    setStatus('Analiz ediliyor…');
    setTimeout(() => finishLoad(msg), 30);
  }
}

function finishLoad(msg) {
  const job = pending;
  pending = null;
  try {
    const analysis = analyzeAssembly(msg.root, msg.meshes);
    selectedPart = null;
    viewer.setModel(msg.meshes, analysis);
    current = {
      fileName: job.fileName,
      sizeBytes: job.sizeBytes,
      seconds: (performance.now() - job.t0) / 1000,
      analysis,
    };
    $('#empty-hint').classList.add('hidden');
    renderSummary(current);
    renderParts(current);
    setStatus(null);
    designUI.setAnalysis(current).catch((err) => {
      console.error(err);
      setStatus('Tasarım paneli açılamadı: ' + err.message, { error: true });
    });
  } catch (err) {
    console.error(err);
    showError('Model analiz edilemedi: ' + err.message);
    return;
  }
  setControlsBusy(false);
}

/* ---------- Dosya girişi ---------- */

function handleFile(file) {
  if (!file) return;
  if (!/\.(step|stp)$/i.test(file.name)) {
    showError(`"${file.name}" bir STEP dosyası değil. Lütfen .step veya .stp uzantılı dosya seç.`);
    return;
  }
  file.arrayBuffer()
    .then((buf) => loadBuffer(buf, file.name, file.size))
    .catch(() => showError('Dosya okunamadı.'));
}

$('#file-input').addEventListener('change', (e) => {
  handleFile(e.target.files[0]);
  e.target.value = '';
});

$('#sample-btn').addEventListener('click', async () => {
  setControlsBusy(true);
  setStatus('Örnek kart indiriliyor…');
  try {
    const res = await fetch(SAMPLE_URL);
    if (!res.ok) throw new Error(res.status);
    const buf = await res.arrayBuffer();
    loadBuffer(buf, 'ornek-kart.step', buf.byteLength);
  } catch {
    showError('Örnek dosya indirilemedi.');
  }
});

// Pencerenin her yerine sürükle-bırak
let dragDepth = 0;
const overlay = $('#drop-overlay');
const dropzone = $('#dropzone');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  overlay.classList.remove('hidden');
  dropzone.classList.add('drag');
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) { overlay.classList.add('hidden'); dropzone.classList.remove('drag'); }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.add('hidden');
  dropzone.classList.remove('drag');
  handleFile(e.dataTransfer.files[0]);
});

/* ---------- Görünüm araç çubuğu ---------- */

document.querySelectorAll('[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => viewer.setView(btn.dataset.view));
});
$('#guides-btn').addEventListener('click', (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  e.currentTarget.setAttribute('aria-pressed', String(on));
  viewer.setGuidesVisible(on);
});

/* ---------- Özet paneli ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stat(label, value, sub = '', cls = '') {
  return `<div class="stat ${cls}"><div class="label">${esc(label)}</div>` +
    `<div class="value">${value}</div>${sub ? `<div class="sub" title="${esc(sub)}">${esc(sub)}</div>` : ''}</div>`;
}

const mmv = (v) => `${fmt(v)} <span class="unit">mm</span>`;

function renderSummary({ fileName, sizeBytes, seconds, analysis: a }) {
  const el = $('#summary-panel');
  const sizeMb = sizeBytes / (1024 * 1024);
  let html = `<div class="file-line"><span class="file-name" title="${esc(fileName)}">${esc(fileName)}</span>` +
    `<span class="muted small">${sizeMb < 1 ? int.format(Math.round(sizeBytes / 1024)) + ' KB' : fmt(sizeMb) + ' MB'} · ${fmt(seconds)} sn</span></div>`;

  html += '<div class="stats">';
  if (a.board) {
    const b = a.board;
    html += stat('PCB ölçüsü (sınır kutusu)',
      `${fmt(b.length)} × ${fmt(b.width)} × ${fmt(b.thickness)} <span class="unit">mm</span>`,
      `${b.axes.u} × ${b.axes.v} × kalınlık (${b.axes.n}) · tespit: ${b.detectedBy.join(' + ')} · "${b.name}"`, 'wide');
    html += stat('Üst yüzeyden en yüksek', mmv(a.maxAbove.value), a.maxAbove.name || 'üstte bileşen yok');
    html += stat('Alt yüzeyden taşan', mmv(a.maxBelow.value), a.maxBelow.name || 'altta taşan yok');
    html += stat('Bileşen zarfı (iç hacim ihtiyacı)',
      `${fmt(a.envelope.length)} × ${fmt(a.envelope.width)} × ${fmt(a.envelope.height)} <span class="unit">mm</span>`,
      'Kart + tüm bileşenler, taşan konnektörler dahil. Boşluk/et kalınlığı M1\'de eklenecek.', 'wide accent');
    html += stat('Bileşen', `${int.format(a.partCount - 1)}`, `üst ${a.counts.top} · alt ${a.counts.bottom}`);
    html += stat('Kenarda / taşan', `${a.counts.edge} <span class="unit">/ ${a.counts.overhang}</span>`, 'konnektör adayı');
    const mount = (a.holes || []).filter((h) => h.mount);
    const sizes = [...new Set(mount.map((h) => 'Ø' + fmt(h.d)))].join(', ');
    const pinHoles = (a.holes || []).length - mount.length;
    html += stat('Montaj deliği', `${mount.length}`,
      mount.length ? `${sizes}${pinHoles ? ` · ${pinHoles} pin deliği ayrıca` : ''}` : 'kart gövdesinde bulunamadı', 'wide');
  } else {
    const s = a.assemblySize;
    html += stat('Montaj ölçüsü (sınır kutusu)', `${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])} <span class="unit">mm</span>`, 'X × Y × Z', 'wide accent');
    html += stat('Parça', int.format(a.partCount), `${int.format(a.triangleCount)} üçgen`);
  }
  html += '</div>';

  const notes = [...a.warnings];
  if (a.board) {
    notes.push({ level: 'info', text: `Kenar eşiği ${fmt(a.options.edgeMargin)} mm. Kenarda veya kart dışına taşan bileşenler, M3'te port açıklıklarının kaynağı olacak.` });
    notes.push({ level: 'info', text: 'Kart sınırı gerçek kontur değil, sınır kutusu olarak alındı. Dikdörtgen olmayan kartlarda fark olabilir.' });
  }
  if (notes.length) {
    html += '<ul class="notes">' + notes.map((n) => `<li class="note ${n.level === 'warn' ? 'warn' : ''}">${esc(n.text)}</li>`).join('') + '</ul>';
  }
  html += '<div class="row"><button type="button" class="btn" id="report-btn">Analiz raporunu indir (JSON)</button></div>';

  el.innerHTML = '<h2 class="panel-title">Analiz</h2>' + html;
  el.classList.remove('hidden');
  $('#report-btn').addEventListener('click', downloadReport);
}

/* ---------- Bileşen tablosu ---------- */

const SIDE_TEXT = { top: 'üst', bottom: 'alt', board: 'PCB' };

function edgeText(p) {
  if (!p.edges.length) return '';
  const parts = p.edges.map((e) => (e.kind === 'overhang' ? `${e.side} taşma ${fmt(e.value)}` : `${e.side} kenarda`));
  return `<span class="pill edge" title="${esc(parts.join(', '))}">${esc(p.edges.map((e) => e.side).join(' '))}</span>`;
}

function renderParts({ analysis: a }) {
  const body = $('#parts-body');
  const rows = [...a.parts].sort((x, y) => {
    if (x.isBoard !== y.isBoard) return x.isBoard ? -1 : 1;
    return y.height - x.height;
  });
  body.innerHTML = rows.map((p) => {
    const side = p.side ? `<span class="pill ${p.isBoard ? 'board' : ''}">${SIDE_TEXT[p.side]}</span>` : '';
    const height = p.isBoard ? fmt(a.board.thickness) : (p.side ? fmt(p.height) : '–');
    const title = p.isBoard ? 'Kart kalınlığı' : `Üste ${fmt(p.above)} mm, alta ${fmt(p.below)} mm`;
    return `<tr data-id="${p.id}"><td class="name" title="${esc(p.name)}">${esc(p.name)}</td>` +
      `<td>${side}</td><td class="num" title="${esc(title)}">${height}</td><td>${edgeText(p)}</td></tr>`;
  }).join('');
  $('#parts-count').textContent = `${int.format(a.partCount)} parça`;
  $('#parts-panel').classList.remove('hidden');

  body.querySelectorAll('tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    tr.addEventListener('mouseenter', () => viewer.highlight(id));
    tr.addEventListener('mouseleave', () => viewer.highlight(selectedPart));
    tr.addEventListener('click', () => selectPart(selectedPart === id ? null : id));
  });
}

function selectPart(id, { scroll = false } = {}) {
  selectedPart = id ?? null;
  viewer.highlight(selectedPart);
  document.querySelectorAll('#parts-body tr').forEach((tr) => {
    const on = Number(tr.dataset.id) === selectedPart;
    tr.classList.toggle('sel', on);
    if (on && scroll) tr.scrollIntoView({ block: 'nearest' });
  });
}

/* ---------- Rapor ---------- */

function downloadReport() {
  if (!current) return;
  const a = current.analysis;
  const r3 = (arr) => arr.map((v) => Math.round(v * 1000) / 1000);
  const report = {
    app: 'Ikra Enclosure Engine',
    version: APP_VERSION,
    file: current.fileName,
    createdAt: new Date().toISOString(),
    units: 'mm',
    assemblySize: r3(a.assemblySize),
    board: a.board && { ...a.board, box: { min: r3(a.board.box.min), max: r3(a.board.box.max) } },
    maxAbove: a.maxAbove,
    maxBelow: a.maxBelow,
    envelope: a.envelope && { ...a.envelope, box: { min: r3(a.envelope.box.min), max: r3(a.envelope.box.max) } },
    counts: a.counts,
    holes: (a.holes || []).map((h) => ({ x: h.x, y: h.y, d: h.d, mount: h.mount, occupiedBy: h.occupiedBy })),
    warnings: a.warnings,
    design: designUI.reportSection(),
    parts: a.parts.map((p) => ({
      name: p.name,
      side: p.side,
      height: p.height,
      above: p.above,
      below: p.below,
      edges: p.edges,
      box: { min: r3(p.box.min), max: r3(p.box.max) },
    })),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = current.fileName.replace(/\.(step|stp)$/i, '') + '.ikra-analiz.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
