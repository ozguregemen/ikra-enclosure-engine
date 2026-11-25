/*
 * Ikra Enclosure Engine — M0 arayüz akışı:
 * STEP yükle → (Web Worker'da OpenCascade) oku → analiz et → 3B göster + özet.
 */
import { Viewer } from './viewer.js';
import { analyzeAssembly } from './analysis.js';
import { createDesignUI } from './design-ui.js';

const APP_VERSION = '0.16.0 (V1.10)';
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

const viewer = new Viewer($('#viewer'), {
  onPick: (id) => selectPart(id, { scroll: true }),
  cubeContainer: $('#viewcube'),
});
$('#app-version').textContent = `Sürüm ${APP_VERSION}`;

/* ---------- Sekmeler ---------- */

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  for (const id of ['analysis', 'design', 'output']) {
    $(`#tab-${id}`).classList.toggle('hidden', id !== name);
  }
  $('.tab-panels').scrollTop = 0;
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.goto)));

// Tasarım panelinden gelen olaylar: DFM sayıları ve üretim tamamlandı
document.addEventListener('ikra:checks', (e) => {
  const { error = 0, warn = 0 } = e.detail || {};
  const badge = $('#output-badge');
  const chip = $('#dfm-chip');
  const issues = error + warn;
  badge.classList.toggle('hidden', !issues);
  badge.classList.toggle('error', error > 0);
  badge.textContent = issues ? String(issues) : '';
  chip.hidden = false;
  chip.className = `status-chip ${error ? 'error' : warn ? 'warn' : ''}`;
  chip.textContent = error ? `${error} hata${warn ? ` · ${warn} uyarı` : ''}` : warn ? `${warn} uyarı` : 'DFM: sorun yok';
});
document.addEventListener('ikra:built', (e) => {
  if (e.detail && e.detail.first) selectTab('output');
});
$('#dfm-chip').addEventListener('click', () => {
  selectTab('output');
  $('#dfm-anchor').scrollIntoView({ block: 'start' });
});

/* ---------- Görünüm ve kısayollar ---------- */

$('#view-home').addEventListener('click', () => viewer.setView('iso'));
$('#view-fit').addEventListener('click', () => viewer.fit());
const helpDialog = $('#help-dialog');
$('#help-btn').addEventListener('click', () => helpDialog.showModal());
$('#help-close').addEventListener('click', () => helpDialog.close());

const KEY_VIEWS = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom' };
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') viewer.fit();
  else if (k === 'h') viewer.setView('iso');
  else if (k === 'g') $('#guides-btn').click();
  else if (k === 't') $('#toolbox-btn').click();
  else if (KEY_VIEWS[k]) viewer.setView(KEY_VIEWS[k]);
  else return;
  e.preventDefault();
});

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
  document.querySelectorAll('[data-action="sample"]').forEach((b) => { b.disabled = busy; });
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

