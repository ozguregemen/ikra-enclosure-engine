/*
 * Tasarım arayüzü: gereksinimler ve tasarım girdileri → tasarım döngüsü (dfm/loop.js: üret → incele → düzelt →
 * yeniden incele) → inceleme paneli → katı model (cad-worker.js) → son inceleme (dfm/review.js reviewBuild) →
 * final tasarım ve çıktılar.
 *
 * Durum makinesi (phase): idle → designing → reviewing → building → built | build-error | invalid
 *   idle         kart ya da kural yok
 *   designing    computeDesign + döngü çalışıyor (eşzamanlı, kısa)
 *   reviewing    döngü bitti, bulgular birleştiriliyor
 *   building     katı model sırada (yarım saniyelik bekleme) ya da işçide
 *   built        son katı model güncel tasarımın geometrisiyle aynı
 *   build-error  bu geometri için katı model üretilemedi
 *   invalid      tasarım geçersiz ya da açık (muaf tutulmamış) hata var: katı model oluşturulmaz
 * "Güncel" karşılaştırması geometrinin parmak iziyle yapılır (muafiyet, süzgeç gibi geometri dışı değişiklikler
 * yeniden oluşturma tetiklemez).
 */
import { defaultParams, paramHint, pickScrew, screwTable, libraryTypes, LID_MODES, PARAM_FIELDS } from './design.js';
import { buildSheets, exportPdf } from './drawing.js';
import { createToolbox, headIcon, insertIcon, panelIcon } from './toolbox.js';
import { FACE_LABEL, holeText } from './panel.js';
import { loadPreferred, savePreferred, parsePreferredCsv, matchPreferred, bomCsv, preferredTemplateCsv } from './bom.js';
import { assemblyItems } from './assembly.js';
import { FIT_CLASSES, toleranceOf } from './fits.js';
import { MOUNT_TYPES, MOUNT_SIZES } from './mount.js';
import { runDesignLoop, baseParams, AUTO_KEYS } from './dfm/loop.js';
import { reviewBuild, summarize, toFinding, mergeBuildFindings, staleWaivers, validWaiver } from './dfm/review.js';
import { ruleInfo } from './dfm/catalog.js';
import { treatmentFor } from './treat.js';

const $ = (sel) => document.querySelector(sel);
const nf2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nfx = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
// Görüntülenen sayılarda eksi işareti tipografik eksidir (U+2212); "-0" hiçbir zaman yazılmaz.
// Giriş alanlarının değerleri (inputText) ASCII eksiyle kalır: kullanıcı yazdığını aynen düzenler.
const uminus = (s) => s.replace(/^[-−]/, '−');
const f2 = (v) => uminus(nf2.format(Math.round(v * 100) / 100 || 0));
const fx = (v) => uminus(nfx.format(Math.round(v * 100) / 100 || 0));
const REBUILD_MS = 500; // düzenlemeden sonra katı model yeniden oluşturma gecikmesi
const COMMIT_MS = 700; // yazarken değerin uygulanması için bekleme
const HISTORY_MAX = 50;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const inputText = (v) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100).replace('.', ',') : '');
const parseInput = (s) => {
  const t = String(s ?? '').trim().replace(',', '.');
  return t === '' || !/^[-+]?\d*\.?\d+$/.test(t) ? NaN : Number(t);
};
const dims = (a, b, c) => `${f2(a)} × ${f2(b)} × ${f2(c)} mm`;

/**
 * Kabı yeniden çiz; odak kabın içindeyse eşdeğer öğeye (kimlik ya da data-* öznitelikleri) geri döner.
 * Böylece arka planda biten bir katı model ya da inceleme güncellemesi klavye kullanıcısının yerini kaybettirmez.
 */
