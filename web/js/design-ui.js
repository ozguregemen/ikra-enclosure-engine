/*
 * Tasarım paneli (M1): süreç/malzeme seçimi, parametreler, muhafaza üretimi ve indirme.
 * Hesap design.js'te, katı model üretimi cad-worker.js'te yapılır.
 */
import { computeDesign, defaultParams, paramHint, pickScrew, LID_MODES, PARAM_FIELDS } from './design.js';

const $ = (sel) => document.querySelector(sel);
const nf2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const f2 = (v) => nf2.format(v);
const AUTO_REBUILD_MS = 450;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const inputText = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
const parseInput = (s) => Number(String(s).trim().replace(',', '.'));
const dims = (a, b, c) => `${f2(a)} × ${f2(b)} × ${f2(c)} <span class="unit">mm</span>`;

function stat(label, value, sub = '', cls = '') {
  return `<div class="stat ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div>` +
    (sub ? `<div class="sub" title="${esc(sub)}">${esc(sub)}</div>` : '') + '</div>';
}

function download(buffer, fileName, type) {
  const url = URL.createObjectURL(new Blob([buffer], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function createDesignUI({ viewer, setStatus }) {
  const state = {
    index: null,
    rulesCache: new Map(),
    process: 'fdm',
    material: 'pla',
    rules: null,
    analysis: null,
    fileName: '',
    params: null,
    design: null,
    worker: null,
    seq: 0,
    pendingId: null,
    result: null,
    generated: false,
    autoTimer: null,
    firstBuild: true,
    fasteners: null,
    lidMode: 'screw',
    selectedHoles: new Set(),
  };

  /* ---------- Kural dosyaları ---------- */

  async function loadIndex() {
    if (!state.index) {
      const res = await fetch('rules/index.json');
      if (!res.ok) throw new Error('Kural listesi yüklenemedi.');
      state.index = await res.json();
    }
    if (!state.fasteners) {
      const res = await fetch('rules/fasteners.json');
      if (!res.ok) throw new Error('Vida tablosu yüklenemedi.');
      state.fasteners = await res.json();
    }
    return state.index;
  }

  async function loadRules() {
    const proc = state.index.processes.find((p) => p.id === state.process);
    const mat = proc.materials.find((m) => m.id === state.material) || proc.materials[0];
    state.material = mat.id;
    if (!state.rulesCache.has(mat.file)) {
      const res = await fetch('rules/' + mat.file);
      if (!res.ok) throw new Error(`Kural dosyası yüklenemedi: ${mat.file}`);
      state.rulesCache.set(mat.file, await res.json());
    }
    state.rules = state.rulesCache.get(mat.file);
  }

  /* ---------- Süreç ve malzeme ---------- */

  function renderSelectors() {
    $('#process-seg').innerHTML = state.index.processes.map((p) =>
      `<button type="button" role="radio" data-process="${p.id}" aria-checked="${p.id === state.process}">${esc(p.label)}</button>`).join('');
    const proc = state.index.processes.find((p) => p.id === state.process);
    $('#material-chips').innerHTML = proc.materials.map((m) =>
      `<button type="button" class="chip" role="radio" data-material="${m.id}" aria-checked="${m.id === state.material}">${esc(m.label)}</button>`).join('');
    $('#rule-notes').innerHTML = (state.rules?.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
  }

  $('#process-seg').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-process]');
    if (!btn || btn.dataset.process === state.process) return;
    state.process = btn.dataset.process;
    state.material = state.index.processes.find((p) => p.id === state.process).materials[0].id;
    await applyRules();
  });
  $('#material-chips').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-material]');
    if (!btn || btn.dataset.material === state.material) return;
    state.material = btn.dataset.material;
    await applyRules();
  });

  const designOptions = () => ({ fasteners: state.fasteners, lidMode: state.lidMode, selectedHoles: state.selectedHoles });
  const currentDefaults = () => defaultParams(state.analysis, state.rules, designOptions());

  /** Bağlantı seçimi değişince, kullanıcı elle değiştirmediyse PCB altı yüksekliği yeni varsayılana çek */
  function refreshAutoStandoff(prevDefaults) {
    if (Math.abs(state.params.standoffHeight - prevDefaults.standoffHeight) < 1e-9) {
      state.params.standoffHeight = currentDefaults().standoffHeight;
    }
    renderParams();
  }

  async function applyRules() {
    try {
      await loadRules();
    } catch (err) {
      setStatus(err.message, { error: true });
      return;
    }
    state.params = currentDefaults();
    renderSelectors();
    renderParams();
    update();
  }

  /* ---------- Parametreler ---------- */

  function renderParams() {
    const defaults = currentDefaults();
    $('#params').innerHTML = PARAM_FIELDS.map((fld) => `
      <div class="param">
        <label for="p-${fld.key}">${esc(fld.label)}</label>
        <div class="input-wrap">
          <input id="p-${fld.key}" data-key="${fld.key}" type="text" inputmode="decimal" autocomplete="off"
            value="${inputText(state.params[fld.key])}" class="${Math.abs(state.params[fld.key] - defaults[fld.key]) > 1e-9 ? 'changed' : ''}">
          <span class="unit">mm</span>
        </div>
        <span class="hint muted">${esc(paramHint(fld.key, state.rules, state.analysis, defaults))}</span>
      </div>`).join('');
  }

  $('#params').addEventListener('input', (e) => {
    const input = e.target.closest('input[data-key]');
    if (!input) return;
    const key = input.dataset.key;
    state.params[key] = parseInput(input.value);
    const def = currentDefaults()[key];
    input.classList.toggle('changed', !(Math.abs(state.params[key] - def) < 1e-9));
    update();
  });
  $('#dfm-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fix-key]');
    if (!btn || !state.params) return;
    state.params[btn.dataset.fixKey] = Number(btn.dataset.fixValue);
    renderParams();
    update();
  });
  $('#params-reset').addEventListener('click', () => {
    if (!state.rules) return;
    state.params = currentDefaults();
    renderParams();
    update();
  });

  /* ---------- Bağlantı: delikler ve kapak modu ---------- */

  function renderFastening() {
    const holes = state.analysis.holes || [];
    const mount = holes.map((h, i) => ({ ...h, index: i })).filter((h) => h.mount);
    const others = holes.length - mount.length;
    $('#holes-summary').textContent = holes.length
      ? `${mount.length} montaj deliği${others ? ` · ${others} pin deliği yok sayıldı` : ''}`
      : '';
    $('#hole-list').innerHTML = mount.length
      ? mount.map((h, k) => {
        const s = state.fasteners ? pickScrew(h.d, state.fasteners.screws) : null;
        return `<label class="hole-row"><input type="checkbox" data-hole="${h.index}" ${state.selectedHoles.has(h.index) ? 'checked' : ''}>` +
          `<span>Delik ${k + 1} · Ø${f2(h.d)}${s ? ` · ${s.size}` : ''}</span>` +
          `<span class="pos">${f2(h.x)}; ${f2(h.y)}</span></label>`;
      }).join('')
      : '<div class="hole-empty">Kartta montaj deliği bulunamadı. PCB tutucu üretilemez; kart kenarı tutucuları sonraki sürümlerde.</div>';
    $('#lid-mode').innerHTML = LID_MODES.map((m) =>
      `<button type="button" role="radio" data-lid="${m.id}" aria-checked="${m.id === state.lidMode}">${esc(m.label)}</button>`).join('');
  }

  $('#hole-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-hole]');
    if (!cb) return;
    const idx = Number(cb.dataset.hole);
    const prev = currentDefaults();
    if (cb.checked) state.selectedHoles.add(idx); else state.selectedHoles.delete(idx);
    refreshAutoStandoff(prev);
    update();
  });
  $('#lid-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lid]');
    if (!btn || btn.dataset.lid === state.lidMode) return;
    const prev = currentDefaults();
    state.lidMode = btn.dataset.lid;
    renderFastening();
    refreshAutoStandoff(prev);
    update();
  });

  /* ---------- Hesap ve özet ---------- */

  function update() {
    if (!state.analysis || !state.rules) return;
    const d = computeDesign(state.analysis, state.rules, state.params, {
      fasteners: state.fasteners,
      lidMode: state.lidMode,
      selectedHoles: state.selectedHoles,
    });
    state.design = d;
    const bom = d.bom || [];
    $('#bom-title').classList.toggle('hidden', !bom.length);
    $('#bom-list').innerHTML = bom.map((line) => `<li>${esc(line)}</li>`).join('');

    const errEl = $('#design-error');
    errEl.classList.toggle('hidden', !d.error);
    errEl.textContent = d.error || '';
    $('#generate-btn').disabled = !d.ok;

    renderStats();
    $('#dfm-list').innerHTML = (d.checks || []).map((c) =>
      `<li class="note ${c.level === 'info' ? '' : c.level}"><span>${esc(c.text)}` +
      (c.fix ? ` <button type="button" class="link-btn" data-fix-key="${esc(c.fix.key)}" data-fix-value="${c.fix.value}">${esc(c.fix.label)}</button>` : '') +
      '</span></li>').join('');

    if (state.generated) {
      $('#stale-tag').classList.toggle('hidden', false);
      clearTimeout(state.autoTimer);
      if (d.ok) state.autoTimer = setTimeout(generate, AUTO_REBUILD_MS);
    }
  }

  function renderStats() {
    const d = state.design;
    if (!d || !d.outer) { $('#design-stats').innerHTML = ''; return; }
    let mass = '–';
    let massSub = 'oluşturunca hesaplanır';
    if (state.result) {
      const v = state.result.volumes;
      const grams = ((v.base + v.lid) / 1000) * state.rules.density_g_cm3;
      mass = `${nf0.format(grams)} <span class="unit">g</span>`;
      massSub = `gövde ${nf1.format(v.base / 1000)} + kapak ${nf1.format(v.lid / 1000)} cm³ · ${state.rules.label}`;
    }
    $('#design-stats').innerHTML =
      stat('Dış ölçü (U × G × Y)', dims(d.outer.L, d.outer.W, d.outer.H), `${state.rules.label} · ${processLabel()}`, 'wide accent') +
      stat('İç cep', dims(d.cavity.L, d.cavity.W, d.cavity.H), 'PCB + boşluklar') +
      stat('Et / taban / kapak', `${f2(d.params.wall)} <span class="unit">mm</span>`, `kapak dili ${f2(d.params.lipT)} mm, boşluk ${f2(d.params.fit)} mm`) +
      stat('Tahmini kütle', mass, massSub) +
      stat('Kapak dili', `${d.lipBars.length} <span class="unit">/ 4 kenar</span>`, d.lipRemoved.length ? `kaldırılan: ${d.lipRemoved.map((x) => x.side).join(', ')}` : 'tüm kenarlarda') +
      stat('Bağlantı', `${d.screws.length} <span class="unit">vida</span>`,
        d.standoffs.length ? `${d.standoffs.length} standoff · ${d.lidTubes.length} kapak borusu` : 'montaj deliği yok');
  }

  const processLabel = () => state.index.processes.find((p) => p.id === state.process).label;

  /* ---------- Katı model üretimi ---------- */

  function getWorker() {
    if (state.worker) return state.worker;
    const w = new Worker('js/cad-worker.js', { type: 'module' });
    w.onmessage = onWorkerMessage;
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      state.worker = null;
      state.pendingId = null;
      setBusy(false);
      setStatus('CAD çekirdeği yüklenemedi. İnternet bağlantını kontrol edip tekrar dene (jsDelivr CDN).', { error: true });
    };
    state.worker = w;
    return w;
  }

  function setBusy(busy) {
    const btn = $('#generate-btn');
    btn.textContent = busy ? 'Oluşturuluyor…' : (state.generated ? 'Yeniden oluştur' : 'Muhafaza oluştur');
    btn.disabled = busy || !(state.design && state.design.ok);
  }

  function generate() {
    clearTimeout(state.autoTimer);
    const d = state.design;
    if (!d || !d.ok) return;
    const id = ++state.seq;
    state.pendingId = id;
    state.pendingDesign = d;
    setBusy(true);
    const stem = state.fileName.replace(/\.(step|stp)$/i, '') || 'ikra';
    getWorker().postMessage({ id, geometry: d.geometry, names: { base: `${stem}_govde`, lid: `${stem}_kapak` } });
  }

  function onWorkerMessage(ev) {
    const msg = ev.data;
    if (msg.id !== state.pendingId) return;
    if (msg.type === 'progress') {
      if (msg.stage === 'engine' && state.firstBuild) setStatus('CAD çekirdeği yükleniyor… (ilk seferde ~6 MB)');
      if (msg.stage === 'build' && state.firstBuild) setStatus('Muhafaza oluşturuluyor…');
      return;
    }
    state.pendingId = null;
    if (msg.type === 'error') {
      setBusy(false);
      setStatus('Muhafaza oluşturulamadı: ' + msg.message, { error: true });
      return;
    }
    const d = state.pendingDesign;
    state.result = { ...msg, design: d };
    state.generated = true;
    const screws = d.screws.map((s) => ({
      x: s.x, y: s.y, d: s.d, headD: s.head_d, headH: s.head_h, length: s.length, lid: s.lid,
      z: s.lid ? d.geometry.zTop : state.analysis.board.top,
    }));
    viewer.setEnclosure(msg.meshes, { explodeOffset: Math.max(d.outer.H * 0.75, 10), screws });
    if (state.firstBuild) viewer.setView('iso');
    state.firstBuild = false;
    $('#enc-toggles').classList.remove('hidden');
    $('#downloads').classList.remove('hidden');
    $('#generate-hint').textContent = `${nf0.format(msg.buildMs)} ms'de üretildi · parametre değişince kendiliğinden güncellenir`;
    $('#stale-tag').classList.toggle('hidden', state.design === d);
    setStatus(null);
    setBusy(false);
    renderStats();
  }

  $('#generate-btn').addEventListener('click', generate);

  /* ---------- İndirme ---------- */

  const fileStem = () => (state.fileName.replace(/\.(step|stp)$/i, '') || 'ikra');
  $('#dl-step').addEventListener('click', () => {
    if (!state.result) return;
    download(state.result.files.step, `${fileStem()}_ikra_${state.process}-${state.material}.step`, 'model/step');
  });
  $('#dl-stl-base').addEventListener('click', () => {
    if (state.result) download(state.result.files.stlBase, `${fileStem()}_govde.stl`, 'model/stl');
  });
  $('#dl-stl-lid').addEventListener('click', () => {
    if (state.result) download(state.result.files.stlLid, `${fileStem()}_kapak.stl`, 'model/stl');
  });

  /* ---------- 3B görünüm anahtarları ---------- */

  document.querySelectorAll('[data-enc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const on = !btn.classList.contains('on');
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      viewer.setEnclosureOptions({ [btn.dataset.enc]: on });
    });
  });

  /* ---------- Dış arayüz ---------- */

  async function setAnalysis(current) {
    clearTimeout(state.autoTimer);
    state.analysis = current.analysis;
    state.fileName = current.fileName;
    state.generated = false;
    state.result = null;
    state.pendingId = null;
    state.firstBuild = true;
    $('#enc-toggles').classList.add('hidden');
    $('#downloads').classList.add('hidden');
    $('#stale-tag').classList.add('hidden');
    $('#generate-hint').textContent = 'İlk seferde CAD çekirdeği (~6 MB) indirilir.';
    setBusy(false);
    try {
      await loadIndex();
      await loadRules();
    } catch (err) {
      setStatus(err.message, { error: true });
      return;
    }
    $('#design-panel').classList.remove('hidden');
    state.selectedHoles = new Set((state.analysis.holes || []).map((h, i) => (h.mount ? i : -1)).filter((i) => i >= 0));
    state.lidMode = 'screw';
    state.params = currentDefaults();
    renderSelectors();
    renderParams();
    renderFastening();
    update();
    setBusy(false);
  }

  function reportSection() {
    const d = state.design;
    if (!d || !d.outer) return null;
    return {
      process: state.process,
      material: state.material,
      rules: state.rules.id,
      params: d.params,
      outer: d.outer,
      cavity: { L: d.cavity.L, W: d.cavity.W, H: d.cavity.H },
      z: d.z,
      lipBars: d.lipBars.map((l) => ({ side: l.side, depth: l.depth })),
      ports: d.ports.map((p) => ({ name: p.name, side: p.side, width: p.width, height: p.height })),
      lidMode: state.lidMode,
      fastening: d.fasteningMethod,
      standoffs: d.standoffs.map((s) => ({ x: s.x, y: s.y, od: s.od, holeD: s.holeD, depth: s.depth, screw: s.screw })),
      lidTubes: d.lidTubes.map((t) => ({ x: t.x, y: t.y, od: t.od, holeD: t.holeD, length: t.length })),
      screws: d.screws.map((s) => ({ size: s.size, length: s.length, engagement: s.engagement, lid: s.lid, x: s.x, y: s.y })),
      bom: d.bom,
      volumes_mm3: state.result ? state.result.volumes : null,
      checks: d.checks,
    };
  }

  return { setAnalysis, reportSection };
}