function loadBuffer(buffer, fileName, sizeBytes, project = null) {
  const id = ++requestSeq;
  // İşçiye aktarılan tampon boşalır: projeye gömmek ve kimlik (SHA-256) için kopya tutulur
  const bytes = buffer.slice(0);
  pending = { id, fileName, sizeBytes, t0: performance.now(), bytes, project };
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
      bytes: job.bytes,
      sha256: null,
    };
    const loaded = current;
    const hashReady = sha256Hex(job.bytes).then((h) => { loaded.sha256 = h; return h; }).catch(() => null);
    $('#empty-hint').classList.add('hidden');
    $('#start-panel').classList.add('hidden');
    $('#work').classList.remove('hidden');
    $('#sidebar').classList.add('has-work');
    renderSummary(current);
    renderParts(current);
    selectTab('analysis');
    setStatus(null);
    designUI.setAnalysis(current)
      .then(async () => {
        $('#save-btn').disabled = false;
        // Proje dosyasıyla açıldıysa ya da bekleyen bir proje bu kartı bekliyorsa ayarları uygula
        const proj = job.project || pendingProject;
        if (!proj) { $('#project-name').textContent = ''; return; }
        pendingProject = null;
        const h = await hashReady;
        const mismatch = proj.step?.sha256 && h && proj.step.sha256 !== h;
        const warnings = await designUI.importState(proj.design);
        if (mismatch) warnings.unshift(`Yüklenen STEP projedekinden farklı (${proj.step.fileName}); delik ve port seçimleri uyuşmayabilir.`);
        $('#project-name').textContent = proj.name || '';
        selectTab('design');
        setStatus(`Proje açıldı: ${proj.name || job.fileName}${warnings.length ? ' — ' + warnings.join(' ') : ''}`, { error: warnings.length > 0 });
        if (!warnings.length) setTimeout(() => setStatus(null), 2600);
      })
      .catch((err) => {
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
  if (/\.(json|ikra)$/i.test(file.name)) { openProject(file); return; }
  if (!/\.(step|stp)$/i.test(file.name)) {
    showError(`"${file.name}" bir STEP ya da Ikra proje dosyası değil. Lütfen .step / .stp ya da .ikra.json dosyası seç.`);
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

async function loadSample() {
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
}
document.querySelectorAll('[data-action="sample"]').forEach((b) => b.addEventListener('click', loadSample));

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

/* ---------- Proje kaydet / aç (.ikra.json) ---------- */

const PROJECT_FORMAT = 'ikra-project';
let pendingProject = null; // STEP'i gömülü olmayan, kartı bekleyen proje

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function bufToBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBuf(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}
const stemOf = (name) => String(name || 'ikra').replace(/\.(step|stp)$/i, '');

const saveDialog = $('#save-dialog');
function openSaveDialog() {
  if (!current || !designUI.hasDesign()) { setStatus('Önce bir kart yükle.', { error: true }); return; }
  $('#save-name').value = $('#project-name').textContent || stemOf(current.fileName);
  $('#save-step-size').textContent = `${(current.sizeBytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  saveDialog.showModal();
}

async function saveProject() {
  const name = ($('#save-name').value || '').trim() || stemOf(current.fileName);
  const embed = $('#save-embed').checked;
  const design = designUI.exportState();
  if (!design) return;
  const hash = current.sha256 || (current.bytes ? await sha256Hex(current.bytes) : null);
  const project = {
    format: PROJECT_FORMAT,
    version: 1,
    app: APP_VERSION,
    name,
    saved: new Date().toISOString(),
    step: { fileName: current.fileName, size: current.sizeBytes, sha256: hash, ...(embed && current.bytes ? { data: bufToBase64(current.bytes) } : {}) },
    design,
  };
  const blob = new Blob([JSON.stringify(project, null, embed ? 0 : 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.ikra.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  $('#project-name').textContent = name;
  saveDialog.close();
  setStatus(`Proje kaydedildi: ${a.download}${embed ? ' (STEP içinde)' : ' (STEP ayrı tutulmalı)'}`);
  setTimeout(() => setStatus(null), 2600);
}

async function openProject(file) {
  let proj;
  try {
    proj = JSON.parse(await file.text());
  } catch {
    showError(`"${file.name}" okunamadı: geçerli bir proje dosyası değil.`);
    return;
  }
  if (proj?.format !== PROJECT_FORMAT || !proj.design) {
    showError(`"${file.name}" bir Ikra proje dosyası değil.`);
    return;
  }
  if (proj.step?.data) {
    try {
      const buf = base64ToBuf(proj.step.data);
      loadBuffer(buf, proj.step.fileName || `${proj.name || 'proje'}.step`, buf.byteLength, proj);
    } catch {
      showError('Projedeki STEP verisi bozuk.');
    }
    return;
  }
  // STEP gömülü değil: yüklü kart aynıysa hemen uygula, değilse kartı bekle
  if (current && proj.step?.sha256 && current.sha256 === proj.step.sha256) {
    const warnings = await designUI.importState(proj.design);
    $('#project-name').textContent = proj.name || '';
    selectTab('design');
    setStatus(`Proje açıldı: ${proj.name}${warnings.length ? ' — ' + warnings.join(' ') : ''}`, { error: warnings.length > 0 });
    if (!warnings.length) setTimeout(() => setStatus(null), 2600);
    return;
  }
  pendingProject = proj;
  setStatus(`Proje "${proj.name || file.name}" hazır: kartın STEP dosyasını (${proj.step?.fileName || 'aynı kart'}) yükle, ayarlar otomatik uygulanır.`);
}

$('#save-btn').addEventListener('click', openSaveDialog);
$('#open-btn').addEventListener('click', () => $('#file-input').click());
$('#save-cancel').addEventListener('click', () => saveDialog.close());
$('#save-ok').addEventListener('click', (e) => { e.preventDefault(); saveProject().catch((err) => setStatus('Proje kaydedilemedi: ' + err.message, { error: true })); });
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); if (!document.querySelector('dialog[open]')) openSaveDialog(); }
  if (k === 'o') { e.preventDefault(); $('#file-input').click(); }
});

/* ---------- Görünüm araç çubuğu ---------- */

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
  $('#file-name').textContent = fileName;
  $('#file-name').title = fileName;
  $('#file-meta').textContent = `${sizeMb < 1 ? int.format(Math.round(sizeBytes / 1024)) + ' KB' : fmt(sizeMb) + ' MB'} · ${fmt(seconds)} sn'de okundu · ${a.partCount} parça`;

  let html = '<div class="stats">';
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

  el.innerHTML = '<h2 class="panel-title">PCB analizi</h2>' + html;
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
