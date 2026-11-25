/*
 * Tasarım paneli (M1): süreç/malzeme seçimi, parametreler, muhafaza üretimi ve indirme.
 * Hesap design.js'te, katı model üretimi cad-worker.js'te yapılır.
 */
import { computeDesign, defaultParams, paramHint, pickScrew, screwTable, libraryTypes, LID_MODES, PARAM_FIELDS } from './design.js';
import { buildSheets, exportPdf } from './drawing.js';
import { createToolbox, headIcon, insertIcon } from './toolbox.js';

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
    portOverrides: new Map(),
    sealingIndex: null,
    sealing: 'none',
    drawingId: null,
    sheets: null,
    sheetIdx: 0,
    toolbox: null, // iso-screws.json
    toolboxUI: null,
    screwSpec: { type: 'iso7045', size: 'auto', length: 'auto', material: 'auto', washer: 'none', washerMaterial: 'match' },
    fmaterials: null, // fastener-materials.json
    inserts: null, // inserts.json
    insertSpec: { type: 'auto', variant: 'auto' },
  };

  /* ---------- Kural dosyaları ---------- */

  async function loadIndex() {
    if (!state.index) {
      const res = await fetch('rules/index.json');
      if (!res.ok) throw new Error('Kural listesi yüklenemedi.');
      state.index = await res.json();
    }
    if (!state.sealingIndex) {
      const res = await fetch('rules/sealing.json');
      if (!res.ok) throw new Error('Sızdırmazlık kuralları yüklenemedi.');
      state.sealingIndex = await res.json();
    }
    await loadToolbox();
    return state.index;
  }

  async function loadToolbox() {
    const getJson = async (url, msg) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(msg);
      return res.json();
    };
    if (!state.toolbox) state.toolbox = await getJson('rules/toolbox/iso-screws.json', 'Toolbox vida kütüphanesi yüklenemedi.');
    if (!state.inserts) state.inserts = await getJson('rules/toolbox/inserts.json', 'Toolbox burç kütüphanesi yüklenemedi.');
    if (!state.fmaterials) state.fmaterials = await getJson('rules/toolbox/fastener-materials.json', 'Bağlantı elemanı malzemeleri yüklenemedi.');
    if (!state.fasteners) state.fasteners = await getJson('rules/fasteners.json', 'Vida tablosu yüklenemedi.');
    if (!state.toolboxUI) {
      state.toolboxUI = createToolbox({
        dialog: $('#toolbox-dialog'),
        libraries: [state.toolbox, state.inserts],
        materials: state.fmaterials.materials,
        fasteners: state.fasteners,
        evaluate: evaluateSpec,
        onApply: (spec, ispec) => setToolboxSpec(spec, ispec),
      });
    }
  }

  const toolboxTypes = () => libraryTypes(state.toolbox, 'screws');
  const washerTypes = () => libraryTypes(state.toolbox, 'washers');
  const insertTypes = () => libraryTypes(state.inserts);

  /** Toolbox seçimini uygula: kullanıcının elle değiştirmediği parametreler yeni vida/burca göre yeniden hesaplanır */
  function setToolboxSpec(spec, ispec = state.insertSpec) {
    const t = toolboxTypes().find((x) => x.id === spec.type);
    const next = { type: spec.type, size: spec.size, length: spec.length, material: spec.material || 'auto', washer: spec.washer || 'none', washerMaterial: spec.washerMaterial || 'match' };
    if (t && next.material !== 'auto' && !(t.materials || []).includes(next.material)) next.material = 'auto';
    if (t && next.size !== 'auto' && !t.sizes[next.size]) next.size = 'auto';
    const nextIns = { type: ispec.type || 'auto', variant: ispec.variant || 'auto' };
    if (!state.analysis || !state.rules || !state.params) {
      state.screwSpec = next;
      state.insertSpec = nextIns;
      renderScrewPick();
      return;
    }
    const prev = currentDefaults();
    state.screwSpec = next;
    state.insertSpec = nextIns;
    refreshAutoParams(prev);
    renderFastening();
    update();
  }
  const setScrewSpec = (spec) => setToolboxSpec(spec, state.insertSpec);

  /**
   * Toolbox penceresinin canlı hesabı: seçilen vida tipine/boyutuna göre otomatik boylu tasarım (boy durumları için)
   * ve tam seçimli tasarım (uygulanınca oluşacak parametrelerle).
   */
  function evaluateSpec(spec, ispec = state.insertSpec) {
    if (!state.analysis || !state.rules || !state.params || !state.analysis.board || state.analysis.board.axes.n !== 'Z') return null;
    const opts = (sp, ip) => ({ ...designOptions(), screwSpec: sp, insertSpec: ip });
    const prev = currentDefaults();
    const adapt = (sp, ip) => {
      const next = defaultParams(state.analysis, state.rules, opts(sp, ip));
      const p = { ...state.params };
      for (const key of Object.keys(next)) if (Math.abs(p[key] - prev[key]) < 1e-9) p[key] = next[key];
      return p;
    };
    const autoSpec = { ...spec, length: 'auto' };
    const auto = computeDesign(state.analysis, state.rules, adapt(autoSpec, ispec), opts(autoSpec, ispec));
    const sel = spec.length === 'auto' ? auto : computeDesign(state.analysis, state.rules, adapt(spec, ispec), opts(spec, ispec));
    return {
      auto,
      sel,
      standoffAuto: Math.abs(state.params.standoffHeight - prev.standoffHeight) < 1e-9,
      standoffNow: state.params.standoffHeight,
      ruleMethod: state.rules.fastening || 'insert',
      helicoilD: state.rules.helicoil_length_d || 2,
    };
  }

  function openToolbox(view = 'screw') {
    loadToolbox()
      .then(() => state.toolboxUI.open(state.screwSpec, state.insertSpec, view))
      .catch((err) => setStatus(err.message, { error: true }));
  }
  $('#toolbox-btn').addEventListener('click', () => openToolbox('screw'));
  $('#screw-pick').addEventListener('click', () => openToolbox('screw'));
  $('#insert-pick').addEventListener('click', () => openToolbox('insert'));

  /** Bağlantı kartındaki gövde tarafı satırı: burç / kılavuz / ön delik */
  function renderInsertPick(d = state.design) {
    const st = d?.standoffs?.[0];
    const m = d?.fasteningMethod;
    const ins = st?.insert;
    const kind = m === 'helicoil' ? 'helicoil' : m === 'insert' ? 'heatset' : 'tapped';
    $('#insert-pick-icon').innerHTML = insertIcon(kind);
    $('#insert-pick-title').textContent = !st ? 'Gövde tarafı'
      : ins ? (ins.kind === 'helicoil' ? `Helicoil ${st.screw} × ${ins.id.replace('.', ',')} (${String(ins.L).replace('.', ',')} mm)` : ins.id)
        : m === 'self_tap' ? `Ön delik Ø${String(st.holeD).replace('.', ',')}` : m === 'insert' ? `${st.screw} insert` : `${st.screw} kılavuz · Ø${String(st.holeD).replace('.', ',')}`;
    const how = { insert: 'Isıyla gömülen insert', helicoil: 'Tel dişli burç', tapped: 'Doğrudan diş', self_tap: 'Sac vidası dişini kendisi açar' }[m] || '';
    $('#insert-pick-sub').textContent = `${how}${state.insertSpec.type === 'auto' ? ' · kural dosyasına göre' : ' · elle seçildi'}`;
  }

  /** Bağlantı kartındaki vida satırı: seçili tip, etkin boyut × boy */
  function renderScrewPick(d = state.design) {
    const t = toolboxTypes().find((x) => x.id === state.screwSpec.type);
    if (!t) return;
    $('#screw-pick-icon').innerHTML = headIcon(t.head);
    const groups = new Map();
    for (const s of d?.screws || []) {
      const key = `${s.size}×${s.length === null || s.length === undefined ? '?' : String(s.length).replace('.', ',')}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const list = [...groups.keys()];
    const mat = d?.screwMaterial?.tag;
    $('#screw-pick-title').textContent = (list.length ? `${t.code} · ${list.join(', ').replace(/×/g, ' × ')}` : t.code) + (mat ? ` ${mat}` : '');
    const parts = [t.short];
    if (d?.washer) parts.push(`${d.washer.code} pul${d.washer.material ? ' ' + d.washer.material : ''}`);
    const tq = d?.torque?.lid || d?.torque?.pcb;
    if (tq) parts.push(`${String(tq.T).replace('.', ',')} N·m`);
    const auto = [state.screwSpec.size === 'auto' ? 'boyut' : null, state.screwSpec.length === 'auto' ? 'boy' : null].filter(Boolean);
    if (auto.length) parts.push(`${auto.join(' ve ')} otomatik`);
    $('#screw-pick-sub').textContent = parts.join(' · ');
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

  const sealingLevel = () => (state.sealingIndex?.levels || []).find((l) => l.id === state.sealing) || null;
  const designOptions = () => ({
    fasteners: state.fasteners,
    lidMode: state.lidMode,
    selectedHoles: state.selectedHoles,
    portOverrides: state.portOverrides,
    sealing: sealingLevel(),
    toolbox: { types: toolboxTypes(), inserts: insertTypes(), washers: washerTypes(), materials: state.fmaterials?.materials || [], model: state.fmaterials?.model || null },
    screwSpec: state.screwSpec,
    insertSpec: state.insertSpec,
  });
  const currentDefaults = () => defaultParams(state.analysis, state.rules, designOptions());

  /** Bağlantı/IP seçimi değişince, kullanıcının elle değiştirmediği parametreleri yeni varsayılana çek */
  function refreshAutoParams(prevDefaults) {
    const next = currentDefaults();
    for (const key of Object.keys(next)) {
      if (Math.abs(state.params[key] - prevDefaults[key]) < 1e-9) state.params[key] = next[key];
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
    const key = btn.dataset.fixKey;
    const value = btn.dataset.fixValue;
    // Toolbox önerileri: vida tipi / boyutu / boyu
    if (key === 'screwType') { setScrewSpec({ ...state.screwSpec, type: value, length: 'auto' }); return; }
    if (key === 'screwSize') { setScrewSpec({ ...state.screwSpec, size: value, length: 'auto' }); return; }
    if (key === 'screwLength') { setScrewSpec({ ...state.screwSpec, length: Number(value) }); return; }
    if (key === 'insertType') { setToolboxSpec(state.screwSpec, { type: value, variant: 'auto' }); return; }
    if (key === 'washer') { setScrewSpec({ ...state.screwSpec, washer: value }); return; }
    if (key === 'screwMaterial') { setScrewSpec({ ...state.screwSpec, material: value }); return; }
    state.params[key] = Number(value);
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
    $('#holes-summary').textContent = mount.length
      ? `${state.selectedHoles.size}/${mount.length} delik · ${state.lidMode === 'screw' ? 'vidalı kapak' : 'geçme kapak'}`
      : 'montaj deliği yok';
    const t = toolboxTypes().find((x) => x.id === state.screwSpec.type);
    const allowed = t ? Object.keys(t.sizes) : null;
    $('#hole-list').innerHTML = mount.length
      ? mount.map((h, k) => {
        const s = !state.fasteners ? null
          : state.screwSpec.size !== 'auto' ? { size: state.screwSpec.size } : pickScrew(h.d, screwTable(state.fasteners, t), allowed);
        return `<label class="hole-row"><input type="checkbox" data-hole="${h.index}" ${state.selectedHoles.has(h.index) ? 'checked' : ''}>` +
          `<span>Delik ${k + 1} · Ø${f2(h.d)}${s ? ` · ${s.size}` : ''}</span>` +
          `<span class="pos">${f2(h.x)}; ${f2(h.y)}</span></label>`;
      }).join('')
      : '<div class="hole-empty">Kartta montaj deliği bulunamadı. PCB tutucu üretilemez; kart kenarı tutucuları sonraki sürümlerde.</div>';
    $('#lid-mode').innerHTML = LID_MODES.map((m) =>
      `<button type="button" role="radio" data-lid="${m.id}" aria-checked="${m.id === state.lidMode}">${esc(m.label)}</button>`).join('');
    const levels = state.sealingIndex?.levels || [];
    $('#ip-level').innerHTML = levels.map((l) =>
      `<button type="button" role="radio" data-ip="${l.id}" aria-checked="${l.id === state.sealing}">${esc(l.label)}</button>`).join('');
    const lvl = sealingLevel();
    $('#ip-desc').textContent = lvl && lvl.id !== 'none'
      ? `${lvl.desc}. Duvar üstünde Ø${f2(lvl.cord_d)} kordon conta kanalı açılır; kapak vidaları contayı sıkıştırır.`
      : 'Sızdırmazlık yok: kapak doğrudan gövdeye oturur.';
    $('#sum-ip').textContent = lvl && lvl.id !== 'none' ? lvl.label : 'Yok';
  }

  $('#hole-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-hole]');
    if (!cb) return;
    const idx = Number(cb.dataset.hole);
    const prev = currentDefaults();
    if (cb.checked) state.selectedHoles.add(idx); else state.selectedHoles.delete(idx);
    refreshAutoParams(prev);
    update();
  });
  $('#lid-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lid]');
    if (!btn || btn.dataset.lid === state.lidMode) return;
    const prev = currentDefaults();
    state.lidMode = btn.dataset.lid;
    renderFastening();
    refreshAutoParams(prev);
    update();
  });
  $('#ip-level').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ip]');
    if (!btn || btn.dataset.ip === state.sealing) return;
    const prev = currentDefaults();
    state.sealing = btn.dataset.ip;
    renderFastening();
    refreshAutoParams(prev);
    update();
  });

  /* ---------- Port açıklıkları ---------- */

  function renderPorts(d) {
    const ports = d.ports || [];
    $('#ports-summary').textContent = ports.length ? `${ports.filter((p) => p.enabled).length} / ${ports.length} açık` : '';
    $('#port-list').innerHTML = ports.length
      ? ports.map((p) => `
        <div class="port-row ${p.enabled ? '' : 'off'}" data-part="${p.partId}">
          <label class="port-main"><input type="checkbox" data-port="${esc(p.key)}" ${p.enabled ? 'checked' : ''}>
            <span class="port-name" title="${esc(p.name)}">${esc(p.name)}</span></label>
          <span class="port-size">${f2(p.openWidth)} × ${f2(p.openHeight)}</span>
          <select data-port-style="${esc(p.key)}" aria-label="Açıklık tipi" ${p.enabled ? '' : 'disabled'}>
            <option value="window" ${p.style === 'window' ? 'selected' : ''}>Pencere</option>
            <option value="notch" ${p.style === 'notch' ? 'selected' : ''}>Çentik</option>
          </select>
          <span class="port-meta"><span class="pill side">${esc(p.side)}</span>${p.crossing ? 'duvardan geçiyor' : 'duvara dayalı'}` +
          `${!p.crossing && p.connectorLike ? ' · konnektör' : ''}${p.autoNotch ? ' · üstte ince duvar kaldığı için çentik' : ''}</span>
        </div>`).join('')
      : '<div class="hole-empty">Duvara değen veya dayalı bileşen yok.</div>';
  }

  $('#port-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-port]');
    const sel = e.target.closest('select[data-port-style]');
    const key = cb ? cb.dataset.port : sel ? sel.dataset.portStyle : null;
    if (!key) return;
    const ov = { ...(state.portOverrides.get(key) || {}) };
    if (cb) ov.enabled = cb.checked;
    if (sel) ov.style = sel.value;
    state.portOverrides.set(key, ov);
    update();
  });
  $('#port-list').addEventListener('mouseover', (e) => {
    const row = e.target.closest('.port-row');
    if (row) viewer.highlight(Number(row.dataset.part));
  });
  $('#port-list').addEventListener('mouseleave', () => viewer.highlight(null));

  /* ---------- DFM paneli ---------- */

  const DFM_CATS = [['genel', 'Genel'], ['surec', 'Süreç'], ['ip', 'Sızdırmazlık (IP)'], ['port', 'Port açıklıkları'], ['kapak', 'Kapak'], ['baglanti', 'Bağlantı']];
  const LEVEL_RANK = { error: 0, warn: 1, info: 2, ok: 3 };
  const LEVEL_LABEL = [['error', 'hata'], ['warn', 'uyarı'], ['ok', 'uygun'], ['info', 'bilgi']];

  function noteHtml(c) {
    return `<li class="note ${c.level === 'info' ? '' : c.level}"${c.focus ? ` data-focus="${c.focus.partId}"` : ''}><span>${esc(c.text)}` +
      (c.fix ? ` <button type="button" class="link-btn" data-fix-key="${esc(c.fix.key)}" data-fix-value="${c.fix.value}">${esc(c.fix.label)}</button>` : '') +
      '</span></li>';
  }

  function renderChecks(checks) {
    const counts = { error: 0, warn: 0, info: 0, ok: 0 };
    for (const c of checks) counts[c.level]++;
    $('#dfm-counts').innerHTML = LEVEL_LABEL.filter(([k]) => counts[k])
      .map(([k, label]) => `<span class="dfm-count ${k}">${counts[k]} ${label}</span>`).join('');
    $('#dfm-list').innerHTML = DFM_CATS.map(([id, label]) => {
      const list = checks.filter((c) => (c.cat || 'genel') === id).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
      return list.length ? `<section class="dfm-group"><h4>${label}</h4><ul class="notes">${list.map(noteHtml).join('')}</ul></section>` : '';
    }).join('');
  }

  $('#dfm-list').addEventListener('mouseover', (e) => {
    const li = e.target.closest('[data-focus]');
    viewer.highlight(li ? Number(li.dataset.focus) : null);
  });
  $('#dfm-list').addEventListener('mouseleave', () => viewer.highlight(null));

  /* ---------- Hesap ve özet ---------- */

  function update() {
    if (!state.analysis || !state.rules) return;
    const d = computeDesign(state.analysis, state.rules, state.params, designOptions());
    state.design = d;
    renderPorts(d);
    const bom = d.bom || [];
    $('#bom-title').classList.toggle('hidden', !bom.length);
    $('#bom-list').innerHTML = bom.map((line) => `<li>${esc(line)}</li>`).join('');
    renderScrewPick(d);
    renderInsertPick(d);

    const errEl = $('#design-error');
    errEl.classList.toggle('hidden', !d.error);
    errEl.textContent = d.error || '';
    $('#generate-btn').disabled = !d.ok;

    renderStats();
    renderChecks(d.checks || []);

    // Kart özetleri ve kabuğa (sekme rozeti, durum çipi) bildirim
    const proc = state.index.processes.find((pp) => pp.id === state.process);
    $('#sum-process').textContent = `${proc.label} · ${state.rules.label}`;
    $('#sum-params').textContent = d.params
      ? `Et ${f2(d.params.wall)} · PCB altı ${f2(d.params.standoffHeight)} mm`
      : 'geçersiz değer';
    const mountCount = (state.analysis.holes || []).filter((h) => h.mount).length;
    const sc = d.screws && d.screws[0];
    $('#holes-summary').textContent = mountCount
      ? `${state.selectedHoles.size}/${mountCount} delik` + (sc ? ` · ${sc.code ? sc.code + ' ' : ''}${sc.size}×${sc.length === null || sc.length === undefined ? '?' : String(sc.length).replace('.', ',')}` : '') +
        (state.lidMode === 'screw' ? '' : ' · geçme kapak')
      : 'montaj deliği yok';
    const counts = { error: 0, warn: 0 };
    for (const c of d.checks || []) if (c.level in counts) counts[c.level]++;
    if (d.error) counts.error++;
    document.dispatchEvent(new CustomEvent('ikra:checks', { detail: counts }));

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
        d.standoffs.length ? `${d.standoffs.length} standoff · ${d.lidTubes.length} kapak borusu` : 'montaj deliği yok') +
      stat('Port açıklığı', `${d.geometry.cutouts.length}`,
        d.geometry.cutouts.length ? d.ports.filter((p) => p.enabled).map((p) => `${p.side} ${p.style === 'notch' ? 'çentik' : 'pencere'}`).join(' · ') : 'yok');
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
    if (state.drawingId !== null && msg.id === state.drawingId) { onDrawing(msg); return; }
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
      head: s.head, headDActual: s.head_d_actual, driveKind: s.driveKind, drive: s.driveVal, driveA: s.driveA, driveM: s.driveM,
      size: s.size, P: s.P, tapping: s.tapping, seat: s.seat || 0, washer: s.washer, finish: s.material?.finish || 'stainless',
      z: s.lid ? d.geometry.zTop : state.analysis.board.top,
    }));
    const inserts = d.standoffs.filter((s) => s.insert).map((s) => ({ x: s.x, y: s.y, z: s.z1, ...s.insert }));
    viewer.setEnclosure(msg.meshes, { explodeOffset: Math.max(d.outer.H * 0.75, 10), screws, inserts });
    const first = state.firstBuild;
    if (first) viewer.setView('iso');
    state.firstBuild = false;
    $('#enc-toggles').classList.remove('hidden');
    $('#downloads').classList.remove('hidden');
    $('#output-empty').classList.add('hidden');
    document.dispatchEvent(new CustomEvent('ikra:built', { detail: { first } }));
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

  /* ---------- Teknik resim ---------- */

  const dialog = $('#drawing-dialog');

  function requestDrawing() {
    if (!state.result) return;
    if (state.pendingId !== null) { setStatus('Muhafaza güncelleniyor, birazdan tekrar dene.', { error: true }); return; }
    state.drawingId = ++state.seq;
    $('#drawing-btn').disabled = true;
    $('#drawing-btn').lastElementChild.textContent = 'Hazırlanıyor…';
    getWorker().postMessage({ type: 'drawing', id: state.drawingId });
  }

  function onDrawing(msg) {
    state.drawingId = null;
    $('#drawing-btn').disabled = false;
    $('#drawing-btn').lastElementChild.textContent = 'Teknik resim (önizle)';
    if (msg.type === 'error') { setStatus('Teknik resim üretilemedi: ' + msg.message, { error: true }); return; }
    const d = state.result.design;
    const proc = state.index.processes.find((p) => p.id === state.process);
    try {
      state.sheets = buildSheets({
        views: msg.views,
        design: d,
        rules: state.rules,
        info: {
          project: fileStem(),
          material: state.rules.label,
          process: proc.label,
          ip: d.sealing ? d.sealing.label : 'Yok',
          date: new Date().toISOString().slice(0, 10),
          version: $('#app-version').textContent.replace(/^Sürüm\s*/, 'v'),
        },
      });
    } catch (err) {
      console.error(err);
      setStatus('Teknik resim çizilemedi: ' + err.message, { error: true });
      return;
    }
    state.sheetIdx = 0;
    renderSheet();
    $('#dd-status').textContent = `${state.sheets.length} pafta · ${Math.round(msg.ms)} ms`;
    if (!dialog.open) dialog.showModal();
  }

  function renderSheet() {
    $('#dd-tabs').innerHTML = state.sheets.map((s, i) =>
      `<button type="button" role="tab" data-sheet="${i}" aria-selected="${i === state.sheetIdx}">${i + 1} · ${esc(s.title)} (${s.scale >= 1 ? s.scale + ':1' : '1:' + Math.round(1 / s.scale)})</button>`).join('');
    $('#dd-body').innerHTML = state.sheets[state.sheetIdx].svg;
  }

  $('#drawing-btn').addEventListener('click', requestDrawing);
  $('#dd-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sheet]');
    if (!b) return;
    state.sheetIdx = Number(b.dataset.sheet);
    renderSheet();
  });
  $('#dd-close').addEventListener('click', () => dialog.close());
  $('#dd-pdf').addEventListener('click', async () => {
    if (!state.sheets) return;
    const btn = $('#dd-pdf');
    btn.disabled = true;
    btn.textContent = 'PDF hazırlanıyor…';
    $('#dd-status').textContent = 'İlk seferde PDF kütüphanesi ve Türkçe font (~2 MB) indirilir.';
    try {
      await exportPdf(state.sheets, `${fileStem()}_ikra_teknik-resim.pdf`);
      $('#dd-status').textContent = 'PDF indirildi.';
    } catch (err) {
      console.error(err);
      $('#dd-status').textContent = 'PDF oluşturulamadı: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'PDF indir';
    }
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
    $('#output-empty').classList.remove('hidden');
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
    state.screwSpec = { ...state.screwSpec, length: 'auto' }; // tip ve boyut korunur; boy yeni karta göre
    state.insertSpec = { ...state.insertSpec, variant: 'auto' };
    state.portOverrides = new Map();
    state.sheets = null;
    state.drawingId = null;
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
      ports: d.ports.map((p) => ({
        name: p.name, side: p.side, crossing: p.crossing, enabled: p.enabled, style: p.style,
        openWidth: p.openWidth, openHeight: p.openHeight, recess: p.recess,
      })),
      lidMode: state.lidMode,
      sealing: d.sealing,
      fastening: d.fasteningMethod,
      standoffs: d.standoffs.map((s) => ({ x: s.x, y: s.y, od: s.od, holeD: s.holeD, depth: s.depth, screw: s.screw })),
      lidTubes: d.lidTubes.map((t) => ({ x: t.x, y: t.y, od: t.od, holeD: t.holeD, length: t.length })),
      screwSpec: d.screwSpec,
      insertSpec: d.insertSpec,
      inserts: d.standoffs.map((s) => s.insert).filter(Boolean),
      screws: d.screws.map((s) => ({
        standard: s.code, name: s.name, size: s.size, length: s.length, engagement: s.engagement, lid: s.lid, x: s.x, y: s.y,
        head: s.head, drive: s.driveText, designation: s.designation, material: s.material?.label || null,
        washer: s.washer ? `${s.washer.code} ${s.washer.size} ${s.washer.material?.tag || ''}`.trim() : null, torque_Nm: s.torque?.T ?? null, torque_limit: s.torque?.limit ?? null,
      })),
      bom: d.bom,
      volumes_mm3: state.result ? state.result.volumes : null,
      checks: d.checks,
    };
  }

  return { setAnalysis, reportSection };
}