function rerender(el, html) {
  const a = document.activeElement;
  let sel = null;
  if (a && a !== el && el.contains(a)) {
    if (a.id) sel = `#${CSS.escape(a.id)}`;
    else {
      const holder = a.tagName === 'SUMMARY' ? a.parentElement : a;
      const attrs = [...holder.attributes].filter((x) => x.name.startsWith('data-')).map((x) => `[${x.name}="${CSS.escape(x.value)}"]`).join('');
      if (attrs) sel = `${holder.tagName.toLowerCase()}${attrs}${a.tagName === 'SUMMARY' ? ' > summary' : ''}`;
    }
  }
  el.innerHTML = html;
  if (sel) el.querySelector(sel)?.focus({ preventScroll: true });
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

/* ---------- Sözlük ---------- */

const CAT_ORDER = ['genel', 'surec', 'ip', 'montaj', 'rf', 'baglanti', 'kapak', 'port', 'panel', 'geometri'];
const CAT_LABEL = {
  genel: 'Genel', surec: 'Süreç ve malzeme', port: 'Port açıklıkları', kapak: 'Kapak', baglanti: 'Bağlantı elemanları',
  montaj: 'Kutunun sabitlenmesi', panel: 'Panel elemanları', ip: 'Sızdırmazlık (IP)', rf: 'RF ve anten', geometri: 'Katı model',
};
const LEVEL_LABEL = { error: 'Hata', warn: 'Uyarı', info: 'Bilgi', ok: 'Geçti', waived: 'Muaf' };
const LEVEL_PLURAL = { error: 'Hatalar', warn: 'Uyarılar', info: 'Bilgiler' };
const LEVEL_RANK = { error: 0, warn: 1, info: 2, ok: 3 };
// Karar adları teknik resimdeki DFM paftasıyla aynı (ÜRETİME HAZIR / UYARILARLA HAZIR / ÜRETİME UYGUN DEĞİL)
const STATUS_LABEL = { ready: 'Hazır', advisories: 'Uyarılarla hazır', blocked: 'Üretime uygun değil' };
const STATUS_ICON = { ready: 'ok', advisories: 'warn', blocked: 'error' };
const STOP_SHORT = {
  converged: 'yakınsadı', 'needs-user': 'kullanıcı kararı gerekiyor', 'max-iter': 'tur sınırına ulaşıldı',
  oscillation: 'salınım', stalled: 'ilerleme yok',
};
const STOP_TEXT = {
  converged: 'Uygulanabilecek güvenli otomatik düzeltme kalmadı; tasarım kuralların izin verdiği en iyi noktada.',
  'needs-user': 'Kalan bulguların düzeltmesi otomatik uygulanamaz: bir seçim değişikliği, kilitli bir değer ya da yalnızca öneri. Karar kullanıcıdadır.',
  'max-iter': 'Döngü en fazla 8 tur çalışır; kalan düzeltmeler gözden geçirilmelidir.',
  oscillation: 'Düzeltmeler birbirini geri aldığı için döngü durduruldu; ilgili parametrelerden biri kilitlenmelidir.',
  stalled: 'Denenen düzeltmeler bulguları azaltmadı ve geri alındı; kalan bulgular için kullanıcı kararı gerekir.',
};
const REJECT_WHY = { 'no-gain': 'bulguları azaltmadı', oscillation: 'salınıma yol açtı', 'no-effect': 'tasarımda etkisi olmadı' };
const PART_LABEL = { base: 'Gövde', lid: 'Kapak', clip: 'DIN klipsi', all: 'Tüm muhafaza' };
// Freze takım çapı (CNC): tasarım seçeneği toolDiameter (mm; null = kural dosyasındaki process_params.tool_diameter)
const TOOL_KEY = 'toolDiameter';
const TOOL_LABEL = 'Freze takım çapı';
const TOOL_LIMITS = [0.5, 12];
const PARAM_LABEL = { ...Object.fromEntries(PARAM_FIELDS.map((f) => [f.key, f.label])), [TOOL_KEY]: TOOL_LABEL };
/** Bulgunun düzeltme seçenekleri: motor fixes[] verdiyse hepsi (fixes[0] === fix, ör. Helicoil ya da daha küçük freze), yoksa yalnız fix */
const fixList = (fd) => (Array.isArray(fd?.fixes) && fd.fixes.length ? fd.fixes : fd?.fix ? [fd.fix] : []).filter((x) => x && x.key);
const PARAM_LIMITS = { wall: [0.2, 20], pcbClearance: [0, 20], topClearance: [0, 100], standoffHeight: [0, 100], cornerRadius: [0, 50] };
/** Katı modelden önce değerlendirilemeyen (yalnızca son incelemede üretilen) kurallar: muafiyetleri ön incelemede "eşleşmeyen" sayılmaz */
const POST_ONLY_RULES = new Set(['GEO-TREAT', 'GEO-BUILD']);
const STAGE_CATS = { req: ['surec', 'ip', 'montaj', 'rf'], design: ['genel', 'port', 'kapak', 'baglanti', 'panel'] };
const CONF_LABEL = { high: 'yüksek', medium: 'orta', low: 'düşük' };
const KIND_LABEL = {
  chamfer: 'pah', fillet: 'radyüs', draft: 'çıkma açısı', countersink: 'havşa', dogbone: 'köşe boşaltma',
  leadin: 'giriş pahı', boolean: 'Boole işlemi', build: 'parça', info: 'bilgi',
};
const DEFAULT_MATERIAL = { fdm: 'petg' }; // FDM'de varsayılan PETG (PLA ısıda şekil değiştirir)
// Sıcaklık gereksinimi kuralı (dfm/catalog.js REQ-TEMP: başlık, gerekçe ve kaynaklar katalogdan; requirementFindings)
const REQ_TEMP_RULE = 'REQ-TEMP';

/* Düzey simgeleri: biçim + metin, renk tek başına anlam taşımaz */
const ICON_PATHS = {
  error: '<path class="bg" d="M6.9 1h6.2L19 6.9v6.2L13.1 19H6.9L1 13.1V6.9z"/><path class="fg" d="M7 7l6 6M13 7l-6 6"/>',
  warn: '<path class="bg" d="M10 1.2 19.2 18.3H.8z"/><path class="fg" d="M10 7.2v4.8M10 15.1h.01"/>',
  info: '<circle class="bg" cx="10" cy="10" r="9"/><path class="fg" d="M10 9v5M10 6.1h.01"/>',
  ok: '<circle class="bg" cx="10" cy="10" r="9"/><path class="fg" d="m5.8 10.2 2.9 2.9 5.5-5.6"/>',
  waived: '<circle class="bg" cx="10" cy="10" r="9"/><path class="fg" d="M6 10h8"/>',
  run: '<circle class="bg" cx="10" cy="10" r="9"/><path class="fg" d="M10 5.5V10l3 2"/>',
  pending: '<circle class="bg" cx="10" cy="10" r="8.4"/><path class="fg" d="M7 10h6"/>',
};
const lvlIcon = (lvl) => `<svg class="lvl-ico ${lvl}" viewBox="0 0 20 20" aria-hidden="true">${ICON_PATHS[lvl] || ICON_PATHS.info}</svg>`;
const LOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const UNLOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>';
// Düğme etiketinin son sözcüğü (bütün sözcük) bir eylemse etiket olduğu gibi kullanılır; değilse "Uygula: …" öneki alır
const VERB_END = /^(uygula|yap|seç|ekle|aç|kapat|al|geç|kaldır|çıkar|kullan|kullanma|değiştir|büyüt|artır|ver|getir|çevir|taşı|azalt|düşür|koy)$/i;

/**
 * ui: main.js'in bildirim ve gezinme yardımcıları
 *   toast(text, {action, onAction, timeout}), announce(text), alert(text, {actions}), clearAlert(), progress(text|null),
 *   confirm({title, html, buttons}) → Promise<id|null>, selectStage(id, {focus}), setStageStatus(id, status, sr),
 *   openReview(), closeReview(), isDrawer(), appVersion
 */
export function createDesignUI({ viewer, ui }) {
  const state = {
    index: null,
    rulesCache: new Map(),
    process: 'fdm',
    material: DEFAULT_MATERIAL.fdm,
    rules: null,
    analysis: null,
    fileName: '',
    params: null,
    design: null,
    worker: null,
    seq: 0,
    inFlight: null, // { id, key, design, treat, treatErr, t0, force }
    buildTimer: null,
    buildQueued: false,
    buildStage: null,
    buildFail: null, // { key, message }
    buildError: null,
    holdBuild: false, // proje uygulanana kadar katı model bekletilir
    force: false,
    forceKey: null,
    result: null, // son katı model: { ...worker mesajı, design (treat + treatReport ekli kopya), geomKey, buildMs }
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
    asmId: null,
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
    mount: { type: 'none', size: 'M4', count: 4, axis: 'auto', hole: 'round' }, // kutunun sabitlenmesi
    lidSel: null, // { process, material } — null: kapak gövdeyle aynı malzeme
    edgeHold: 'auto', // kart kenarı tutucu: auto (delik yoksa) / on / off
    encloseOverrides: new Map(), // partId → true (kutunun içine al) / false (duvardan çıkar)
    lidRules: null,
    tolEdit: 'body', // tolerans kartında düzenlenen malzeme: gövde / kapak
    tolOverrides: loadTolOverrides(),
    locks: new Set(), // kullanıcının yazdığı (kilitli) anahtarlar: tasarım döngüsü bunları değiştirmez
    toolDiameter: null, // CNC freze takım çapı (mm); null: kural dosyasının değeri. Yazılınca "Kilitli" sayılır
    waivers: {}, // { bulguId: { reason, date, rule, title } } — kullanıcı muafiyetleri (proje dosyasına yazılır)
    req: { tempMax: null }, // gereksinimler: en yüksek çalışma sıcaklığı (°C)
    loop: null, // son tasarım döngüsü sonucu (dfm/loop.js)
    post: null, // son inceleme bulguları (güncel katı model için)
    review: null, // birleşik inceleme (ön + son)
    lastStatus: null,
    filter: { level: 'all', cat: 'all' },
    openSecs: new Set(['sec:changes']),
    silent: false,
    actionLabel: null,
    hist: { undo: [], redo: [], present: null, saved: null, seq: 0, busy: Promise.resolve() },
    commitTimer: null,
    paramsRendering: false, // parametre alanları yeniden çiziliyor: kaldırılan alanın blur/change olayı uygulanmaz
  };

  /* ---------- Kural dosyaları ---------- */

  async function getJson(url, msg) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(msg);
    return res.json();
  }

  async function loadIndex() {
    if (!state.index) state.index = await getJson('rules/index.json', 'Kural listesi yüklenemedi.');
    if (!state.sealingIndex) state.sealingIndex = await getJson('rules/sealing.json', 'Sızdırmazlık kuralları yüklenemedi.');
    await loadToolbox();
    return state.index;
  }

  async function loadToolbox() {
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

  async function rulesFile(file) {
    if (!state.rulesCache.has(file)) state.rulesCache.set(file, await getJson('rules/' + file, `Kural dosyası yüklenemedi: ${file}`));
    return state.rulesCache.get(file);
  }

  async function loadRules() {
    const proc = state.index.processes.find((p) => p.id === state.process);
    const mat = proc.materials.find((m) => m.id === state.material) || proc.materials[0];
    state.material = mat.id;
    state.rules = await rulesFile(mat.file);
  }

  /** Gereksinim karşılaştırması için süreçteki tüm malzeme dosyaları (küçük JSON'lar; isteğe bağlı) */
  async function ensureProcessRules(processId) {
    const proc = state.index?.processes.find((p) => p.id === processId);
    if (!proc) return;
    await Promise.all(proc.materials.map((m) => rulesFile(m.file).catch(() => null)));
  }
  const rulesOf = (processId, materialId) => {
    const proc = state.index?.processes.find((p) => p.id === processId);
    const m = proc?.materials.find((x) => x.id === materialId);
    return m ? state.rulesCache.get(m.file) || null : null;
  };

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

  /** Toolbox seçimini uygula: kilitsiz parametreler yeni vida/burca göre döngüden yeniden gelir */
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
    state.screwSpec = next;
    state.insertSpec = nextIns;
    if (panel) state.panelParts = panel;
    // Toolbox'ta aralayıcı boyu seçildiyse PCB altı yükseklik bu boy olur ve kilitlenir (döngü değiştirmez)
    if (nextIns.type === 'standoff' && ispec.standoffLen) {
      state.params.standoffHeight = Number(ispec.standoffLen);
      state.locks.add('standoffHeight');
    }
    refreshAutoParams();
    renderFastening();
    state.actionLabel = 'Toolbox seçimi';
    update();
  }
  const setScrewSpec = (spec) => setToolboxSpec(spec, state.insertSpec);

  /** Kilitli değerler ve muafiyetlerle tasarım döngüsü (önizlemeler uygulanınca oluşacak tasarımla aynıdır) */
  const loopWith = (opts, extraLocks = {}) => runDesignLoop(state.analysis, state.rules,
    { userParams: { ...lockedParams(), ...extraLocks }, waivers: state.waivers, maxIter: 8 }, opts);

  /**
   * Toolbox penceresinin canlı hesabı: seçilen vida tipine/boyutuna göre otomatik boylu tasarım (boy durumları için)
   * ve tam seçimli tasarım. İkisi de kilitlerle ve muafiyetlerle döngüden geçer.
   */
  function evaluateSpec(spec, ispec = state.insertSpec, cspec = state.cornerSpec) {
    if (!state.analysis || !state.rules || !state.params || !state.analysis.board || state.analysis.board.axes.n !== 'Z') return null;
    const opts = (sp, ip, cp) => ({ ...designOptions(), screwSpec: sp, insertSpec: ip, cornerSpec: cp });
    const extra = ispec && ispec.type === 'standoff' && ispec.standoffLen ? { standoffHeight: Number(ispec.standoffLen) } : {};
    const autoSpec = { ...spec, length: 'auto' };
    const autoC = cspec ? { ...cspec, length: 'auto' } : null;
    const auto = loopWith(opts(autoSpec, ispec, autoC), extra).design;
    const same = spec.length === 'auto' && (!cspec || cspec.length === 'auto');
    const sel = same ? auto : loopWith(opts(spec, ispec, cspec), extra).design;
    return {
      auto,
      sel,
      standoffAuto: !state.locks.has('standoffHeight'),
      standoffNow: state.params.standoffHeight,
      ruleMethod: state.rules.fastening || 'insert',
      helicoilD: state.rules.helicoil_length_d || 2,
      process: state.rules.process,
    };
  }

  /** Toolbox panel görünümünün canlı hesabı: taslak panel listesiyle döngüden geçmiş tasarım */
  function evaluatePanel(list) {
    if (!state.analysis || !state.rules || !state.params || !state.analysis.board || state.analysis.board.axes.n !== 'Z') return null;
    return loopWith({ ...designOptions(), panelParts: list }).design;
  }

  function openToolbox(view = 'screw', group = 'pcb', panelType = null) {
    loadToolbox()
      .then(() => state.toolboxUI.open(state.screwSpec, state.insertSpec, view, {
        corner: state.cornerSpec, group, cornerMode: state.lidMode === 'corner', panel: state.panelParts, panelType,
      }))
      .catch((err) => ui.alert(err.message));
  }
  $('#panel-add').addEventListener('click', () => openToolbox('panel', 'pcb', state.panelParts.length ? null : 'sma-bh'));
  $('#toolbox-btn').addEventListener('click', () => openToolbox('screw'));
  $('#screw-pick').addEventListener('click', () => openToolbox('screw', 'pcb'));
  $('#corner-pick').addEventListener('click', () => openToolbox('screw', 'corner'));
  $('#insert-pick').addEventListener('click', () => openToolbox('insert'));

  /** Kapak bağlantısı kartındaki köşe (kapak) vidası satırı */
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
    state.cornerAxis = btn.dataset.axis;
    refreshAutoParams();
    state.actionLabel = 'Köşe payı ekseni';
    update();
  });

  /** Kartın tutulması kartındaki gövde tarafı satırı: burç / kılavuz / ön delik */
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

  /** Kartın tutulması kartındaki vida satırı: seçili tip, etkin boyut × boy */
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

  /* ---------- Süreç ve malzeme (Gereksinimler) ---------- */

  const processSeg = (cur) => state.index.processes.map((p) =>
    `<button type="button" role="radio" data-process="${p.id}" aria-checked="${p.id === cur}">${esc(p.label)}</button>`).join('');
  // Malzemeler gruplu (index.json "group"); sıcaklık gereksinimi verildiyse yetersiz malzemeler işaretlenir
  function materialChips(processId, cur) {
    const proc = state.index.processes.find((p) => p.id === processId);
    const tmax = state.req.tempMax;
    let lastGroup = null;
    return proc.materials.map((m) => {
      const head = m.group && m.group !== lastGroup ? `<span class="chip-group" aria-hidden="true">${esc(m.group)}</span>` : '';
      lastGroup = m.group || lastGroup;
      const r = tmax ? rulesOf(processId, m.id) : null;
      const low = r && Number.isFinite(r.max_service_temp_c) && r.max_service_temp_c < tmax;
      const tip = `${m.title || m.label}${r && Number.isFinite(r.max_service_temp_c) ? ` · sürekli kullanım ≈ ${r.max_service_temp_c} °C` : ''}${low ? ' · sıcaklık gereksinimini karşılamıyor' : ''}`;
      return `${head}<button type="button" class="chip" role="radio" data-material="${m.id}" aria-checked="${m.id === cur}" title="${esc(tip)}">${esc(m.label)}` +
        `${low ? `<span class="chip-warn" aria-hidden="true">!</span><span class="vh"> (sıcaklık gereksinimi karşılanmıyor)</span>` : ''}</button>`;
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
    renderTempReq();
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

  /** Sıcaklık gereksinimi: seçili malzemenin sürekli kullanım sıcaklığıyla karşılaştırma ve uygun malzemeler */
  function renderTempReq() {
    const input = $('#req-temp');
    const msg = $('#req-temp-msg');
    if (document.activeElement !== input && input.getAttribute('aria-invalid') !== 'true') input.value = state.req.tempMax ? String(state.req.tempMax) : '';
    const tmax = state.req.tempMax;
    if (!tmax || !state.rules) { if (input.getAttribute('aria-invalid') !== 'true') { msg.textContent = ''; msg.className = 'field-msg'; } return; }
    const r = state.rules;
    const proc = state.index.processes.find((p) => p.id === state.process);
    const fits = proc.materials.map((m) => ({ m, r: rulesOf(state.process, m.id) }))
      .filter((x) => x.r && Number.isFinite(x.r.max_service_temp_c) && x.r.max_service_temp_c >= tmax)
      .sort((a, b) => a.r.max_service_temp_c - b.r.max_service_temp_c).slice(0, 4);
    if (Number.isFinite(r.max_service_temp_c) && r.max_service_temp_c < tmax) {
      msg.className = 'field-msg warn';
      msg.textContent = `${r.label} sürekli kullanımda ≈ ${r.max_service_temp_c} °C: istenen ${tmax} °C için yetersiz. ` +
        (fits.length ? `Bu süreçte uygun: ${fits.map((x) => `${x.m.label} (≈ ${x.r.max_service_temp_c} °C)`).join(', ')}.` : 'Bu süreçte uygun malzeme yok; başka süreç seçilmeli.') +
        ' Tasarım incelemesinde hata olarak listelenir.';
    } else {
      msg.className = 'field-msg';
      msg.textContent = `${r.label} (≈ ${r.max_service_temp_c ?? '?'} °C) bu gereksinimi karşılıyor; sıcaklıkta sünme ve uzun süreli yaşlanma ayrıca doğrulanmalı.`;
    }
  }
  $('#req-temp').addEventListener('change', async (e) => {
    const input = e.target;
    const raw = String(input.value).trim();
    const msg = $('#req-temp-msg');
    if (raw === '') { input.setAttribute('aria-invalid', 'false'); state.req = { tempMax: null }; renderSelectors(); state.actionLabel = 'Sıcaklık gereksinimi'; update(); return; }
    const v = parseInput(raw);
    if (!Number.isFinite(v) || v < -60 || v > 400) {
      input.setAttribute('aria-invalid', 'true');
      msg.className = 'field-msg error';
      msg.textContent = 'Sıcaklık −60 ile 400 °C arasında bir sayı olmalı; değer uygulanmadı.';
      return;
    }
    input.setAttribute('aria-invalid', 'false');
    state.req = { tempMax: Math.round(v) };
    try { await ensureProcessRules(state.process); if (state.lidSel) await ensureProcessRules(state.lidSel.process); } catch { /* yalnızca işaretleme */ }
    renderSelectors();
    state.actionLabel = 'Sıcaklık gereksinimi';
    update();
  });

  $('#process-seg').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-process]');
    if (!btn || btn.dataset.process === state.process) return;
    state.process = btn.dataset.process;
    const proc = state.index.processes.find((p) => p.id === state.process);
    state.material = (proc.materials.find((m) => m.id === DEFAULT_MATERIAL[state.process]) || proc.materials[0]).id;
    if (state.req.tempMax) await ensureProcessRules(state.process).catch(() => null);
    await applyRules(`Süreç: ${proc.label}`);
  });
  $('#material-chips').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-material]');
    if (!btn || btn.dataset.material === state.material) return;
    state.material = btn.dataset.material;
    await applyRules('Malzeme');
  });

  /** Kapak kural dosyası (ayrı malzeme seçiliyse) */
  async function loadLidRules() {
    if (!state.lidSel) { state.lidRules = null; return; }
    const proc = state.index.processes.find((p) => p.id === state.lidSel.process) || state.index.processes[0];
    const mat = proc.materials.find((m) => m.id === state.lidSel.material) || proc.materials[0];
    state.lidSel = { process: proc.id, material: mat.id };
    state.lidRules = await rulesFile(mat.file);
  }
  async function setLidSel(sel) {
    const had = state.rules && state.analysis;
    state.lidSel = sel;
    try { await loadLidRules(); } catch (err) { ui.alert(err.message); return; }
    if (state.req.tempMax && state.lidSel) await ensureProcessRules(state.lidSel.process).catch(() => null);
    if (!state.lidSel) state.tolEdit = 'body';
    if (had) refreshAutoParams();
    renderSelectors();
    state.actionLabel = 'Kapak malzemesi';
    update();
  }
  $('#lid-mat-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lidmode]');
    if (!btn) return;
    if (btn.dataset.lidmode === 'same') { if (state.lidSel) setLidSel(null); return; }
    if (state.lidSel) return;
    // Varsayılan: aynı süreçte şeffaf/ışık geçiren bir malzeme varsa o (CNC'de PMMA), yoksa başka bir malzeme
    const proc = state.index.processes.find((p) => p.id === state.process);
    const pick = proc.materials.find((m) => m.id === 'pmma') || proc.materials.find((m) => m.id !== state.material) || proc.materials[0];
    setLidSel({ process: state.process, material: pick.id });
  });
  $('#lid-process-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-process]');
    if (!btn || !state.lidSel || btn.dataset.process === state.lidSel.process) return;
    const proc = state.index.processes.find((p) => p.id === btn.dataset.process);
    setLidSel({ process: proc.id, material: (proc.materials.find((m) => m.id === DEFAULT_MATERIAL[proc.id]) || proc.materials[0]).id });
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
    // Yalnızca CNC (gövde ya da ayrı kapak) varken; süreç değişince saklanan değer başka sürece uygulanmaz
    toolDiameter: usesCnc() ? state.toolDiameter : null,
  });
  /** CNC süreci (gövde ya da ayrı kapak) var mı; freze takım çapı alanı yalnızca o zaman gösterilir */
  const usesCnc = () => state.rules?.process === 'cnc' || !!(state.lidSel && state.lidRules?.process === 'cnc');
  /** Kural dosyasındaki takım çapı (gövde CNC ise gövdenin, değilse CNC kapağın); CNC yoksa null */
  const ruleToolD = () => {
    const R = state.rules?.process === 'cnc' ? state.rules : state.lidSel && state.lidRules?.process === 'cnc' ? state.lidRules : null;
    const v = Number(R?.process_params?.tool_diameter);
    return R ? (Number.isFinite(v) && v > 0 ? v : 3) : null;
  };
  const validToolD = (v) => Number.isFinite(v) && v >= TOOL_LIMITS[0] - 1e-9 && v <= TOOL_LIMITS[1] + 1e-9;
  /** Kilitli (kullanıcının yazdığı) değer sayısı: parametre kilitleri + elle yazılmış takım çapı */
  const lockCount = () => state.locks.size + (state.toolDiameter !== null && usesCnc() ? 1 : 0);
  /** Tüm kilitler kaldırılır: parametreler ve takım çapı yeniden otomatik (kural değeri) */
  const clearLocks = () => { state.locks = new Set(); state.toolDiameter = null; };
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

  /** Seçim değişince kilitsiz parametreler döngünün yeni sonucuna çekilir */
  function refreshAutoParams() {
    if (!state.analysis || !state.rules || !state.params) return;
    const next = runLoop().params;
    for (const key of Object.keys(next)) if (!state.locks.has(key)) state.params[key] = next[key];
  }

  /** Süreç ya da malzeme değişti: kilitli kullanıcı değerleri korunur, kilitsizler yeni kural setinden gelir */
  async function applyRules(label = 'Malzeme') {
    const keep = lockedParams();
    try {
      await loadRules();
      await loadLidRules();
    } catch (err) {
      ui.alert(err.message);
      return;
    }
    state.params = { ...currentDefaults(), ...keep };
    renderSelectors();
    renderParams();
    state.actionLabel = `${label}: ${state.rules.label}`;
    update();
    const kept = Object.entries(keep).map(([k, v]) => `${PARAM_LABEL[k] || k} ${fx(v)} mm`);
    if (state.toolDiameter !== null && usesCnc()) kept.push(`${TOOL_LABEL} Ø${fx(state.toolDiameter)} mm`);
    if (kept.length) {
      ui.toast(`Kilitli değerler korundu: ${kept.join(', ')}.`, {
        action: 'Kilitleri kaldır',
        onAction: () => { clearLocks(); renderParams(); state.actionLabel = 'Kilitler kaldırıldı'; update(); },
        timeout: 9000,
      });
    }
  }

  /* ---------- Parametreler: Otomatik / Kilitli ---------- */

  function renderParams() {
    if (!state.rules || !state.params) return;
    // Odaktaki alan kaldırılırken tarayıcı blur/change olaylarını eşzamanlı yayar: bu sırada uygulama yapılmaz
    // (geri almada eski yazılan değer yeni durumun üstüne yeniden yazılmasın)
    state.paramsRendering = true;
    try { renderParamsHtml(); } finally { state.paramsRendering = false; }
    syncParamInputs();
  }
  function renderParamsHtml() {
    // Takım çapı kendi satırında (toolRowHtml); PARAM_FIELDS'e eklenirse iki kez çizilmez
    $('#params').innerHTML = PARAM_FIELDS.filter((fld) => fld.key !== TOOL_KEY).map((fld) => {
      const k = fld.key;
      return `
      <div class="param" data-key="${k}">
        <span class="p-lab"><label for="p-${k}">${esc(fld.label)}</label><span class="mode-badge" id="p-${k}-mode">Otomatik</span></span>
        <button type="button" class="lock-btn" data-lock="${k}" aria-pressed="false" aria-label="${esc(fld.label)} değerini kilitle" aria-describedby="p-${k}-mode">${UNLOCK_SVG}</button>
        <div class="input-wrap">
          <input id="p-${k}" data-key="${k}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
            aria-describedby="p-${k}-hint p-${k}-msg" aria-invalid="false" value="${inputText(state.params[k])}">
          <span class="unit">mm</span>
        </div>
        <span class="hint" id="p-${k}-hint"></span>
        <span class="auto-note" id="p-${k}-auto" hidden></span>
        <span class="field-msg" id="p-${k}-msg"></span>
      </div>`;
    }).join('') + toolRowHtml();
  }

  /** Freze takım çapı satırı (yalnızca CNC): boş = kural değeri (yer tutucuda), yazılan değer kilitlenir */
  function toolRowHtml() {
    if (!usesCnc()) return '';
    const def = ruleToolD();
    return `
      <div class="param" data-tool-row>
        <span class="p-lab"><label for="p-tool">${TOOL_LABEL}</label><span class="mode-badge" id="p-tool-mode">Otomatik</span></span>
        <button type="button" class="lock-btn" data-tool-lock aria-pressed="false" aria-label="${TOOL_LABEL} değerini kilitle" aria-describedby="p-tool-mode">${UNLOCK_SVG}</button>
        <div class="input-wrap">
          <input id="p-tool" data-tool type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
            aria-describedby="p-tool-hint p-tool-msg" aria-invalid="false" value="${state.toolDiameter !== null ? inputText(state.toolDiameter) : ''}" placeholder="${inputText(def)}">
          <span class="unit">mm</span>
        </div>
        <span class="hint" id="p-tool-hint"></span>
        <span class="auto-note" id="p-tool-auto" hidden></span>
        <span class="field-msg" id="p-tool-msg"></span>
      </div>`;
  }

  /** Takım çapı alanı doğrulaması: boş → kural değeri (v null); geçersiz ya da 0,5–12 mm dışı → uygulanmaz */
  function validateTool(input) {
    const msg = document.getElementById('p-tool-msg');
    const raw = String(input.value).trim();
    const v = raw === '' ? null : parseInput(raw);
    let err = '';
    if (v !== null && !Number.isFinite(v)) err = 'Sayı girilmeli (ör. 3); değer uygulanmadı.';
    else if (v !== null && !validToolD(v)) err = `Takım çapı ${fx(TOOL_LIMITS[0])}–${fx(TOOL_LIMITS[1])} mm arasında olmalı; değer uygulanmadı.`;
    input.setAttribute('aria-invalid', String(!!err));
    if (msg) { msg.className = `field-msg${err ? ' error' : ''}`; msg.textContent = err; }
    return err ? { ok: false } : { ok: true, v };
  }

  function commitTool(input) {
    clearTimeout(state.commitTimer);
    // Yeniden çizimde kaldırılan (ör. geri almada) odaktaki alanın blur/change olayı eski değeri yeniden yazmasın
    if (state.paramsRendering || !input.isConnected) return;
    const r = validateTool(input);
    if (!r.ok) return;
    const cur = state.toolDiameter;
    if ((r.v === null && cur === null) || (r.v !== null && cur !== null && Math.abs(r.v - cur) < 1e-9)) return;
    state.toolDiameter = r.v === null ? null : Math.round(r.v * 100) / 100;
    state.actionLabel = r.v === null ? `${TOOL_LABEL}: kural değeri` : `${TOOL_LABEL} Ø${fx(r.v)} mm`;
    update();
  }

  /** Takım çapı satırını durumla eşitle (CNC değilse satır yoktur; süreç değişince satır yeniden çizilir) */
  function syncToolRow() {
    const row = document.querySelector('.param[data-tool-row]');
    if (!!row !== usesCnc()) { renderParams(); return; }
    if (!row) return;
    const input = row.querySelector('input');
    const locked = state.toolDiameter !== null;
    const def = ruleToolD();
    input.placeholder = inputText(def);
    if (document.activeElement !== input && input.getAttribute('aria-invalid') !== 'true') {
      input.value = locked ? inputText(state.toolDiameter) : '';
      validateTool(input);
    }
    input.classList.toggle('locked', locked);
    const btn = row.querySelector('.lock-btn');
    btn.setAttribute('aria-pressed', String(locked));
    btn.innerHTML = locked ? LOCK_SVG : UNLOCK_SVG;
    btn.title = locked ? 'Kilitli: kilidi kaldırınca kural değerine döner' : 'Otomatik (kural değeri): kilitlenirse bu değer sabit kalır';
    const badge = row.querySelector('.mode-badge');
    badge.textContent = locked ? 'Kilitli' : 'Otomatik';
    badge.classList.toggle('locked', locked);
    row.querySelector('.hint').textContent = `Boş: kural değeri Ø${fx(def)} mm. Atölyedeki en küçük parmak frezenin çapı yazılır; iç köşe radyüsü (≥ takım yarıçapı), port ve cep köşeleri ile somun cebi köşe boşaltması buna göre.`;
    const note = row.querySelector('.auto-note');
    // Freze önerisi birincil düzeltme ya da seçenek (fixes[]) olabilir; katı model sonrası bulgular da (birleşik inceleme) sayılır
    const toolFixOf = (fd) => fixList(fd).find((x) => x.key === TOOL_KEY && Number.isFinite(Number(x.value)));
    const want = (state.review?.findings || state.loop?.findings || []).filter((fd) => !fd.waived && (fd.level === 'error' || fd.level === 'warn') && toolFixOf(fd));
    const text = want.length
      ? `${locked ? 'Kilitli değer: ' : ''}kural önerisi Ø${fx(Math.min(...want.map((fd) => Number(toolFixOf(fd).value))))} mm${locked ? ' uygulanmadı' : ''} (${[...new Set(want.map((fd) => fd.rule))].join(', ')})`
      : '';
    note.hidden = !text;
    note.textContent = text;
  }

  /** Alanları durumla eşitle (odaktaki alanın yazılan değerine dokunulmaz) */
  function syncParamInputs() {
    if (!state.rules || !state.params || !state.analysis) return;
    const defaults = currentDefaults();
    const loop = state.loop;
    for (const fld of PARAM_FIELDS) {
      const k = fld.key;
      const row = document.querySelector(`.param[data-key="${k}"]`);
      if (!row) continue;
      const input = row.querySelector('input');
      const locked = state.locks.has(k);
      if (document.activeElement !== input && input.getAttribute('aria-invalid') !== 'true') {
        // Değer dışarıdan değişti (döngü, düzeltme, geri alma): alan ve iletisi yeniden doğrulanır
        input.value = inputText(state.params[k]);
        validateParam(input);
      }
      input.classList.toggle('locked', locked);
      const btn = row.querySelector('.lock-btn');
      btn.setAttribute('aria-pressed', String(locked));
      btn.innerHTML = locked ? LOCK_SVG : UNLOCK_SVG;
      btn.title = locked ? 'Kilitli: kilidi kaldırınca değer yeniden otomatik olur' : 'Otomatik: kilitlenirse döngü bu değeri değiştirmez';
      const badge = row.querySelector('.mode-badge');
      badge.textContent = locked ? 'Kilitli' : 'Otomatik';
      badge.classList.toggle('locked', locked);
      // CNC iç köşe ipucu seçili freze çapına göre (boş: kural dosyası)
      row.querySelector('.hint').textContent = paramHint(k, state.rules, state.analysis, defaults, usesCnc() ? state.toolDiameter : null);
      const note = row.querySelector('.auto-note');
      let text = '';
      if (!locked && loop) {
        const ch = loop.changes.filter((c) => c.key === k);
        if (ch.length) text = `İnceleme döngüsü: ${fx(ch[0].from)} → ${fx(ch[ch.length - 1].to)} mm (${[...new Set(ch.map((c) => c.rule))].join(', ')})`;
      } else if (locked && loop) {
        const want = loop.findings.filter((fd) => !fd.waived && (fd.level === 'error' || fd.level === 'warn') && fd.fix && fd.fix.key === k && typeof fd.fix.value === 'number');
        if (want.length) text = `Kilitli değer: kural önerisi ${fx(Math.max(...want.map((fd) => fd.fix.value)))} mm uygulanmadı (${[...new Set(want.map((fd) => fd.rule))].join(', ')})`;
      }
      note.hidden = !text;
      note.textContent = text;
    }
    syncToolRow();
    const n = lockCount();
    $('#params-lock-sum').textContent = n ? `${n} kilitli parametre` : 'tüm parametreler otomatik';
    $('#params-reset').disabled = !n;
  }

  /** Alan doğrulaması: geçersiz ya da aralık dışı değer uygulanmaz */
  function validateParam(input) {
    const k = input.dataset.key;
    const fld = PARAM_FIELDS.find((x) => x.key === k);
    const msg = document.getElementById(`p-${k}-msg`);
    const v = parseInput(input.value);
    const [lo, hi] = PARAM_LIMITS[k] || [0, 1000];
    let err = '';
    if (!Number.isFinite(v)) err = 'Sayı girilmeli (ör. 2,4); değer uygulanmadı.';
    else if (v < lo || v > hi) err = `İzin verilen aralık ${fx(lo)}–${fx(hi)} mm; değer uygulanmadı.`;
    input.setAttribute('aria-invalid', String(!!err));
    if (err) { msg.className = 'field-msg error'; msg.textContent = err; return null; }
    let warn = '';
    if (k === 'wall' && state.rules && v < state.rules.min_wall - 1e-9) warn = `${state.rules.label} için en az et ${fx(state.rules.min_wall)} mm: tasarım hata verir.`;
    msg.className = 'field-msg warn';
    msg.textContent = warn;
    void fld;
    return v;
  }

  function commitParam(input) {
    clearTimeout(state.commitTimer);
    if (state.paramsRendering || !input.isConnected) return; // yeniden çizimde kaldırılan alanın blur/change olayı
    const v = validateParam(input);
    if (v === null) return;
    const k = input.dataset.key;
    // Değer değişmediyse hiçbir şey yapılmaz: otomatik alan yalnızca farklı bir değer yazılınca (ya da kilit düğmesiyle) kilitlenir
    // (otomatik değer alanda iki ondalığa yuvarlı görünür; görünen değer aynen onaylanırsa da değişiklik sayılmaz)
    if (Math.abs(state.params[k] - v) < 1e-9 || (!state.locks.has(k) && inputText(v) === inputText(state.params[k]))) return;
    state.params[k] = v;
    state.locks.add(k); // yazılan değer kilitlenir: döngü değiştirmez
    state.actionLabel = `${PARAM_LABEL[k]} ${fx(v)} mm`;
    update();
  }

  /* Freze takım çapı alanı: Enter, odaktan çıkış ya da 0,7 s bekleme uygular; Esc vazgeçer; ↑/↓ 0,5 mm (Shift: 1 mm) */
  $('#params').addEventListener('input', (e) => {
    const input = e.target.closest('input[data-tool]');
    if (!input) return;
    clearTimeout(state.commitTimer);
    if (validateTool(input).ok) state.commitTimer = setTimeout(() => commitTool(input), COMMIT_MS);
  });
  $('#params').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-tool]');
    if (input) commitTool(input);
  });
  $('#params').addEventListener('keydown', (e) => {
    const input = e.target.closest('input[data-tool]');
    if (!input) return;
    if (e.key === 'Enter') { e.preventDefault(); commitTool(input); return; }
    if (e.key === 'Escape') {
      clearTimeout(state.commitTimer);
      state.commitTimer = null;
      input.value = state.toolDiameter !== null ? inputText(state.toolDiameter) : '';
      validateTool(input);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const cur = String(input.value).trim() === '' ? ruleToolD() : parseInput(input.value);
      if (!Number.isFinite(cur)) return;
      e.preventDefault();
      const step = (e.shiftKey ? 1 : 0.5) * (e.key === 'ArrowUp' ? 1 : -1);
      input.value = inputText(Math.min(TOOL_LIMITS[1], Math.max(TOOL_LIMITS[0], Math.round((cur + step) * 100) / 100)));
      clearTimeout(state.commitTimer);
      if (validateTool(input).ok) state.commitTimer = setTimeout(() => commitTool(input), COMMIT_MS);
    }
  });
  $('#params').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tool-lock]');
    if (!btn) return;
    if (state.toolDiameter !== null) {
      state.toolDiameter = null;
      state.actionLabel = `${TOOL_LABEL} otomatiğe döndü`;
    } else {
      const input = document.getElementById('p-tool');
      const r = input ? validateTool(input) : { ok: true, v: null };
      if (!r.ok) return;
      state.toolDiameter = r.v ?? ruleToolD();
      state.actionLabel = `${TOOL_LABEL} kilitlendi`;
    }
    update();
  });

  $('#params').addEventListener('input', (e) => {
    const input = e.target.closest('input[data-key]');
    if (!input) return;
    clearTimeout(state.commitTimer);
    if (validateParam(input) !== null) state.commitTimer = setTimeout(() => commitParam(input), COMMIT_MS);
  });
  $('#params').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-key]');
    if (input) commitParam(input);
  });
  $('#params').addEventListener('keydown', (e) => {
    const input = e.target.closest('input[data-key]');
    if (!input) return;
    if (e.key === 'Enter') { e.preventDefault(); commitParam(input); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const fld = PARAM_FIELDS.find((x) => x.key === input.dataset.key);
      const cur = parseInput(input.value);
      if (!Number.isFinite(cur)) return;
      e.preventDefault();
      const step = (fld?.step || 0.1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      input.value = inputText(Math.max(0, Math.round((cur + step) * 100) / 100));
      clearTimeout(state.commitTimer);
      if (validateParam(input) !== null) state.commitTimer = setTimeout(() => commitParam(input), COMMIT_MS);
    }
    if (e.key === 'Escape') {
      // Yazmaktan vazgeçildi: bekleyen uygulama iptal edilir, alan son uygulanan değere döner (kilit değişmez)
      clearTimeout(state.commitTimer);
      state.commitTimer = null;
      input.value = inputText(state.params[input.dataset.key]);
      validateParam(input);
    }
  });
  $('#params').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lock]');
    if (!btn) return;
    const k = btn.dataset.lock;
    if (state.locks.has(k)) {
      state.locks.delete(k);
      state.actionLabel = `${PARAM_LABEL[k]} otomatiğe döndü`;
    } else {
      const input = document.getElementById(`p-${k}`);
      const v = input ? validateParam(input) : state.params[k];
      if (v === null) return;
      state.params[k] = v;
      state.locks.add(k);
      state.actionLabel = `${PARAM_LABEL[k]} kilitlendi`;
    }
    update();
  });
  $('#params-reset').addEventListener('click', () => {
    if (!state.rules || !lockCount()) return;
    clearLocks();
    state.actionLabel = 'Tüm kilitler kaldırıldı';
    update();
    toastUndo('Tüm kilitler kaldırıldı; parametreler yeniden otomatik.');
  });

  /* ---------- Düzeltmeler (bulgu "Uygula") ---------- */

  /** Bulgunun önerdiği düzeltmeyi uygula. Sayısal öneriler değeri uygular ve anahtarı kilitler (kullanıcı kararı). */
  function applyFix(key, value) {
    if (!state.params) return false;
    if (key === 'screwType') { setScrewSpec({ ...state.screwSpec, type: value, length: 'auto' }); return true; }
    if (key === 'screwSize') { setScrewSpec({ ...state.screwSpec, size: value, length: 'auto' }); return true; }
    if (key === 'screwLength') { setScrewSpec({ ...state.screwSpec, length: Number(value) }); return true; }
    if (key === 'insertType') { setToolboxSpec(state.screwSpec, { ...state.insertSpec, type: value, variant: 'auto' }); return true; }
    if (key === 'nutType') { setToolboxSpec(state.screwSpec, { ...state.insertSpec, type: 'nut', nut: value }); return true; }
    if (key === 'standoffType') { setToolboxSpec(state.screwSpec, { ...state.insertSpec, type: 'standoff', standoff: value }); return true; }
    if (key === 'washer') { setScrewSpec({ ...state.screwSpec, washer: value }); return true; }
    if (key === 'screwMaterial') { setScrewSpec({ ...state.screwSpec, material: value }); return true; }
    if (key === 'material') {
      const proc = state.index.processes.find((p) => p.id === state.process);
      if (!proc?.materials.some((m) => m.id === value)) return false;
      if (value === state.material) return true;
      state.material = value;
      return applyRules('Malzeme').then(() => true);
    }
    if (key === 'lidMaterial') {
      if (!state.lidSel) return false;
      const proc = state.index.processes.find((p) => p.id === state.lidSel.process);
      if (!proc?.materials.some((m) => m.id === value)) return false;
      return setLidSel({ ...state.lidSel, material: value }).then(() => true);
    }
    if (key === 'lidMode') { state.lidMode = value; renderFastening(); refreshAutoParams(); update(); return true; }
    if (key === 'cornerAxis') { state.cornerAxis = value; refreshAutoParams(); update(); return true; }
    if (key === 'panelAdd') {
      const t = panelTypes().find((x) => x.id === value);
      if (!t) return false;
      changePanel(() => {
        if (['lightpipe', 'foot'].includes(t.kind) && state.panelParts.some((x) => x.type === t.id)) return;
        state.panelParts = [...state.panelParts, { uid: newPanelUid(), type: t.id, size: t.defaultSize || (t.sizes ? Object.keys(t.sizes)[0] : null), face: null, u: null, v: null, custom: t.kind === 'custom' ? { ...t.custom } : undefined }];
      });
      return true;
    }
    if (key === 'fitLid') { setFit('lid', value); return true; }
    if (key === 'edgeHold') { setEdgeHold(value); return true; }
    if (key === 'holeOff') { state.selectedHoles.delete(Number(value)); renderFastening(); refreshAutoParams(); update(); return true; }
    if (key === 'mountAxis') { setMount({ axis: value }); return true; }
    if (key === 'mountType') { setMount({ type: value }); return true; }
    if (key === 'mountCount') { setMount({ count: Number(value) }); return true; }
    if (key === TOOL_KEY) {
      // Takım çapı önerisi: değer yazılır ve kilitlenir (kullanıcı kararı); null kural değerine döndürür; aralık dışı öneri uygulanmaz
      const v = value === null || value === '' ? null : Number(value);
      if (v !== null && !validToolD(v)) return false;
      state.toolDiameter = v === null ? null : Math.round(v * 100) / 100;
      update();
      return true;
    }
    if (key === 'setParam') {
      const [pk, pv] = String(value).split(':');
      if (!(pk in state.params) || !Number.isFinite(Number(pv))) return false;
      state.params[pk] = Number(pv);
      state.locks.add(pk);
      update();
      return true;
    }
    if (key === 'portStyle' || key === 'portEnable') {
      // Port açıklığı: "partId|kenar|stil" (çentik/pencere) ya da "partId|kenar" (açıklığı aç)
      const parts = String(value).split('|');
      const pkey = `${parts[0]}|${parts[1]}`;
      const ov = { ...(state.portOverrides.get(pkey) || {}) };
      if (key === 'portStyle') ov.style = parts[2];
      else ov.enabled = true;
      state.portOverrides = new Map(state.portOverrides);
      state.portOverrides.set(pkey, ov);
      update();
      return true;
    }
    if (key === 'panelAuto') {
      const [uid, mode] = String(value).split(':');
      changePanel(() => {
        state.panelParts = state.panelParts.map((x) => (x.uid === uid ? { ...x, u: null, v: null, face: mode === 'all' ? null : x.face } : x));
      });
      return true;
    }
    if (!AUTO_KEYS.includes(key) || !Number.isFinite(Number(value))) return false;
    // Sayısal öneri: değer uygulanır ve kilitlenir (döngü bu değeri korur, diğerlerini yeniden yakınsatır)
    state.params[key] = Number(value);
    state.locks.add(key);
    update();
    return true;
  }

  /* ---------- Kartın tutulması, kapak bağlantısı, IP ---------- */

  function renderFastening() {
    const holes = state.analysis.holes || [];
    const mount = holes.map((h, i) => ({ ...h, index: i })).filter((h) => h.mount);
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
    $('#sum-lid').textContent = (LID_MODES.find((m) => m.id === state.lidMode)?.label || '').toLocaleLowerCase('tr');
  }

  $('#hole-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-hole]');
    if (!cb) return;
    const idx = Number(cb.dataset.hole);
    state.selectedHoles = new Set(state.selectedHoles);
    if (cb.checked) state.selectedHoles.add(idx); else state.selectedHoles.delete(idx);
    refreshAutoParams();
    state.actionLabel = 'Montaj deliği seçimi';
    update();
  });
  $('#lid-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lid]');
    if (!btn || btn.dataset.lid === state.lidMode) return;
    state.lidMode = btn.dataset.lid;
    renderFastening();
    refreshAutoParams();
    state.actionLabel = 'Kapak bağlantısı';
    update();
  });
  $('#ip-level').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ip]');
    if (!btn || btn.dataset.ip === state.sealing) return;
    state.sealing = btn.dataset.ip;
    renderFastening();
    refreshAutoParams();
    state.actionLabel = 'IP seviyesi';
    update();
  });

  /* ---------- Port açıklıkları ---------- */

  function renderPorts(d) {
    const ports = d.ports || [];
    $('#ports-summary').textContent = ports.length ? `${ports.filter((p) => p.enabled).length} / ${ports.length} açık` : 'yok';
    $('#port-list').innerHTML = ports.length
      ? ports.map((p) => `
        <div class="port-row ${p.enabled ? '' : 'off'}" data-part="${p.partId}">
          <label class="port-main"><input type="checkbox" data-port="${esc(p.key)}" ${p.enabled ? 'checked' : ''}>
            <span class="port-name" title="${esc(p.name)}">${esc(p.name)}</span></label>
          <span class="port-size">${f2(p.openWidth)} × ${f2(p.openHeight)}</span>
          <select data-port-style="${esc(p.key)}" aria-label="${esc(p.name)}: açıklık tipi" ${p.enabled ? '' : 'disabled'}>
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
        `<button type="button" class="link-btn" data-unenclose="${en.partId}">Duvardan çıkar<span class="vh">: ${esc(en.name)}</span></button></div>`).join('')}</div>`;
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
    state.portOverrides = new Map(state.portOverrides);
    state.portOverrides.set(key, ov);
    state.actionLabel = 'Port açıklığı';
    update();
  });
  $('#port-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unenclose]');
    if (b) setEnclose(Number(b.dataset.unenclose), false);
  });
  function setEnclose(partId, on) {
    state.encloseOverrides = new Map(state.encloseOverrides);
    state.encloseOverrides.set(partId, on);
    if (state.rules && state.analysis) refreshAutoParams();
    state.actionLabel = on ? 'Parça kutunun içine alındı' : 'Parça duvardan çıkarıldı';
    update();
  }
  // Satır vurgusu fareyle ve klavye odağıyla (yalnızca fareye bağlı değil)
  const hlRow = (e) => {
    const row = e.target.closest('.port-row, .enc-row');
    viewer.highlight(row ? Number(row.dataset.part) : null);
  };
  $('#port-list').addEventListener('mouseover', hlRow);
  $('#port-list').addEventListener('focusin', hlRow);
  $('#port-list').addEventListener('mouseleave', () => viewer.highlight(null));
  $('#port-list').addEventListener('focusout', (e) => { if (!$('#port-list').contains(e.relatedTarget)) viewer.highlight(null); });

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
    const seg = (cur, labels) => FIT_CLASSES.map((c) =>
      `<button type="button" role="radio" data-fit="${c.id}" aria-checked="${cur === c.id}" title="${esc(c.hint)}">${esc(labels ? labels[c.id] : c.label)}</button>`).join('');
    $('#fit-lid').innerHTML = seg(state.fits.lid);
    $('#fit-screw').innerHTML = seg(state.fits.screw, { press: 'İnce', normal: 'Orta', loose: 'Kaba' });
    const R = tolRules();
    $('#tol-edit').classList.toggle('hidden', !state.lidSel || !state.lidRules);
    $('#tol-edit').innerHTML = state.lidSel && state.lidRules ? [['body', `Gövde · ${state.rules.label}`], ['lid', `Kapak · ${state.lidRules.label}`]].map(([id, label]) =>
      `<button type="button" role="radio" data-toledit="${id}" aria-checked="${state.tolEdit === id}">${esc(label)}</button>`).join('') : '';
    const base = toleranceOf(R, null);
    const ov = state.tolOverrides[R.id] || {};
    const val = (k) => (['press', 'normal', 'loose'].includes(k) ? base.fits[k] : base[k] ?? 0);
    $('#tol-mat').textContent = `· ${R.label}`;
    const active = document.activeElement?.closest?.('#tol-grid input');
    if (!active) {
      $('#tol-grid').innerHTML = TOL_FIELDS.map(([k, label, hint]) => {
        if (k === 'hole_comp' && R.process !== 'fdm' && !Number.isFinite(ov[k])) return '';
        const changed = Number.isFinite(ov[k]);
        return `<div class="tol-row${changed ? ' changed' : ''}"><label for="tol-${k}">${esc(label)}</label>
          <span class="input-wrap"><input type="text" inputmode="decimal" id="tol-${k}" data-tol="${k}" value="${changed ? inputText(ov[k]) : ''}" placeholder="${inputText(val(k))}" aria-describedby="tol-${k}-eff tol-${k}-msg" aria-invalid="false"><span class="unit">mm</span></span>
          <span class="eff" id="tol-${k}-eff">${changed ? 'düzeltildi' : 'malzeme'}: ${inputText(changed ? ov[k] : val(k))} · ${esc(hint)}</span>
          <span class="field-msg error" id="tol-${k}-msg"></span></div>`;
      }).join('');
    }
    const tol = d?.tolerance;
    const anyOv = Object.keys(ov).length > 0;
    $('#tol-reset').classList.toggle('hidden', !anyOv);
    $('#tol-note').textContent = (base.source ? `Kaynak: ${base.source}. ` : '') +
      'Kullanılan yazıcı ya da atölye için ölçülen değer yazılır; bu tarayıcıda malzemeye özel saklanır. Boş = malzeme değeri.';
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
    $('#tol-result').innerHTML = `<table class="kv">${rows.map(([a, b]) => `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>`;
  }

  function setFit(group, cls) {
    if (state.fits[group] === cls) return;
    state.fits = { ...state.fits, [group]: cls };
    if (state.rules) refreshAutoParams();
    renderTolerance();
    state.actionLabel = 'Geçme sınıfı';
    update();
  }
  $('#fit-lid').addEventListener('click', (e) => { const b = e.target.closest('[data-fit]'); if (b) setFit('lid', b.dataset.fit); });
  $('#fit-screw').addEventListener('click', (e) => { const b = e.target.closest('[data-fit]'); if (b) setFit('screw', b.dataset.fit); });
  $('#tol-grid').addEventListener('change', (e) => {
    const inp = e.target.closest('[data-tol]');
    if (!inp || !state.rules) return;
    const raw = String(inp.value).trim();
    const v = raw === '' ? null : parseInput(raw);
    const msg = document.getElementById(`tol-${inp.dataset.tol}-msg`);
    if (v !== null && (!Number.isFinite(v) || Math.abs(v) > 5)) {
      inp.setAttribute('aria-invalid', 'true');
      if (msg) msg.textContent = 'Değer −5 ile 5 mm arasında bir sayı olmalı; uygulanmadı.';
      return;
    }
    inp.setAttribute('aria-invalid', 'false');
    if (msg) msg.textContent = '';
    const R = tolRules();
    const cur = { ...(state.tolOverrides[R.id] || {}) };
    if (v === null) delete cur[inp.dataset.tol]; else cur[inp.dataset.tol] = v;
    state.tolOverrides = { ...state.tolOverrides, [R.id]: cur };
    if (!Object.keys(cur).length) delete state.tolOverrides[R.id];
    saveTolOverrides(state.tolOverrides);
    refreshAutoParams();
    inp.blur();
    renderTolerance();
    state.actionLabel = 'Tolerans düzeltmesi';
    update();
  });
  $('#tol-reset').addEventListener('click', () => {
    if (!state.rules) return;
    delete state.tolOverrides[tolRules().id];
    state.tolOverrides = { ...state.tolOverrides };
    saveTolOverrides(state.tolOverrides);
    refreshAutoParams();
    renderTolerance();
    state.actionLabel = 'Tolerans düzeltmeleri kaldırıldı';
    update();
    toastUndo('Malzeme tolerans değerlerine dönüldü.');
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
    state.edgeHold = v;
    if (state.rules && state.analysis) refreshAutoParams();
    state.actionLabel = 'Kart kenarı tutucu';
    update();
  }
  $('#edge-hold').addEventListener('click', (e) => { const b = e.target.closest('[data-edge]'); if (b) setEdgeHold(b.dataset.edge); });

  /* ---------- Kutunun sabitlenmesi ---------- */

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
      $('#mount-info').innerHTML = `<table class="kv">${drows.map(([a, b]) => `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>`;
      return;
    }
    const rows = [
      ['Delik', `Ø${n2(info.d)}${mt.type === 'ears' && mt.hole === 'slot' ? ' (uzun)' : ''}`],
      ['Delik aralığı', info.spacing.filter((v) => v > 0.05).map(n2).join(' × ') + ' mm'],
      mt.type === 'ears' ? ['Kulak', `kalınlık ${n2(info.t)} · genişlik ${n2(info.w)} · çıkıntı ${n2(info.P)} mm`] : null,
      fp ? ['Taban izi (kulaklarla)', `${n2(fp.L)} × ${n2(fp.W)} mm`] : null,
    ].filter(Boolean);
    $('#mount-info').innerHTML = `<table class="kv">${rows.map(([a, b]) => `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>`;
  }

  function setMount(patch) {
    state.mount = { ...state.mount, ...patch };
    if (state.rules && state.analysis) refreshAutoParams();
    renderMount();
    state.actionLabel = 'Kutunun sabitlenmesi';
    update();
  }
  $('#mount-type').addEventListener('click', (e) => { const b = e.target.closest('[data-mtype]'); if (b) setMount({ type: b.dataset.mtype }); });
  $('#mount-size').addEventListener('click', (e) => { const b = e.target.closest('[data-msize]'); if (b) setMount({ size: b.dataset.msize }); });
  $('#mount-count').addEventListener('click', (e) => { const b = e.target.closest('[data-mcount]'); if (b) setMount({ count: Number(b.dataset.mcount) }); });
  $('#mount-axis').addEventListener('click', (e) => { const b = e.target.closest('[data-maxis]'); if (b) setMount({ axis: b.dataset.maxis }); });
  $('#mount-hole').addEventListener('click', (e) => { const b = e.target.closest('[data-mhole]'); if (b) setMount({ hole: b.dataset.mhole }); });

  /* ---------- Panel elemanları ---------- */

  const newPanelUid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const PANEL_FACES = ['-Y', '+X', '+Y', '-X'];

  /** Panel listesini değiştir: otomatik parametreler (ör. üst boşluk) yeni listeye göre güncellenir */
  function changePanel(mutate, label = 'Panel elemanı') {
    if (!state.rules || !state.analysis) { mutate(); return; }
    mutate();
    refreshAutoParams();
    state.actionLabel = label;
    update();
  }

  function renderPanelCard(d) {
    const items = new Map((d?.panel?.items || []).map((it) => [it.uid, it]));
    const types = panelTypes();
    const n2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 100) / 100).replace('.', ','));
    $('#panel-summary').textContent = state.panelParts.length ? `${state.panelParts.length} eleman` : 'yok';
    if (document.activeElement?.closest?.('#panel-list input')) return; // yazılan alan yeniden çizilmez
    $('#panel-list').innerHTML = state.panelParts.length ? state.panelParts.map((sp) => {
      const t = types.find((x) => x.id === sp.type);
      if (!t) return '';
      const it = items.get(sp.uid);
      const lvl = it ? (it.autoFail ? 'error' : it.issues.reduce((m, q) => (LEVEL_RANK[q.level] < LEVEL_RANK[m] ? q.level : m), 'ok')) : 'ok';
      const single = ['lightpipe', 'foot'].includes(t.kind);
      const sizes = t.sizes ? Object.keys(t.sizes) : [];
      const faces = (t.faces || []).flatMap((fc) => (fc === 'wall' ? PANEL_FACES : fc === 'lid' ? ['lid'] : []));
      const title = it?.title || t.code;
      const sizeSel = sizes.length ? `<label class="pp-f"><span>Boyut</span><select data-pp="size">${sizes.map((s) => `<option value="${esc(s)}" ${s === (it?.size || sp.size) ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : '';
      let fields = sizeSel;
      if (!single) {
        const face = it?.face || sp.face || '-Y';
        const lid = face === 'lid';
        const uLab = lid ? 'X' : it?.uAxis || (face[1] === 'X' ? 'Y' : 'X');
        const vLab = lid ? 'Y' : 'Z';
        fields += `<label class="pp-f"><span>Yüz</span><select data-pp="face"><option value="">Otomatik${!sp.face && it ? ` (${esc(FACE_LABEL[it.face])})` : ''}</option>` +
          faces.map((fc) => `<option value="${fc}" ${sp.face === fc ? 'selected' : ''}>${esc(FACE_LABEL[fc])}</option>`).join('') + '</select></label>' +
          `<label class="pp-f num"><span>${uLab}<span class="vh"> (${lid ? 'kavite merkezinden X' : `duvar boyunca kavite merkezinden ${uLab}`}, mm)</span></span><input type="text" inputmode="decimal" data-pp="u" value="${n2(sp.u)}" placeholder="${n2(it?.u)}"></label>` +
          `<label class="pp-f num"><span>${vLab}<span class="vh"> (${lid ? 'kavite merkezinden Y' : 'gövde alt yüzünden yükseklik'}, mm)</span></span><input type="text" inputmode="decimal" data-pp="v" value="${n2(sp.v)}" placeholder="${n2(it?.v)}"></label>`;
      }
      let custom = '';
      if (t.kind === 'custom') {
        const c = { ...t.custom, ...(sp.custom || {}) };
        custom = `<div class="pp-custom">${[['d', 'Delik Ø'], ['flat', 'Düzlük'], ['af', 'Somun SW'], ['panelMax', 'En kalın et'], ['inner', 'İç boy']].map(([k, label]) =>
          `<label class="pp-f num"><span>${label}</span><input type="text" inputmode="decimal" data-pp="c-${k}" value="${n2(c[k])}"></label>`).join('')}</div>`;
      }
      const first = it ? (it.autoFail ? { level: 'error', text: 'çakışmasız yer bulunamadı (inceleme panelindeki bulguya bakın)' } : it.issues.find((q) => q.level === 'error') || it.issues.find((q) => q.level === 'warn')) : null;
      const info = !it ? '' : it.kind === 'lightpipe' ? `${it.positions.length} LED · L ${[...new Set(it.positions.map((q) => n2(q.L)))].join(' / ')} mm`
        : it.kind === 'foot' ? `taban köşeleri · Ø${n2(it.pd.d)} × ${n2(it.pd.h)}`
          : `${holeText(it.hole)}${it.spot ? ` · lamba Ø${n2(it.spot.d)} × ${n2(it.spot.depth)}` : ''}${it.pigtail ? ` · pigtail ${it.pigtail} mm` : ''}` +
            `${it.wallNeed ? ` · duvara almak için üst boşluk ${n2(it.wallNeed)} mm` : ''}`;
      return `<div class="pp-row" data-uid="${sp.uid}">
        <div class="pp-head"><span class="tb-pl-dot ${lvl}" aria-hidden="true"></span>${panelIcon(t.kind)}<span class="pp-title">${esc(title)}</span>
          <button type="button" class="icon-btn" data-pp-del aria-label="${esc(title)} kaldır" title="Kaldır">×</button></div>
        ${fields ? `<div class="pp-fields">${fields}</div>` : ''}${custom}
        <div class="pp-msg small ${first ? 't-' + (first.level === 'error' ? 'err' : 'warn') : 'muted'}">${first ? `${LEVEL_LABEL[first.level]}: ` : ''}${esc(first ? first.text : info)}</div>
      </div>`;
    }).join('') : '<div class="hole-empty">Panel elemanı yok. SMA/RP-SMA, kablo rakoru, basınç dengeleme, ışık borusu, lastik ayak ya da veri sayfasından özel delik eklenebilir.</div>';
  }

  $('#panel-list').addEventListener('change', (e) => {
    const el = e.target.closest('[data-pp]');
    const row = e.target.closest('[data-uid]');
    if (!el || !row) return;
    const uid = row.dataset.uid;
    const key = el.dataset.pp;
    const raw = String(el.value).trim();
    const numeric = key === 'u' || key === 'v' || key.startsWith('c-');
    const num = raw === '' ? null : parseInput(raw);
    if (numeric && num !== null && !Number.isFinite(num)) { el.setAttribute('aria-invalid', 'true'); el.title = 'Sayı girilmeli; değer uygulanmadı.'; return; }
    el.setAttribute('aria-invalid', 'false');
    el.title = '';
    if (numeric) el.blur();
    changePanel(() => {
      state.panelParts = state.panelParts.map((sp) => {
        if (sp.uid !== uid) return sp;
        if (key === 'size') return { ...sp, size: el.value };
        if (key === 'face') return { ...sp, face: el.value || null, u: null, v: null };
        if (key === 'u' || key === 'v') {
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
    const title = del.closest('.pp-row')?.querySelector('.pp-title')?.textContent || 'Panel elemanı';
    changePanel(() => { state.panelParts = state.panelParts.filter((sp) => sp.uid !== uid); }, `${title} kaldırıldı`);
    toastUndo(`${title} kaldırıldı.`);
    setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) $('#panel-add').focus(); }, 0);
  });

  /* ---------- Geometri parmak izi, katı model durumu ---------- */

  const geomKeys = new WeakMap();
  /**
   * Katı modeli belirleyen her şey: geometri (işlem politikası hariç) + gövde/kapak kural seti + freze takım çapı.
   * Takım çapı ayrıca eklenir: kenar işlemi politikası (treatmentFor) ona bağlıysa geometri aynı kalsa da yeniden oluşturulur.
   */
  function geomKey(d) {
    if (!d || !d.geometry) return null;
    let k = geomKeys.get(d);
    if (!k) {
      const { treat, ...g } = d.geometry;
      void treat;
      k = `${state.rules?.id}|${state.lidSel && state.lidRules ? state.lidRules.id : '-'}|${JSON.stringify(g)}`;
      geomKeys.set(d, k);
    }
    return `${k}|tool:${usesCnc() && state.toolDiameter !== null ? state.toolDiameter : '-'}`;
  }
  const openErrors = () => (state.review ? state.review.findings : state.loop?.findings || []).filter((fd) => fd.level === 'error' && !fd.waived);
  const preOpenErrors = () => (state.loop?.findings || []).filter((fd) => fd.level === 'error' && !fd.waived);
  const isCurrent = () => !!(state.result && state.design && state.result.geomKey === geomKey(state.design));
  const forced = () => !!(state.force && state.forceKey && state.forceKey === geomKey(state.design));
  /** Katı model kendiliğinden oluşturulabilir mi: geçerli geometri ve açık (muaf tutulmamış) hata yok */
  const canBuild = () => !!(state.design && !state.design.error && state.design.geometry && (preOpenErrors().length === 0 || forced()));
  const buildFailedHere = () => !!(state.buildFail && state.design && state.buildFail.key === geomKey(state.design));
  const needsBuild = () => canBuild() && !isCurrent() && !buildFailedHere() && !state.holdBuild;

  /** Görünür durum makinesi */
  function phase() {
    if (!state.analysis || !state.rules) return 'idle';
    if (!state.design) return 'designing';
    if (state.design.error) return 'invalid';
    if (state.inFlight || state.buildTimer) return 'building';
    if (isCurrent()) return 'built';
    if (buildFailedHere()) return 'build-error';
    if (!canBuild()) return 'invalid';
    return 'building';
  }

  function scheduleBuild(delay = REBUILD_MS) {
    clearTimeout(state.buildTimer);
    state.buildTimer = null;
    if (!needsBuild()) return;
    state.buildTimer = setTimeout(() => { state.buildTimer = null; generate(); }, delay);
  }

  /* ---------- İnceleme birleştirme ---------- */

  /**
   * Son inceleme: işçinin işlem raporu (sözleşme A) bulgulara çevrilir. INJ-DRAFT sınırları burada verilmez:
   * reviewBuild gövde ve kapak sınırlarını (kapakta plaka/dil/boru ayrı) tasarımın kendi kontrollerinden okur.
   * (Tek bir draftLimit vermek kapağın sınırını gövdeye ya da gövdeninkini kapağa yazabilirdi.)
   */
  function computePost() {
    if (!isCurrent()) { state.post = null; return; }
    let post = [];
    try {
      post = reviewBuild(state.design, state.result.treatReport || null, {
        waivers: state.waivers, params: state.params, locks: state.locks,
      }) || [];
    } catch (err) {
      console.error('Son inceleme çalıştırılamadı', err);
      post = [toFinding({ level: 'warn', rule: 'GEO-TREAT', cat: 'geometri', part: 'all', text: `Katı model işlem raporu incelenemedi (${err.message}); kenar işlemleri elle doğrulanmalı.` })];
    }
    if (state.result.treatErr) {
      post = [...post, toFinding({ level: 'info', rule: 'GEO-TREAT', cat: 'geometri', part: 'all',
        text: `Kenar işlemi politikası hesaplanamadı (${state.result.treatErr}); katı model kenar işlemleri olmadan (önceki yöntemle) oluşturuldu.` })];
    }
    state.post = post;
  }

  /**
   * Gereksinim kontrolleri (Gereksinimler aşaması): en yüksek çalışma sıcaklığı seçili gövde ve kapak malzemesinin
   * sürekli kullanım sıcaklığıyla karşılaştırılır. Karşılanmıyorsa hata bulgusu (karar, muafiyet, kapı ve raporda görünür).
   */
  function requirementFindings() {
    const tmax = state.req?.tempMax;
    if (!Number.isFinite(tmax) || !state.rules) return [];
    const out = [];
    const check = (R, processId, part, fixKey) => {
      if (!R || !Number.isFinite(R.max_service_temp_c)) return;
      const who = part === 'lid' ? 'Kapak malzemesi' : part === 'base' ? 'Gövde malzemesi' : 'Muhafaza malzemesi';
      const base = { rule: REQ_TEMP_RULE, cat: 'surec', part, measured: R.max_service_temp_c, limit: tmax, op: '>=', unit: '°C' };
      if (R.max_service_temp_c >= tmax) {
        out.push(toFinding({ ...base, level: 'ok', text: `${who} ${R.label} sürekli kullanımda ≈ ${R.max_service_temp_c} °C dayanır; istenen en yüksek çalışma sıcaklığı ${tmax} °C karşılanıyor.` }));
        return;
      }
      const proc = state.index.processes.find((p) => p.id === processId);
      const fits = (proc?.materials || []).map((m) => ({ m, r: rulesOf(processId, m.id) }))
        .filter((x) => x.r && Number.isFinite(x.r.max_service_temp_c) && x.r.max_service_temp_c >= tmax)
        .sort((a, b) => a.r.max_service_temp_c - b.r.max_service_temp_c);
      const list = fits.slice(0, 4).map((x) => `${x.m.label} (≈ ${x.r.max_service_temp_c} °C)`).join(', ');
      out.push(toFinding({
        ...base, level: 'error',
        text: `${who} ${R.label} sürekli kullanımda ≈ ${R.max_service_temp_c} °C dayanır; istenen en yüksek çalışma sıcaklığı ${tmax} °C. ` +
          (fits.length ? `Bu süreçte uygun malzemeler: ${list}.` : 'Bu süreçte uygun malzeme yok; başka üretim yöntemi seçilmeli.'),
        fix: fits.length ? { key: fixKey, value: fits[0].m.id, label: `Malzeme: ${fits[0].m.label} seç`, auto: false } : null,
      }));
    };
    const lidDiff = !!(state.lidSel && state.lidRules);
    check(state.rules, state.process, lidDiff ? 'base' : 'all', 'material');
    if (lidDiff) check(state.lidRules, state.lidSel.process, 'lid', 'lidMaterial');
    // Başlık, gerekçe ve kaynaklar katalogdan (dfm/catalog.js REQ-TEMP; toFinding)
    for (const fd of out) {
      const w = state.waivers[fd.id];
      if (fd.level !== 'ok' && validWaiver(w)) fd.waived = { reason: String(w.reason).trim(), date: w.date || null };
    }
    return out;
  }

  /**
   * Birleşik inceleme: gereksinimler + döngü bulguları + (model güncelse) son inceleme. mergeBuildFindings, katı
   * modelde doğrulanan parçanın (gövde / kapak) ön incelemedeki INJ-DRAFT notunu düşürür: her parça için tek INJ-DRAFT.
   */
  function composeReview() {
    const loop = state.loop;
    if (!loop) return null;
    const post = state.post;
    const merged = post ? mergeBuildFindings(loop.findings, post).findings : loop.findings;
    const findings = [...requirementFindings(), ...merged];
    const sum = summarize(findings);
    const r = {
      phase: post ? 'post' : 'pre', status: sum.status, counts: sum.counts, findings, post: post || [],
      stop: loop.stop, iterations: loop.iterations, changes: loop.changes || [], rejected: loop.rejected || [],
    };
    r.stale = staleList(r);
    return r;
  }

  /**
   * Eşleşmeyen muafiyetler (review.js staleWaivers): hiçbir bulguya bağlanmayan kayıtlar. Yalnızca katı modelde
   * üretilen bulguların muafiyetleri, model güncel değilken değerlendirilemeyeceği için listelenmez.
   */
  function staleList(r) {
    const ids = staleWaivers(state.waivers, r.findings);
    return ids.map((id) => ({ id, ...(state.waivers[id] || {}) }))
      .filter((w) => r.phase === 'post' || !(w.post === true || POST_ONLY_RULES.has(w.rule)));
  }

  /* ---------- Ana hesap ---------- */

  function update({ record = true } = {}) {
    if (!state.analysis || !state.rules) return;
    clearTimeout(state.commitTimer);
    // designing: tasarım döngüsü kilitli değerlerle üretir, inceler, güvenli düzeltmeleri uygular ve yeniden inceler
    const loop = runLoop();
    state.loop = loop;
    for (const fld of PARAM_FIELDS) {
      if (state.locks.has(fld.key) || !Number.isFinite(loop.params[fld.key])) continue;
      state.params[fld.key] = loop.params[fld.key];
    }
    const d = loop.design;
    state.design = d;
    if (state.force && state.forceKey !== geomKey(d)) { state.force = false; state.forceKey = null; }
    // reviewing: ön inceleme + (model güncelse) son inceleme
    computePost();
    state.review = composeReview();

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
    syncParamInputs();
    renderSummaries();

    scheduleBuild();
    renderAll();
    if (record) recordHistory();
    announceStatus();
  }

  function renderSummaries() {
    const d = state.design;
    const proc = state.index.processes.find((pp) => pp.id === state.process);
    $('#sum-process').textContent = `${proc.label} · ${state.rules.label}${state.lidSel && state.lidRules ? ` · kapak ${state.lidRules.label}` : ''}`;
    $('#sum-params').textContent = d.params
      ? `et ${f2(d.params.wall)} · PCB altı ${f2(d.params.standoffHeight)} mm${usesCnc() ? ` · takım Ø${fx(state.toolDiameter ?? ruleToolD())}` : ''}${lockCount() ? ` · ${lockCount()} kilitli` : ''}`
      : 'geçersiz değer';
    const mountCount = (state.analysis.holes || []).filter((h) => h.mount).length;
    const sc = d.screws && d.screws[0];
    $('#holes-summary').textContent = mountCount
      ? `${state.selectedHoles.size}/${mountCount} delik` + (sc ? ` · ${sc.code ? sc.code + ' ' : ''}${sc.size}×${sc.length === null || sc.length === undefined ? '?' : String(sc.length).replace('.', ',')}` : '')
      : 'montaj deliği yok';
  }

  function renderAll() {
    renderReview();
    renderCardStatus();
    renderStages();
    renderPipeline();
    renderLoopTimeline();
    renderSolidState();
    renderFinal();
    renderOutputs();
    renderViewerState();
  }

  function announceStatus() {
    const r = state.review;
    if (!r) return;
    const key = `${r.phase}|${r.status}|${r.counts.error}|${r.counts.warn}`;
    if (key === state.lastStatus) return;
    const prev = state.lastStatus;
    state.lastStatus = key;
    if (!prev) return;
    ui.announce(`${r.phase === 'post' ? 'Son inceleme' : 'İnceleme'}: ${STATUS_LABEL[r.status]}, ${r.counts.error} hata, ${r.counts.warn} uyarı.`);
  }

  /* ---------- İnceleme paneli ---------- */

  function measureHtml(fd) {
    const m = Number.isFinite(fd.measured) ? fd.measured : null;
    const L = fd.limit;
    const unit = fd.unit || '';
    const sp = unit && unit !== '°' && unit !== '%' ? ' ' : '';
    const fmt = (v) => `${fx(v)}${sp}${unit}`;
    const OP = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '=': '=' };
    if (m === null && (L === null || L === undefined)) return '';
    if (fd.op === 'in' && Array.isArray(L)) {
      if (m === null) return `<span class="req">Önerilen aralık:</span> <b>${fx(L[0])}–${fmt(L[1])}</b>`;
      const inside = m >= L[0] - 1e-9 && m <= L[1] + 1e-9;
      return `<b>${fmt(m)}</b> ${inside ? '∈' : '∉'} <b>${fx(L[0])}–${fmt(L[1])}</b> <span class="req">· önerilen aralık</span>`;
    }
    if (fd.op === 'multiple') return `<b>${m !== null ? fmt(m) : '–'}</b> <span class="req">· nozul katı:</span> <b>${Number.isFinite(L) ? fmt(L) : '–'}</b>`;
    if (!Number.isFinite(L)) return m !== null ? `<span class="req">Ölçülen:</span> <b>${fmt(m)}</b>` : '';
    if (m === null) return `<span class="req">Gerekli:</span> <b>${OP[fd.op] || ''} ${fmt(L)}</b>`;
    const rel = m < L - 1e-9 ? '<' : m > L + 1e-9 ? '>' : '=';
    return `<b>${fmt(m)}</b> ${rel} <b>${fmt(L)}</b>${fd.op && OP[fd.op] ? ` <span class="req">· gerekli ${OP[fd.op]} ${fmt(L)}</span>` : ''}`;
  }

  const fixLabel = (fix) => {
    // Sayısal parametre düzeltmesi: hangi değerin hangi parametreye yazılacağı etikette açıkça yazılır
    const fv = Number(fix?.value);
    if (fix && AUTO_KEYS.includes(fix.key) && PARAM_LABEL[fix.key] && Number.isFinite(fv)) return `Uygula: ${PARAM_LABEL[fix.key]} ${fx(fv)} mm`;
    if (fix?.key === TOOL_KEY && fix.value !== null && Number.isFinite(fv)) return `Uygula: ${TOOL_LABEL} Ø${fx(fv)} mm`;
    const l = String(fix?.label || 'Düzeltmeyi uygula').trim();
    const last = l.split(/\s+/).pop().toLocaleLowerCase('tr');
    return VERB_END.test(last) ? l : `Uygula: ${l}`;
  };
  const canShow = (fd) => (fd.focus && Number.isFinite(fd.focus.partId)) || (['base', 'lid', 'clip'].includes(fd.part) && state.result);
  const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

  /** Bulgunun eylem düğmeleri; describedBy: düğmeyi hangi bulgunun anlattığı (kart başlığı ya da grup öğesinin metni) */
  function findingActions(fd, describedBy) {
    const acts = [];
    const d = `data-fid="${esc(fd.id)}" aria-describedby="${describedBy}"`;
    // Birinci düzeltme birincil düğme; seçenekler (fixes[1..]) yanında ikincil düğme
    if (!fd.waived && fd.level !== 'ok') {
      fixList(fd).forEach((fix, i) => acts.push(`<button type="button" class="btn sm${i ? '' : ' primary'}" data-act="fix" data-fi="${i}" ${d}>${esc(fixLabel(fix))}</button>`));
    }
    if (canShow(fd)) acts.push(`<button type="button" class="btn sm" data-act="show" ${d}>Göster</button>`);
    if (!fd.waived && (fd.level === 'error' || fd.level === 'warn')) acts.push(`<button type="button" class="btn sm" data-act="waive" ${d}>Muaf tut</button>`);
    if (fd.waived) acts.push(`<button type="button" class="btn sm" data-act="unwaive" ${d}>Muafiyeti kaldır</button>`);
    return acts.length ? `<div class="fc-actions">${acts.join('')}</div>` : '';
  }
  /** "Neden?" açılır bölümü: kuralın gerekçesi, kaynakları ve kaynak güveni */
  function whyBlock(fd, key, label) {
    const info = fd.rule ? ruleInfo(fd.rule) : null;
    const why = fd.why || info?.why || '';
    const src = (Array.isArray(fd.source) && fd.source.length ? fd.source : info?.source) || [];
    const conf = fd.conf || info?.conf;
    if (!why && !src.length) return '';
    return `<details class="fc-why" data-open-key="${esc(key)}"${state.openSecs.has(key) ? ' open' : ''}><summary>Neden?<span class="vh"> ${esc(label || '')}</span></summary>
        ${why ? `<p>${esc(why)}</p>` : ''}
        ${src.length ? `<ul class="fc-src">${src.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}<span class="vh"> (yeni sekmede açılır)</span></a>` : esc(s.title)}</li>`).join('')}</ul>` : ''}
        ${conf ? `<p class="fc-conf">Kaynak güveni: ${esc(CONF_LABEL[conf] || conf)}</p>` : ''}</details>`;
  }
  const metaChips = (fd) => `<span class="part-chip">${esc(PART_LABEL[fd.part] || 'Genel')}</span>${fd.autoFixed ? '<span class="auto-chip">otomatik düzeltildi</span>' : ''}` +
    `${fd.fix && fd.fix.auto === false && !fd.waived ? '<span class="part-chip">öneri</span>' : ''}`;

  function findingCard(fd) {
    const lvl = fd.waived ? 'waived' : fd.level;
    const meas = measureHtml(fd);
    const hid = `fh-${safeId(fd.id)}`;
    const date = fd.waived?.date ? new Date(fd.waived.date).toLocaleDateString('tr-TR') : '';
    return `<article class="fcard ${lvl}" data-fid="${esc(fd.id)}" aria-labelledby="${hid}">
      <div class="fc-head">${lvlIcon(lvl)}<h4 id="${hid}">${esc(fd.title || fd.rule || 'Bulgu')}</h4></div>
      <div class="fc-meta"><span class="lvl-inline ${lvl}">${LEVEL_LABEL[lvl]}</span>${fd.rule ? `<span class="rule-id">${esc(fd.rule)}</span>` : ''}${metaChips(fd)}</div>
      ${meas ? `<p class="fc-measure">${meas}</p>` : ''}
      <p class="fc-text">${esc(fd.text)}</p>
      ${fd.waived ? `<p class="fc-waiver">Muaf tutuldu${date ? ` (${esc(date)})` : ''}: ${esc(fd.waived.reason)}</p>` : ''}
      ${whyBlock(fd, `why:${fd.id}`, fd.title)}
      ${findingActions(fd, hid)}
    </article>`;
  }

  /* Tekrarlanan bulgular: aynı kural + düzey + kategori tek grup kartında ("PORT-RECESS · 3 bulgu"); öğe eylemleri ayrı */
  const catOf = (fd) => (CAT_ORDER.includes(fd.cat) ? fd.cat : 'genel');
  const grpKey = (fd) => `grp:${fd.level}:${catOf(fd)}:${fd.rule || fd.id}`;
  /** Açılır bölüm durumu: kullanıcı açtıysa/kapattıysa o; yoksa varsayılan */
  const discOpen = (key, defOpen) => state.openSecs.has(key) || (defOpen && !state.openSecs.has(`!${key}`));
  /** Başlık içinde düğme deseni (APG açılır bölüm): başlık düzeyi korunur, düğme aria-expanded ile durumu bildirir */
  const discBtn = (key, ctrl, open, inner, cls = '') =>
    `<button type="button" class="disc-btn${cls ? ' ' + cls : ''}" data-disclosure data-open-key="${esc(key)}" aria-expanded="${open}" aria-controls="${ctrl}"><span class="disc-chev" aria-hidden="true"></span>${inner}</button>`;

  /** Grup öğesi; parça bütün öğelerde aynıysa (grup başlığında yazılı) parça etiketi tekrarlanmaz */
  function groupItem(fd, samePart) {
    const lvl = fd.waived ? 'waived' : fd.level;
    const tid = `ft-${safeId(fd.id)}`;
    const meas = measureHtml(fd);
    const meta = samePart ? metaChips(fd).replace(/^<span class="part-chip">[^<]*<\/span>/, '') : metaChips(fd);
    return `<li class="fitem ${lvl}" data-fid="${esc(fd.id)}">
        ${meta ? `<div class="fc-meta">${meta}</div>` : ''}
        ${meas ? `<p class="fc-measure">${meas}</p>` : ''}
        <p class="fc-text" id="${tid}">${esc(fd.text)}</p>
        ${findingActions(fd, tid)}
      </li>`;
  }

  function groupCard(level, list) {
    const fd0 = list[0];
    const key = grpKey(fd0);
    const sid = safeId(key);
    const open = discOpen(key, level === 'error'); // hatalar açık gelir; uyarı ve bilgi grupları kapalı (gürültü)
    const title = fd0.title || ruleInfo(fd0.rule)?.title || fd0.rule || 'Bulgu';
    const parts = [...new Set(list.map((fd) => PART_LABEL[fd.part] || 'Genel'))];
    const inner = `${lvlIcon(level)}<span class="fgrp-text"><span class="fgrp-title">${esc(title)}</span> ` +
      `<span class="fgrp-meta"><span class="rule-id">${esc(fd0.rule || '')}</span> · ${list.length} bulgu · ${esc(parts.join(', '))}</span></span>`;
    return `<section class="fgrp ${level}">
      <h4 class="fgrp-head" id="gh-${sid}">${discBtn(key, `gb-${sid}`, open, inner)}</h4>
      <div class="fgrp-body" id="gb-${sid}"${open ? '' : ' hidden'}>
        ${whyBlock(fd0, `why:${key}`, title)}
        <ul class="fgrp-list">${list.map((fd) => groupItem(fd, parts.length === 1)).join('')}</ul>
      </div>
    </section>`;
  }

  /** Bir kategorideki bulgular: tekrarlanan kural grup kartında, diğerleri tek kart (ilk görülme sırası korunur) */
  function catItems(level, xs) {
    const byRule = new Map();
    for (const fd of xs) {
      const k = fd.rule || fd.id;
      if (!byRule.has(k)) byRule.set(k, []);
      byRule.get(k).push(fd);
    }
    return [...byRule.values()].map((list) => (list.length > 1 ? groupCard(level, list) : findingCard(list[0]))).join('');
  }

  /** Bulgu görünür olsun diye düzey bölümü ve grup kartı açılır (ör. muafiyet kaldırılınca bulgu kapalı gruba dönerse) */
  function revealFinding(fd) {
    if (!fd || fd.level === 'ok') return;
    for (const k of [`lvl:${fd.level}`, grpKey(fd)]) { state.openSecs.add(k); state.openSecs.delete(`!${k}`); }
  }

  const countsText = (c) => {
    const parts = [[c.error, 'hata'], [c.warn, 'uyarı'], [c.info, 'bilgi'], [c.ok, 'geçti'], [c.waived, 'muaf']].filter(([n]) => n > 0).map(([n, l]) => `${n} ${l}`);
    return parts.length ? parts.join(' · ') : 'bulgu yok';
  };

  /** Kural etiketi: geçen satırda yalnızca kimlik (katalog başlığı sorunu anlattığından "geçti" metniyle çelişmesin) */
  const ruleTag = (fd) => (fd.rule ? `<span class="rule-id">${esc(fd.rule)}${fd.level !== 'ok' && fd.title ? ` · ${esc(fd.title)}` : ''}</span>` : '');

  /** Değişikliği tetikleyen bulgunun ölçüsü (loop.js changes[]: measured / limit / op / unit varsa) */
  const changeCause = (c) => {
    const has = Number.isFinite(c?.measured) || Number.isFinite(c?.limit) || (Array.isArray(c?.limit) && c.limit.length === 2);
    const m = has ? measureHtml(c) : '';
    return m ? `<span class="chg-cause"><span class="req">neden:</span> ${m}</span>` : '';
  };

  function changeRow(c, i) {
    const info = ruleInfo(c.rule);
    const lbl = PARAM_LABEL[c.key] || c.key;
    const key = `chg:${c.rule}:${c.key}:${c.iter}`;
    const trig = c.level ? `${(LEVEL_LABEL[c.level] || c.level).toLocaleLowerCase('tr')} düzeyindeki bulgu nedeniyle` : '';
    const src = info?.source || [];
    const why = info?.why || '';
    return `<li class="chg"><span class="chg-main">${esc(lbl)} <span class="chg-val">${fx(c.from)} → ${fx(c.to)} mm</span></span>
      <span class="chg-sub"><span class="rule-id">${esc(c.rule || '')}</span> ${esc(c.title || info?.title || '')} · tur ${c.iter + 1}${trig ? ` · ${esc(trig)}` : ''}</span>
      ${changeCause(c)}
      ${why || src.length ? `<details class="fc-why chg-why" data-open-key="${esc(key)}"${state.openSecs.has(key) ? ' open' : ''}><summary>Neden?<span class="vh"> ${esc(lbl)} ${fx(c.from)} → ${fx(c.to)} mm</span></summary>
        ${why ? `<p>${esc(why)}</p>` : ''}
        ${src.length ? `<ul class="fc-src">${src.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}<span class="vh"> (yeni sekmede açılır)</span></a>` : esc(s.title)}</li>`).join('')}</ul>` : ''}</details>` : ''}
      <button type="button" class="btn sm" data-act="revert" data-ci="${i}" aria-label="Geri al: ${esc(lbl)} ${fx(c.from)} mm değerinde kilitlenir">Geri al</button></li>`;
  }
  function rejectedRow(c) {
    const info = ruleInfo(c.rule);
    const intro = (c.introduced || []).filter(Boolean);
    return `<li class="chg rejected"><span class="chg-main">${esc(PARAM_LABEL[c.key] || c.key)} <span class="chg-val">${fx(c.from)} → ${fx(c.to)} mm</span></span>
      <span class="chg-sub"><span class="rule-id">${esc(c.rule || '')}</span> ${esc(info?.title || '')} · tur ${c.iter + 1} · ${esc(REJECT_WHY[c.why] || c.why || '')}` +
      `${intro.length ? ` · yeni bulgu doğururdu: ${intro.map((r) => `${esc(r)} (${esc(ruleInfo(r)?.title || '')})`).join(', ')}` : ''}</span>${changeCause(c)}</li>`;
  }

  function renderReview() {
    const body = $('#review-body');
    const r = state.review;
    const badge = $('#review-badge');
    if (!r) { badge.classList.add('hidden'); return; }
    const proc = state.index.processes.find((p) => p.id === state.process);
    const ph = phase();
    $('#review-phase').textContent = r.phase === 'post' ? 'Son inceleme' : ph === 'building' ? 'Ön inceleme · model bekleniyor' : 'Ön inceleme';
    const issues = r.counts.error + r.counts.warn;
    badge.classList.toggle('hidden', !issues);
    badge.className = `count-badge ${r.counts.error ? 'error' : r.counts.warn ? 'warn' : ''}${issues ? '' : ' hidden'}`;
    badge.textContent = issues ? String(issues) : '';
    badge.setAttribute('aria-label', `${r.counts.error} hata, ${r.counts.warn} uyarı`);

    const open = r.findings.filter((fd) => !fd.waived && fd.level !== 'ok');
    const waived = r.findings.filter((fd) => fd.waived);
    const passed = r.findings.filter((fd) => !fd.waived && fd.level === 'ok');
    const flt = state.filter;
    const lvlCount = (l) => open.filter((fd) => fd.level === l).length;
    const cats = CAT_ORDER.filter((c) => open.some((fd) => fd.cat === c));
    if (flt.cat !== 'all' && !cats.includes(flt.cat)) flt.cat = 'all';
    const shown = open.filter((fd) => (flt.level === 'all' || fd.level === flt.level) && (flt.cat === 'all' || fd.cat === flt.cat));
    // Bölümler başlık + düğme deseniyle: panel H2 → bölüm H3 → bulgu / grup H4 (başlıkla gezinme bozulmaz).
    // <section> öğelerine bilerek ad verilmez: her biri ayrı "bölge" işaretine dönüşüp yer işareti listesini kalabalıklaştırmasın.
    const sec = (key, title, count, inner, defOpen = false) => {
      const isOpen = discOpen(key, defOpen);
      const sid = safeId(key);
      return `<section class="rv-section"><h3 class="rv-head" id="sh-${sid}">` +
        discBtn(key, `sb-${sid}`, isOpen, `<span class="rv-title">${title}</span> <span class="count-badge">${count}</span>`) +
        `</h3><div class="rv-body" id="sb-${sid}"${isOpen ? '' : ' hidden'}>${inner}</div></section>`;
    };

    // Açık hata ya da uyarı varken bilgi bölümü kapalı gelir (kullanıcı açarsa açık kalır; "Bilgi" süzgeci açar)
    const hasIssues = lvlCount('error') + lvlCount('warn') > 0;
    const groups = ['error', 'warn', 'info'].map((l) => {
      const list = shown.filter((fd) => fd.level === l);
      if (!list.length) return '';
      const byCat = CAT_ORDER.map((c) => [c, list.filter((fd) => catOf(fd) === c)]).filter(([, xs]) => xs.length);
      const key = `lvl:${l}`;
      const isOpen = discOpen(key, l !== 'info' || !hasIssues || flt.level === 'info');
      const head = `${lvlIcon(l)}<span class="rv-title">${LEVEL_PLURAL[l]}</span> <span class="count-badge ${l === 'info' ? '' : l}">${list.length}</span>`;
      return `<section class="fgroup ${l}"><h3 class="rv-head" id="lvh-${l}">${discBtn(key, `lvb-${l}`, isOpen, head)}</h3>` +
        `<div class="fgroup-body" id="lvb-${l}"${isOpen ? '' : ' hidden'}>` +
        // Kategori adı başlık değil grup etiketidir: başlık düzeyi bulgu başlıklarında (h4) kalır
        byCat.map(([c, xs], ci) => `<div class="fcat" role="group" aria-labelledby="fcat-${l}-${ci}"><p class="fcat-title" id="fcat-${l}-${ci}">${esc(CAT_LABEL[c] || c)}</p>${catItems(l, xs)}</div>`).join('') +
        '</div></section>';
    }).join('');

    // Hiçbir bulguyla eşleşmeyen muafiyetler: gerekçesiyle listelenir, kaldırılabilir
    const stale = r.stale || [];
    const staleRow = (w) => {
      const title = w.title || ruleInfo(w.rule)?.title || 'Bulgu';
      const date = w.date ? new Date(w.date).toLocaleDateString('tr-TR') : '';
      return `<li class="chg stale" data-wid="${esc(w.id)}"><span class="chg-main">${esc(title)}</span>
        <span class="chg-sub">${w.rule ? `<span class="rule-id">${esc(w.rule)}</span> · ` : ''}${date ? `${esc(date)} · ` : ''}gerekçe: ${esc(w.reason || '–')}</span>
        <button type="button" class="btn sm" data-act="unstale" data-wid="${esc(w.id)}" aria-label="Eşleşmeyen muafiyeti kaldır: ${esc(title)}">Kaldır</button></li>`;
    };
    const staleHtml = stale.length ? sec('sec:stale', `${lvlIcon('waived')} Eşleşmeyen muafiyetler`, stale.length,
      `<p class="muted small">Bu muafiyetler artık hiçbir bulguyla eşleşmiyor: sorun giderilmiş ya da bulgunun metni (ör. bir ölçü) değişmiş olabilir. Yeni bir sorunu sessizce örtmemesi için başka bulguya aktarılmaz; gerekiyorsa ilgili bulgu yeniden muaf tutulmalı.</p>
       <ul class="rv-list">${stale.map(staleRow).join('')}</ul>${stale.length > 1 ? '<div class="row"><button type="button" class="btn sm" data-act="unstale-all">Tümünü kaldır</button></div>' : ''}`, true) : '';

    const chips = [['all', 'Tümü', open.length], ['error', 'Hata', lvlCount('error')], ['warn', 'Uyarı', lvlCount('warn')], ['info', 'Bilgi', lvlCount('info')]]
      .map(([id, label, n]) => `<button type="button" class="chip" role="radio" data-flevel="${id}" aria-checked="${flt.level === id}">${label} <span class="chip-sub">${n}</span></button>`).join('');
    const catSel = `<label class="vh" for="rv-cat">Kategori süzgeci</label><select id="rv-cat"><option value="all">Tüm kategoriler</option>${cats.map((c) => `<option value="${c}" ${flt.cat === c ? 'selected' : ''}>${esc(CAT_LABEL[c] || c)}</option>`).join('')}</select>`;

    const ctx = [proc?.label, state.rules?.label, state.lidSel && state.lidRules ? `kapak ${state.lidRules.label}` : null].filter(Boolean).join(' · ');
    const html = `
      <div class="verdict ${r.status}">${lvlIcon(STATUS_ICON[r.status])}<div class="v-title">${STATUS_LABEL[r.status]}</div>
        <div class="v-counts">${countsText(r.counts)}</div>
        <div class="v-ctx">${r.phase === 'post' ? 'Son inceleme: katı model dahil' : 'Ön inceleme (parametrik): katı model doğrulaması bekleniyor'} · ${esc(ctx)}</div></div>
      <div class="loop-log"><div><strong>İnceleme döngüsü:</strong> ${r.iterations} tur · ${r.changes.length} otomatik düzeltme · durma nedeni: ${esc(STOP_SHORT[r.stop] || r.stop || '–')}</div>
        <div class="why">${esc(STOP_TEXT[r.stop] || '')}</div></div>
      ${sec('sec:changes', 'Otomatik düzeltmeler', r.changes.length, r.changes.length
        ? `<ul class="rv-list">${r.changes.map(changeRow).join('')}</ul><p class="muted small">“Geri al” parametreyi önceki değerinde kilitler; ilgili bulgu kullanıcı kararı olarak kalır.</p>`
        : '<p class="empty-list">Otomatik düzeltme gerekmedi ya da uygulanabilir güvenli düzeltme yok.</p>', true)}
      ${r.rejected.length ? sec('sec:rejected', 'Denendi, uygulanmadı', r.rejected.length, `<ul class="rv-list">${r.rejected.map(rejectedRow).join('')}</ul>`) : ''}
      <div class="filters" role="radiogroup" aria-label="Bulgu düzeyi süzgeci">${chips}${catSel}</div>
      ${groups || `<p class="empty-list">${open.length ? 'Süzgece uyan bulgu yok.' : 'Açık bulgu yok: tüm kontroller geçti ya da muaf tutuldu.'}</p>`}
      ${waived.length ? sec('sec:waived', `${lvlIcon('waived')} Muaf tutulanlar`, waived.length, waived.map(findingCard).join('')) : ''}
      ${staleHtml}
      ${sec('sec:passed', `${lvlIcon('ok')} ${passed.length} kontrol geçti`, passed.length, passed.length
        ? `<ul class="passed">${passed.map((fd) => `<li>${lvlIcon('ok')}<span>${esc(fd.text)}${fd.autoFixed ? ' <span class="auto-chip">otomatik düzeltildi</span>' : ''}</span><span class="rule-id">${esc(fd.rule || '')}</span></li>`).join('')}</ul>`
        : '<p class="empty-list">Henüz geçen kontrol yok.</p>')}`;
    rerender(body, html);
  }

  const findingById = (id) => (state.review?.findings || []).find((fd) => fd.id === id) || null;

  // Açık/kapalı bölümler yeniden çizimde korunur ("toggle" kabarcıklanmaz: yakalama evresinde dinlenir)
  $('#review-body').addEventListener('toggle', (e) => {
    const det = e.target;
    const key = det?.dataset?.openKey;
    if (!key) return;
    if (det.open) { state.openSecs.add(key); state.openSecs.delete(`!${key}`); } else { state.openSecs.delete(key); state.openSecs.add(`!${key}`); }
  }, true);
  // Başlık + düğme açılır bölümleri (main.js açıp kapatır ve "ikra:disclosure" yayar): durum yeniden çizimde korunur
  const rememberDisclosure = (e) => {
    const key = e.detail?.key;
    if (!key) return;
    if (e.detail.open) { state.openSecs.add(key); state.openSecs.delete(`!${key}`); } else { state.openSecs.delete(key); state.openSecs.add(`!${key}`); }
  };
  $('#review-body').addEventListener('ikra:disclosure', rememberDisclosure);
  $('#review-body').addEventListener('change', (e) => {
    if (e.target.id === 'rv-cat') { state.filter.cat = e.target.value; renderReview(); $('#rv-cat')?.focus(); }
  });
  $('#review-body').addEventListener('click', (e) => {
    const fl = e.target.closest('[data-flevel]');
    if (fl) {
      state.filter.level = fl.dataset.flevel;
      // Düzey süzgeci seçilince o düzeyin bölümü (kapatılmış olsa da) açılır
      if (fl.dataset.flevel !== 'all') { state.openSecs.add(`lvl:${fl.dataset.flevel}`); state.openSecs.delete(`!lvl:${fl.dataset.flevel}`); }
      renderReview();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'revert') { revertChange(Number(btn.dataset.ci)); return; }
    if (act === 'unstale') { removeStale([btn.dataset.wid]); return; }
    if (act === 'unstale-all') { removeStale((state.review?.stale || []).map((w) => w.id)); return; }
    const fd = findingById(btn.dataset.fid);
    if (!fd) return;
    if (act === 'fix') fixFinding(fd, Number(btn.dataset.fi) || 0);
    else if (act === 'show') showFinding(fd);
    else if (act === 'waive') openWaiver(fd);
    else if (act === 'unwaive') unwaive(fd);
  });

  /** Odak kaybolduysa (kart yeniden çizildi ya da kalktı) inceleme başlığına ya da verilen öğeye dön */
  function keepFocus(selector) {
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const el = (selector && document.querySelector(selector)) || $('#review-title');
      el?.focus({ preventScroll: false });
    }, 30);
  }

  /** fi: düzeltme seçeneğinin sırası (fixList; 0 = birincil düzeltme) */
  async function fixFinding(fd, fi = 0) {
    const fix = fixList(fd)[fi] || fd.fix;
    if (!fix) return;
    const before = numericFixText(fix);
    state.actionLabel = `Düzeltme: ${fd.title}`;
    // Malzeme değişikliği gibi düzeltmeler kural dosyasını yükler (eşzamansız): bildirim geçmiş kaydından sonra
    const ok = await Promise.resolve(applyFix(fix.key, fix.value)).catch((err) => { console.error(err); return false; });
    if (!ok) { ui.toast('Bu öneri otomatik uygulanamıyor; ilgili ayar elle değiştirilmeli.'); return; }
    toastUndo(`Düzeltme uygulandı: ${fd.title}${before ? ` — ${before}` : ''}.`);
    keepFocus(`#review-body [data-fid="${CSS.escape(fd.id)}"] [data-act]`);
  }
  const numericFixText = (fix) => {
    if (fix && (fix.key === 'material' || fix.key === 'lidMaterial')) {
      const pid = fix.key === 'lidMaterial' ? state.lidSel?.process : state.process;
      const m = state.index.processes.find((p) => p.id === pid)?.materials.find((x) => x.id === fix.value);
      return `${fix.key === 'lidMaterial' ? 'kapak malzemesi' : 'malzeme'} ${m?.label || fix.value} seçildi`;
    }
    if (fix?.key === TOOL_KEY) {
      const was = state.toolDiameter ?? ruleToolD();
      const to = fix.value === null || fix.value === '' ? null : Number(fix.value);
      return to === null ? `${TOOL_LABEL.toLocaleLowerCase('tr')} kural değerine döndü`
        : `${TOOL_LABEL.toLocaleLowerCase('tr')} ${was !== null ? `Ø${fx(was)} → ` : ''}Ø${fx(to)} mm (kilitlendi)`;
    }
    if (!fix || !AUTO_KEYS.includes(fix.key) || !Number.isFinite(Number(fix.value))) return fix?.label || '';
    return `${PARAM_LABEL[fix.key]} ${fx(state.params[fix.key])} → ${fx(Number(fix.value))} mm (kilitlendi)`;
  };

  function showFinding(fd) {
    const ok = viewer.focus({ partId: fd.focus && Number.isFinite(fd.focus.partId) ? fd.focus.partId : null, part: fd.part });
    syncDock(); // gizli parça gösterilmek için açıldıysa görünüm düğmeleri de güncellenir
    if (!ok) { ui.toast('Bu bulgu için 3B görünümde gösterilecek bir konum yok.'); return; }
    if (ui.isDrawer()) { ui.closeReview(); $('#viewer').focus({ preventScroll: true }); $('#viewer-wrap').scrollIntoView({ block: 'nearest' }); }
    ui.announce(`${fd.title}: 3B görünümde vurgulandı.`);
  }

  function revertChange(i) {
    const c = state.loop?.changes?.[i];
    if (!c) return;
    const lbl = PARAM_LABEL[c.key] || c.key;
    if (c.key === TOOL_KEY) {
      // Döngü takım çapını değiştirdiyse: önceki değerde kilitlenir (önceki değer yoksa kural değeri, kilitsiz)
      state.toolDiameter = validToolD(Number(c.from)) ? Number(c.from) : null;
    } else {
      if (!state.params || !(c.key in state.params)) return;
      state.params[c.key] = c.from;
      state.locks.add(c.key);
    }
    state.actionLabel = `Otomatik düzeltme geri alındı: ${lbl}`;
    update();
    toastUndo(c.key === TOOL_KEY && state.toolDiameter === null
      ? `Otomatik düzeltme geri alındı: ${lbl} kural değerine döndü.`
      : `Otomatik düzeltme geri alındı: ${lbl} ${fx(c.from)} mm değerinde kilitlendi.`);
    keepFocus('#review-body [data-act="revert"]');
  }

  /* Muafiyet penceresi: gerekçe zorunlu (en az 3 karakter) */
  const wDialog = $('#waiver-dialog');
  let waiverTarget = null;
  function openWaiver(fd) {
    waiverTarget = fd;
    const meas = measureHtml(fd);
    $('#waiver-finding').innerHTML = `<strong>${lvlIcon(fd.level)} ${esc(fd.title)}</strong>${fd.rule ? ` <span class="rule-id">${esc(fd.rule)}</span>` : ''}` +
      `${meas ? `<span class="fc-measure">${meas}</span>` : ''}<span>${esc(fd.text)}</span>`;
    const ta = $('#waiver-reason');
    ta.value = '';
    ta.setAttribute('aria-invalid', 'false');
    $('#waiver-err').textContent = '';
    wDialog.showModal();
    ta.focus();
  }
  $('#waiver-cancel').addEventListener('click', () => wDialog.close());
  $('#waiver-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ta = $('#waiver-reason');
    const reason = ta.value.trim();
    if (reason.length < 3) {
      ta.setAttribute('aria-invalid', 'true');
      $('#waiver-err').textContent = 'Gerekçe en az 3 karakter olmalı.';
      ta.focus();
      return;
    }
    const fd = waiverTarget;
    wDialog.close();
    if (!fd) return;
    // post: katı model sonrası bulgu (model güncel değilken eşleşmeyen sayılmaz)
    const post = (state.post || []).some((x) => x.id === fd.id);
    state.waivers = { ...state.waivers, [fd.id]: { reason, date: new Date().toISOString().slice(0, 10), rule: fd.rule || null, title: fd.title || '', ...(post ? { post: true } : {}) } };
    state.openSecs.add('sec:waived');
    state.actionLabel = `Muafiyet: ${fd.title}`;
    update();
    toastUndo(`Muaf tutuldu: ${fd.title}.`);
    setTimeout(() => document.querySelector(`#review-body [data-act="unwaive"][data-fid="${CSS.escape(fd.id)}"]`)?.focus(), 40);
  });
  function unwaive(fd) {
    const next = { ...state.waivers };
    delete next[fd.id];
    state.waivers = next;
    revealFinding(fd); // bulgu kapalı bir grup kartına dönerse odak gizli düğmede kalmasın
    state.actionLabel = `Muafiyet kaldırıldı: ${fd.title}`;
    update();
    toastUndo(`Muafiyet kaldırıldı: ${fd.title}.`);
    keepFocus(`#review-body [data-fid="${CSS.escape(fd.id)}"] [data-act]`);
  }
  /** Eşleşmeyen muafiyet kayıtlarını sil (geri alınabilir) */
  function removeStale(ids) {
    const list = ids.filter((id) => id && Object.prototype.hasOwnProperty.call(state.waivers, id));
    if (!list.length) return;
    const next = { ...state.waivers };
    for (const id of list) delete next[id];
    state.waivers = next;
    const one = list.length === 1 ? (state.review?.stale || []).find((w) => w.id === list[0]) : null;
    state.actionLabel = list.length > 1 ? `${list.length} eşleşmeyen muafiyet kaldırıldı` : 'Eşleşmeyen muafiyet kaldırıldı';
    update();
    toastUndo(list.length > 1 ? `${list.length} eşleşmeyen muafiyet kaldırıldı.` : `Eşleşmeyen muafiyet kaldırıldı${one?.title ? `: ${one.title}` : ''}.`);
    keepFocus('#review-body [data-act="unstale"]');
  }

  /* ---------- Kart durum noktaları, aşamalar, durum çubuğu ---------- */

  const worstOf = (list) => {
    let w = null;
    for (const fd of list) {
      if (fd.waived) continue;
      if (fd.level === 'error') return 'error';
      if (fd.level === 'warn') w = 'warn';
      else if (!w) w = 'ok';
    }
    return w;
  };

  function renderCardStatus() {
    const fs = state.review?.findings || [];
    document.querySelectorAll('#side .card[data-cat]').forEach((card) => {
      const cat = card.dataset.cat;
      const list = fs.filter((fd) => (fd.cat || 'genel') === cat);
      const w = worstOf(list);
      card.dataset.status = w || '';
      // Durum yalnızca renkle değil, biçimle de gösterilir (sekizgen ×, üçgen !, daire ✓)
      const dot = card.querySelector('.card-dot');
      if (dot && dot.dataset.lvl !== (w || '')) { dot.dataset.lvl = w || ''; dot.innerHTML = w ? lvlIcon(w) : ''; }
      // Durum metni kartın açma düğmesinde (başlığın adı): "Kartın tutulması … (1 uyarı)"
      const toggle = card.querySelector('.card-toggle');
      if (!toggle) return;
      let sr = toggle.querySelector('.card-sr');
      if (!sr) { sr = document.createElement('span'); sr.className = 'vh card-sr'; toggle.appendChild(sr); }
      const e = list.filter((fd) => !fd.waived && fd.level === 'error').length;
      const wn = list.filter((fd) => !fd.waived && fd.level === 'warn').length;
      sr.textContent = e || wn ? ` (${[e ? `${e} hata` : '', wn ? `${wn} uyarı` : ''].filter(Boolean).join(', ')})` : '';
    });
  }

  function renderStages() {
    const r = state.review;
    const ph = phase();
    const fs = r?.findings || [];
    const st = (cats) => {
      const w = worstOf(fs.filter((fd) => cats.includes(fd.cat || 'genel')));
      return w === 'error' ? 'error' : w === 'warn' ? 'warn' : 'done';
    };
    const SR = { done: 'tamam', warn: 'uyarı var', error: 'hata var', run: 'çalışıyor', pending: 'bekliyor', wait: 'beklemede' };
    const set = (id, s, extra = '') => ui.setStageStatus(id, s, `${SR[s] || ''}${extra ? ', ' + extra : ''}`);
    if (!r) return;
    set('req', st(STAGE_CATS.req));
    set('design', state.design?.error ? 'error' : st(STAGE_CATS.design));
    const loopS = r ? STATUS_ICON[state.loop.status] : 'pending';
    set('loop', loopS === 'ok' ? 'done' : loopS, `${state.loop.iterations} tur, ${state.loop.changes.length} otomatik düzeltme`);
    const solid = ph === 'building' ? 'run' : ph === 'built' ? 'done' : ph === 'build-error' ? 'error' : ph === 'invalid' ? (state.design?.error ? 'error' : 'wait') : 'pending';
    set('solid', solid);
    const fin = r.phase === 'post' ? (r.status === 'ready' ? 'done' : r.status === 'advisories' ? 'warn' : 'error') : ph === 'building' ? 'run' : 'pending';
    set('final', fin);
    const outS = isCurrent() ? (r.status === 'blocked' ? 'warn' : 'done') : 'pending';
    set('output', outS);
  }

  function renderPipeline() {
    const el = $('#pipeline');
    const r = state.review;
    if (!r) { el.innerHTML = '<span class="muted">Kart bekleniyor</span>'; return; }
    const ph = phase();
    const seg = (goto, ico, text) => `<button type="button" class="pl-seg" data-goto="${goto}">${ico}<span>${text}</span></button>`;
    const designOk = !state.design?.error;
    const loopIco = STATUS_ICON[state.loop.status];
    const ms = state.result?.buildMs;
    const secs = Number.isFinite(ms) ? `${nf1.format(ms / 1000)} s` : '';
    let solid;
    if (ph === 'building') solid = seg('solid', '<span class="spinner" aria-hidden="true"></span>', state.inFlight ? `Katı model: ${state.buildStage === 'engine' ? 'CAD çekirdeği yükleniyor…' : 'oluşturuluyor…'}` : 'Katı model: güncellenecek…');
    else if (ph === 'built') solid = seg('solid', lvlIcon('ok'), `Katı model ✓ ${secs}`);
    else if (ph === 'build-error') solid = seg('solid', lvlIcon('error'), 'Katı model × oluşturulamadı');
    else if (ph === 'invalid') solid = seg('solid', lvlIcon('pending'), state.design?.error ? 'Katı model: tasarım geçersiz' : `Katı model: bekliyor (${preOpenErrors().length} hata)`);
    else solid = seg('solid', lvlIcon('pending'), 'Katı model: –');
    const fin = r.phase === 'post'
      ? seg('final', lvlIcon(STATUS_ICON[r.status]), `Son inceleme ${r.status === 'ready' ? '✓' : r.status === 'advisories' ? `! ${r.counts.warn} uyarı` : `× ${r.counts.error} hata`}`)
      : seg('final', lvlIcon('pending'), 'Son inceleme: bekliyor');
    const sep = '<span class="pl-sep" aria-hidden="true">·</span>';
    el.innerHTML = [
      seg('design', lvlIcon(designOk ? 'ok' : 'error'), designOk ? 'Tasarım ✓' : 'Tasarım × geçersiz'),
      seg('loop', lvlIcon(loopIco), `İnceleme: ${state.loop.iterations} tur, ${state.loop.changes.length} otomatik düzeltme`),
      solid, fin,
    ].join(sep);
  }
  $('#pipeline').addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (!b) return;
    ui.selectStage(b.dataset.goto, { focus: true });
    if (b.dataset.goto === 'loop' || b.dataset.goto === 'final') ui.openReview({ focus: false });
  });

  /** Görüntüleyici katmanları: güncelleniyor çubuğu ve "son geçerli model" etiketi */
  function renderViewerState() {
    const ph = phase();
    $('#viewer-progress').classList.toggle('hidden', !(ph === 'building' && state.inFlight));
    const ov = $('#stale-overlay');
    if (!state.result || isCurrent()) { ov.classList.add('hidden'); return; }
    ov.classList.remove('hidden');
    ov.classList.toggle('run', ph === 'building');
    const p = state.result.design?.params;
    const lastTxt = p ? `son geçerli model (et ${f2(p.wall)} mm)` : 'son geçerli model';
    $('#stale-text').textContent = ph === 'building' ? `Güncelleniyor… görüntülenen: ${lastTxt}`
      : ph === 'build-error' ? `Oluşturulamadı · görüntülenen: ${lastTxt}`
        : `Model güncel değil: tasarımda ${preOpenErrors().length || 'açık'} hata var · görüntülenen: ${lastTxt}`;
  }

  /* ---------- Aşama panelleri: döngü, katı model, son inceleme, çıktılar ---------- */

  function renderLoopTimeline() {
    const el = $('#loop-timeline');
    const loop = state.loop;
    if (!loop) { el.innerHTML = ''; return; }
    const total = loop.findings.length;
    const byIter = new Map();
    loop.changes.forEach((c, i) => { if (!byIter.has(c.iter)) byIter.set(c.iter, []); byIter.get(c.iter).push([c, i]); });
    const rej = loop.rejected || [];
    const items = [];
    items.push(`<li class="tl-item"><span class="tl-dot">1</span><div class="tl-body"><strong>Tur 1 · İlk tasarım incelendi</strong>
      <p>Kural seti varsayılanları${lockCount() ? ` ve ${lockCount()} kilitli değer` : ''} ile tasarım üretildi; ${total} kontrol kataloğa bağlı kurallarla değerlendirildi.</p></div></li>`);
    for (const [iter, list] of [...byIter.entries()].sort((a, b) => a[0] - b[0])) {
      items.push(`<li class="tl-item"><span class="tl-dot fix">${iter + 1}</span><div class="tl-body"><strong>Tur ${iter + 1} · Otomatik düzeltme, yeniden inceleme</strong>
        <ul class="rv-list">${list.map(([c, i]) => changeRow(c, i)).join('')}</ul></div></li>`);
    }
    if (rej.length) {
      items.push(`<li class="tl-item"><span class="tl-dot warn">!</span><div class="tl-body"><strong>Denendi, uygulanmadı (${rej.length})</strong>
        <p>Bu düzeltmeler bulguları azaltmadığı ya da salınım yarattığı için geri alındı.</p><ul class="rv-list">${rej.map(rejectedRow).join('')}</ul></div></li>`);
    }
    const s = STATUS_ICON[loop.status];
    items.push(`<li class="tl-item"><span class="tl-dot ${s}" aria-hidden="true">${{ ok: '✓', warn: '!', error: '×' }[s] || ''}</span><div class="tl-body"><strong>Durdu · ${esc(STOP_SHORT[loop.stop] || loop.stop)}</strong>
      <p>${esc(STOP_TEXT[loop.stop] || '')}</p><p>Sonuç: <b>${STATUS_LABEL[loop.status]}</b> — ${countsText(loop.counts)}.</p>
      <div class="row"><button type="button" class="btn sm" data-open-review>Bulguları incele</button></div></div></li>`);
    rerender(el, `<p class="lead">Tasarım, kaynaklı DFM kurallarıyla incelenir; yalnızca değeri artıran güvenli sayısal düzeltmeler otomatik uygulanır ve her düzeltmeden sonra tasarım yeniden incelenir. Kilitli değerlere dokunulmaz.</p>
      <ol class="timeline">${items.join('')}</ol>`);
  }
  $('#loop-timeline').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-review]')) { ui.openReview({ focus: true }); return; }
    const b = e.target.closest('[data-act="revert"]');
    if (b) revertChange(Number(b.dataset.ci));
  });

  const stateCard = (cls, ico, title, lines = [], actions = '') =>
    `<div class="state-card ${cls}">${lvlIcon(ico)}<strong>${title}</strong>${lines.map((l) => `<div class="sc-line">${l}</div>`).join('')}${actions ? `<div class="row">${actions}</div>` : ''}</div>`;

  function volumesText(v) {
    if (!v) return '';
    return `gövde ${nf1.format(v.base / 1000)} cm³ · kapak ${nf1.format(v.lid / 1000)} cm³${v.clip ? ` · klips ${nf1.format(v.clip / 1000)} cm³` : ''}`;
  }
  function treatCounts(rep) {
    const rows = (rep || []).filter((e) => e && e.kind !== 'info');
    const limited = (e) => e.ok && (e.limited === true || (e.limited === undefined && Number.isFinite(e.applied) && Number.isFinite(e.size) && e.applied < e.size - 1e-6));
    return { total: rows.length, full: rows.filter((e) => e.ok && !limited(e)).length, limited: rows.filter(limited).length, failed: rows.filter((e) => e.ok === false).length };
  }

  function renderSolidState() {
    rerender($('#solid-state'), solidStateHtml());
  }
  function solidStateHtml() {
    const ph = phase();
    const d = state.design;
    const errs = preOpenErrors();
    const btn = $('#generate-btn');
    const force = $('#force-build-btn');
    btn.textContent = state.result ? 'Yeniden oluştur' : 'Katı modeli oluştur';
    btn.disabled = !canBuild() || !!state.inFlight;
    force.classList.toggle('hidden', !(d && !d.error && d.geometry && errs.length && !forced()));
    if (!d) return '';
    if (d.error) return stateCard('error', 'error', 'Tasarım geçersiz', [esc(d.error)]);
    if (ph === 'building') {
      return stateCard('run', 'run', state.inFlight ? 'Katı model oluşturuluyor…' : 'Katı model yarım saniye içinde yeniden oluşturulacak',
        [state.firstBuild ? 'İlk oluşturmada CAD çekirdeği (OpenCascade) indirilir; tek seferliktir.' : 'Tasarım değişti; önceki model güncellenene kadar gösterilir, dosyalar indirilemez.']);
    }
    if (ph === 'built') {
      const tc = treatCounts(state.result.treatReport);
      return stateCard('ok', 'ok', `Katı model güncel · ${nf1.format((state.result.buildMs || 0) / 1000)} s`, [
        esc(volumesText(state.result.volumes)),
        state.result.treatReport ? `Kenar işlemleri: ${tc.full} tam, ${tc.limited} sınırlı, ${tc.failed} uygulanamadı (ayrıntı: Son inceleme).` : 'Kenar işlemi raporu yok: model önceki yöntemle (kenar işlemsiz) oluşturuldu.',
        state.result.forced ? 'Bu model açık hatalara rağmen bilerek oluşturuldu.' : '',
      ].filter(Boolean));
    }
    if (ph === 'build-error') {
      return stateCard('error', 'error', 'Katı model oluşturulamadı', [esc(state.buildFail?.message || ''), 'Parametre ya da seçim değiştirilip yeniden denenmeli; sorun sürerse hata raporu (analiz JSON) paylaşılabilir.'],
        '<button type="button" class="btn sm" data-retry>Tekrar dene</button>');
    }
    if (ph === 'invalid') {
      return stateCard('error', 'error', `Katı model oluşturulmadı: tasarımda ${errs.length} açık hata var`, [
        `<ul class="plain">${errs.slice(0, 6).map((fd) => `<li>${esc(fd.title)}${fd.rule ? ` <span class="rule-id">${esc(fd.rule)}</span>` : ''}</li>`).join('')}</ul>`,
        'Hatalar düzeltilmeli ya da gerekçeyle muaf tutulmalı. Model yine de görülmek isteniyorsa “Hatalara rağmen oluştur” seçilebilir; indirmeden önce onay istenir.',
      ], '<button type="button" class="btn sm" data-open-review>Hataları göster</button>');
    }
    return stateCard('', 'pending', 'Katı model bekleniyor');
  }
  $('#solid-state').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-review]')) { state.filter.level = 'error'; renderReview(); ui.openReview({ focus: true }); }
    if (e.target.closest('[data-retry]')) { state.buildFail = null; generate(); }
  });
  $('#generate-btn').addEventListener('click', () => { state.buildFail = null; generate(); });
  $('#force-build-btn').addEventListener('click', async () => {
    const errs = preOpenErrors();
    const ok = await ui.confirm({
      title: 'Hatalara rağmen katı model oluşturulsun mu?',
      html: `<p>Tasarımda ${errs.length} açık hata var. Katı model oluşturulur ama karar <b>Üretime uygun değil</b> olarak kalır; dosyalar indirilmeden önce yeniden onay istenir.</p>
        <ul class="confirm-list">${errs.map((fd) => `<li><b>${esc(fd.title)}</b> <span class="rule-id">${esc(fd.rule || '')}</span><br>${esc(fd.text)}</li>`).join('')}</ul>`,
      buttons: [{ id: 'cancel', label: 'Vazgeç' }, { id: 'go', label: 'Yine de oluştur', primary: true, danger: true }],
    });
    if (ok !== 'go') return;
    state.force = true;
    state.forceKey = geomKey(state.design);
    state.buildFail = null;
    generate({ force: true });
  });

  function treatTableHtml(rep) {
    const rows = (rep || []).filter((e) => e && e.kind !== 'info');
    const infos = (rep || []).filter((e) => e && e.kind === 'info');
    if (!rows.length) return `<p class="empty-list">${rep ? 'Raporlanan kenar işlemi yok.' : 'Kenar işlemi raporu yok: model kenar işlemsiz oluşturuldu.'}</p>`;
    const unitOf = (e) => e.unit || (e.kind === 'draft' ? '°' : e.kind === 'boolean' ? 'adet' : 'mm');
    const val = (e, v) => {
      if (!Number.isFinite(v)) return '–';
      const u = unitOf(e);
      if (u === 'adet') return `${nf0.format(v)}`;
      return `${fx(v)}${u === '°' ? '°' : ' ' + u}`;
    };
    const statusOf = (e) => {
      const limited = e.ok && (e.limited === true || (e.limited === undefined && Number.isFinite(e.applied) && Number.isFinite(e.size) && e.applied < e.size - 1e-6));
      return e.ok === false ? ['error', 'Uygulanamadı'] : limited ? ['warn', 'Sınırlı'] : ['ok', 'Tam'];
    };
    const order = { base: 0, lid: 1, clip: 2 };
    const sorted = [...rows].sort((a, b) => (order[a.part] ?? 3) - (order[b.part] ?? 3));
    return `<table class="treat"><caption class="vh">Kenar işlemleri: istenen ve katı modelde uygulanan</caption>
      <thead><tr><th scope="col">Parça</th><th scope="col">Özellik</th><th scope="col" class="num">İstenen</th><th scope="col" class="num">Uygulanan</th><th scope="col">Durum</th></tr></thead>
      <tbody>${sorted.map((e) => {
        const [lvl, label] = statusOf(e);
        const isBool = e.kind === 'boolean';
        return `<tr><td>${esc(PART_LABEL[e.part] || e.part || '')}</td>
          <td>${esc(e.feature || e.key)}${e.kind && !isBool ? ` <span class="muted">· ${esc(KIND_LABEL[e.kind] || e.kind)}</span>` : ''}${e.count > 1 ? ` <span class="muted">×${e.count}</span>` : ''}${e.rule ? ` <span class="rule-id">${esc(e.rule)}</span>` : ''}${e.note ? `<span class="note-line">${esc(e.note)}</span>` : ''}</td>
          <td class="num">${isBool ? `${nf0.format(e.size ?? 0)} adet` : val(e, e.size)}</td>
          <td class="num">${isBool ? `${nf0.format(e.applied ?? 0)} adet` : e.ok === false ? '–' : val(e, e.applied)}</td>
          <td><span class="lvl-inline ${lvl}">${label}</span></td></tr>`;
      }).join('')}</tbody></table>${infos.length ? `<p class="muted small">${infos.length} bilgi satırı (bilerek keskin bırakılan ayırma çizgisi, ofset, gömme vb.) tabloda gösterilmez.</p>` : ''}`;
  }

  function renderFinal() {
    const fr = $('#final-review');
    const el = { set innerHTML(h) { rerender(fr, h); } };
    const r = state.review;
    if (!r) { el.innerHTML = ''; $('#treat-final').innerHTML = ''; return; }
    if (r.phase !== 'post') {
      el.innerHTML = stateCard('', 'pending', 'Son inceleme katı model oluşturulunca çalışır', ['Katı modelde gerçekten uygulanan radyüs, pah, kalıp çıkma açısı ve Boole işlemleri incelemedeki varsayımlarla karşılaştırılır.']);
      $('#treat-final').innerHTML = '';
      return;
    }
    const post = r.post;
    const open = post.filter((fd) => !fd.waived && fd.level !== 'ok' && fd.level !== 'info');
    el.innerHTML = `<div class="verdict ${r.status}">${lvlIcon(STATUS_ICON[r.status])}<div class="v-title">${STATUS_LABEL[r.status]}</div>
        <div class="v-counts">Birleşik sonuç (ön + son inceleme): ${countsText(r.counts)}</div></div>
      <h3 class="sub-title">Katı model kontrolleri (${post.length})</h3>
      <ul class="passed">${post.map((fd) => `<li>${lvlIcon(fd.waived ? 'waived' : fd.level)}<span>${esc(fd.text)}</span>${ruleTag(fd)}</li>`).join('') || '<li><span class="empty-list">Kontrol yok.</span></li>'}</ul>
      ${open.length ? '<div class="row"><button type="button" class="btn sm" data-open-review>Açık bulguları incele</button></div>' : ''}
      <h3 class="sub-title">Kenar işlemleri</h3>`;
    $('#treat-final').innerHTML = treatTableHtml(state.result?.treatReport);
  }
  $('#final-review').addEventListener('click', (e) => { if (e.target.closest('[data-open-review]')) ui.openReview({ focus: true }); });

  /** Çıktı kapısı: model güncel değilse indirme kapalı (gerekçesiyle); üretime uygun değilse önce onay */
  function gateState() {
    const ph = phase();
    const r = state.review;
    if (!state.result) return { ok: false, cls: '', ico: 'pending', title: 'Henüz katı model yok', lines: [ph === 'building' ? 'Katı model oluşturuluyor…' : 'Katı model oluşturulunca dosyalar burada indirilir.'] };
    if (!isCurrent()) {
      if (ph === 'building') return { ok: false, cls: 'run', ico: 'run', title: 'Model güncelleniyor: dosyalar indirilemez', lines: ['Tasarım değişti; katı model yeniden oluşturuluyor. Eski dosyalar bilerek sunulmaz.'] };
      if (ph === 'build-error') return { ok: false, cls: 'error', ico: 'error', title: 'Model güncel değil: son oluşturma başarısız', lines: [esc(state.buildFail?.message || '')], action: '<button type="button" class="btn sm" data-retry>Yeniden oluştur</button>' };
      const n = preOpenErrors().length;
      return { ok: false, cls: 'error', ico: 'error', title: state.design?.error ? 'Model güncel değil: tasarım geçersiz' : `Model güncel değil: tasarımda ${n} açık hata var`,
        lines: ['Görüntülenen ve indirilebilecek dosyalar son geçerli tasarıma ait olurdu; bu yüzden indirme kapalı. Hatalar düzeltilmeli, muaf tutulmalı ya da katı model bilerek oluşturulmalı.'],
        action: '<button type="button" class="btn sm" data-open-review>Hataları göster</button>' };
    }
    if (r.status === 'blocked') return { ok: true, confirm: true, cls: 'error', ico: 'error', title: `${STATUS_LABEL.blocked}: ${r.counts.error} açık hata`, lines: ['Dosyalar indirilebilir; indirmeden önce açık hatalar listelenip onay istenir.'] };
    if (r.status === 'advisories') return { ok: true, cls: 'warn', ico: 'warn', title: `Uyarılarla hazır: ${r.counts.warn} açık uyarı`, lines: ['Son inceleme tamamlandı; uyarılar üretim öncesi gözden geçirilmeli.'] };
    return { ok: true, cls: 'ok', ico: 'ok', title: 'Hazır: son inceleme tamamlandı', lines: ['Tasarım niyeti belirtilen kurallarla uyumludur; üretim öncesi üretici onayı gerekir.'] };
  }

  function renderOutputs() {
    const g = gateState();
    rerender($('#export-gate'), stateCard(g.cls, g.ico, g.title, g.lines, g.action || ''));
    document.querySelectorAll('#downloads [data-gate]').forEach((b) => {
      b.disabled = !g.ok || (b.id === 'dl-step-asm' && !!state.asmId) || (b.id === 'drawing-btn' && state.drawingId !== null);
      if (!g.ok) b.setAttribute('aria-describedby', 'export-gate'); else b.removeAttribute('aria-describedby');
    });
    $('#dl-stl-clip').classList.toggle('hidden', !state.result?.files?.stlClip);
    const rep = state.result?.treatReport;
    const tc = treatCounts(rep);
    $('#treat-sum').textContent = state.result ? (rep ? `${tc.full} tam · ${tc.limited} sınırlı · ${tc.failed} uygulanamadı` : 'rapor yok') : 'katı model yok';
    $('#treat-table').innerHTML = state.result ? treatTableHtml(rep) : '<p class="empty-list">Katı model oluşturulunca listelenir.</p>';
    renderStats();
  }
  $('#export-gate').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-review]')) { state.filter.level = 'error'; renderReview(); ui.openReview({ focus: true }); }
    if (e.target.closest('[data-retry]')) { state.buildFail = null; generate(); }
  });

  /** İndirme kapısı: üretime uygun olmayan tasarımda açık hatalar listelenir ve onay istenir */
  async function gated(run) {
    const g = gateState();
    if (!g.ok) { ui.toast(g.title); return; }
    if (g.confirm && !(await confirmOpenErrors())) return;
    run();
  }
  /** Açık (muaf tutulmamış) hata varsa listelenir ve indirme onayı istenir; onaylanırsa ya da hata yoksa true */
  async function confirmOpenErrors() {
    const errs = openErrors();
    if (!errs.length) return true;
    const ans = await ui.confirm({
      title: `Tasarımda ${errs.length} hata var; yine de indirmek istiyor musunuz?`,
      html: `<p>Açık hatalar düzeltilmeden ya da muaf tutulmadan üretilen dosyalar üretilemeyebilir ya da montajda çakışabilir.</p>
        <ul class="confirm-list">${errs.map((fd) => `<li><b>${esc(fd.title)}</b> <span class="rule-id">${esc(fd.rule || '')}</span><br>${esc(fd.text)}</li>`).join('')}</ul>`,
      buttons: [{ id: 'cancel', label: 'Vazgeç' }, { id: 'review', label: 'Hataları göster' }, { id: 'go', label: 'Yine de indir', primary: true, danger: true }],
    });
    if (ans === 'review') { state.filter.level = 'error'; renderReview(); ui.openReview({ focus: true }); return false; }
    return ans === 'go';
  }

  function renderStats() {
    const d = state.design;
    if (!d || !d.outer) { $('#design-stats').innerHTML = ''; return; }
    const v = isCurrent() ? state.result.volumes : null;
    let mass = '–';
    let massSub = 'katı model oluşturulunca hesaplanır';
    if (v) {
      const lidDensity = state.lidSel && state.lidRules ? state.lidRules.density_g_cm3 : state.rules.density_g_cm3;
      const grams = ((v.base + (v.clip || 0)) / 1000) * state.rules.density_g_cm3 + (v.lid / 1000) * lidDensity;
      mass = `${nf0.format(grams)} g`;
      massSub = `${volumesText(v)} · ${state.rules.label}${state.lidSel && state.lidRules ? ` / ${state.lidRules.label}` : ''}`;
    }
    const ports = d.ports.filter((p) => p.enabled);
    const rows = [
      ['Dış ölçü (U × G × Y)', dims(d.outer.L, d.outer.W, d.outer.H), `${state.rules.label} · ${processLabel()}${d.mount?.footprint ? ` · kulaklarla ${f2(d.mount.footprint.L)} × ${f2(d.mount.footprint.W)}` : ''}`],
      ['İç cep', dims(d.cavity.L, d.cavity.W, d.cavity.H), 'PCB + boşluklar'],
      ['Et kalınlığı', `${f2(d.params.wall)} mm`, `kapak dili ${f2(d.params.lipT)} mm · dil boşluğu ${f2(d.params.fit)} mm`],
      ['Tahmini kütle', mass, massSub],
      ['Kapak dili', `${d.lipBars.length} / 4 kenar`, d.lipRemoved.length ? `kaldırılan: ${d.lipRemoved.map((x) => x.side).join(', ')}` : 'tüm kenarlarda'],
      ['Bağlantı', `${d.screws.length} vida`, d.standoffs.length ? `${d.standoffs.length} standoff · ${d.lidTubes.length} kapak borusu` : 'montaj deliği yok'],
      ['Port açıklığı', `${d.geometry.cutouts.length}`, ports.length ? ports.map((p) => `${p.side} ${p.style === 'notch' ? 'çentik' : 'pencere'}`).join(' · ') : 'yok'],
      ['Panel elemanı', `${(d.panel?.items || []).length}`, (d.panel?.items || []).length ? d.panel.items.map((it) => it.title).slice(0, 3).join(' · ') : 'yok'],
      ['Sızdırmazlık', d.sealing ? d.sealing.label : 'Yok', ''],
    ];
    $('#design-stats').innerHTML = `<table class="spec-table"><caption class="vh">Final tasarım özeti</caption>${rows.map(([a, b, c]) =>
      `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}${c ? `<span class="sub">${esc(c)}</span>` : ''}</td></tr>`).join('')}</table>`;
  }

  const processLabel = () => state.index.processes.find((p) => p.id === state.process).label;

  /* ---------- Katı model üretimi (tek iş, en son istek kazanır) ---------- */

  function getWorker() {
    if (state.worker) return state.worker;
    const w = new Worker('js/cad-worker.js', { type: 'module' });
    w.onmessage = onWorkerMessage;
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      state.worker = null;
      const job = state.inFlight;
      state.inFlight = null;
      state.drawingId = null;
      state.asmId = null;
      // Bekleyen teknik resim / montaj isteklerinin ilerleme metni ve "Hazırlanıyor…" etiketleri geri alınır
      ui.progress(null);
      $('#drawing-btn .dl-name').textContent = 'Teknik resim ve DFM raporu';
      $('#dl-step-asm .dl-name').textContent = 'Montaj (bağlantı elemanlarıyla)';
      if (job) state.buildFail = { key: job.key, message: 'CAD çekirdeği yüklenemedi' };
      state.buildError = 'CAD çekirdeği yüklenemedi';
      ui.alert('CAD çekirdeği yüklenemedi. İnternet bağlantısı kontrol edilip yeniden denenmeli (çekirdek jsDelivr CDN üzerinden gelir).', {
        actions: [{ label: 'Tekrar dene', onClick: () => { state.buildFail = null; generate(); } }],
      });
      document.dispatchEvent(new CustomEvent('ikra:build-error', { detail: { message: state.buildError } }));
      renderAll();
    };
    state.worker = w;
    return w;
  }

  function generate({ force = false } = {}) {
    clearTimeout(state.buildTimer);
    state.buildTimer = null;
    const d = state.design;
    if (!d || d.error || !d.geometry) { renderAll(); return; }
    if (!force && !canBuild()) { renderAll(); return; }
    state.holdBuild = false;
    // Tek iş: işçide bir oluşturma varken yenisi kuyruğa girmez; bitince en son tasarım oluşturulur
    if (state.inFlight) { state.buildQueued = true; renderAll(); return; }
    const key = geomKey(d);
    const id = ++state.seq;
    const lidR = state.lidSel && state.lidRules ? state.lidRules : state.rules;
    let treat = null;
    let treatErr = null;
    try {
      treat = treatmentFor(d, state.rules, lidR);
    } catch (err) {
      // Politika hesaplanamazsa kenar işlemsiz (eski) yöntemle oluşturulur; son incelemede bilgi olarak görünür
      console.warn('Kenar işlemi politikası hesaplanamadı; kenar işlemsiz oluşturuluyor.', err);
      treat = null;
      treatErr = String(err?.message || err);
    }
    const stem = state.fileName.replace(/\.(step|stp)$/i, '') || 'ikra';
    state.inFlight = { id, key, design: d, treat, treatErr, t0: performance.now(), force: force || forced() };
    state.buildStage = null;
    ui.clearAlert();
    // Tasarım nesnesi önbellekte paylaşıldığı için değiştirilmez: işlem politikası kopyaya eklenir
    getWorker().postMessage({ id, geometry: { ...d.geometry, treat }, names: { base: `${stem}_govde`, lid: `${stem}_kapak`, clip: `${stem}_din_klipsi` } });
    renderAll();
  }

  function onWorkerMessage(ev) {
    const msg = ev.data;
    if (state.drawingId !== null && msg.id === state.drawingId) { onDrawing(msg); return; }
    if (state.asmId && msg.id === state.asmId) { onAssemblyStep(msg); return; }
    const job = state.inFlight;
    if (!job || msg.id !== job.id) return;
    if (msg.type === 'progress') { state.buildStage = msg.stage; renderPipeline(); renderSolidState(); return; }
    state.inFlight = null;
    if (msg.type === 'error') {
      state.buildFail = { key: job.key, message: msg.message };
      state.buildError = msg.message;
      if (job.key === geomKey(state.design)) {
        ui.alert(`Katı model oluşturulamadı: ${msg.message}`, { actions: [{ label: 'Ayrıntılar', onClick: () => ui.selectStage('solid', { focus: true }) }] });
      }
      document.dispatchEvent(new CustomEvent('ikra:build-error', { detail: { message: msg.message } }));
      continueQueue();
      renderAll();
      return;
    }
    state.buildFail = null;
    state.buildError = null;
    const d = job.design;
    const rd = { ...d, geometry: { ...d.geometry, treat: job.treat }, treatReport: msg.treatReport || null };
    state.result = { ...msg, design: rd, geomKey: job.key, buildMs: Number.isFinite(msg.buildMs) ? msg.buildMs : performance.now() - job.t0, treatErr: job.treatErr, forced: job.force };
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
    // Son inceleme: güncel model için işlem raporu bulgulara çevrilir ve birleşik karar hesaplanır
    computePost();
    state.review = composeReview();
    const current = isCurrent();
    continueQueue();
    renderAll();
    announceStatus();
    if (current && state.review) {
      const r = state.review;
      ui.announce(`Katı model hazır, son inceleme tamamlandı: ${STATUS_LABEL[r.status]}, ${r.counts.error} hata, ${r.counts.warn} uyarı.`);
    }
    document.dispatchEvent(new CustomEvent('ikra:built', { detail: { first, current } }));
  }

  function continueQueue() {
    if (state.buildQueued || needsBuild()) {
      state.buildQueued = false;
      if (needsBuild() || (forced() && !isCurrent())) generate({ force: forced() });
    }
  }

  /* ---------- İndirme ---------- */

  const fileStem = () => (state.fileName.replace(/\.(step|stp)$/i, '') || 'ikra');
  $('#dl-step').addEventListener('click', () => gated(() => download(state.result.files.step, `${fileStem()}_ikra_${state.process}-${state.material}.step`, 'model/step')));
  $('#dl-stl-base').addEventListener('click', () => gated(() => download(state.result.files.stlBase, `${fileStem()}_govde.stl`, 'model/stl')));
  $('#dl-stl-lid').addEventListener('click', () => gated(() => download(state.result.files.stlLid, `${fileStem()}_kapak.stl`, 'model/stl')));
  $('#dl-stl-clip').addEventListener('click', () => gated(() => { if (state.result?.files.stlClip) download(state.result.files.stlClip, `${fileStem()}_din_klipsi.stl`, 'model/stl'); }));

  /* ---------- Malzeme listesi (CSV) ve tercihli parça listesi ---------- */

  const projectInfo = () => {
    const proc = state.index?.processes.find((p) => p.id === state.process);
    return {
      project: fileStem(), material: state.rules?.label || '', process: proc?.label || '',
      date: new Date().toISOString().slice(0, 10), version: `Ikra v${ui.appVersion}`,
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

  $('#dl-bom').addEventListener('click', async () => {
    const d = state.design;
    if (!d?.parts?.length) return;
    // BOM parametrik tasarımdan gelir (katı model gerekmez); açık hata varsa yine önce onay istenir
    if (!(await confirmOpenErrors())) return;
    download(new TextEncoder().encode(bomCsv(d.parts, state.preferred, projectInfo())), `${fileStem()}_ikra_bom.csv`, 'text/csv');
  });
  $('#pref-template').addEventListener('click', () => {
    download(new TextEncoder().encode(preferredTemplateCsv(state.design?.parts || [], state.preferred)), 'ikra_tercihli_parcalar.csv', 'text/csv');
  });
  $('#pref-clear').addEventListener('click', () => {
    const prev = state.preferred;
    state.preferred = { items: [], name: '', date: '' };
    savePreferred(state.preferred);
    renderPreferredMatch();
    ui.toast('Tercihli parça listesi kaldırıldı.', {
      action: 'Geri al',
      onAction: () => { state.preferred = prev; savePreferred(prev); renderPreferredMatch(); ui.toast('Tercihli parça listesi geri yüklendi.'); },
    });
    setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) $('#pref-upload').focus(); }, 0);
  });
  $('#pref-upload').addEventListener('click', () => $('#pref-file').click());
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
      ui.toast(`Tercihli liste yüklendi: ${items.length} kalem${skipped ? `, ${skipped} satır atlandı` : ''}${saved ? '' : ' (tarayıcıda saklanamadı; sayfa yenilenince kaybolur)'}.`);
    } catch (err) {
      ui.alert('Tercihli liste okunamadı: ' + err.message);
    }
  });

  /* ---------- Teknik resim ve montaj STEP'i ---------- */

  const dialog = $('#drawing-dialog');

  function requestDrawing() {
    if (!state.result || !isCurrent()) return;
    if (state.inFlight) { ui.toast('Katı model güncelleniyor; birazdan yeniden denenmeli.'); return; }
    state.drawingId = ++state.seq;
    const btn = $('#drawing-btn');
    btn.disabled = true;
    btn.querySelector('.dl-name').textContent = 'Hazırlanıyor…';
    ui.progress('Teknik resim görünüşleri hazırlanıyor…');
    const d = state.result.design;
    getWorker().postMessage({
      type: 'drawing', id: state.drawingId,
      assembly: { items: assemblyItems(d, state.analysis.board.top), explode: explodeOf(d) },
    });
  }
  const explodeOf = (d) => Math.round(Math.max(d.outer.H * 0.75, 10));

  function requestAssemblyStep() {
    if (!state.result || !isCurrent()) return;
    if (state.inFlight) { ui.toast('Katı model güncelleniyor; birazdan yeniden denenmeli.'); return; }
    state.asmId = ++state.seq;
    const btn = $('#dl-step-asm');
    btn.disabled = true;
    btn.querySelector('.dl-name').textContent = 'Hazırlanıyor…';
    ui.progress('Montaj STEP dosyası hazırlanıyor…');
    const stem = fileStem();
    getWorker().postMessage({
      type: 'assemblyStep', id: state.asmId, items: assemblyItems(state.result.design, state.analysis.board.top),
      names: { base: `${stem}_govde`, lid: `${stem}_kapak`, clip: `${stem}_din_klipsi` },
    });
  }
  function onAssemblyStep(msg) {
    state.asmId = null;
    ui.progress(null);
    $('#dl-step-asm').querySelector('.dl-name').textContent = 'Montaj (bağlantı elemanlarıyla)';
    renderOutputs();
    if (msg.type === 'error') { ui.alert('Montaj STEP üretilemedi: ' + msg.message); return; }
    download(msg.step, `${fileStem()}_ikra_montaj_${state.process}-${state.material}.step`, 'model/step');
    ui.toast(`Montaj STEP indirildi: gövde, kapak ve ${msg.count} eleman.`);
  }
  $('#dl-step-asm').addEventListener('click', () => gated(requestAssemblyStep));

  /** Teknik resme eklenecek DFM inceleme raporu (sözleşme C) ve indirilen JSON'daki inceleme bölümü */
  function reviewExport() {
    const r = state.review;
    if (!r) return null;
    return {
      status: r.status,
      phase: r.phase,
      stop: r.stop,
      iterations: r.iterations,
      counts: { error: r.counts.error, warn: r.counts.warn, info: r.counts.info, ok: r.counts.ok, waived: r.counts.waived },
      changes: r.changes.map((c) => ({
        rule: c.rule, title: c.title || ruleInfo(c.rule)?.title || '', key: c.key, from: c.from, to: c.to, text: c.text || '',
        // Tetikleyen bulgunun ölçüsü (loop.js verirse)
        ...(c.measured !== undefined || c.limit !== undefined ? { measured: c.measured ?? null, limit: c.limit ?? null, op: c.op ?? null, unit: c.unit ?? null } : {}),
      })),
      rejected: r.rejected.map((c) => ({ rule: c.rule, key: c.key, from: c.from, to: c.to, why: REJECT_WHY[c.why] || c.why || '', introduced: c.introduced || [] })),
      findings: r.findings.map((fd) => ({
        id: fd.id, rule: fd.rule, title: fd.title, level: fd.level, cat: fd.cat, text: fd.text,
        measured: fd.measured ?? null, limit: fd.limit ?? null, op: fd.op ?? null, unit: fd.unit ?? null, part: fd.part,
        waived: !!fd.waived, reason: fd.waived ? fd.waived.reason : '', waivedAt: fd.waived?.date || null, autoFixed: !!fd.autoFixed,
        src: (Array.isArray(fd.source) && fd.source.length ? fd.source : ruleInfo(fd.rule)?.source || []).map((s) => ({ title: s.title, url: s.url || '' })),
      })),
      appVersion: ui.appVersion,
      createdAt: new Date().toISOString(),
    };
  }

  function onDrawing(msg) {
    state.drawingId = null;
    ui.progress(null);
    $('#drawing-btn').querySelector('.dl-name').textContent = 'Teknik resim ve DFM raporu';
    renderOutputs();
    if (msg.type === 'error') { ui.alert('Teknik resim üretilemedi: ' + msg.message); return; }
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
        review: reviewExport(),
        info: {
          project: fileStem(),
          material: state.rules.label,
          process: proc.label,
          lidMaterial: state.lidSel && state.lidRules ? state.lidRules.label : null,
          lidProcess: state.lidSel ? state.index.processes.find((p) => p.id === state.lidSel.process)?.label : null,
          ip: d.sealing ? d.sealing.label : 'Yok',
          date: new Date().toISOString().slice(0, 10),
          version: `v${ui.appVersion}`,
        },
      });
    } catch (err) {
      console.error(err);
      ui.alert('Teknik resim çizilemedi: ' + err.message);
      return;
    }
    state.sheetIdx = 0;
    renderSheet();
    $('#dd-status').textContent = `${state.sheets.length} pafta · ${Math.round(msg.ms)} ms`;
    if (!dialog.open) dialog.showModal();
  }

  function renderSheet() {
    // Ölçek yalnızca çizim paftalarında; DFM rapor paftası (kind 'report') ölçeksizdir (antette de "—")
    const scaleOf = (s) => (s.kind === 'report' || !Number.isFinite(s.scale) || s.scale <= 0 ? ''
      : ` (${s.scale >= 1 ? `${s.scale}:1` : `1:${Math.round(1 / s.scale)}`})`); // antetteki yazımla aynı
    $('#dd-tabs').innerHTML = state.sheets.map((s, i) =>
      `<button type="button" role="tab" data-sheet="${i}" id="sheet-tab-${i}" aria-selected="${i === state.sheetIdx}" tabindex="${i === state.sheetIdx ? 0 : -1}">${i + 1} · ${esc(s.title)}${scaleOf(s)}</button>`).join('');
    $('#dd-body').innerHTML = state.sheets[state.sheetIdx].svg;
    $('#dd-body').setAttribute('aria-labelledby', `sheet-tab-${state.sheetIdx}`);
  }

  $('#drawing-btn').addEventListener('click', () => gated(requestDrawing));
  $('#dd-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sheet]');
    if (!b) return;
    state.sheetIdx = Number(b.dataset.sheet);
    renderSheet();
    $(`#sheet-tab-${state.sheetIdx}`)?.focus();
  });
  $('#dd-tabs').addEventListener('keydown', (e) => {
    if (!state.sheets) return;
    const n = state.sheets.length;
    const map = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let i = state.sheetIdx;
    if (e.key in map) i = (i + map[e.key] + n) % n;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else return;
    e.preventDefault();
    state.sheetIdx = i;
    renderSheet();
    $(`#sheet-tab-${i}`)?.focus();
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

  /** Görünüm düğmelerini görüntüleyicinin gerçek durumuyla eşitle (ör. "Göster" gizli gövdeyi açtığında) */
  function syncDock() {
    const o = viewer.encOpts || {};
    document.querySelectorAll('[data-enc]').forEach((btn) => {
      const on = !!o[btn.dataset.enc];
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }
  document.querySelectorAll('[data-enc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const on = !btn.classList.contains('on');
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      viewer.setEnclosureOptions({ [btn.dataset.enc]: on });
    });
  });

  /* ---------- Geri al / yinele (50 adım) ---------- */

  const snap = () => JSON.stringify(exportState());
  function historyReset() {
    const h = state.hist;
    h.undo = [];
    h.redo = [];
    h.present = snap();
    h.saved = h.present;
    renderHistory();
  }
  function recordHistory() {
    const h = state.hist;
    if (state.silent || h.present === null) { state.actionLabel = null; return; }
    const s = snap();
    if (s === h.present) { state.actionLabel = null; return; }
    h.undo.push({ snap: h.present, label: state.actionLabel || 'Değişiklik', id: ++h.seq });
    if (h.undo.length > HISTORY_MAX) h.undo.shift();
    h.redo = [];
    h.present = s;
    state.actionLabel = null;
    renderHistory();
  }
  function renderHistory() {
    const h = state.hist;
    const u = $('#undo-btn');
    const r = $('#redo-btn');
    u.disabled = !h.undo.length;
    r.disabled = !h.redo.length;
    u.title = h.undo.length ? `Geri al: ${h.undo[h.undo.length - 1].label} (Ctrl+Z)` : 'Geri al (Ctrl+Z)';
    r.title = h.redo.length ? `Yinele: ${h.redo[h.redo.length - 1].label} (Ctrl+Y)` : 'Yinele (Ctrl+Y)';
    u.setAttribute('aria-label', h.undo.length ? `Geri al: ${h.undo[h.undo.length - 1].label}` : 'Geri al');
    r.setAttribute('aria-label', h.redo.length ? `Yinele: ${h.redo[h.redo.length - 1].label}` : 'Yinele');
    const dirty = h.present !== null && h.present !== h.saved;
    $('#dirty-flag').hidden = !dirty;
  }
  async function restore(s) {
    state.silent = true;
    try {
      await applySettings(JSON.parse(s), {});
    } finally {
      state.silent = false;
    }
    renderSelectors();
    renderParams();
    renderFastening();
    update({ record: false });
  }
  function undo() {
    const h = state.hist;
    h.busy = h.busy.then(async () => {
      const e = h.undo.pop();
      if (!e) return;
      h.redo.push({ snap: h.present, label: e.label, id: e.id });
      h.present = e.snap;
      await restore(e.snap);
      renderHistory();
      ui.toast(`Geri alındı: ${e.label}.`, { action: 'Yinele', onAction: redo });
    }).catch((err) => console.error(err));
    return h.busy;
  }
  function redo() {
    const h = state.hist;
    h.busy = h.busy.then(async () => {
      const e = h.redo.pop();
      if (!e) return;
      h.undo.push({ snap: h.present, label: e.label, id: e.id });
      h.present = e.snap;
      await restore(e.snap);
      renderHistory();
      ui.toast(`Yinelendi: ${e.label}.`);
    }).catch((err) => console.error(err));
    return h.busy;
  }
  /** Son eylem için "Geri al" düğmeli bildirim; araya başka eylem girdiyse düğme hiçbir şeyi geri almaz */
  function toastUndo(text) {
    const top = state.hist.undo[state.hist.undo.length - 1];
    const id = top?.id;
    ui.toast(text, {
      action: id ? 'Geri al' : null,
      onAction: () => {
        const cur = state.hist.undo[state.hist.undo.length - 1];
        if (!cur || cur.id !== id) { ui.toast('Bu eylemden sonra başka değişiklik yapıldı; geçmişten (Ctrl+Z) adım adım geri alınabilir.'); return; }
        undo();
      },
    });
  }
  $('#undo-btn').addEventListener('click', () => undo());
  $('#redo-btn').addEventListener('click', () => redo());

  /* ---------- Dış arayüz ---------- */

  async function setAnalysis(current, { deferBuild = false } = {}) {
    clearTimeout(state.buildTimer);
    state.buildTimer = null;
    state.analysis = current.analysis;
    state.fileName = current.fileName;
    state.result = null;
    state.post = null;
    state.review = null;
    state.loop = null;
    state.design = null;
    state.inFlight = null;
    state.buildQueued = false;
    state.buildFail = null;
    state.buildError = null;
    state.force = false;
    state.forceKey = null;
    state.firstBuild = true;
    state.lastStatus = null;
    state.holdBuild = deferBuild;
    state.filter = { level: 'all', cat: 'all' };
    $('#enc-toggles').classList.add('hidden');
    try {
      await loadIndex();
      await loadRules();
      await loadLidRules();
    } catch (err) {
      ui.alert(err.message);
      return;
    }
    state.selectedHoles = new Set((state.analysis.holes || []).map((h, i) => (h.mount ? i : -1)).filter((i) => i >= 0));
    state.lidMode = 'screw';
    state.screwSpec = { ...state.screwSpec, length: 'auto' }; // tip ve boyut korunur; boy yeni karta göre
    state.insertSpec = { ...state.insertSpec, variant: 'auto' };
    if (state.cornerSpec) state.cornerSpec = { ...state.cornerSpec, length: 'auto' };
    state.cornerAxis = 'auto';
    state.panelParts = state.panelParts.map((sp) => ({ ...sp, u: null, v: null })); // panel elemanları korunur, konumları yeni karta göre
    state.portOverrides = new Map();
    state.encloseOverrides = new Map();
    state.sheets = null;
    state.drawingId = null;
    state.asmId = null;
    clearLocks(); // yeni kart: kilitler (takım çapı dahil) ve muafiyetler sıfırlanır (proje açılırsa importState geri yükler)
    state.waivers = {};
    state.params = currentDefaults();
    state.silent = true;
    renderSelectors();
    renderParams();
    renderFastening();
    update({ record: false });
    state.silent = false;
    historyReset();
  }

  function reportSection() {
    const d = state.design;
    if (!d || !d.outer) return null;
    return {
      process: state.process,
      material: state.material,
      rules: state.rules.id,
      phase: phase(),
      params: d.params,
      locks: [...state.locks],
      // Tasarıma uygulanan freze seçimi (CNC yoksa null; saklanan değer proje durumunda kalır) ve motorun geçerli çapları
      toolDiameter: usesCnc() ? state.toolDiameter : null,
      cncTool: d.cncTool || null,
      requirements: { ...state.req },
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
      volumes_mm3: isCurrent() ? state.result.volumes : null,
      treatReport: isCurrent() ? state.result.treatReport || null : null,
      checks: d.checks,
      review: reviewExport(),
    };
  }

  /* ---------- Proje kaydet / aç ---------- */

  /** Tasarım ayarlarının tamamı (STEP hariç): proje dosyasına ve geri alma geçmişine yazılır */
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
      toolDiameter: state.toolDiameter, // null: kural değeri (eski projelerde alan yoktur → null)
      waivers: { ...state.waivers },
      requirements: { ...state.req },
    };
  }

  /**
   * Ayarları uygula (proje dosyası ya da geri alma anlık görüntüsü). Bilinmeyen malzeme/süreç atlanır ve uyarı döner.
   * Eski projelerde (kilit bilgisi yok) yalnızca döngünün otomatik değerinden büyük ya da kural varsayılanından küçük
   * değerler elle girilmiş sayılır; ikisinin arasındakiler otomatiktir.
   */
  async function applySettings(s, { project = false } = {}) {
    const warnings = [];
    await loadIndex();
    const proc = state.index.processes.find((p) => p.id === s.process);
    if (proc) {
      state.process = proc.id;
      if (proc.materials.some((m) => m.id === s.material)) state.material = s.material;
      else { state.material = proc.materials[0].id; if (project) warnings.push(`"${s.material}" malzemesi bu sürümde yok; ${proc.materials[0].label} seçildi.`); }
    } else if (s.process && project) warnings.push(`"${s.process}" süreci bu sürümde yok.`);
    await loadRules();
    state.lidSel = s.lidMaterial && s.lidMaterial.process && s.lidMaterial.material ? { ...s.lidMaterial } : null;
    try { await loadLidRules(); } catch { state.lidSel = null; state.lidRules = null; if (project) warnings.push('Projedeki kapak malzemesi bu sürümde yok; kapak gövdeyle aynı malzemeden.'); }
    // Tolerans düzeltmeleri: proje dosyası yalnızca ekler (tarayıcıdaki ölçülmüş değerler korunur);
    // geri alma/yineleme anlık görüntüsü ise düzeltmeyi birebir geri yükler (boşsa siler)
    const setTol = (id, ov) => {
      const has = !!(ov && typeof ov === 'object' && Object.keys(ov).length);
      if (project && !has) return;
      const next = { ...state.tolOverrides };
      if (has) next[id] = { ...ov }; else delete next[id];
      state.tolOverrides = next;
      saveTolOverrides(next);
    };
    if (state.lidRules) setTol(state.lidRules.id, s.lidToleranceOverride);
    const holes = (state.analysis.holes || []).map((h, i) => (h.mount ? i : -1)).filter((i) => i >= 0);
    state.selectedHoles = new Set((s.selectedHoles || []).filter((i) => holes.includes(i)));
    if (project && (s.selectedHoles || []).length !== state.selectedHoles.size) warnings.push('Bazı montaj delikleri bu kartta bulunamadı.');
    state.lidMode = LID_MODES.some((m) => m.id === s.lidMode) ? s.lidMode : 'screw';
    state.cornerAxis = ['auto', 'x', 'y'].includes(s.cornerAxis) ? s.cornerAxis : 'auto';
    state.cornerSpec = s.cornerSpec ? normalizeSpec(s.cornerSpec) : null;
    state.portOverrides = new Map(Array.isArray(s.portOverrides) ? s.portOverrides : []);
    state.sealing = (state.sealingIndex?.levels || []).some((l) => l.id === s.sealing) ? s.sealing : 'none';
    if (s.screwSpec) state.screwSpec = normalizeSpec(s.screwSpec) || state.screwSpec;
    if (s.insertSpec) state.insertSpec = { ...state.insertSpec, ...s.insertSpec };
    const ptypes = panelTypes();
    state.panelParts = (s.panelParts || []).filter((p) => ptypes.some((t) => t.id === p.type));
    if (project && (s.panelParts || []).length !== state.panelParts.length) warnings.push('Bazı panel elemanı tipleri bu sürümde yok; atlandı.');
    state.fits = { lid: 'normal', screw: 'normal', ...(s.fits || {}) };
    state.mount = { type: 'none', size: 'M4', count: 4, axis: 'auto', hole: 'round', ...(s.mount || {}) };
    state.edgeHold = ['auto', 'on', 'off'].includes(s.edgeHold) ? s.edgeHold : 'auto';
    state.encloseOverrides = new Map(Array.isArray(s.encloseOverrides) ? s.encloseOverrides : []);
    state.req = { tempMax: Number.isFinite(s.requirements?.tempMax) ? s.requirements.tempMax : null };
    // Freze takım çapı: yoksa ya da geçersizse kural değeri (eski projeler değişmeden açılır)
    const td = s.toolDiameter === null || s.toolDiameter === undefined || s.toolDiameter === '' ? null : Number(s.toolDiameter);
    state.toolDiameter = td !== null && validToolD(td) ? Math.round(td * 100) / 100 : null;
    if (project && td !== null && state.toolDiameter === null) warnings.push(`Projedeki freze takım çapı (${s.toolDiameter}) ${fx(TOOL_LIMITS[0])}–${fx(TOOL_LIMITS[1])} mm aralığında değil; kural değeri kullanıldı.`);
    if (state.req.tempMax) await ensureProcessRules(state.process).catch(() => null);
    if (state.req.tempMax && state.lidSel) await ensureProcessRules(state.lidSel.process).catch(() => null);
    setTol(state.rules.id, s.toleranceOverride);
    // Parametreler: kilitli değerler kayıttaki gibi, kilitsizler tasarım döngüsünden (eksik alan kural varsayılanından)
    state.waivers = s.waivers && typeof s.waivers === 'object' && !Array.isArray(s.waivers) ? { ...s.waivers } : {};
    const def = currentDefaults();
    state.params = { ...def };
    for (const fld of PARAM_FIELDS) if (Number.isFinite(s.params?.[fld.key])) state.params[fld.key] = s.params[fld.key];
    if (Array.isArray(s.locks)) {
      state.locks = new Set(s.locks.filter((k) => PARAM_FIELDS.some((fld) => fld.key === k) && Number.isFinite(s.params?.[k])));
    } else {
      // Eski proje: döngünün değerinden büyük ya da kural varsayılanından küçük olanlar elle girilmiş sayılır (E3)
      const base = baseParams(state.analysis, state.rules);
      state.locks = new Set(PARAM_FIELDS.map((fld) => fld.key).filter((k) => Number.isFinite(s.params?.[k]) &&
        (s.params[k] > def[k] + 1e-6 || s.params[k] < base[k] - 1e-6)));
    }
    state.sheets = null;
    return warnings;
  }

  /** Proje dosyasını uygula (STEP analizi yüklendikten sonra). Dönüş: uyarı metinleri */
  async function importState(s) {
    if (!s || !state.analysis) return ['Proje ayarları uygulanamadı: önce kart yüklenmeli.'];
    state.silent = true;
    let warnings = [];
    try {
      warnings = await applySettings(s, { project: true });
    } finally {
      state.silent = false;
    }
    state.holdBuild = false;
    renderSelectors();
    renderParams();
    renderFastening();
    update({ record: false });
    historyReset();
    // Proje açılınca katı model hemen (beklemeden) oluşturulur
    if (canBuild()) generate();
    return warnings;
  }

  const hasDesign = () => !!(state.rules && state.params && state.analysis);
  const isDirty = () => state.hist.present !== null && state.hist.present !== state.hist.saved;
  const markSaved = () => { state.hist.saved = state.hist.present; renderHistory(); };

  /** Otomatik test (tools/selftest.ps1): tasarımın, incelemenin ve son katı modelin özeti */
  function selfTest() {
    const r = state.result;
    const rv = state.review;
    return {
      report: reportSection(),
      state: exportState(),
      built: isCurrent(),
      volumes: r ? r.volumes : null,
      files: r ? Object.keys(r.files).filter((k) => r.files[k]) : [],
      treatReport: r?.treatReport || null,
      loop: state.loop ? { status: state.loop.status, stop: state.loop.stop, iterations: state.loop.iterations, counts: state.loop.counts, changes: state.loop.changes, findings: state.loop.findings } : null,
      buildError: state.buildError || null,
      review: rv ? {
        phase: rv.phase, status: rv.status, counts: rv.counts, stop: rv.stop, iterations: rv.iterations,
        findings: rv.findings.map((fd) => ({ id: fd.id, rule: fd.rule, level: fd.level, cat: fd.cat, part: fd.part, title: fd.title, text: fd.text, measured: fd.measured ?? null, limit: fd.limit ?? null, op: fd.op ?? null, unit: fd.unit ?? null, waived: !!fd.waived, autoFixed: !!fd.autoFixed })),
        post: rv.post.map((fd) => ({ rule: fd.rule, level: fd.level, text: fd.text })),
        stale: (rv.stale || []).map((w) => w.id),
      } : null,
      rejected: state.loop ? state.loop.rejected : [],
      buildMs: r && Number.isFinite(r.buildMs) ? Math.round(r.buildMs) : null,
      phase: phase(),
    };
  }

  return { setAnalysis, reportSection, exportState, importState, hasDesign, selfTest, undo, redo, isDirty, markSaved };
}
