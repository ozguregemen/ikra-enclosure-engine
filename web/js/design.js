/*
 * Tasarım hesabı (M1).
 * Girdi: PCB analizi + süreç/malzeme kural seti + kullanıcı parametreleri.
 * Çıktı: muhafaza ölçüleri, CAD işçisi için geometri tanımı, DFM kontrolleri.
 * Saf fonksiyonlardır; DOM'a veya CAD çekirdeğine bağımlı değildir.
 *
 * Model (M1): dikdörtgen, yuvarlatılmış köşeli alt gövde + düz kapak.
 * Kapağın altında, gövdenin iç duvarlarına oturan konumlandırma dili vardır.
 * Koordinatlar STEP dosyasıyla aynıdır: çıktı PCB modeliyle hizalı açılır.
 */

const CORNER_MIN_GAP = 0.2; // mm: PCB köşesi ile yuvarlatılmış iç köşe arasında kalacak en az boşluk
const LIP_COMPONENT_GAP = 0.3; // mm: kapak dili ile altındaki bileşen arası en az boşluk
const LIP_MIN_LENGTH = 4; // mm: bundan kısa dil parçası üretilmez
// RF bileşeni ipuçları: alt dize olarak aranacaklar ve tam kelime (token) olarak aranacaklar
const RF_SUBSTR = /(gps|gnss|antenna|anten|bluetooth|lora|radar|u\.?fl|ipex|wi-?fi)/i;
const RF_TOKENS = new Set(['ant', 'rf', 'sma', 'ble', 'lte', 'gsm', 'nfc', 'mmwave']);
const isRfName = (name) => RF_SUBSTR.test(name) ||
  String(name).toLowerCase().split(/[^a-z0-9]+/).some((t) => RF_TOKENS.has(t));

import { detectPorts } from './ports.js';

const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const f = (v) => nf.format(Math.round(v * 100) / 100);

export const PARAM_FIELDS = [
  { key: 'wall', label: 'Et kalınlığı', step: 0.1 },
  { key: 'pcbClearance', label: 'PCB–duvar boşluğu', step: 0.05 },
  { key: 'topClearance', label: 'Bileşen üstü boşluk', step: 0.1 },
  { key: 'standoffHeight', label: 'PCB altı yükseklik', step: 0.1 },
  { key: 'cornerRadius', label: 'İç köşe radyüsü', step: 0.1 },
];

