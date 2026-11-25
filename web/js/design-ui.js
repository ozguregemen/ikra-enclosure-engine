/*
 * Tasarım paneli (M1): süreç/malzeme seçimi, parametreler, muhafaza üretimi ve indirme.
 * Hesap design.js'te, katı model üretimi cad-worker.js'te yapılır.
 */
import { computeDesign, defaultParams, paramHint, pickScrew, screwTable, libraryTypes, LID_MODES, PARAM_FIELDS } from './design.js';
import { buildSheets, exportPdf } from './drawing.js';
import { createToolbox, headIcon, insertIcon, panelIcon } from './toolbox.js';
import { FACE_LABEL, holeText } from './panel.js';
import { loadPreferred, savePreferred, parsePreferredCsv, matchPreferred, bomCsv, preferredTemplateCsv } from './bom.js';
import { assemblyItems } from './assembly.js';
import { FIT_CLASSES, toleranceOf } from './fits.js';
import { MOUNT_TYPES, MOUNT_SIZES } from './mount.js';
import { runDesignLoop, baseParams, AUTO_KEYS } from './dfm/loop.js';

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

const TOL_KEY = 'ikra.toleranceOverrides.v1';
function loadTolOverrides() {
  try { return JSON.parse(localStorage.getItem(TOL_KEY) || '{}') || {}; } catch { return {}; }
}
function saveTolOverrides(v) {
  try { localStorage.setItem(TOL_KEY, JSON.stringify(v)); } catch { /* tarayıcı depolaması kapalı: oturumla sınırlı */ }
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
    cornerAxis: 'auto',
    cornerSpec: null, // köşe kapak vidaları (null: PCB vidasıyla aynı tip, boyut otomatik)
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
    insertSpec: { type: 'auto', variant: 'auto', nut: 'iso4032', standoff: 'hex-ff', standoffMat: 'auto' },
    panelLib: null, // panel-parts.json
    panelParts: [], // [{ uid, type, size, face, u, v, custom }] — null = otomatik
    preferred: loadPreferred(), // şirket tercihli parça listesi (yalnızca bu tarayıcıda)
    fits: { lid: 'normal', screw: 'normal' }, // geçme sınıfları
    mount: { type: 'none', size: 'M4', count: 4, axis: 'auto', hole: 'round' }, // kutunun bağlanması
    lidSel: null, // { process, material } — null: kapak gövdeyle aynı malzeme
    edgeHold: 'auto', // kart kenarı tutucu: auto (delik yoksa) / on / off
    encloseOverrides: new Map(), // partId → true (kutunun içine al) / false (duvardan çıkar)
    lidRules: null,
    tolEdit: 'body', // tolerans kartında düzenlenen malzeme: gövde / kapak
    tolOverrides: loadTolOverrides(), // { 'fdm/pla': { general, per_100mm, hole_comp, press, normal, loose } } — kendi yazıcı/atölye değerleri
    locks: new Set(), // kullanıcının parametre kutusuna yazdığı (kilitli) anahtarlar: tasarım döngüsü bunları değiştirmez
    waivers: {}, // { bulguId: { reason, date } } — kullanıcı muafiyetleri (proje dosyasına yazılır)
    loop: null, // son tasarım döngüsü sonucu (dfm/loop.js)
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
    if (!state.panelLib) state.panelLib = await getJson('rules/toolbox/panel-parts.json', 'Toolbox panel elemanları yüklenemedi.');
    if (!state.toolboxUI) {
      state.toolboxUI = createToolbox({
        dialog: $('#toolbox-dialog'),
        libraries: [state.toolbox, state.inserts, state.panelLib],
        materials: state.fmaterials.materials,
        fasteners: state.fasteners,
        evaluate: evaluateSpec,
        evaluatePanel,
        preferred: () => state.preferred.items,
        onApply: (spec, ispec, cspec, panel) => setToolboxSpec(spec, ispec, cspec, panel),
      });
    }
  }

  /** Vida seçimini doğrula: tipte olmayan boyut/malzeme 'auto' olur */
  function normalizeSpec(spec) {
    if (!spec) return null;
    const t = toolboxTypes().find((x) => x.id === spec.type);
    const next = {
      type: spec.type, size: spec.size, length: spec.length, material: spec.material || 'auto',
      washer: spec.washer || 'none', washerMaterial: spec.washerMaterial || 'match', headSeat: spec.headSeat || 'surface',
    };
    if (t && next.material !== 'auto' && !(t.materials || []).includes(next.material)) next.material = 'auto';
    if (t && next.size !== 'auto' && !t.sizes[next.size]) next.size = 'auto';
    return next;
  }

  const toolboxTypes = () => libraryTypes(state.toolbox, 'screws');
  const washerTypes = () => libraryTypes(state.toolbox, 'washers');
  const insertTypes = () => libraryTypes(state.inserts, 'inserts');
  const standoffTypes = () => libraryTypes(state.inserts, 'standoffs');
  const nutTypes = () => libraryTypes(state.toolbox, 'nuts');
  const panelTypes = () => (state.panelLib ? libraryTypes(state.panelLib, 'panel') : []);

  /** Toolbox seçimini uygula: kullanıcının elle değiştirmediği parametreler yeni vida/burca göre yeniden hesaplanır */
  function setToolboxSpec(spec, ispec = state.insertSpec, cspec = state.cornerSpec, panel = undefined) {
    const next = normalizeSpec(spec);
    state.cornerSpec = normalizeSpec(cspec);
    const nextIns = {
      type: ispec.type || 'auto', variant: ispec.variant || 'auto', nut: ispec.nut || 'iso4032',
      standoff: ispec.standoff || 'hex-ff', standoffMat: ispec.standoffMat || 'auto',
    };
    if (!state.analysis || !state.rules || !state.params) {
      state.screwSpec = next;
      state.insertSpec = nextIns;
      if (panel) state.panelParts = panel;
      renderScrewPick();
      return;
    }
    const prev = currentDefaults();
    state.screwSpec = next;
    state.insertSpec = nextIns;
    if (panel) state.panelParts = panel;
    refreshAutoParams(prev);
    // Toolbox'ta aralayıcı boyu seçildiyse PCB altı yükseklik bu boy olur
    if (nextIns.type === 'standoff' && ispec.standoffLen) { state.params.standoffHeight = Number(ispec.standoffLen); renderParams(); }
    renderFastening();
    update();
  }
  const setScrewSpec = (spec) => setToolboxSpec(spec, state.insertSpec);

  /**
   * Toolbox penceresinin canlı hesabı: seçilen vida tipine/boyutuna göre otomatik boylu tasarım (boy durumları için)
   * ve tam seçimli tasarım (uygulanınca oluşacak parametrelerle).
   */
  function evaluateSpec(spec, ispec = state.insertSpec, cspec = state.cornerSpec) {
    if (!state.analysis || !state.rules || !state.params || !state.analysis.board || state.analysis.board.axes.n !== 'Z') return null;
    const opts = (sp, ip, cp) => ({ ...designOptions(), screwSpec: sp, insertSpec: ip, cornerSpec: cp });
    const prev = currentDefaults();
    const adapt = (sp, ip, cp) => {
      const next = defaultParams(state.analysis, state.rules, opts(sp, ip, cp));
      const p = { ...state.params };
      for (const key of Object.keys(next)) if (Math.abs(p[key] - prev[key]) < 1e-9) p[key] = next[key];
      return p;
    };
    const autoSpec = { ...spec, length: 'auto' };
    const autoC = cspec ? { ...cspec, length: 'auto' } : null;
    const auto = computeDesign(state.analysis, state.rules, adapt(autoSpec, ispec, autoC), opts(autoSpec, ispec, autoC));
    const same = spec.length === 'auto' && (!cspec || cspec.length === 'auto');
    const sel = same ? auto : computeDesign(state.analysis, state.rules, adapt(spec, ispec, cspec), opts(spec, ispec, cspec));
    return {
      auto,
      sel,
      standoffAuto: Math.abs(state.params.standoffHeight - prev.standoffHeight) < 1e-9,
      standoffNow: state.params.standoffHeight,
      ruleMethod: state.rules.fastening || 'insert',
      helicoilD: state.rules.helicoil_length_d || 2,
      process: state.rules.process,
    };
  }

  /** Toolbox panel görünümünün canlı hesabı: taslak panel listesiyle (otomatik yükseltmeler dahil) tasarım */
  function evaluatePanel(list) {
    if (!state.analysis || !state.rules || !state.params || !state.analysis.board || state.analysis.board.axes.n !== 'Z') return null;
    const opts = { ...designOptions(), panelParts: list };
    const prev = currentDefaults();
    const next = defaultParams(state.analysis, state.rules, opts);
    const p = { ...state.params };
    for (const key of Object.keys(next)) if (Math.abs(p[key] - prev[key]) < 1e-9) p[key] = next[key];
    return computeDesign(state.analysis, state.rules, p, opts);
  }

  function openToolbox(view = 'screw', group = 'pcb', panelType = null) {
    loadToolbox()
      .then(() => state.toolboxUI.open(state.screwSpec, state.insertSpec, view, {
        corner: state.cornerSpec, group, cornerMode: state.lidMode === 'corner', panel: state.panelParts, panelType,
      }))
      .catch((err) => setStatus(err.message, { error: true }));
  }
  $('#panel-add').addEventListener('click', () => openToolbox('panel', 'pcb', state.panelParts.length ? null : 'sma-bh'));
  $('#toolbox-btn').addEventListener('click', () => openToolbox('screw'));
  $('#screw-pick').addEventListener('click', () => openToolbox('screw', 'pcb'));
  $('#corner-pick').addEventListener('click', () => openToolbox('screw', 'corner'));
  $('#insert-pick').addEventListener('click', () => openToolbox('insert'));

  /** Bağlantı kartındaki köşe (kapak) vidası satırı */
  function renderCornerPick(d = state.design) {
    const show = state.lidMode === 'corner';
    $('#corner-pick-wrap').classList.toggle('hidden', !show);
    if (!show) return;
    const cs = (d?.screws || []).filter((s) => s.role === 'corner');
    const sc = cs[0];
    const t = toolboxTypes().find((x) => x.id === (sc?.type || state.cornerSpec?.type || state.screwSpec.type));
    if (t) $('#corner-pick-icon').innerHTML = headIcon(t.head);
    $('#corner-pick-title').textContent = sc
      ? `${sc.code ? sc.code + ' · ' : ''}${sc.size} × ${String(sc.length ?? '?').replace('.', ',')}${sc.material ? ' ' + sc.material.tag : ''}`
      : 'Köşe vidası';
    const tq = d?.torque?.corner;
    const cp = d?.cornerPlan;
    $('#corner-pick-sub').textContent = [
      `${cs.length} köşe`, sc?.counterbore ? 'gömme baş' : null, tq ? `${String(tq.T).replace('.', ',')} N·m` : null,
      cp && cp.extra > 0 ? `kavite ${cp.axis === 0 ? 'X' : 'Y'} +${String(Math.round(cp.extra * 10) / 10).replace('.', ',')} mm/uç` : null,
    ].filter(Boolean).join(' · ');
    $('#corner-axis').innerHTML = [['auto', 'Otomatik'], ['x', 'X ekseni'], ['y', 'Y ekseni']].map(([id, label]) =>
      `<button type="button" role="radio" data-axis="${id}" aria-checked="${state.cornerAxis === id}">${label}</button>`).join('');
  }
  $('#corner-axis').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-axis]');
    if (!btn || btn.dataset.axis === state.cornerAxis) return;
    const prev = currentDefaults();
    state.cornerAxis = btn.dataset.axis;
    refreshAutoParams(prev);
    update();
  });

  /** Bağlantı kartındaki gövde tarafı satırı: burç / kılavuz / ön delik */
  function renderInsertPick(d = state.design) {
    const st = d?.standoffs?.[0];
    const m = d?.fasteningMethod;
    const ins = st?.insert;
    const kind = m === 'helicoil' ? 'helicoil' : m === 'insert' ? 'heatset' : m === 'nut' ? 'nut' : m === 'standoff' ? 'standoff' : 'tapped';
    $('#insert-pick-icon').innerHTML = insertIcon(kind);
    $('#insert-pick-title').textContent = !st ? 'Gövde tarafı'
      : ins ? (ins.kind === 'helicoil' ? `Helicoil ${st.screw} × ${ins.id.replace('.', ',')} (${String(ins.L).replace('.', ',')} mm)`
        : ins.kind === 'nut' ? `${ins.code} ${st.screw} ${ins.shape === 'hex' ? 'somun cebi (alttan)' : 'kare somun yuvası'}`
          : ins.kind === 'standoff' ? `${st.screw} × ${String(ins.L).replace('.', ',')} aralayıcı ${ins.ends === 'ff' ? 'D-D' : 'E-D'}` : ins.id)
        : m === 'self_tap' ? `Ön delik Ø${String(st.holeD).replace('.', ',')}` : m === 'insert' ? `${st.screw} insert` : `${st.screw} kılavuz · Ø${String(st.holeD).replace('.', ',')}`;
    const how = { insert: 'Isıyla gömülen insert', helicoil: 'Tel dişli burç', tapped: 'Doğrudan diş', self_tap: 'Sac vidası dişini kendisi açar', nut: 'Somunda tutunur', standoff: `Hazır aralayıcı${ins?.material ? ', ' + ins.material.tag : ''}` }[m] || '';
    $('#insert-pick-sub').textContent = `${how}${state.insertSpec.type === 'auto' ? ' · kural dosyasına göre' : ' · elle seçildi'}`;
  }

  /** Bağlantı kartındaki vida satırı: seçili tip, etkin boyut × boy */
  function renderScrewPick(d = state.design) {
    const t = toolboxTypes().find((x) => x.id === state.screwSpec.type);
    if (!t) return;
    $('#screw-pick-icon').innerHTML = headIcon(t.head);
    const groups = new Map();
    for (const s of (d?.screws || []).filter((x) => x.role !== 'corner')) {
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

  const processSeg = (cur) => state.index.processes.map((p) =>
    `<button type="button" role="radio" data-process="${p.id}" aria-checked="${p.id === cur}">${esc(p.label)}</button>`).join('');
  // Malzemeler gruplu (index.json "group"): Standart / Mühendislik / Karbon fiber; asetal-naylon / yüksek performans …
  function materialChips(processId, cur) {
    const proc = state.index.processes.find((p) => p.id === processId);
    let lastGroup = null;
    return proc.materials.map((m) => {
      const head = m.group && m.group !== lastGroup ? `<span class="chip-group">${esc(m.group)}</span>` : '';
      lastGroup = m.group || lastGroup;
      return `${head}<button type="button" class="chip" role="radio" data-material="${m.id}" aria-checked="${m.id === cur}" title="${esc(m.title || m.label)}">${esc(m.label)}</button>`;
    }).join('');
  }
  const materialProps = (r) => (r ? [
    r.max_service_temp_c ? `sürekli kullanım ≈ <b>${r.max_service_temp_c} °C</b>${r.hdt_c ? ` (HDT ${r.hdt_c} °C)` : ''}` : null,
    r.density_g_cm3 ? `yoğunluk <b>${String(r.density_g_cm3).replace('.', ',')}</b> g/cm³` : null,
    r.tensile_strength_mpa ? `çekme <b>${r.tensile_strength_mpa} MPa</b>${r.process === 'fdm' ? ' (katman yönü dahil)' : ''}` : null,
    r.cte_um_mk ? `ısıl genleşme ${r.cte_um_mk} µm/m·K` : null,
    Number.isFinite(r.moisture_pct) ? `su emme %${String(r.moisture_pct).replace('.', ',')}` : null,
    r.tolerance ? `genel tolerans ±${String(r.tolerance.general).replace('.', ',')} mm` : null,
  ].filter(Boolean).join(' · ') : '');

  function renderSelectors() {
    $('#process-seg').innerHTML = processSeg(state.process);
    $('#material-chips').innerHTML = materialChips(state.process, state.material);
    $('#mat-props').innerHTML = materialProps(state.rules);
    $('#rule-notes').innerHTML = (state.rules?.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
    // Kapak malzemesi: gövdeyle aynı ya da ayrı süreç/malzeme
    const diff = !!state.lidSel;
    $('#lid-mat-mode').innerHTML = [['same', 'Gövdeyle aynı'], ['diff', 'Farklı malzeme']].map(([id, label]) =>
      `<button type="button" role="radio" data-lidmode="${id}" aria-checked="${(id === 'diff') === diff}">${label}</button>`).join('');
    $('#lid-mat').classList.toggle('hidden', !diff);
    if (diff) {
      $('#lid-process-seg').innerHTML = processSeg(state.lidSel.process);
      $('#lid-material-chips').innerHTML = materialChips(state.lidSel.process, state.lidSel.material);
      $('#lid-mat-props').innerHTML = materialProps(state.lidRules) +
        (state.lidRules?.notes?.length ? `<br><span class="muted">${esc(state.lidRules.notes[0])}</span>` : '');
    }
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

  /** Kapak kural dosyası (ayrı malzeme seçiliyse) */
  async function loadLidRules() {
    if (!state.lidSel) { state.lidRules = null; return; }
    const proc = state.index.processes.find((p) => p.id === state.lidSel.process) || state.index.processes[0];
    const mat = proc.materials.find((m) => m.id === state.lidSel.material) || proc.materials[0];
    state.lidSel = { process: proc.id, material: mat.id };
    if (!state.rulesCache.has(mat.file)) {
      const res = await fetch('rules/' + mat.file);
      if (!res.ok) throw new Error(`Kural dosyası yüklenemedi: ${mat.file}`);
      state.rulesCache.set(mat.file, await res.json());
    }
    state.lidRules = state.rulesCache.get(mat.file);
  }
  async function setLidSel(sel) {
    const prev = state.rules && state.analysis ? currentDefaults() : null;
    state.lidSel = sel;
    try { await loadLidRules(); } catch (err) { setStatus(err.message, { error: true }); return; }
    if (!state.lidSel) state.tolEdit = 'body';
    if (prev) refreshAutoParams(prev);
    renderSelectors();
    update();
  }
  $('#lid-mat-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lidmode]');
    if (!btn) return;
    if (btn.dataset.lidmode === 'same') { if (state.lidSel) setLidSel(null); return; }
    if (state.lidSel) return;
    // Varsayılan: aynı süreçte şeffaf/ışık geçiren bir malzeme varsa o (CNC'de PMMA), yoksa aynı malzeme
    const proc = state.index.processes.find((p) => p.id === state.process);
    const pick = proc.materials.find((m) => m.id === 'pmma') || proc.materials.find((m) => m.id !== state.material) || proc.materials[0];
    setLidSel({ process: state.process, material: pick.id });
  });
  $('#lid-process-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-process]');
    if (!btn || !state.lidSel || btn.dataset.process === state.lidSel.process) return;
    const proc = state.index.processes.find((p) => p.id === btn.dataset.process);
    setLidSel({ process: proc.id, material: proc.materials[0].id });
  });
  $('#lid-material-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-material]');
    if (!btn || !state.lidSel || btn.dataset.material === state.lidSel.material) return;
    setLidSel({ ...state.lidSel, material: btn.dataset.material });
  });

  const sealingLevel = () => (state.sealingIndex?.levels || []).find((l) => l.id === state.sealing) || null;
  const designOptions = () => ({
    fasteners: state.fasteners,
    lidMode: state.lidMode,
    cornerAxis: state.cornerAxis,
    cornerSpec: state.cornerSpec,
    selectedHoles: state.selectedHoles,
    portOverrides: state.portOverrides,
    sealing: sealingLevel(),
    toolbox: { types: toolboxTypes(), inserts: insertTypes(), washers: washerTypes(), nuts: nutTypes(), standoffs: standoffTypes(), panel: panelTypes(), materials: state.fmaterials?.materials || [], model: state.fmaterials?.model || null },
    screwSpec: state.screwSpec,
    insertSpec: state.insertSpec,
    panelParts: state.panelParts,
    fits: state.fits,
    tolerance: state.rules ? state.tolOverrides[state.rules.id] || null : null,
    lidRules: state.lidSel ? state.lidRules : null,
    lidTolerance: state.lidSel && state.lidRules ? state.tolOverrides[state.lidRules.id] || null : null,
    mount: state.mount,
    edgeHold: state.edgeHold,
    encloseOverrides: state.encloseOverrides,
  });
  // Kilitsiz varsayılanlar: kural dosyası + tasarım döngüsünün otomatik düzeltmeleri (dfm/loop.js; sonuçlar önbellekte)
  const currentDefaults = () => defaultParams(state.analysis, state.rules, designOptions());
  /** Kullanıcının yazdığı (kilitli) parametreler */
  const lockedParams = () => {
    const out = {};
    for (const key of state.locks) if (state.params && key in state.params) out[key] = state.params[key];
    return out;
  };
  /** Tasarım döngüsü: üret → incele → güvenli düzeltmeleri uygula → yeniden incele (kilitli değerler korunur) */
  const runLoop = () => runDesignLoop(state.analysis, state.rules, { userParams: lockedParams(), waivers: state.waivers, maxIter: 8 }, designOptions());

  /** Bağlantı/IP seçimi değişince kilitsiz parametreler döngünün yeni sonucuna çekilir (prevDefaults: eski çağrılarla uyum için) */
  function refreshAutoParams(prevDefaults) {
    void prevDefaults;
    if (!state.analysis || !state.rules || !state.params) return;
    const next = runLoop().params;
    for (const key of Object.keys(next)) if (!state.locks.has(key)) state.params[key] = next[key];
    renderParams();
  }

  async function applyRules() {
    try {
      await loadRules();
      await loadLidRules();
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
    state.locks.add(key); // kullanıcının yazdığı değer kilitlenir: döngü değiştirmez
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
    if (key === 'insertType') { setToolboxSpec(state.screwSpec, { ...state.insertSpec, type: value, variant: 'auto' }); return; }
    if (key === 'nutType') { setToolboxSpec(state.screwSpec, { ...state.insertSpec, type: 'nut', nut: value }); return; }
    if (key === 'standoffType') { setToolboxSpec(state.screwSpec, { ...state.insertSpec, type: 'standoff', standoff: value }); return; }
    if (key === 'washer') { setScrewSpec({ ...state.screwSpec, washer: value }); return; }
    if (key === 'lidMode') { const prev = currentDefaults(); state.lidMode = value; renderFastening(); refreshAutoParams(prev); update(); return; }
    if (key === 'cornerAxis') { const prev = currentDefaults(); state.cornerAxis = value; refreshAutoParams(prev); update(); return; }
    if (key === 'screwMaterial') { setScrewSpec({ ...state.screwSpec, material: value }); return; }
    if (key === 'panelAdd') {
      const t = panelTypes().find((x) => x.id === value);
      if (!t) return;
      changePanel(() => {
        if (['lightpipe', 'foot'].includes(t.kind) && state.panelParts.some((x) => x.type === t.id)) return;
        state.panelParts = [...state.panelParts, { uid: newPanelUid(), type: t.id, size: t.defaultSize || (t.sizes ? Object.keys(t.sizes)[0] : null), face: null, u: null, v: null, custom: t.kind === 'custom' ? { ...t.custom } : undefined }];
      });
      return;
    }
    if (key === 'fitLid') { setFit('lid', value); return; }
    if (key === 'edgeHold') { setEdgeHold(value); return; }
    if (key === 'holeOff') { const prev = currentDefaults(); state.selectedHoles.delete(Number(value)); renderFastening(); refreshAutoParams(prev); update(); return; }
    if (key === 'mountAxis') { setMount({ axis: value }); return; }
    if (key === 'mountType') { setMount({ type: value }); return; }
    if (key === 'mountCount') { setMount({ count: Number(value) }); return; }
    if (key === 'setParam') {
      const [pk, pv] = String(value).split(':');
      if (!(pk in state.params)) return;
      state.params[pk] = Number(pv);
      state.locks.add(pk); // kullanıcı kararı: kilitli
      renderParams();
      update();
      return;
    }
    if (key === 'portStyle' || key === 'portEnable') {
      // Port açıklığı: "partId|kenar|stil" (çentik/pencere) ya da "partId|kenar" (açıklığı aç)
      const parts = String(value).split('|');
      const pkey = `${parts[0]}|${parts[1]}`;
      const ov = { ...(state.portOverrides.get(pkey) || {}) };
      if (key === 'portStyle') ov.style = parts[2];
      else ov.enabled = true;
      state.portOverrides.set(pkey, ov);
      update();
      return;
    }
    if (key === 'panelAuto') {
      const [uid, mode] = String(value).split(':');
      changePanel(() => {
        state.panelParts = state.panelParts.map((x) => (x.uid === uid ? { ...x, u: null, v: null, face: mode === 'all' ? null : x.face } : x));
      });
      return;
    }
    if (!AUTO_KEYS.includes(key) || !Number.isFinite(Number(value))) return;
    // Sayısal parametre önerisi: değer uygulanır ve kilitlenir (döngü bu değeri korur, diğerlerini yeniden yakınsatır)
    state.params[key] = Number(value);
    state.locks.add(key);
    renderParams();
    update();
  });
  $('#params-reset').addEventListener('click', () => {
    if (!state.rules) return;
    state.locks = new Set();
    state.params = currentDefaults();
    renderParams();
    update();
  });

  /* ---------- Bağlantı: delikler ve kapak modu ---------- */

  function renderFastening() {
    const holes = state.analysis.holes || [];
    const mount = holes.map((h, i) => ({ ...h, index: i })).filter((h) => h.mount);
    $('#holes-summary').textContent = mount.length
      ? `${state.selectedHoles.size}/${mount.length} delik · ${{ screw: 'vidalı kapak', corner: 'köşe vidalı kapak', none: 'geçme kapak' }[state.lidMode]}`
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
      : '<div class="hole-empty">Kartta montaj deliği bulunamadı: kart, aşağıdaki kart kenarı tutucularıyla (alt destek + kapak baskısı) tutulur.</div>';
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
            ${p.crossing ? '<option value="enclose">İçeri al (açıklık yok)</option>' : ''}
          </select>
          <span class="port-meta"><span class="pill side">${esc(p.side)}</span>${p.crossing ? 'duvardan geçiyor' : 'duvara dayalı'}` +
          `${!p.crossing && p.connectorLike ? ' · konnektör' : ''}${p.autoNotch ? ' · üstte ince duvar kaldığı için çentik' : ''}</span>
        </div>`).join('')
      : '<div class="hole-empty">Duvara değen veya dayalı bileşen yok.</div>';
    // Kartın dışına taşıp kutunun içine alınan parçalar (anten kendiliğinden ya da "İçeri al" ile)
    const enc = d.enclosed || [];
    if (enc.length) {
      $('#port-list').innerHTML += `<div class="enc-list"><span class="muted small">Kutunun içine alınanlar (taşan, açıklık yok):</span>${enc.map((en) =>
        `<div class="enc-row" data-part="${en.partId}"><span class="port-name" title="${esc(en.name)}">${esc(en.name)}</span><span class="muted small">${en.auto ? 'anten' : 'elle'}</span>` +
        `<button type="button" class="link-btn" data-unenclose="${en.partId}">Duvardan çıkar</button></div>`).join('')}</div>`;
    }
  }

  $('#port-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-port]');
    const sel = e.target.closest('select[data-port-style]');
    const key = cb ? cb.dataset.port : sel ? sel.dataset.portStyle : null;
    if (!key) return;
    // "İçeri al": taşan parça kutunun içine alınır (kavite büyür, açıklık açılmaz)
    if (sel && sel.value === 'enclose') { setEnclose(Number(String(key).split('|')[0]), true); return; }
    const ov = { ...(state.portOverrides.get(key) || {}) };
    if (cb) ov.enabled = cb.checked;
    if (sel) ov.style = sel.value;
    state.portOverrides.set(key, ov);
    update();
  });
  $('#port-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unenclose]');
    if (b) setEnclose(Number(b.dataset.unenclose), false);
  });
  function setEnclose(partId, on) {
    const prev = state.rules && state.analysis ? currentDefaults() : null;
    state.encloseOverrides = new Map(state.encloseOverrides);
    state.encloseOverrides.set(partId, on);
    if (prev) refreshAutoParams(prev);
    update();
  }
  $('#port-list').addEventListener('mouseover', (e) => {
    const row = e.target.closest('.port-row');
    if (row) viewer.highlight(Number(row.dataset.part));
  });
  $('#port-list').addEventListener('mouseleave', () => viewer.highlight(null));

  /* ---------- Toleranslar ve geçmeler ---------- */

  const TOL_FIELDS = [
    ['general', 'Genel tolerans ±', 'küçük ölçüler'],
    ['per_100mm', 'Her 100 mm için ek ±', 'çekme, ısıl genleşme, nem'],
    ['hole_comp', 'Delik telafisi', 'modeldeki delik çapına eklenir'],
    ['press', 'Sıkı geçme boşluğu', 'çapsal; eksi = sıkılık'],
    ['normal', 'Normal geçme boşluğu', 'çapsal'],
    ['loose', 'Bol geçme boşluğu', 'çapsal'],
    ['lid_extra', 'Kapak dili ek payı', 'yan başına; iki yüzeyin baskı/işleme sapması'],
  ];

  const tolRules = () => (state.tolEdit === 'lid' && state.lidSel && state.lidRules ? state.lidRules : state.rules);
  $('#tol-edit').addEventListener('click', (e) => {
    const b = e.target.closest('[data-toledit]');
    if (!b || b.dataset.toledit === state.tolEdit) return;
    state.tolEdit = b.dataset.toledit;
    renderTolerance();
  });

  function renderTolerance(d = state.design) {
    if (!state.rules) return;
    const seg = (fid, cur, labels) => FIT_CLASSES.map((c) =>
      `<button type="button" role="radio" data-fit="${c.id}" aria-checked="${cur === c.id}" title="${esc(c.hint)}">${esc(labels ? labels[c.id] : c.label)}</button>`).join('');
    $('#fit-lid').innerHTML = seg('lid', state.fits.lid);
    $('#fit-screw').innerHTML = seg('screw', state.fits.screw, { press: 'İnce', normal: 'Orta', loose: 'Kaba' });
    // Düzenlenen malzeme: gövde ya da (ayrıysa) kapak
    const R = tolRules();
    $('#tol-edit').classList.toggle('hidden', !state.lidSel || !state.lidRules);
    $('#tol-edit').innerHTML = state.lidSel && state.lidRules ? [['body', `Gövde · ${state.rules.label}`], ['lid', `Kapak · ${state.lidRules.label}`]].map(([id, label]) =>
      `<button type="button" role="radio" data-toledit="${id}" aria-checked="${state.tolEdit === id}">${esc(label)}</button>`).join('') : '';
    const base = toleranceOf(R, null);
    const ov = state.tolOverrides[R.id] || {};
    const val = (k) => (['press', 'normal', 'loose'].includes(k) ? base.fits[k] : base[k] ?? 0);
    $('#tol-mat').textContent = `· ${R.label}`;
    $('#tol-grid').innerHTML = TOL_FIELDS.map(([k, label, hint]) => {
      if (k === 'hole_comp' && R.process !== 'fdm' && !Number.isFinite(ov[k])) return '';
      const changed = Number.isFinite(ov[k]);
      return `<label class="tol-row${changed ? ' changed' : ''}" title="${esc(hint)}"><span>${esc(label)}</span>
        <span class="input-wrap"><input type="text" inputmode="decimal" data-tol="${k}" value="${changed ? inputText(ov[k]) : ''}" placeholder="${inputText(val(k))}"><span class="unit">mm</span></span></label>`;
    }).join('');
    const tol = d?.tolerance;
    const anyOv = Object.keys(ov).length > 0;
    $('#tol-reset').classList.toggle('hidden', !anyOv);
    $('#tol-note').textContent = (base.source ? `Kaynak: ${base.source}. ` : '') +
      'Kendi yazıcın/atölyen için ölçtüğün değeri yaz; bu tarayıcıda malzemeye özel saklanır. Boş = malzeme değeri.';
    $('#sum-tol').textContent = `kapak ${FIT_CLASSES.find((c) => c.id === state.fits.lid).label.toLocaleLowerCase('tr')} · delik ${{ press: 'ince', normal: 'orta', loose: 'kaba' }[state.fits.screw]}${anyOv ? ' · düzeltilmiş' : ''}`;
    if (!tol || !d.outer) { $('#tol-result').innerHTML = ''; return; }
    const st0 = d.standoffs?.[0];
    const sc = d.screws?.find((s) => s.lid) || d.screws?.[0];
    const clr = d.lidTubes?.[0]?.holeD ?? d.geometry?.lidHoles?.[0]?.holeD ?? null;
    const lp = (d.panel?.items || []).find((it) => it.kind === 'lightpipe');
    const rows = [
      ['Kapak dili boşluğu', `${f2(tol.lidGap)} mm / kenar`],
      clr ? [`${sc?.size || ''} geçiş deliği (kapakta)`, `Ø${f2(clr)}`] : null,
      st0 ? [`Gövde deliği (${{ insert: 'insert', helicoil: 'Helicoil matkabı', tapped: 'kılavuz matkabı', self_tap: 'ön delik', nut: 'geçiş', standoff: 'geçiş' }[d.fasteningMethod] || 'delik'})`, `Ø${f2(st0.holeD)}`] : null,
      st0?.insert?.kind === 'nut' ? ['Somun cebi', `SW ${f2(st0.insert.pocket ?? st0.insert.s)}`] : null,
      lp?.hole ? [`${lp.size} ışık borusu deliği`, `Ø${f2(lp.hole.d)} (sıkı)`] : null,
      [`Genel tolerans (${f2(Math.max(d.outer.L, d.outer.W))} mm)`, `±${f2(tol.general + (tol.per_100mm * Math.max(d.outer.L, d.outer.W)) / 100)}`],
    ].filter(Boolean);
    $('#tol-result').innerHTML = `<table class="tb-table">${rows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>`;
  }

  function setFit(group, cls) {
    if (state.fits[group] === cls) return;
    const prev = state.rules ? currentDefaults() : null;
    state.fits = { ...state.fits, [group]: cls };
    if (prev) refreshAutoParams(prev);
    renderTolerance();
    update();
  }
  $('#fit-lid').addEventListener('click', (e) => { const b = e.target.closest('[data-fit]'); if (b) setFit('lid', b.dataset.fit); });
  $('#fit-screw').addEventListener('click', (e) => { const b = e.target.closest('[data-fit]'); if (b) setFit('screw', b.dataset.fit); });
  $('#tol-grid').addEventListener('change', (e) => {
    const inp = e.target.closest('[data-tol]');
    if (!inp || !state.rules) return;
    const raw = String(inp.value).trim();
    const v = raw === '' ? null : parseInput(raw);
    if (v !== null && (!Number.isFinite(v) || Math.abs(v) > 5)) { renderTolerance(); return; }
    const prev = currentDefaults();
    const R = tolRules();
    const cur = { ...(state.tolOverrides[R.id] || {}) };
    if (v === null) delete cur[inp.dataset.tol]; else cur[inp.dataset.tol] = v;
    state.tolOverrides = { ...state.tolOverrides, [R.id]: cur };
    if (!Object.keys(cur).length) delete state.tolOverrides[R.id];
    saveTolOverrides(state.tolOverrides);
    refreshAutoParams(prev);
    renderTolerance();
    update();
  });
  $('#tol-reset').addEventListener('click', () => {
    if (!state.rules) return;
    const prev = currentDefaults();
    delete state.tolOverrides[tolRules().id];
    state.tolOverrides = { ...state.tolOverrides };
    saveTolOverrides(state.tolOverrides);
    refreshAutoParams(prev);
    renderTolerance();
    update();
  });

  /* ---------- Kart kenarı tutucu ---------- */

  function renderEdgeHold(d = state.design) {
    $('#edge-hold').innerHTML = [['auto', 'Otomatik'], ['on', 'Açık'], ['off', 'Kapalı']].map(([id, label]) =>
      `<button type="button" role="radio" data-edge="${id}" aria-checked="${state.edgeHold === id}">${label}</button>`).join('');
    const eh = d?.edgeHold;
    $('#edge-desc').textContent = !eh ? ''
      : !eh.active ? (state.edgeHold === 'off' ? 'Kapalı: kart yalnızca montaj deliklerinden tutulur.' : 'Kart montaj deliklerinden tutuluyor; kenar tutucu gerekmiyor (Açık seçilirse ek olarak eklenir).')
        : `${eh.pads} alt destek (tabana ve duvara bağlı) + ${eh.pressers} kapak baskısı; kart kenarından ${eh.info?.overlap ? String(eh.info.overlap).replace('.', ',') : '–'} mm içeri tutulur.`;
  }
  function setEdgeHold(v) {
    if (!['auto', 'on', 'off'].includes(v) || v === state.edgeHold) return;
    const prev = state.rules && state.analysis ? currentDefaults() : null;
    state.edgeHold = v;
    if (prev) refreshAutoParams(prev);
    update();
  }
  $('#edge-hold').addEventListener('click', (e) => { const b = e.target.closest('[data-edge]'); if (b) setEdgeHold(b.dataset.edge); });

  /* ---------- Montaj (kutunun bağlanması) ---------- */

  const MOUNT_DESC = {
    none: 'Kutu bir yere bağlanmıyor (masa üstü; gerekirse lastik ayak panel elemanlarından eklenir).',
    ears: 'Taban hizasında dışa çıkan kulaklar: kutu yüzeye düz oturur, vidalar dışarıdan sıkılır; sızdırmazlığı bozmaz.',
    floor: 'Tabandan delikler: kutu, kart takılmadan önce içeriden yüzeye vidalanır; dış görünüş temiz kalır.',
    din: 'EN 60715 TS35 ray için ayrı basılan klips: kutunun altına içeriden 2 × M3 ile vidalanır; sabit kanca + iki esnek kilit dili, aletsiz takılır.',
  };

  function renderMount(d = state.design) {
    const mt = state.mount;
    const seg = (items, cur, attr) => items.map(([id, label]) =>
      `<button type="button" role="radio" data-${attr}="${id}" aria-checked="${String(cur) === String(id)}">${esc(label)}</button>`).join('');
    $('#mount-type').innerHTML = seg(MOUNT_TYPES.map((t) => [t.id, t.label]), mt.type, 'mtype');
    $('#mount-desc').textContent = MOUNT_DESC[mt.type];
    $('#mount-opts').classList.toggle('hidden', mt.type === 'none');
    const din = mt.type === 'din';
    $('#mount-ear-opts').classList.toggle('hidden', mt.type !== 'ears' && !din);
    $('#mount-screw-opts').classList.toggle('hidden', din);
    $('#mount-hole-opts').classList.toggle('hidden', din);
    $('#mount-axis-title').textContent = din ? 'Ray yönü' : 'Kulak duvarı';
    $('#mount-size').innerHTML = MOUNT_SIZES.map((s) =>
      `<button type="button" class="chip" role="radio" data-msize="${s}" aria-checked="${mt.size === s}">${s}</button>`).join('');
    $('#mount-count').innerHTML = seg([[2, '2'], [4, '4']], mt.count, 'mcount');
    $('#mount-axis').innerHTML = seg(din ? [['auto', 'Otomatik'], ['x', 'X boyunca'], ['y', 'Y boyunca']] : [['auto', 'Otomatik'], ['x', '±X duvarları'], ['y', '±Y duvarları']], mt.axis, 'maxis');
    $('#mount-hole').innerHTML = seg([['round', 'Yuvarlak'], ['slot', 'Uzun delik (hizalama)']], mt.hole, 'mhole');
    const info = d?.mount?.info;
    const fp = d?.mount?.footprint;
    const n2 = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
    $('#sum-mount').textContent = mt.type === 'none' ? 'yok' : din ? `DIN TS35${info ? ` · ray ${info.axis === 0 ? 'X' : 'Y'}` : ''}` : `${info ? info.count : ''} × ${mt.size} ${mt.type === 'ears' ? 'kulak' : 'taban'}`;
    if (!info) { $('#mount-info').innerHTML = ''; return; }
    if (din) {
      const sp = info.spacing.filter((v) => v > 0.05).map(n2).join('');
      const drows = [
        ['Klips', `${n2(info.clipL)} × ${n2(info.clipW)} mm, ray ${info.axis === 0 ? 'X' : 'Y'} yönünde`],
        ['Bağlantı', `2 × ${info.method === 'self_tap' ? 'Ø3' : 'M3'}×${info.len} içeriden, aralık ${sp} mm; klipste ${info.method === 'insert' ? 'insert' : info.method === 'self_tap' ? 'sac vidası' : 'kılavuz'}`],
        ['Kilit dili', `${n2(info.t)} mm, uzama ≈ %${n2(info.strain)} (izin ≈ %${n2(info.allow)})`],
        ['Rayda yer', `${n2(info.railSpace)} mm ≈ ${info.modules} modül`],
      ];
      $('#mount-info').innerHTML = `<table class="tb-table">${drows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>`;
      return;
    }
    const rows = [
      ['Delik', `Ø${n2(info.d)}${mt.type === 'ears' && mt.hole === 'slot' ? ' (uzun)' : ''}`],
      ['Delik aralığı', info.spacing.filter((v) => v > 0.05).map(n2).join(' × ') + ' mm'],
      mt.type === 'ears' ? ['Kulak', `kalınlık ${n2(info.t)} · genişlik ${n2(info.w)} · çıkıntı ${n2(info.P)} mm`] : null,
      fp ? ['Taban izi (kulaklarla)', `${n2(fp.L)} × ${n2(fp.W)} mm`] : null,
    ].filter(Boolean);
    $('#mount-info').innerHTML = `<table class="tb-table">${rows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>`;
  }

  function setMount(patch) {
    const prev = state.rules && state.analysis ? currentDefaults() : null;
    state.mount = { ...state.mount, ...patch };
    if (prev) refreshAutoParams(prev);
    renderMount();
    update();
  }
  $('#mount-type').addEventListener('click', (e) => { const b = e.target.closest('[data-mtype]'); if (b) setMount({ type: b.dataset.mtype }); });
  $('#mount-size').addEventListener('click', (e) => { const b = e.target.closest('[data-msize]'); if (b) setMount({ size: b.dataset.msize }); });
  $('#mount-count').addEventListener('click', (e) => { const b = e.target.closest('[data-mcount]'); if (b) setMount({ count: Number(b.dataset.mcount) }); });
  $('#mount-axis').addEventListener('click', (e) => { const b = e.target.closest('[data-maxis]'); if (b) setMount({ axis: b.dataset.maxis }); });
  $('#mount-hole').addEventListener('click', (e) => { const b = e.target.closest('[data-mhole]'); if (b) setMount({ hole: b.dataset.mhole }); });

  /* ---------- Panel elemanları (Toolbox Paket D) ---------- */

  const newPanelUid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const LVL = { error: 0, warn: 1, info: 2, ok: 3 };
  const PANEL_FACES = ['-Y', '+X', '+Y', '-X'];

  /** Panel listesini değiştir: otomatik parametreler (ör. üst boşluk) yeni listeye göre güncellenir */
  function changePanel(mutate) {
    if (!state.rules || !state.analysis) { mutate(); return; }
    const prev = currentDefaults();
    mutate();
    refreshAutoParams(prev);
    update();
  }

  function renderPanelCard(d) {
    const items = new Map((d?.panel?.items || []).map((it) => [it.uid, it]));
    const types = panelTypes();
    const n2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 100) / 100).replace('.', ','));
    $('#panel-summary').textContent = state.panelParts.length ? `${state.panelParts.length} eleman` : 'yok';
    $('#panel-list').innerHTML = state.panelParts.length ? state.panelParts.map((sp) => {
      const t = types.find((x) => x.id === sp.type);
      if (!t) return '';
      const it = items.get(sp.uid);
      const lvl = it ? (it.autoFail ? 'error' : it.issues.reduce((m, q) => (LVL[q.level] < LVL[m] ? q.level : m), 'ok')) : 'ok';
      const single = ['lightpipe', 'foot'].includes(t.kind);
      const sizes = t.sizes ? Object.keys(t.sizes) : [];
      const faces = (t.faces || []).flatMap((fc) => (fc === 'wall' ? PANEL_FACES : fc === 'lid' ? ['lid'] : []));
      const sizeSel = sizes.length ? `<label class="pp-f"><span>Boyut</span><select data-pp="size">${sizes.map((s) => `<option value="${esc(s)}" ${s === (it?.size || sp.size) ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : '';
      let fields = sizeSel;
      if (!single) {
        const face = it?.face || sp.face || '-Y';
        const lid = face === 'lid';
        const uLab = lid ? 'X' : it?.uAxis || (face[1] === 'X' ? 'Y' : 'X');
        const vLab = lid ? 'Y' : 'Z';
        fields += `<label class="pp-f"><span>Yüz</span><select data-pp="face"><option value="">Otomatik${!sp.face && it ? ` (${esc(FACE_LABEL[it.face])})` : ''}</option>` +
          faces.map((fc) => `<option value="${fc}" ${sp.face === fc ? 'selected' : ''}>${esc(FACE_LABEL[fc])}</option>`).join('') + '</select></label>' +
          `<label class="pp-f num" title="${lid ? 'Kavite merkezinden X' : `Duvar boyunca kavite merkezinden ${uLab}`}"><span>${uLab}</span><input type="text" inputmode="decimal" data-pp="u" value="${n2(sp.u)}" placeholder="${n2(it?.u)}"></label>` +
          `<label class="pp-f num" title="${lid ? 'Kavite merkezinden Y' : 'Gövde alt yüzünden yükseklik'}"><span>${vLab}</span><input type="text" inputmode="decimal" data-pp="v" value="${n2(sp.v)}" placeholder="${n2(it?.v)}"></label>`;
      }
      let custom = '';
      if (t.kind === 'custom') {
        const c = { ...t.custom, ...(sp.custom || {}) };
        custom = `<div class="pp-custom">${[['d', 'Delik Ø'], ['flat', 'Düzlük'], ['af', 'Somun SW'], ['panelMax', 'Maks. et'], ['inner', 'İç boy']].map(([k, label]) =>
          `<label class="pp-f num"><span>${label}</span><input type="text" inputmode="decimal" data-pp="c-${k}" value="${n2(c[k])}"></label>`).join('')}</div>`;
      }
      const first = it ? (it.autoFail ? { level: 'error', text: 'çakışmasız yer bulunamadı (DFM kontrollerine bak)' } : it.issues.find((q) => q.level === 'error') || it.issues.find((q) => q.level === 'warn')) : null;
      const info = !it ? '' : it.kind === 'lightpipe' ? `${it.positions.length} LED · L ${[...new Set(it.positions.map((q) => n2(q.L)))].join(' / ')} mm`
        : it.kind === 'foot' ? `taban köşeleri · Ø${n2(it.pd.d)} × ${n2(it.pd.h)}`
          : `${holeText(it.hole)}${it.spot ? ` · lamba Ø${n2(it.spot.d)} × ${n2(it.spot.depth)}` : ''}${it.pigtail ? ` · pigtail ${it.pigtail} mm` : ''}` +
            `${it.wallNeed ? ` · duvara almak için üst boşluk ${n2(it.wallNeed)} mm` : ''}`;
      return `<div class="pp-row" data-uid="${sp.uid}">
        <div class="pp-head"><span class="tb-pl-dot ${lvl}"></span>${panelIcon(t.kind)}<span class="pp-title">${esc(it?.title || t.code)}</span>
          <button type="button" class="icon-btn" data-pp-del title="Kaldır" aria-label="Kaldır">×</button></div>
        ${fields ? `<div class="pp-fields">${fields}</div>` : ''}${custom}
        <div class="pp-msg small ${first ? 't-' + (first.level === 'error' ? 'err' : 'warn') : 'muted'}">${esc(first ? first.text : info)}</div>
      </div>`;
    }).join('') : '<div class="hole-empty">Panel elemanı yok. SMA/RP-SMA, kablo rakoru, basınç dengeleme, ışık borusu, lastik ayak veya veri sayfasından özel delik ekleyebilirsin.</div>';
  }

  $('#panel-list').addEventListener('change', (e) => {
    const el = e.target.closest('[data-pp]');
    const row = e.target.closest('[data-uid]');
    if (!el || !row) return;
    const uid = row.dataset.uid;
    const key = el.dataset.pp;
    const raw = String(el.value).trim();
    const numeric = key === 'u' || key === 'v' || key.startsWith('c-');
    const num = raw === '' ? null : Number(raw.replace(',', '.'));
    if (numeric && num !== null && !Number.isFinite(num)) return;
    changePanel(() => {
      state.panelParts = state.panelParts.map((sp) => {
        if (sp.uid !== uid) return sp;
        if (key === 'size') return { ...sp, size: el.value };
        if (key === 'face') return { ...sp, face: el.value || null, u: null, v: null };
        if (key === 'u' || key === 'v') {
          // Konum yazılınca yüz de sabitlenir (otomatik seçilmiş yüzde kalır)
          // Tek koordinat yazılınca diğeri de o anki (otomatik) değerinde sabitlenir: konum tamamen elle olur
          const it = state.design?.panel?.items?.find((x) => x.uid === uid);
          const other = key === 'u' ? 'v' : 'u';
          return { ...sp, [key]: num, [other]: sp[other] ?? (num === null ? null : it?.[other] ?? null), face: sp.face || it?.face || null };
        }
        if (key.startsWith('c-') && num !== null) return { ...sp, custom: { ...(sp.custom || {}), [key.slice(2)]: num } };
        return sp;
      });
    });
  });
  $('#panel-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-pp-del]');
    if (!del) return;
    const uid = del.closest('[data-uid]').dataset.uid;
    changePanel(() => { state.panelParts = state.panelParts.filter((sp) => sp.uid !== uid); });
  });

  /* ---------- DFM paneli ---------- */

  const DFM_CATS = [['genel', 'Genel'], ['surec', 'Süreç'], ['ip', 'Sızdırmazlık (IP)'], ['port', 'Port açıklıkları'], ['panel', 'Panel elemanları'], ['montaj', 'Montaj'], ['kapak', 'Kapak'], ['baglanti', 'Bağlantı']];
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
    // Tasarım döngüsü: kilitli değerlerle üret, incele, güvenli düzeltmeleri uygula ve yeniden incele; gösterilen tasarım son turunki
    const loop = runLoop();
    state.loop = loop;
    for (const fld of PARAM_FIELDS) {
      if (state.locks.has(fld.key) || !Number.isFinite(loop.params[fld.key])) continue;
      state.params[fld.key] = loop.params[fld.key];
    }
    // Parametre kutuları: kilitsizler döngünün değerini gösterir (yazılan kutuya dokunulmaz); kilitliler "değişti" işaretli
    for (const fld of PARAM_FIELDS) {
      const el = document.getElementById(`p-${fld.key}`);
      if (!el) continue;
      if (!state.locks.has(fld.key) && document.activeElement !== el) el.value = inputText(state.params[fld.key]);
      el.classList.toggle('changed', state.locks.has(fld.key));
    }
    const d = loop.design;
    state.design = d;
    renderPorts(d);
    const bom = d.bom || [];
    $('#bom-title').classList.toggle('hidden', !bom.length);
    $('#bom-list').innerHTML = bom.map((line) => `<li>${esc(line)}</li>`).join('');
    renderPreferredMatch(d);
    renderScrewPick(d);
    renderInsertPick(d);
    renderCornerPick(d);
    renderPanelCard(d);
    renderTolerance(d);
    renderMount(d);
    renderEdgeHold(d);

    const errEl = $('#design-error');
    errEl.classList.toggle('hidden', !d.error);
    errEl.textContent = d.error || '';
    $('#generate-btn').disabled = !d.ok;

    renderStats();
    // DFM listesi döngünün bulgularından (aynı görünüm; muaf bulgular bilgi olarak, bilinmeyen kategoriler Genel altında)
    const knownCats = new Set(DFM_CATS.map(([id]) => id));
    renderChecks(loop.findings.map((fd) => ({
      ...fd,
      cat: knownCats.has(fd.cat) ? fd.cat : 'genel',
      level: fd.waived ? 'info' : fd.level,
      text: fd.waived ? `${fd.text} (muaf tutuldu: ${fd.waived.reason})` : fd.text,
    })));

    // Kart özetleri ve kabuğa (sekme rozeti, durum çipi) bildirim
    const proc = state.index.processes.find((pp) => pp.id === state.process);
    $('#sum-process').textContent = `${proc.label} · ${state.rules.label}${state.lidSel && state.lidRules ? ` · kapak ${state.lidRules.label}` : ''}`;
    $('#sum-params').textContent = d.params
      ? `Et ${f2(d.params.wall)} · PCB altı ${f2(d.params.standoffHeight)} mm`
      : 'geçersiz değer';
    const mountCount = (state.analysis.holes || []).filter((h) => h.mount).length;
    const sc = d.screws && d.screws[0];
    $('#holes-summary').textContent = mountCount
      ? `${state.selectedHoles.size}/${mountCount} delik` + (sc ? ` · ${sc.code ? sc.code + ' ' : ''}${sc.size}×${sc.length === null || sc.length === undefined ? '?' : String(sc.length).replace('.', ',')}` : '') +
        (state.lidMode === 'screw' ? '' : state.lidMode === 'corner' ? ' · köşe vidalı kapak' : ' · geçme kapak')
      : 'montaj deliği yok';
    const counts = { error: loop.counts.error, warn: loop.counts.warn };
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
      const lidDensity = state.lidSel && state.lidRules ? state.lidRules.density_g_cm3 : state.rules.density_g_cm3;
      const grams = ((v.base + (v.clip || 0)) / 1000) * state.rules.density_g_cm3 + (v.lid / 1000) * lidDensity;
      mass = `${nf0.format(grams)} <span class="unit">g</span>`;
      massSub = `gövde ${nf1.format(v.base / 1000)} + kapak ${nf1.format(v.lid / 1000)}${v.clip ? ` + klips ${nf1.format(v.clip / 1000)}` : ''} cm³ · ${state.rules.label}${state.lidSel && state.lidRules ? ` / ${state.lidRules.label}` : ''}`;
    }
    $('#design-stats').innerHTML =
      stat('Dış ölçü (U × G × Y)', dims(d.outer.L, d.outer.W, d.outer.H), `${state.rules.label} · ${processLabel()}${d.mount?.footprint ? ` · kulaklarla ${f2(d.mount.footprint.L)} × ${f2(d.mount.footprint.W)}` : ''}`, 'wide accent') +
      stat('İç cep', dims(d.cavity.L, d.cavity.W, d.cavity.H), 'PCB + boşluklar') +
      stat('Et / taban / kapak', `${f2(d.params.wall)} <span class="unit">mm</span>`, `kapak dili ${f2(d.params.lipT)} mm, boşluk ${f2(d.params.fit)} mm`) +
      stat('Tahmini kütle', mass, massSub) +
      stat('Kapak dili', `${d.lipBars.length} <span class="unit">/ 4 kenar</span>`, d.lipRemoved.length ? `kaldırılan: ${d.lipRemoved.map((x) => x.side).join(', ')}` : 'tüm kenarlarda') +
      stat('Bağlantı', `${d.screws.length} <span class="unit">vida</span>`,
        d.standoffs.length ? `${d.standoffs.length} standoff · ${d.lidTubes.length} kapak borusu` : 'montaj deliği yok') +
      stat('Port açıklığı', `${d.geometry.cutouts.length}`,
        d.geometry.cutouts.length ? d.ports.filter((p) => p.enabled).map((p) => `${p.side} ${p.style === 'notch' ? 'çentik' : 'pencere'}`).join(' · ') : 'yok') +
      stat('Panel elemanı', `${(d.panel?.items || []).length}`,
        (d.panel?.items || []).length ? d.panel.items.map((it) => it.title).slice(0, 3).join(' · ') : 'yok');
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
    getWorker().postMessage({ id, geometry: d.geometry, names: { base: `${stem}_govde`, lid: `${stem}_kapak`, clip: `${stem}_din_klipsi` } });
  }

  function onWorkerMessage(ev) {
    const msg = ev.data;
    if (state.drawingId !== null && msg.id === state.drawingId) { onDrawing(msg); return; }
    if (state.asmId && msg.id === state.asmId) { onAssemblyStep(msg); return; }
    if (msg.id !== state.pendingId) return;
    if (msg.type === 'progress') {
      if (msg.stage === 'engine' && state.firstBuild) setStatus('CAD çekirdeği yükleniyor… (ilk seferde ~6 MB)');
      if (msg.stage === 'build' && state.firstBuild) setStatus('Muhafaza oluşturuluyor…');
      return;
    }
    state.pendingId = null;
    if (msg.type === 'error') {
      setBusy(false);
      state.buildError = msg.message;
      setStatus('Muhafaza oluşturulamadı: ' + msg.message, { error: true });
      document.dispatchEvent(new CustomEvent('ikra:build-error', { detail: { message: msg.message } }));
      return;
    }
    state.buildError = null;
    const d = state.pendingDesign;
    state.result = { ...msg, design: d };
    state.generated = true;
    const screws = d.screws.map((s) => ({
      x: s.x, y: s.y, d: s.d, headD: s.head_d, headH: s.head_h, length: s.length, lid: s.lid,
      head: s.head, headDActual: s.head_d_actual, driveKind: s.driveKind, drive: s.driveVal, driveA: s.driveA, driveM: s.driveM,
      size: s.size, P: s.P, tapping: s.tapping, seat: s.seat || 0, washer: s.washer, finish: s.material?.finish || 'stainless',
      z: s.zSeat ?? (s.lid ? d.geometry.zTop : state.analysis.board.top),
    }));
    const inserts = [...d.standoffs, ...(d.cornerBosses || [])].filter((s) => s.insert).map((s) => ({ x: s.x, y: s.y, z: s.z1, ...s.insert }));
    viewer.setEnclosure(msg.meshes, { explodeOffset: Math.max(d.outer.H * 0.75, 10), screws, inserts, panel: d.panel?.visuals || [] });
    const first = state.firstBuild;
    if (first) viewer.setView('iso');
    state.firstBuild = false;
    $('#enc-toggles').classList.remove('hidden');
    $('#downloads').classList.remove('hidden');
    $('#dl-stl-clip').classList.toggle('hidden', !msg.files.stlClip);
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
  $('#dl-stl-clip').addEventListener('click', () => {
    if (state.result?.files.stlClip) download(state.result.files.stlClip, `${fileStem()}_din_klipsi.stl`, 'model/stl');
  });

  /* ---------- Malzeme listesi (CSV) ve tercihli parça listesi ---------- */

  const projectInfo = () => {
    const proc = state.index?.processes.find((p) => p.id === state.process);
    return {
      project: fileStem(), material: state.rules?.label || '', process: proc?.label || '',
      date: new Date().toISOString().slice(0, 10), version: $('#app-version').textContent.replace(/^Sürüm\s*/, 'Ikra v'),
      bodies: [
        { name: `Gövde (${fileStem()}_govde)`, material: state.rules?.label || '', spec: proc?.label || '' },
        { name: `Kapak (${fileStem()}_kapak)`, material: (state.lidSel && state.lidRules ? state.lidRules.label : state.rules?.label) || '', spec: (state.lidSel ? state.index?.processes.find((p) => p.id === state.lidSel.process)?.label : proc?.label) || '' },
        ...(state.design?.geometry?.din ? [{ name: `DIN ray klipsi EN 60715 TS35 (${fileStem()}_din_klipsi)`, material: state.rules?.label || '', spec: proc?.label || '' }] : []),
      ],
    };
  };

  /** Tercihli liste yüklüyse: BOM satırlarının kaçı stokta, hangileri değil */
  function renderPreferredMatch(d = state.design) {
    const pref = state.preferred;
    const n = pref.items.length;
    $('#pref-sum').textContent = n ? `${n} kalem${pref.name ? ' · ' + pref.name : ''}` : 'yüklü değil';
    $('#pref-clear').disabled = !n;
    const parts = d?.parts || [];
    const box = $('#pref-match');
    if (!n || !parts.length) { box.classList.add('hidden'); return; }
    const miss = parts.filter((p) => !matchPreferred(p, pref.items));
    box.classList.remove('hidden');
    box.innerHTML = miss.length
      ? `<span class="t-warn">★ ${parts.length - miss.length}/${parts.length} kalem tercihli listede.</span> Listede olmayanlar: ` +
        miss.map((p) => `<b>${esc([p.standard || p.name, p.size + (p.length ? '×' + String(p.length).replace('.', ',') : ''), p.material].filter(Boolean).join(' '))}</b>`).join(', ')
      : `<span class="t-ok">★ Tüm ${parts.length} kalem tercihli listede; stok kodları BOM CSV'de.</span>`;
  }

  $('#dl-bom').addEventListener('click', () => {
    const d = state.design;
    if (!d?.parts?.length) return;
    download(new TextEncoder().encode(bomCsv(d.parts, state.preferred, projectInfo())), `${fileStem()}_ikra_bom.csv`, 'text/csv');
  });
  $('#pref-template').addEventListener('click', () => {
    download(new TextEncoder().encode(preferredTemplateCsv(state.design?.parts || [], state.preferred)), 'ikra_tercihli_parcalar.csv', 'text/csv');
  });
  $('#pref-clear').addEventListener('click', () => {
    state.preferred = { items: [], name: '', date: '' };
    savePreferred(state.preferred);
    renderPreferredMatch();
    setStatus('Tercihli parça listesi kaldırıldı.');
    setTimeout(() => setStatus(null), 1800);
  });
  $('#pref-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { items, skipped } = parsePreferredCsv(await file.text());
      if (!items.length) throw new Error('Geçerli satır bulunamadı (standart ve stok kodu dolu olmalı).');
      state.preferred = { items, name: file.name, date: new Date().toISOString().slice(0, 10) };
      const saved = savePreferred(state.preferred);
      renderPreferredMatch();
      setStatus(`Tercihli liste yüklendi: ${items.length} kalem${skipped ? `, ${skipped} satır atlandı` : ''}${saved ? '' : ' (tarayıcıda saklanamadı; sayfa yenilenince kaybolur)'}.`);
      setTimeout(() => setStatus(null), 2600);
    } catch (err) {
      setStatus('Tercihli liste okunamadı: ' + err.message, { error: true });
    }
  });

  /* ---------- Teknik resim ---------- */

  const dialog = $('#drawing-dialog');

  function requestDrawing() {
    if (!state.result) return;
    if (state.pendingId !== null) { setStatus('Muhafaza güncelleniyor, birazdan tekrar dene.', { error: true }); return; }
    state.drawingId = ++state.seq;
    $('#drawing-btn').disabled = true;
    $('#drawing-btn').lastElementChild.textContent = 'Hazırlanıyor…';
    const d = state.result.design;
    getWorker().postMessage({
      type: 'drawing', id: state.drawingId,
      assembly: { items: assemblyItems(d, state.analysis.board.top), explode: explodeOf(d) },
    });
  }
  const explodeOf = (d) => Math.round(Math.max(d.outer.H * 0.75, 10));

  /* Montaj STEP'i: gövde + kapak + bağlantı/panel elemanları (isteğe bağlı, ayrı üretilir) */
  function requestAssemblyStep() {
    if (!state.result) return;
    if (state.pendingId !== null) { setStatus('Muhafaza güncelleniyor, birazdan tekrar dene.', { error: true }); return; }
    state.asmId = ++state.seq;
    const btn = $('#dl-step-asm');
    btn.disabled = true;
    btn.lastElementChild.textContent = 'Hazırlanıyor…';
    const stem = fileStem();
    getWorker().postMessage({
      type: 'assemblyStep', id: state.asmId, items: assemblyItems(state.result.design, state.analysis.board.top),
      names: { base: `${stem}_govde`, lid: `${stem}_kapak`, clip: `${stem}_din_klipsi` },
    });
  }
  function onAssemblyStep(msg) {
    state.asmId = null;
    const btn = $('#dl-step-asm');
    btn.disabled = false;
    btn.lastElementChild.textContent = 'Montaj (bağlantı elemanlarıyla)';
    if (msg.type === 'error') { setStatus('Montaj STEP üretilemedi: ' + msg.message, { error: true }); return; }
    download(msg.step, `${fileStem()}_ikra_montaj_${state.process}-${state.material}.step`, 'model/step');
    setStatus(`Montaj STEP indirildi: gövde, kapak ve ${msg.count} eleman.`);
    setTimeout(() => setStatus(null), 2400);
  }
  $('#dl-step-asm').addEventListener('click', requestAssemblyStep);

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
        lidRules: state.lidSel && state.lidRules ? state.lidRules : null,
        explode: explodeOf(d),
        preferred: state.preferred.items,
        info: {
          project: fileStem(),
          material: state.rules.label,
          process: proc.label,
          lidMaterial: state.lidSel && state.lidRules ? state.lidRules.label : null,
          lidProcess: state.lidSel ? state.index.processes.find((p) => p.id === state.lidSel.process)?.label : null,
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
      await loadLidRules();
    } catch (err) {
      setStatus(err.message, { error: true });
      return;
    }
    $('#design-panel').classList.remove('hidden');
    state.selectedHoles = new Set((state.analysis.holes || []).map((h, i) => (h.mount ? i : -1)).filter((i) => i >= 0));
    state.lidMode = 'screw';
    state.screwSpec = { ...state.screwSpec, length: 'auto' }; // tip ve boyut korunur; boy yeni karta göre
    state.insertSpec = { ...state.insertSpec, variant: 'auto' };
    if (state.cornerSpec) state.cornerSpec = { ...state.cornerSpec, length: 'auto' };
    state.cornerAxis = 'auto'; // köşe payı ekseni karta göre yeniden seçilir
    state.panelParts = state.panelParts.map((sp) => ({ ...sp, u: null, v: null })); // panel elemanları korunur, konumları yeni karta göre
    state.portOverrides = new Map();
    state.encloseOverrides = new Map();
    state.sheets = null;
    state.drawingId = null;
    state.locks = new Set(); // yeni kart: kilitler ve muafiyetler sıfırlanır (proje açılırsa importState geri yükler)
    state.waivers = {};
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
      panelParts: (d.panel?.items || []).map((it) => ({
        type: it.type, title: it.title, size: it.size, face: it.face, u: it.u ?? null, v: it.v ?? null, hole: it.hole || null, spot: it.spot || null,
        positions: it.positions || null, issues: it.issues.map((q) => ({ level: q.level, text: q.text })),
      })),
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

  /* ---------- Proje kaydet / aç ---------- */

  /** Tasarım ayarlarının tamamı (STEP hariç): proje dosyasına yazılır */
  function exportState() {
    if (!state.rules || !state.params) return null;
    return {
      process: state.process,
      material: state.material,
      rulesId: state.rules.id,
      params: { ...state.params },
      lidMode: state.lidMode,
      cornerAxis: state.cornerAxis,
      cornerSpec: state.cornerSpec,
      selectedHoles: [...state.selectedHoles],
      portOverrides: [...state.portOverrides.entries()],
      sealing: state.sealing,
      screwSpec: state.screwSpec,
      insertSpec: state.insertSpec,
      panelParts: state.panelParts,
      fits: state.fits,
      toleranceOverride: state.tolOverrides[state.rules.id] || null,
      lidMaterial: state.lidSel,
      lidToleranceOverride: state.lidSel && state.lidRules ? state.tolOverrides[state.lidRules.id] || null : null,
      mount: state.mount,
      edgeHold: state.edgeHold,
      encloseOverrides: [...state.encloseOverrides.entries()],
      locks: [...state.locks],
      waivers: { ...state.waivers },
    };
  }

  /**
   * Proje ayarlarını uygula (STEP analizi yüklendikten sonra). Bilinmeyen malzeme/süreç atlanır ve uyarı döner.
   * Dönüş: uyarı metinleri listesi
   */
  async function importState(s) {
    const warnings = [];
    if (!s || !state.analysis) return ['Proje ayarları uygulanamadı: önce kart yüklenmeli.'];
    await loadIndex();
    const proc = state.index.processes.find((p) => p.id === s.process);
    if (proc) {
      state.process = proc.id;
      if (proc.materials.some((m) => m.id === s.material)) state.material = s.material;
      else { state.material = proc.materials[0].id; warnings.push(`"${s.material}" malzemesi bu sürümde yok; ${proc.materials[0].label} seçildi.`); }
    } else if (s.process) warnings.push(`"${s.process}" süreci bu sürümde yok.`);
    await loadRules();
    // Kapak malzemesi (projede ayrıysa)
    state.lidSel = s.lidMaterial && s.lidMaterial.process && s.lidMaterial.material ? { ...s.lidMaterial } : null;
    try { await loadLidRules(); } catch { state.lidSel = null; state.lidRules = null; warnings.push('Projedeki kapak malzemesi bu sürümde yok; kapak gövdeyle aynı malzemeden.'); }
    if (s.lidToleranceOverride && state.lidRules && Object.keys(s.lidToleranceOverride).length) {
      state.tolOverrides = { ...state.tolOverrides, [state.lidRules.id]: { ...s.lidToleranceOverride } };
      saveTolOverrides(state.tolOverrides);
    }
    const holes = (state.analysis.holes || []).map((h, i) => (h.mount ? i : -1)).filter((i) => i >= 0);
    state.selectedHoles = new Set((s.selectedHoles || []).filter((i) => holes.includes(i)));
    if ((s.selectedHoles || []).length !== state.selectedHoles.size) warnings.push('Bazı montaj delikleri bu kartta bulunamadı.');
    state.lidMode = LID_MODES.some((m) => m.id === s.lidMode) ? s.lidMode : 'screw';
    state.cornerAxis = ['auto', 'x', 'y'].includes(s.cornerAxis) ? s.cornerAxis : 'auto';
    state.cornerSpec = s.cornerSpec ? normalizeSpec(s.cornerSpec) : null;
    state.portOverrides = new Map(Array.isArray(s.portOverrides) ? s.portOverrides : []);
    state.sealing = (state.sealingIndex?.levels || []).some((l) => l.id === s.sealing) ? s.sealing : 'none';
    if (s.screwSpec) state.screwSpec = normalizeSpec(s.screwSpec) || state.screwSpec;
    if (s.insertSpec) state.insertSpec = { ...state.insertSpec, ...s.insertSpec };
    const ptypes = panelTypes();
    state.panelParts = (s.panelParts || []).filter((p) => ptypes.some((t) => t.id === p.type));
    if ((s.panelParts || []).length !== state.panelParts.length) warnings.push('Bazı panel elemanı tipleri bu sürümde yok; atlandı.');
    state.fits = { lid: 'normal', screw: 'normal', ...(s.fits || {}) };
    state.mount = { type: 'none', size: 'M4', count: 4, axis: 'auto', hole: 'round', ...(s.mount || {}) };
    state.edgeHold = ['auto', 'on', 'off'].includes(s.edgeHold) ? s.edgeHold : 'auto';
    state.encloseOverrides = new Map(Array.isArray(s.encloseOverrides) ? s.encloseOverrides : []);
    if (s.toleranceOverride && Object.keys(s.toleranceOverride).length) {
      state.tolOverrides = { ...state.tolOverrides, [state.rules.id]: { ...s.toleranceOverride } };
      saveTolOverrides(state.tolOverrides);
    }
    // Parametreler: kilitli değerler projedeki gibi, kilitsizler tasarım döngüsünden (eksik alan kural varsayılanından)
    state.waivers = s.waivers && typeof s.waivers === 'object' && !Array.isArray(s.waivers) ? { ...s.waivers } : {};
    const def = currentDefaults();
    state.params = { ...def };
    for (const fld of PARAM_FIELDS) if (Number.isFinite(s.params?.[fld.key])) state.params[fld.key] = s.params[fld.key];
    if (Array.isArray(s.locks)) {
      state.locks = new Set(s.locks.filter((k) => PARAM_FIELDS.some((fld) => fld.key === k) && Number.isFinite(s.params?.[k])));
    } else {
      // Kilit bilgisi olmayan (eski) proje: kural varsayılanından ve döngünün otomatik değerinden farklı olanlar elle girilmiş sayılır
      const base = baseParams(state.analysis, state.rules);
      state.locks = new Set(PARAM_FIELDS.map((fld) => fld.key).filter((k) => Number.isFinite(s.params?.[k]) &&
        Math.abs(s.params[k] - base[k]) > 1e-6 && Math.abs(s.params[k] - def[k]) > 1e-6));
    }
    state.sheets = null;
    renderSelectors();
    renderParams();
    renderFastening();
    update();
    // Proje açılınca muhafaza da hemen oluşturulsun
    if (state.design?.ok) generate();
    return warnings;
  }

  const hasDesign = () => !!(state.rules && state.params && state.analysis);

  /** Otomatik test (tools/selftest.ps1): tasarımın ve son katı modelin özeti */
  function selfTest() {
    const r = state.result;
    return {
      report: reportSection(),
      state: exportState(),
      built: !!r && r.design === state.design,
      volumes: r ? r.volumes : null,
      files: r ? Object.keys(r.files).filter((k) => r.files[k]) : [],
      treatReport: r?.treatReport || null,
      loop: state.loop ? { status: state.loop.status, stop: state.loop.stop, iterations: state.loop.iterations, counts: state.loop.counts, changes: state.loop.changes, findings: state.loop.findings } : null,
      buildError: state.buildError || null,
    };
  }

  return { setAnalysis, reportSection, exportState, importState, hasDesign, selfTest };
}