export function paramHint(key, rules, analysis, defaults = null) {
  switch (key) {
    case 'wall': {
      const auto = defaults && defaults.wall > rules.default_wall + 1e-6 ? ` · IP conta kanalı için ${f(defaults.wall)} seçildi` : '';
      return `kural: ${f(rules.recommended_wall_min)}–${f(rules.recommended_wall_max)} (en az ${f(rules.min_wall)})${auto}`;
    }
    case 'pcbClearance': return `kural: ${f(rules.pcb_clearance_xy)}`;
    case 'topClearance': {
      const auto = defaults && defaults.topClearance > rules.component_clearance_z + 1e-6
        ? ` · port üstünde conta kanalına yer açmak için ${f(defaults.topClearance)} seçildi` : '';
      return `kural: ${f(rules.component_clearance_z)}${auto}`;
    }
    case 'standoffHeight': {
      const below = analysis.maxBelow ? analysis.maxBelow.value : 0;
      const base = Math.max(rules.min_standoff_height, below + rules.under_board_clearance);
      const auto = defaults && defaults.standoffHeight > base + 1e-6
        ? ` · insert/vida boyuna göre ${f(defaults.standoffHeight)} seçildi` : '';
      return `alttan taşan ${f(below)} + ${f(rules.under_board_clearance)}; en az ${f(rules.min_standoff_height)}${auto}`;
    }
    case 'cornerRadius': return rules.process === 'cnc'
      ? `takım Ø${f(rules.process_params.tool_diameter)} → en az ${f(rules.process_params.tool_diameter / 2)}`
      : `kural: en az ${f(rules.corner_radius_min)}`;
    default: return '';
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Kural dosyasından başlangıç parametreleri. options (fasteners, lidMode, selectedHoles) verilirse
 * PCB altı yükseklik; insert/diş derinliğine ve standart vida boyunun tam oturmasına göre yükseltilir.
 */
export function defaultParams(analysis, rules, options = {}) {
  const below = analysis.maxBelow ? analysis.maxBelow.value : 0;
  const params = {
    wall: rules.default_wall,
    pcbClearance: rules.pcb_clearance_xy,
    topClearance: rules.component_clearance_z,
    standoffHeight: round2(Math.max(rules.min_standoff_height, below + rules.under_board_clearance)),
    cornerRadius: rules.corner_radius_min,
  };
  // Hesabın önerdiği (yalnızca artıran) düzeltmeleri uygula: insert derinliği, vida boyu, IP et kalınlığı...
  if (analysis.board && analysis.board.axes.n === 'Z') {
    for (let i = 0; i < 6; i++) {
      const d = computeDesign(analysis, rules, params, options);
      let changed = false;
      for (const c of d.checks || []) {
        if (c.fix && typeof params[c.fix.key] === 'number' && c.fix.value > params[c.fix.key] + 1e-9) {
          params[c.fix.key] = c.fix.value; changed = true;
        }
      }
      if (!changed) break;
    }
  }
  return params;
}

const MIN_FLOOR_UNDER_HOLE = 0.8; // mm: vida deliği altında kalacak en az taban
const TUBE_GAP = 0.1; // mm: kapak borusu ile PCB üst yüzü arası
const FASTENER_OBSTACLE_GAP = 0.2; // mm

export const LID_MODES = [
  { id: 'screw', label: 'Vidalı (PCB vidalarıyla ortak)' },
  { id: 'none', label: 'Vidasız (yalnızca geçme)' },
];

const METHOD_TEXT = { insert: 'ısıyla gömülen insert', tapped: 'kılavuz çekilmiş diş', self_tap: 'sac vidası (plastik için)' };

/** PCB deliğinden geçebilecek en büyük metrik vida (allowed: izin verilen boyut adları, isteğe bağlı) */
export function pickScrew(holeD, screws, allowed = null) {
  let best = null;
  for (const s of screws) {
    if (allowed && !allowed.includes(s.size)) continue;
    if (s.min_pcb_hole <= holeD + 1e-6 && (!best || s.d > best.d)) best = s;
  }
  return best;
}

/**
 * Belirli bir boyun bu tasarımda durumu: 'ok' | 'short' (az tutunur) | 'long' (deliğin dibine dayanır).
 * info: { grip, available, minEngage } (computeDesign().fastenInfo)
 */
function lengthStatus(info, L) {
  const engagement = L - info.grip;
  if (engagement > info.available - 0.3 + 1e-9) return { status: 'long', engagement };
  if (engagement < info.minEngage - 1e-9) return { status: 'short', engagement };
  return { status: 'ok', engagement };
}

/** Toolbox tipinden seçilen boyutun baş ölçüleri ve boy serisi */
function typeSize(ttype, size) {
  return ttype && ttype.sizes ? ttype.sizes[size] || null : null;
}

/** Toolbox kütüphanesindeki tüm tipler (kategori › grup › tip) */
export function libraryTypes(lib) {
  return lib ? lib.categories.flatMap((c) => (c.groups || []).flatMap((g) => g.types)) : [];
}

/** Sac vidası (ST dişi): dişini plastikte kendisi açar */
export const isTapping = (ttype) => !!ttype && ttype.thread === 'ST';

/**
 * Tipin boyut tablosu (geçiş deliği, PCB deliği, kılavuz/insert/ön delik). Metrik tiplerde fasteners.json,
 * sac vidalarında tipin kendi ölçüleri kullanılır.
 */
export function screwTable(fasteners, ttype) {
  if (!isTapping(ttype)) return fasteners ? fasteners.screws : [];
  return Object.entries(ttype.sizes).map(([size, z]) => ({
    size, d: z.d, min_pcb_hole: z.min_pcb_hole, clearance: z.clearance,
    selftap_pilot: z.pilot, tap_drill: z.pilot, insert_hole: null, insert_length: null, head_d: z.dk, head_h: z.k,
  }));
}

const nfDrive = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
/** Tahrik ölçüsü metni: PH1, T10, imbus 2,5 mm, düz 0,8 mm */
export function driveText(ttype, sz) {
  if (!ttype || !sz || sz.drive === undefined) return '';
  switch (ttype.drive_kind) {
    case 'cross': return `${ttype.recess === 'Z' ? 'PZ' : 'PH'}${sz.drive}`;
    case 'torx': return `T${sz.drive}`;
    case 'hex': return `imbus ${nfDrive.format(sz.drive)} mm`;
    case 'slot': return `düz ${nfDrive.format(sz.drive)} mm`;
    default: return String(sz.drive);
  }
}

/** SolidWorks Toolbox tarzı tanım: "ISO 7045 - M3 × 12 - H", "ISO 7049 - ST2.9 × 13 - C - H" */
export function designation(ttype, size, L) {
  const len = L === null || L === undefined ? '…' : nfDrive.format(L);
  return `${ttype.code} - ${size} × ${len}${ttype.form ? ' - ' + ttype.form : ''}${ttype.recess ? ' - ' + ttype.recess : ''}`;
}

function distToBoxXY(box, x, y) {
  const nx = Math.max(box.min[0], Math.min(x, box.max[0]));
  const ny = Math.max(box.min[1], Math.min(y, box.max[1]));
  return Math.hypot(nx - x, ny - y);
}

/** Standart boylardan, delik derinliğine sığan en uzun vidayı seçer. */
function pickLength(lengths, grip, depthAvail, minEngage) {
  const maxL = grip + depthAvail - 0.3;
  const fit = lengths.filter((L) => L <= maxL + 1e-9);
  const L = fit.length ? fit[fit.length - 1] : null;
  const engagement = L ? L - grip : 0;
  const next = lengths.find((len) => len > maxL + 1e-9) ?? null;
  return { L, engagement, ok: L !== null && engagement >= minEngage - 1e-9, next };
}

function overlaps2D(box, rect, gap) {
  return box.max[0] > rect.min[0] - gap && box.min[0] < rect.max[0] + gap &&
    box.max[1] > rect.min[1] - gap && box.min[1] < rect.max[1] + gap;
}

export function computeDesign(analysis, rules, params, options = {}) {
  const checks = [];
  // fix: { key, value, label } — arayüzde tek tıkla uygulanabilecek parametre önerisi
  // cat: genel | surec | port | kapak | baglanti; focus: { partId } — 3B'de vurgulanacak bileşen
  let cat = 'genel';
  const add = (level, text, fix = null, focus = null) => checks.push({ level, text, fix, cat, focus });
  const partIdByName = (name) => {
    const pt = analysis.parts.find((x) => x.name === name);
    return pt ? { partId: pt.id } : null;
  };
  const b = analysis.board;
  if (!b) return { ok: false, error: 'PCB tespit edilemediği için muhafaza oluşturulamıyor.' };
  if (b.axes.n !== 'Z') {
    return { ok: false, error: `Kart ${b.axes.n} eksenine dik duruyor. M1 şimdilik yalnızca Z eksenine dik (yatay) kartları destekliyor.` };
  }

  const p = {};
  for (const fld of PARAM_FIELDS) {
    const v = Number(params[fld.key]);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: `"${fld.label}" için geçerli bir sayı gir.` };
    p[fld.key] = v;
  }
  if (p.wall <= 0) return { ok: false, error: 'Et kalınlığı sıfırdan büyük olmalı.' };

  const above = analysis.maxAbove ? analysis.maxAbove.value : 0;
  const below = analysis.maxBelow ? analysis.maxBelow.value : 0;
  const wall = p.wall;
  const floor = wall * (rules.floor_ratio ?? 1);
  const lidT = wall;
  const fit = rules.lid_fit_clearance;
  const lipT = rules.lid_lip_thickness;
  const rIn = Math.max(p.cornerRadius, 0.05);
  const rOut = rIn + wall;

  // --- IP sızdırmazlık (M4): duvar üstünde kordon conta kanalı ---
  const seal = options.sealing && options.sealing.id !== 'none' ? options.sealing : null;
  let groove = null;
  if (seal) {
    const depth = Math.round(seal.cord_d * (1 - seal.squeeze) * 100) / 100;
    const area = (Math.PI * seal.cord_d * seal.cord_d) / 4;
    const width = Math.ceil(Math.max(area / (seal.fill_max * depth), seal.cord_d * 1.1) * 20) / 20;
    let rimNeed = Math.ceil((width + 2 * seal.land) * 10) / 10;
    if (rules.process === 'fdm') {
      // FDM'de et kalınlığı nozul çapının katı olmalı: bir üst kata yuvarla
      const nz = rules.process_params.nozzle_diameter;
      rimNeed = Math.round(Math.ceil(rimNeed / nz - 1e-9) * nz * 100) / 100;
    }
    groove = { width, depth, fill: area / (width * depth), rimNeed };
  }
  const ipPortIssues = [];

  // --- Yatay ölçüler: PCB sınır kutusu + boşluk ---
  let clr = p.pcbClearance;
  if (rIn > CORNER_MIN_GAP) {
    const need = rIn - (rIn - CORNER_MIN_GAP) / Math.SQRT2;
    if (clr < need - 1e-6) {
      add('info', `İç köşe radyüsü ${f(rIn)} mm olduğundan, PCB köşeleri yuvarlak köşeye değmesin diye kenar boşluğu ${f(need)} mm'ye çıkarıldı.`);
      clr = need;
    }
  }
  const cav = {
    min: [b.box.min[0] - clr, b.box.min[1] - clr],
    max: [b.box.max[0] + clr, b.box.max[1] + clr],
  };
  const cavL = cav.max[0] - cav.min[0];
  const cavW = cav.max[1] - cav.min[1];
  const center = [(cav.min[0] + cav.max[0]) / 2, (cav.min[1] + cav.max[1]) / 2];

  // --- Düşey ölçüler ---
  if (p.standoffHeight < below + 0.2) {
    add('error', `PCB altı yükseklik (${f(p.standoffHeight)} mm), kartın altından taşan pin/bileşenden (${f(below)} mm) yeterince büyük değil: tabana çarpar.`);
  }
  const floorTop = b.bottom - p.standoffHeight;
  const z0 = floorTop - floor;
  const cavTop = b.top + above + p.topClearance;
  const zTop = cavTop + lidT;

  const outer = { L: cavL + 2 * wall, W: cavW + 2 * wall, H: zTop - z0, r: rOut };

  // --- Engeller: PCB dışındaki tüm gövdeler ---
  const obstacles = [];
  const boardObstacles = [];
  for (const part of analysis.parts) {
    for (const mi of part.meshIdx) {
      const o = { box: analysis.meshBoxes[mi], name: part.name };
      (part.isBoard ? boardObstacles : obstacles).push(o);
    }
  }

  // --- Kapak dili: dört kenar ayrı çubuk; altındaki yüksek bileşene göre kısaltılır ya da kaldırılır ---
  const sideRects = [
    { side: '-X', min: [cav.min[0] + fit, cav.min[1] + rIn], max: [cav.min[0] + fit + lipT, cav.max[1] - rIn] },
    { side: '+X', min: [cav.max[0] - fit - lipT, cav.min[1] + rIn], max: [cav.max[0] - fit, cav.max[1] - rIn] },
    { side: '-Y', min: [cav.min[0] + rIn, cav.min[1] + fit], max: [cav.max[0] - rIn, cav.min[1] + fit + lipT] },
    { side: '+Y', min: [cav.min[0] + rIn, cav.max[1] - fit - lipT], max: [cav.max[0] - rIn, cav.max[1] - fit] },
  ];
  const lipBars = [];
  const lipRemoved = [];
  const lipShortened = [];
  for (const s of sideRects) {
    const len = Math.max(s.max[0] - s.min[0], s.max[1] - s.min[1]);
    if (len < LIP_MIN_LENGTH) continue;
    let topZ = -Infinity;
    let who = null;
    for (const o of [...obstacles, ...boardObstacles]) {
      if (overlaps2D(o.box, s, LIP_COMPONENT_GAP) && o.box.max[2] > topZ) { topZ = o.box.max[2]; who = o.name; }
    }
    const allowed = cavTop - (topZ + LIP_COMPONENT_GAP);
    const depth = Math.min(rules.lid_lip_depth, allowed);
    if (depth >= rules.lid_lip_min_depth) {
      lipBars.push({ side: s.side, min: [s.min[0], s.min[1], cavTop - depth], max: [s.max[0], s.max[1], cavTop], depth });
      if (depth < rules.lid_lip_depth - 1e-6) lipShortened.push({ side: s.side, depth, who });
    } else {
      lipRemoved.push({ side: s.side, who });
    }
  }

  // --- Port açıklıkları (M3): duvardan geçen veya duvara dayalı konnektörler ---
  // Enjeksiyonda üstten açık çentik varsayılır: yan duvardaki kapalı pencere kalıpta yan maça ister.
  const portOverrides = options.portOverrides || new Map();
  // IP'de çentik conta kanalını keseceği için varsayılan her süreçte pencere
  const defaultStyle = seal ? 'window' : rules.process === 'injection' ? 'notch' : 'window';
  const cutR = rules.process === 'cnc' ? rules.process_params.tool_diameter / 2 + 0.1 : 0.5;
  const minBridge = Math.max(rules.min_wall, 1.5);
  const ports = (analysis.meshes ? detectPorts(analysis, cav, [floorTop, cavTop]) : []).map((pt) => {
    const ov = portOverrides.get(pt.key) || {};
    const enabled = ov.enabled ?? (pt.crossing || pt.connectorLike);
    let style = ov.style || defaultStyle;
    const a0 = pt.a0 - rules.cutout_clearance_xy;
    const a1 = pt.a1 + rules.cutout_clearance_xy;
    let zLo = pt.z0 - rules.cutout_clearance_z;
    let zHi = pt.z1 + rules.cutout_clearance_z;
    let clippedBottom = false;
    if (zLo < floorTop + 0.5) { zLo = floorTop + 0.5; clippedBottom = true; }
    const bridge = cavTop - zHi;
    let autoNotch = false;
    if (seal && enabled) {
      // Pencerenin üstünde conta kanalı + et payı kadar duvar kalmalı
      const need = groove.depth + seal.land;
      if (style === 'notch') {
        ipPortIssues.push(['error', `${pt.name}: çentik açıklık duvar üstündeki conta kanalını keser; ${seal.label} için pencere seçilmeli.`, null, { partId: pt.partId }]);
      } else if (bridge < need - 1e-6) {
        const extra = Math.ceil((need - bridge) * 10) / 10;
        ipPortIssues.push(['error', `${pt.name}: açıklığın üstünde ${f(Math.max(bridge, 0))} mm duvar kalıyor; conta kanalı için en az ${f(need)} mm gerekir.`,
          { key: 'topClearance', value: Math.round((p.topClearance + extra) * 10) / 10, label: `üst boşluğu ${f(p.topClearance + extra)} mm yap` }, { partId: pt.partId }]);
      }
    } else if (style === 'window' && bridge < minBridge) { style = 'notch'; autoNotch = true; }
    const openHeight = (style === 'notch' ? cavTop : zHi) - zLo;
    const inner = pt.dir > 0 ? cav.max[pt.axis] : cav.min[pt.axis];
    const outerPlane = inner + pt.dir * wall;
    const recess = pt.dir > 0 ? outerPlane - pt.front : pt.front - outerPlane; // > 0: ön yüz duvarın içinde
    const cornerGap = Math.min(a0 - cav.min[pt.along], cav.max[pt.along] - a1);
    const r = Math.max(0, Math.min(cutR, (a1 - a0) / 2 - 0.05, openHeight / 2 - 0.05));
    return { ...pt, enabled, style, autoNotch, clippedBottom, a0, a1, zLo, zHi: style === 'notch' ? cavTop + 1 : zHi,
      openWidth: a1 - a0, openHeight, bridge, inner, outerPlane, recess, cornerGap, r };
  });
  const cutouts = ports.filter((pt) => pt.enabled).map((pt) => ({
    axis: pt.axis, along: pt.along, a0: pt.a0, a1: pt.a1, z0: pt.zLo, z1: pt.zHi, r: pt.r,
    n0: Math.min(pt.inner - pt.dir * 0.5, pt.outerPlane + pt.dir * 1),
    n1: Math.max(pt.inner - pt.dir * 0.5, pt.outerPlane + pt.dir * 1),
  }));

  // --- Bağlantı (M2): montaj deliklerinden standoff, kapak borusu ve vidalar ---
  const fasteners = options.fasteners;
  const lidMode = options.lidMode || 'screw';
  // Toolbox seçimi: vida tipi (ISO), boyut ve boy ('auto' = hesapla)
  const spec = { type: 'iso7045', size: 'auto', length: 'auto', ...(options.screwSpec || {}) };
  const ttype = (options.toolbox?.types || []).find((t) => t.id === spec.type) || null;
  const tapping = isTapping(ttype);
  // Sac vidası dişini plastikte kendisi açar: süreçten bağımsız olarak gövdede ön delik
  const method = tapping ? 'self_tap' : rules.fastening || 'insert';
  const table = screwTable(fasteners, ttype);
  const mountHoles = (analysis.holes || []).map((h, i) => ({ ...h, index: i })).filter((h) => h.mount);
  const usedHoles = options.selectedHoles ? mountHoles.filter((h) => options.selectedHoles.has(h.index)) : mountHoles;
  const standoffs = [];
  const lidTubes = [];
  const screws = [];
  const fastenChecks = [];
  const lengthIssues = new Map(); // aynı vida boyu sorunu tüm deliklerde tek satır
  const depthIssues = new Map(); // aynı derinlik sorunu tüm deliklerde tek satır
  const at = (h) => `(${f(h.x)}; ${f(h.y)})`;
  const available = p.standoffHeight + floor - MIN_FLOOR_UNDER_HOLE;

  const typeSizes = ttype ? Object.keys(ttype.sizes) : null;
  const countersunk = !!ttype && ttype.head === 'countersunk';
  const specIssues = new Map();
  const noteSpec = (level, text, fix = null) => { if (!specIssues.has(text)) specIssues.set(text, [level, text, fix]); };
  let fastenInfo = null;

  if (fasteners) {
    for (const h of usedHoles) {
      let s;
      if (spec.size === 'auto') {
        s = pickScrew(h.d, table, typeSizes);
        if (!s) {
          noteSpec('error', `Ø${f(h.d)} delikten geçen ${ttype ? ttype.code + ' ' : ''}vida boyutu yok; başka bir vida tipi seç.`);
          continue;
        }
      } else {
        s = table.find((x) => x.size === spec.size);
        if (!s) continue;
        if (ttype && !typeSize(ttype, s.size)) {
          noteSpec('error', `${ttype.code} ${s.size} boyutunda tanımlı değil; listeden başka bir boyut seç.`);
        }
        if (s.min_pcb_hole > h.d + 1e-6) {
          const fit = pickScrew(h.d, table, typeSizes);
          noteSpec('error', `${s.size} vida Ø${f(h.d)} PCB deliğinden geçmez (en az Ø${f(s.min_pcb_hole)} gerekir).${fit ? ` ${fit.size} seçilebilir.` : ''}`,
            fit ? { key: 'screwSize', value: fit.size, label: `${fit.size} seç` } : null);
        }
      }
      const ts = typeSize(ttype, s.size);
      const headD = ts ? ts.dk : s.head_d;
      const headH = ts ? ts.k : s.head_h;
      const lengths = ts ? ts.lengths : fasteners.standard_lengths;
      const featureD = method === 'insert' ? s.insert_hole : method === 'tapped' ? s.tap_drill : s.selftap_pilot;
      // Plastikte sac vidası: en az 2·d diş boyu, boss dış çapı ≥ 2,5 × ön delik
      const engageD = tapping ? Math.max(2, rules.thread_engagement_d) : rules.thread_engagement_d;
      const required = method === 'insert' ? s.insert_length + 0.5 : engageD * s.d + 0.5;
      const minEngage = method === 'insert' ? 0.7 * s.insert_length : engageD * s.d;
      let od = Math.max(rules.boss_min_diameter, featureD + 2 * rules.boss_outer_wall);
      if (method === 'self_tap') od = Math.max(od, 2.2 * s.d, tapping ? 2.5 * featureD : 0);

      if (available < required - 1e-6) {
        const need = Math.ceil((required - floor + MIN_FLOOR_UNDER_HOLE) * 10) / 10;
        const text = `${s.size} ${METHOD_TEXT[method]} için ${f(required)} mm derinlik gerekir; PCB altı yükseklik + taban ${f(available)} mm veriyor.`;
        if (!depthIssues.has(text)) {
          depthIssues.set(text, { count: 0, where: at(h), text, fix: { key: 'standoffHeight', value: need, label: `${f(need)} mm uygula` } });
        }
        depthIssues.get(text).count++;
      }
      const under = obstacles.find((o) => o.box.max[2] > floorTop + 0.01 && o.box.min[2] < b.bottom - 0.01 &&
        distToBoxXY(o.box, h.x, h.y) < od / 2 + FASTENER_OBSTACLE_GAP);
      if (under) fastenChecks.push(['error', `Standoff ${at(h)}, kartın altındaki ${under.name} ile çakışıyor.`]);

      // Kapak borusu: deliğin üstündeki sütun boşsa kapaktan PCB'ye iner
      let tube = null;
      if (lidMode === 'screw') {
        const tubeOd = Math.max(rules.boss_min_diameter, s.clearance + 2 * rules.boss_outer_wall);
        const above = obstacles.find((o) => o.box.max[2] > b.top + 0.01 && o.box.min[2] < cavTop &&
          distToBoxXY(o.box, h.x, h.y) < tubeOd / 2 + FASTENER_OBSTACLE_GAP);
        if (above) {
          fastenChecks.push(['info', `Delik ${at(h)} üstünde ${above.name} var: burada kapak borusu yok, yalnızca PCB vidası.`]);
        } else {
          tube = { x: h.x, y: h.y, od: tubeOd, holeD: s.clearance, z0: b.top + TUBE_GAP, z1: cavTop, length: cavTop - b.top - TUBE_GAP };
          lidTubes.push(tube);
        }
      }

      // Havşa başlı vida yalnızca kapakta (havşa açılabilen yüzeyde) kullanılabilir
      if (countersunk) {
        if (tube) {
          const dTop = headD + 0.3;
          const depthC = (dTop - s.clearance) / 2; // 90° havşa
          tube.countersink = { dTop, depth: depthC };
          const dAtPlateBottom = dTop - 2 * lidT;
          if (dAtPlateBottom > tube.od - 0.8) {
            const needT = Math.ceil(((dTop - tube.od + 0.8) / 2) * 10) / 10;
            noteSpec('error', `${s.size} havşası (Ø${f(dTop)}, derinlik ${f(depthC)} mm) ${f(lidT)} mm kapağı ve boruyu deler; kapak/et kalınlığı en az ${f(needT)} mm olmalı ya da silindir başlı vida seç.`,
              { key: 'wall', value: needT, label: `${f(needT)} mm uygula` });
          } else if (depthC > lidT + 1e-6) {
            noteSpec('info', `${s.size} havşası ${f(depthC)} mm derin; ${f(lidT)} mm kapağın altında vida borusunun içinde devam ediyor.`);
          }
        } else {
          const alt = (options.toolbox?.types || []).find((t) => t.id === ttype.alt);
          noteSpec('error', `${ttype.code} havşa başlı vida yalnızca kapak vidası olarak kullanılabilir; PCB yüzeyine havşa açılamaz.` +
            (alt ? ` Bu delikler için ${alt.code} (${alt.short.toLocaleLowerCase('tr')}) seç.` : ''),
            alt ? { key: 'screwType', value: alt.id, label: `${alt.code} seç` } : null);
        }
      }

      // Vida boyu: baş kapak (veya PCB) üstünde, uç standoff deliğinde.
      // Havşa başlıda boy başı da kapsar ve baş kapakla aynı hizada biter: uç yine üst yüz − L'dedir.
      const grip = tube ? zTop - b.bottom : b.thickness;
      if (!fastenInfo || (tube && !fastenInfo.lidScrew)) {
        fastenInfo = { grip, available, method, size: s.size, lidScrew: !!tube, minEngage, lengths, floor };
      }
      // Seçilen boy kapak vidalarına uygulanır; kapak borusu olmayan (yalnızca PCB) deliklerde boy otomatik kalır
      const explicitLength = spec.length !== 'auto' && (tube || lidMode !== 'screw');
      if (spec.length !== 'auto' && !explicitLength) {
        noteSpec('info', 'Seçilen vida boyu kapak vidalarına uygulandı; üstü dolu (yalnızca PCB) deliklerde boy otomatik seçildi.');
      }
      let len;
      if (!explicitLength) {
        len = pickLength(lengths, grip, available, minEngage);
      } else {
        const L = Number(spec.length);
        const st = lengthStatus({ grip, available, minEngage }, L);
        len = { L, engagement: st.engagement, ok: st.status === 'ok', next: null };
        if (st.status === 'long') {
          // Seçilen vida korunur: standoff yükseltilerek delik derinleştirilir (otomatik parametrede uygulanır)
          const shorter = [...lengths].reverse().find((x) => x - grip <= available - 0.3 && x - grip >= minEngage);
          const needStandoff = Math.ceil((L - grip + 0.3 - floor + MIN_FLOOR_UNDER_HOLE) * 10) / 10;
          noteSpec('error', `${s.size}×${L} vida standoff deliğinin dibine dayanır (bu tasarımda en fazla ${f(grip + available - 0.3)} mm). ` +
            `PCB altı yükseklik ${f(needStandoff)} mm yapılırsa sığar${shorter ? `; ya da ${s.size}×${shorter} seç` : ''}.`,
            { key: 'standoffHeight', value: needStandoff, label: `${f(needStandoff)} mm uygula` });
        } else if (st.status === 'short') {
          const longer = lengths.find((x) => x - grip >= minEngage && x - grip <= available - 0.3);
          noteSpec('warn', st.engagement <= 0
            ? `${s.size}×${L} vida standoff'a ulaşmıyor: kapak + kart ${f(grip)} mm, en az ${f(grip + minEngage)} mm boy gerekir.`
            : `${s.size}×${L} vida yalnızca ${f(st.engagement)} mm tutunur (en az ${f(minEngage)} mm önerilir).`,
            longer ? { key: 'screwLength', value: longer, label: `${s.size}×${longer} seç` } : null);
        }
      }
      const depth = Math.min(available, Math.max(required, (len.L ? len.L - grip : 0) + 0.5));
      if (!explicitLength && !len.ok) {
        const needAvail = len.next !== null ? len.next - grip + 0.3 : null;
        const needStandoff = needAvail !== null ? Math.ceil((needAvail - floor + MIN_FLOOR_UNDER_HOLE) * 10) / 10 : null;
        const text = (len.L ? `${s.size}×${len.L} vida yalnızca ${f(len.engagement)} mm tutunur (en az ${f(minEngage)} mm önerilir).` : `${s.size} için uygun standart boy yok.`) +
          (needStandoff !== null ? ` PCB altı yüksekliği ${f(needStandoff)} mm yapılırsa ${s.size}×${len.next} tam oturur.` : '');
        const key = text;
        if (!lengthIssues.has(key)) {
          lengthIssues.set(key, {
            count: 0, where: at(h), text,
            fix: needStandoff !== null ? { key: 'standoffHeight', value: needStandoff, label: `${f(needStandoff)} mm uygula` } : null,
          });
        }
        lengthIssues.get(key).count++;
      }
      standoffs.push({ x: h.x, y: h.y, od, holeD: featureD, depth, z0: floorTop, z1: b.bottom, screw: s.size });
      screws.push({
        size: s.size, length: len.L, engagement: len.engagement, ok: len.ok, lid: !!tube, x: h.x, y: h.y,
        head_d: headD, head_h: headH, head_d_actual: ts?.dk_actual ?? headD, head: ttype ? ttype.head : 'pan', d: s.d, grip,
        type: ttype ? ttype.id : null, code: ttype ? ttype.code : null, name: ttype ? ttype.name : 'vida',
        driveKind: ttype ? ttype.drive_kind : null, driveText: driveText(ttype, ts),
        driveVal: ts ? ts.drive : null, driveA: ts?.A ?? null, driveM: ts?.m ?? null,
        designation: ttype ? designation(ttype, s.size, len.L) : null,
      });
    }
    // Vida tipi ile gövde süreci uyumu
    if (usedHoles.length && ttype) {
      const tapAlt = (options.toolbox?.types || []).find((t) => t.id === (ttype.head === 'countersunk' ? 'iso7050' : 'iso7049'));
      const machineAlt = (options.toolbox?.types || []).find((t) => t.id === (ttype.head === 'countersunk' ? 'iso7046' : 'iso7045'));
      if (tapping && rules.conductive) {
        noteSpec('warn', `${ttype.code} sac vidası metal gövdeye önerilmez: metrik vida + ${METHOD_TEXT[rules.fastening || 'tapped']} kullan.`,
          machineAlt ? { key: 'screwType', value: machineAlt.id, label: `${machineAlt.code} seç` } : null);
      } else if (tapping && rules.process === 'fdm') {
        noteSpec('info', `Sac vidası baskı gövdeye dişini kendisi açar (Ø${f(standoffs[0]?.holeD ?? 0)} ön delik). Sık sökülüp takılacaksa ısıyla gömülen insert + metrik vida daha dayanıklıdır.`);
      } else if (!tapping && method === 'self_tap') {
        noteSpec('warn', `${rules.label} gövdede vida dişini plastiğe kendisi açmalı: metrik ${ttype.code} yerine sac vidası seç.`,
          tapAlt ? { key: 'screwType', value: tapAlt.id, label: `${tapAlt.code} seç` } : null);
      }
    }
    for (const [level, text, fix] of specIssues.values()) fastenChecks.push([level, text, fix]);
    for (const di of depthIssues.values()) {
      fastenChecks.push(['error', (di.count > 1 ? `${di.count} delikte: ` : `Delik ${di.where}: `) + di.text, di.fix]);
    }
    for (const li of lengthIssues.values()) {
      fastenChecks.push(['warn', (li.count > 1 ? `${li.count} delikte: ` : `Delik ${li.where}: `) + li.text, li.fix]);
    }
  }

  // Malzeme listesi (BOM)
  const bom = [];
  const groups = new Map();
  for (const sc of screws) {
    const key = `${sc.size}|${sc.length}|${sc.lid}`;
    if (!groups.has(key)) groups.set(key, { ...sc, count: 0 });
    groups.get(key).count++;
  }
  for (const g of groups.values()) {
    const drive = g.driveText ? ` (${g.driveText})` : '';
    const len = g.length === null || g.length === undefined ? '?' : f(g.length);
    bom.push(`${g.count} × ${g.code ? g.code + ' ' : ''}${g.size}×${len} ${g.name.toLocaleLowerCase('tr')}${drive} — ${g.lid ? 'kapak + PCB' : 'PCB'}`);
  }
  if (standoffs.length && fasteners) {
    const s = table.find((x) => x.size === standoffs[0].screw);
    if (method === 'insert') bom.push(`${standoffs.length} × ${s.size} ısıyla gömülen insert (L ${f(s.insert_length)}; delik Ø${f(s.insert_hole)})`);
    if (method === 'tapped') bom.push(`${standoffs.length} × ${s.size} kılavuz (matkap Ø${f(s.tap_drill)})`);
    if (method === 'self_tap' && tapping) bom.push(`Gövde: ${standoffs.length} × Ø${f(s.selftap_pilot)} ön delik (${s.size} sac vidası dişini kendisi açar; insert gerekmez)`);
    if (method === 'self_tap' && !tapping) bom.push(`Vidalar plastik için sac vidası tipinde seçilmeli (ön delik Ø${f(s.selftap_pilot)})`);
  }

  // Conta kanalı geometrisi: duvarın orta çizgisi boyunca yuvarlatılmış halka
  let grooveGeom = null;
  let cordLength = 0;
  if (seal) {
    const gL = cavL + wall;
    const gW = cavW + wall;
    const gr = rIn + wall / 2;
    grooveGeom = { L: gL, W: gW, r: gr, width: groove.width, depth: groove.depth };
    cordLength = 2 * (gL + gW) - 8 * gr + 2 * Math.PI * gr;
    bom.push(`1 × Ø${f(seal.cord_d)} silikon kordon conta, ${Math.ceil(cordLength + 10)} mm (uçlar yapıştırılarak halka yapılır)`);
    const lidCount = screws.filter((s) => s.lid).length;
    if (lidCount && !countersunk) bom.push(`${lidCount} × ${screws.find((s) => s.lid).size} sızdırmazlık pulu (vida başı altına)`);
    if (lidCount && countersunk) bom.push(`Sıvı sızdırmazlık / vida sabitleyici (havşa başlı ${lidCount} kapak vidası için)`);
  }

  // --- DFM kontrolleri ---
  cat = 'genel';
  if (wall < rules.min_wall) {
    add('error', `Et kalınlığı ${f(wall)} mm, ${rules.label} için en az ${f(rules.min_wall)} mm olmalı.`);
  } else if (seal && wall > rules.recommended_wall_max && wall <= groove.rimNeed + 0.5 && rules.process !== 'injection') {
    add('info', `Et kalınlığı ${f(wall)} mm: ${seal.label} conta kanalı için önerilen aralığın (${f(rules.recommended_wall_max)} mm) üstüne çıkarıldı.`);
  } else if (wall < rules.recommended_wall_min || wall > rules.recommended_wall_max) {
    add('warn', `Et kalınlığı ${f(wall)} mm, önerilen aralığın (${f(rules.recommended_wall_min)}–${f(rules.recommended_wall_max)} mm) dışında.` +
      (seal && rules.process === 'injection' ? ' Enjeksiyonda kalın duvar çöküntü ve uzun soğuma süresi demek; IP için duvar yerine çevresel flanş (sonraki sürüm) daha uygun.' : ''));
  } else {
    add('ok', `Et kalınlığı ${f(wall)} mm, önerilen aralıkta.`);
  }
  if (rIn < rules.corner_radius_min - 1e-6) {
    add(rules.process === 'cnc' ? 'error' : 'warn', `İç köşe radyüsü ${f(rIn)} mm, kural değerinin (${f(rules.corner_radius_min)} mm) altında.`);
  }

  cat = 'surec';
  if (rules.process === 'fdm') {
    const nz = rules.process_params.nozzle_diameter;
    const n = wall / nz;
    if (Math.abs(n - Math.round(n)) > 0.05) {
      add('warn', `Et kalınlığı nozzle çapının (${f(nz)} mm) katı değil; boşluklu dolum olabilir. ${f(Math.floor(n) * nz)} veya ${f(Math.ceil(n) * nz)} mm önerilir.`);
    } else {
      add('ok', `Et kalınlığı nozzle çapının katı (${Math.round(n)} çevre).`);
    }
    add('info', 'Gövdeyi ağzı yukarı, kapağı dış yüzü tablaya gelecek şekilde bas: bu geometride destek gerekmez.');
  }

  if (rules.process === 'cnc') {
    const tool = rules.process_params.tool_diameter;
    if (rIn < tool / 2) add('error', `İç köşe radyüsü (${f(rIn)} mm), Ø${f(tool)} takımın yarıçapından küçük: işlenemez.`);
    const depth = cavTop - floorTop;
    const ratio = depth / tool;
    if (ratio > rules.process_params.max_depth_ratio) {
      add('warn', `Cep derinliği ${f(depth)} mm, Ø${f(tool)} takım için ${f(ratio)}×D (öneri ≤ ${f(rules.process_params.max_depth_ratio)}×D). Daha büyük takım ve iç köşe radyüsü (ör. Ø6 için ≥ 3,1 mm) ya da gövdeyi yükseklikte ikiye bölmek gerekebilir.`);
    } else {
      add('ok', `Cep derinliği takım için uygun (${f(ratio)}×D).`);
    }
  }

  if (rules.process === 'injection') {
    add('warn', `Geometriye kalıp çıkma açısı henüz uygulanmadı. Yan duvarlara en az ${f(rules.draft_angle_min)}° draft eklenmeli.`);
    const ratio = lipT / wall;
    if (ratio > rules.rib_ratio_max) {
      add('warn', `Kapak dili kalınlığı et kalınlığının %${Math.round(ratio * 100)}'i: çöküntü (sink) riski. En fazla %${Math.round(rules.rib_ratio_max * 100)} önerilir.`);
    } else {
      add('ok', `Kapak dili / et kalınlığı oranı %${Math.round(ratio * 100)}: çöküntü riski düşük.`);
    }
    add('ok', `Taban, duvar ve kapak aynı kalınlıkta (${f(wall)} mm): üniform et kalınlığı.`);
    const nf4 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 4 });
    add('info', `Çekme payı %${f(rules.shrink_factor * 100)}: kalıp ölçüsü = parça ölçüsü × ${nf4.format(1 + rules.shrink_factor)}.`);
  }

  if (rules.conductive) {
    const rf = analysis.parts.filter((pt) => !pt.isBoard && isRfName(pt.name)).map((pt) => pt.name);
    if (rf.length) {
      add('warn', `Metal muhafaza RF sinyalini keser. Kartta RF bileşeni var (${rf.slice(0, 3).join(', ')}): anten için plastik pencere veya dış anten gerekir.`);
    } else {
      add('info', 'Metal muhafaza iletkendir: PCB ile duvar arasındaki boşluğu ve topraklamayı kontrol et.');
    }
  }

  // Port açıklıkları
  cat = 'port';
  const styleText = (s) => (s === 'notch' ? 'çentik (üstten açık)' : 'pencere');
  let sideMachining = false;
  for (const pt of ports) {
    const focus = { partId: pt.partId };
    if (!pt.enabled) {
      if (pt.crossing) add('error', `${pt.name} ${pt.side} duvarından geçiyor ama açıklığı kapalı: gövde montajı yapılamaz.`, null, focus);
      continue;
    }
    add('ok', `${pt.name}: ${pt.side} duvarında ${styleText(pt.style)} açıklık ${f(pt.openWidth)} × ${f(pt.openHeight)} mm.`, null, focus);
    if (pt.autoNotch) {
      add('info', `${pt.name}: açıklığın üstünde yalnızca ${f(Math.max(pt.bridge, 0))} mm duvar kalacağı için açıklık üst kenara kadar uzatıldı; kapak üstünü kapatır.`, null, focus);
    }
    if (pt.clippedBottom) add('warn', `${pt.name}: açıklık tabana kadar inemeyeceği için alt kısmı kırpıldı.`, null, focus);
    if (pt.recess > 1.5) {
      add('warn', `${pt.name}: ön yüzü dış yüzeyden ${f(pt.recess)} mm içeride; fiş gövdesi duvara takılabilir. Açıklığı fiş ölçüsüne göre büyüt veya PCB–duvar boşluğunu azalt.`, null, focus);
    } else if (pt.recess < -0.05) {
      add('info', `${pt.name}: ön yüzü dış yüzeyden ${f(-pt.recess)} mm dışarı taşıyor.`, null, focus);
    }
    if (pt.cornerGap < rules.min_wall) {
      add('warn', `${pt.name}: açıklık köşeye çok yakın (${f(Math.max(pt.cornerGap, 0))} mm duvar kalıyor); köşe zayıflar.`, null, focus);
    }
    if (rules.process === 'injection') {
      if (pt.style === 'window') add('warn', `${pt.name}: kapalı pencere kalıpta yan maça (slider) gerektirir; çentik seçilirse gerekmez.`, null, focus);
    } else if (rules.process === 'fdm' && pt.style === 'window' && pt.openWidth > 10) {
      add('info', `${pt.name}: pencerenin üst kenarı ${f(pt.openWidth)} mm köprü; baskıda hafif sarkma olabilir.`, null, focus);
    }
    if (rules.process === 'cnc') sideMachining = true;
  }
  if (sideMachining) add('info', `Yan duvar açıklıkları ikinci bağlama veya 4. eksen ister; köşe radyüsü takıma göre R${f(cutR)}.`);
  if (rules.process === 'injection' && ports.some((pt) => pt.enabled && pt.style === 'notch')) {
    add('ok', 'Çentik tipi açıklıklar ana kalıp açılma yönünde: yan maça gerekmez.');
  }
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) {
      const A = ports[i], B = ports[j];
      if (!A.enabled || !B.enabled || A.side !== B.side) continue;
      const gap = Math.max(A.a0, B.a0) - Math.min(A.a1, B.a1);
      if (gap < rules.min_wall) add('warn', `${A.name} ile ${B.name} açıklıkları arasında ${f(Math.max(gap, 0))} mm duvar kalıyor.`);
    }
  }

  cat = 'kapak';
  for (const r of lipRemoved) {
    add('info', `Kapak dili ${r.side} kenarında kaldırıldı: altında yüksek bileşen var${r.who ? ` (${r.who})` : ''}.`, null, r.who ? partIdByName(r.who) : null);
  }
  for (const s of lipShortened) {
    add('info', `Kapak dili ${s.side} kenarında ${f(s.depth)} mm'ye kısaltıldı${s.who ? ` (${s.who})` : ''}.`, null, s.who ? partIdByName(s.who) : null);
  }
  if (lipBars.length === 0) add('warn', 'Kapağı konumlayacak dil hiçbir kenara sığmadı; bileşen üstü boşluğu artırmayı dene.');

  // Bağlantı kontrolleri
  cat = 'baglanti';
  if (!mountHoles.length) {
    add('warn', 'Kartta montaj deliği bulunamadı: PCB tutucu (standoff) üretilmedi, kart muhafaza içinde serbest kalır.');
    if (lidMode === 'screw') add('info', 'Kapak vidası montaj deliklerine bağlı olduğundan kapak yalnızca geçmeyle tutunur.');
  } else if (!usedHoles.length) {
    add('warn', 'Hiçbir montaj deliği seçilmedi: PCB tutucu üretilmedi.');
  }
  for (const [level, text, fix] of fastenChecks) add(level, text, fix);
  if (standoffs.length) {
    const st = standoffs[0];
    const slender = p.standoffHeight / st.od;
    if (slender > 4) add('warn', `Standoff boyu/çapı oranı ${f(slender)}: ince uzun, kırılma ve titreşim riski. Duvara kaburgayla bağlamayı düşün.`);
    else add('ok', `${standoffs.length} standoff (Ø${f(st.od)} × ${f(p.standoffHeight)} mm), ${METHOD_TEXT[method]} ile.`);
    if (method === 'insert' && rules.process === 'fdm') add('info', 'İnsertleri havya ucuyla dik bastır (PLA ~200 °C, PETG/ABS ~230 °C).');
    if (rules.process === 'injection') {
      const bossWall = (st.od - st.holeD) / 2;
      if (bossWall > wall) add('warn', `Boss duvarı (${f(bossWall)} mm) et kalınlığından kalın: karşı yüzde çöküntü riski. Boss'u kaburgayla yan duvara bağla.`);
    }
  }
  if (lidTubes.length) {
    const t = lidTubes[0];
    const ratio = t.length / t.od;
    if (rules.process === 'cnc' && ratio > 3) {
      add('warn', `Kapaktaki ${f(t.length)} mm boyundaki borular CNC'de çok malzeme kaldırmayı gerektirir; hazır metal aralayıcı (spacer) kullanmayı düşün.`);
    } else if (ratio > 6) {
      add('warn', `Kapak boruları ince uzun (boy/çap ${f(ratio)}): ${rules.process === 'injection' ? 'maça pimi eğilebilir, dolum zorlaşır' : 'baskıda titreşebilir'}.`);
    } else {
      add('ok', `${lidTubes.length} kapak borusu kapak ile PCB'yi aynı vidayla sıkıştırıyor.`);
    }
  } else if (standoffs.length && lidMode === 'screw') {
    add('warn', 'Hiçbir montaj deliğinin üstü boş değil: kapak yalnızca geçmeyle tutunur.');
  } else if (lidMode === 'none') {
    add('info', 'Kapak vidasız: yalnızca konumlandırma diliyle tutunur.');
  }

  // Sızdırmazlık (IP) kontrolleri
  cat = 'ip';
  if (seal) {
    if (wall < groove.rimNeed - 1e-6) {
      add('error', `${seal.label} conta kanalı (${f(groove.width)} × ${f(groove.depth)} mm) ve iki yanındaki ${f(seal.land)} mm et payı için et kalınlığı en az ${f(groove.rimNeed)} mm olmalı.`,
        { key: 'wall', value: groove.rimNeed, label: `${f(groove.rimNeed)} mm uygula` });
    } else {
      add('ok', `Conta kanalı ${f(groove.width)} × ${f(groove.depth)} mm: Ø${f(seal.cord_d)} kordon %${Math.round(seal.squeeze * 100)} sıkışır, kanal doluluğu %${Math.round(groove.fill * 100)}.`);
    }
    const lidScrews = screws.filter((s) => s.lid).length;
    if (!lidScrews) {
      add('error', `${seal.label} için kapak contayı sıkıştıracak vidalarla bağlanmalı; şu an vidalı kapak yok (montaj deliği veya "Vidalı" kapak bağlantısı gerekir).`);
    } else {
      const pitch = cordLength / lidScrews;
      if (pitch > seal.max_clamp_pitch) {
        add('warn', `${lidScrews} kapak vidası conta boyunca ortalama ${f(pitch)} mm aralık bırakıyor (${seal.label} için ≤ ${seal.max_clamp_pitch} mm önerilir). Kapak kenarlarda yeterince sıkışmayabilir; kenar vidası (sonraki sürüm) veya daha kalın kapak gerekir.`);
      } else {
        add('ok', `Kapak sıkıştırma aralığı ortalama ${f(pitch)} mm.`);
      }
      add('info', countersunk
        ? 'Kapak vidaları conta halkasının içinden geçiyor: havşa başlı vidada pul kullanılamaz, havşaya sıvı sızdırmazlık / vida sabitleyici sür (ya da silindir başlı vida + sızdırmazlık pulu seç).'
        : 'Kapak vidaları conta halkasının içinden geçiyor: her vida başının altına sızdırmazlık pulu koy.');
    }
    for (const [level, text, fix, focus] of ipPortIssues) add(level, text, fix, focus);
    if (ports.some((pt) => pt.enabled)) {
      add('warn', `Açık port var: ${seal.label} için konnektörlerin IP sınıflı panel tipi olması ya da port contası / kablo rakoru kullanılması gerekir.`);
    }
    if (rules.process === 'fdm') {
      add('info', 'FDM parçada katmanlar arasından sızma olabilir: en az 5 çevre, %100 dış katman ve gerekirse iç yüzeye vernik/epoksi önerilir.');
    }
    add('info', `${seal.label}: ${seal.desc}. Seviye, IEC 60529 testiyle doğrulanmalıdır.`);
  }

  return {
    ok: !checks.some((c) => c.level === 'error'),
    rulesId: rules.id,
    params: { ...p, pcbClearanceEff: clr, floor, lidT, rIn, rOut, fit, lipT },
    outer,
    cavity: { L: cavL, W: cavW, H: cavTop - floorTop, min: cav.min, max: cav.max },
    z: { z0, floorTop, cavTop, zTop },
    geometry: {
      center,
      outer: { L: outer.L, W: outer.W, r: rOut },
      cavity: { L: cavL, W: cavW, r: rIn },
      z0,
      floor,
      cavTop,
      lidT,
      zTop,
      lipBars: lipBars.map((l) => ({ min: l.min, max: l.max })),
      standoffs: standoffs.map((s) => ({ x: s.x, y: s.y, od: s.od, holeD: s.holeD, depth: s.depth, z0: s.z0, z1: s.z1 })),
      lidTubes: lidTubes.map((t) => ({ x: t.x, y: t.y, od: t.od, holeD: t.holeD, z0: t.z0, z1: t.z1, countersink: t.countersink || null })),
      cutouts,
      groove: grooveGeom,
    },
    sealing: seal ? { id: seal.id, label: seal.label, cord_d: seal.cord_d, squeeze: seal.squeeze, groove, cordLength } : null,
    ports,
    lipBars,
    lipRemoved,
    mountHoles,
    standoffs,
    lidTubes,
    screws,
    bom,
    screwSpec: spec,
    screwType: ttype ? { id: ttype.id, code: ttype.code, name: ttype.name, head: ttype.head } : null,
    fastenInfo,
    usedHoleMinD: usedHoles.length ? Math.min(...usedHoles.map((h) => h.d)) : null,
    fasteningMethod: method,
    checks,
  };
}
