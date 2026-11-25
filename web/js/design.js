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
// PCB/çip anten: kartın dışına taşsa da kutunun içinde kalmalı (duvardan açıklık açılmaz)
export const isAntennaName = (name) => /(anten|antenna|chip_?ant|pcb_?ant)/i.test(name) || String(name).toLowerCase().split(/[^a-z0-9]+/).includes('ant');
export const isRfName = (name) => RF_SUBSTR.test(name) ||
  String(name).toLowerCase().split(/[^a-z0-9]+/).some((t) => RF_TOKENS.has(t));

import { detectPorts, isConnectorName } from './ports.js';
import { planPanel } from './panel.js';
import { planMount } from './mount.js';
import { planEdgeHold } from './edgehold.js';
import { toleranceOf, lidGap, adjustScrewRow, pocketAf, compHole } from './fits.js';
import { runDesignLoop } from './dfm/loop.js';

// Isıyla gömülen insert: kör delik = insert boyu + 1 mm (CNC Kitchen)
const INSERT_HOLE_EXTRA = 1.0;
// Kılavuzlu kör delik: son tam dişin altında matkap ucu payı max(0,5·d; 5·P), en fazla 5·P + 1,5 mm (Xometry, NASA JSC-67701)
const tapOverrun = (d, P) => Math.min(Math.max(0.5 * d, 5 * P), 5 * P + 1.5);
const pitchOf = (ts, d) => ts?.P ?? Math.round((0.15 * d + 0.05) * 100) / 100;
// RF: anten çevresinde metal parça bulunmaması gereken mesafe (Espressif ESP32 donanım kılavuzu, 15 mm)
const RF_KEEPOUT = 15;
// Karbon fiber / karbon katkılı (kayıplı, kısmen iletken) malzemeler
const CARBON_FILLED = new Set(['pacf', 'petgcf']);

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
        ? ` · port üstü conta kanalı ya da panel elemanı için ${f(defaults.topClearance)} seçildi` : '';
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
 * Varsayılan parametreler: kural dosyasının değerleriyle başlayıp tasarım inceleme döngüsünün
 * (dfm/loop.js) güvenli otomatik düzeltmeleriyle yakınsatılmış değerler (kullanıcı kilidi yok).
 * options (fasteners, lidMode, selectedHoles...) verilirse PCB altı yükseklik insert/diş derinliğine
 * ve vida boyuna, et kalınlığı IP conta kanalına göre yükselir.
 */
export function defaultParams(analysis, rules, options = {}) {
  return runDesignLoop(analysis, rules, { userParams: {} }, options).params;
}

const MIN_FLOOR_UNDER_HOLE = 0.8; // mm: vida deliği altında kalacak en az taban
const TUBE_GAP = 0.1; // mm: kapak borusu ile PCB üst yüzü arası
const FASTENER_OBSTACLE_GAP = 0.2; // mm

export const LID_MODES = [
  { id: 'screw', label: 'PCB vidalarıyla ortak' },
  { id: 'corner', label: 'Köşe vidaları' },
  { id: 'none', label: 'Vidasız (geçme)' },
];

const METHOD_TEXT = {
  insert: 'ısıyla gömülen insert', tapped: 'kılavuz çekilmiş diş', self_tap: 'sac vidası (plastik için)', helicoil: 'Helicoil tel dişli burç',
  nut: 'somun cebi', standoff: 'hazır aralayıcı',
};

/**
 * Toolbox burç seçiminden bu boyut için burç ve varyant (boy). ispec.variant 'auto' ise:
 * ısıyla gömülen insertte standart (uzun) boy, Helicoil'de kural dosyasındaki helicoil_length_d (ör. 2 → "2d").
 */
function insertFor(itype, size, ispec, rules) {
  if (!itype) return null;
  const z = itype.sizes[size];
  if (!z) return null;
  let v = ispec.variant !== 'auto' ? z.variants.find((x) => x.id === ispec.variant) : null;
  if (!v && itype.kind === 'helicoil') {
    const want = `${rules.helicoil_length_d || 2}d`;
    v = z.variants.find((x) => x.id === want) || z.variants[Math.floor(z.variants.length / 2)];
  }
  if (!v) v = z.variants.filter((x) => !x.short).pop() || z.variants[z.variants.length - 1];
  return { ...z, v };
}

/**
 * Gövdedeki vida deliği (insert / Helicoil / kılavuz / sac vidası ön deliği) ölçüleri.
 * fullEngage: vidanın burcun/dişin tamamını kavraması için hedef tutunma (köşe vidalarında boy seçimi).
 */
function holeFeature(m, s, ts, rules, itype, ispec, tapping) {
  const ins = m === 'insert' || m === 'helicoil' ? insertFor(itype, s.size, ispec, rules) : null;
  const engageD = tapping ? Math.max(2, rules.thread_engagement_d) : rules.thread_engagement_d;
  let featureD;
  let required;
  let minEngage;
  let fullEngage;
  if (m === 'insert') {
    const L = ins ? ins.v.L : s.insert_length;
    featureD = ins ? ins.v.hole : s.insert_hole;
    required = L + INSERT_HOLE_EXTRA;
    minEngage = 0.7 * L;
    fullEngage = L + 0.5;
  } else if (m === 'helicoil' && ins) {
    featureD = ins.drill;
    required = ins.v.L + 3.5 * ins.P + 0.5;
    minEngage = ins.v.L;
    fullEngage = ins.v.L + 0.5;
  } else {
    featureD = m === 'self_tap' ? s.selftap_pilot : s.tap_drill;
    // Kılavuzlu kör delikte matkap ucu payı; sac vidası ön deliğinde 0,5 mm uç payı
    required = engageD * s.d + (m === 'tapped' ? tapOverrun(s.d, pitchOf(ts, s.d)) : 0.5);
    minEngage = engageD * s.d;
    fullEngage = engageD * s.d + 0.5;
  }
  let od = Math.max(rules.boss_min_diameter, featureD + 2 * rules.boss_outer_wall);
  if (m === 'self_tap') od = Math.max(od, 2.2 * s.d, tapping ? 2.5 * featureD : 0);
  if (m === 'insert' && ins) od = Math.max(od, ins.v.d1 + 2 * ins.v.wall);
  if (m === 'helicoil' && ins) od = Math.max(od, ins.dhc + 2 * rules.boss_outer_wall);
  return { featureD, required, minEngage, fullEngage, od, ins };
}

/** Gömme baş oyuğu (silindir/bombe başlar): Ø ≈ dk + 1 (M3 İmbus 6,5, M4 8; DIN 974-1 orta seriyle uyumlu), derinlik k + pul + 0,3 */
export function counterboreFor(headD, headH, washer, comp = 0) {
  const d = Math.max(headD + 1.0, washer ? washer.d2 + 0.6 : 0) + comp;
  return { d: Math.round(d * 10) / 10, depth: Math.round((headH + (washer ? washer.s : 0) + 0.3) * 100) / 100 };
}

/**
 * Köşe kapak vidası planı (geometriden bağımsız): tip, boyut, gövde tarafı yöntemi ve boss çapı.
 * Boyut 'auto' ise M3 (sac vidasında ST2.9), yoksa tipin en uygun boyutu.
 */
function planCorner(options, rules) {
  const fasteners = options.fasteners;
  if (!fasteners) return null;
  const base = { type: 'iso7045', size: 'auto', length: 'auto', material: 'auto', washer: 'none', washerMaterial: 'match', headSeat: 'surface', ...(options.screwSpec || {}) };
  const spec = options.cornerSpec ? { ...base, ...options.cornerSpec } : { ...base, size: 'auto', length: 'auto' };
  const ctype = (options.toolbox?.types || []).find((t) => t.id === spec.type) || null;
  const ctol = toleranceOf(rules, options.tolerance);
  const table = screwTable(fasteners, ctype).map((r) => adjustScrewRow(r, ctol, options.fits?.screw || 'normal'));
  const sizes = ctype ? Object.keys(ctype.sizes) : table.map((x) => x.size);
  const size = spec.size !== 'auto' && sizes.includes(spec.size) ? spec.size
    : ['M3', 'ST2.9', 'M2.5', 'M4'].find((x) => sizes.includes(x)) || sizes[sizes.length - 1];
  const s = table.find((x) => x.size === size);
  if (!s) return null;
  const ts = typeSize(ctype, size);
  const tapping = isTapping(ctype);
  const ispec = { type: 'auto', variant: 'auto', ...(options.insertSpec || {}) };
  const inserts = options.toolbox?.inserts || [];
  const ruleMethod = rules.fastening || 'insert';
  let m;
  let itC = null;
  if (tapping) m = 'self_tap';
  else if (ispec.type === 'none') m = 'tapped';
  else if (ispec.type === 'rx-heatset' || ispec.type === 'helicoil-fr') {
    itC = inserts.find((t) => t.id === ispec.type) || null;
    m = itC?.kind === 'helicoil' ? 'helicoil' : 'insert';
  } else m = ['insert', 'helicoil', 'tapped', 'self_tap'].includes(ruleMethod) ? ruleMethod : 'tapped';
  if (!itC && (m === 'insert' || m === 'helicoil')) itC = inserts.find((t) => t.kind === (m === 'helicoil' ? 'helicoil' : 'heatset')) || null;
  const feat = holeFeature(m, s, ts, rules, itC, ispec.type === 'auto' ? { variant: 'auto' } : ispec, tapping);
  return { spec, ctype, s, ts, size, tapping, method: m, itype: itC, ...feat, Rb: feat.od / 2 };
}

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
export function libraryTypes(lib, categoryId = null) {
  if (!lib) return [];
  return lib.categories.filter((c) => !categoryId || c.id === categoryId).flatMap((c) => (c.groups || []).flatMap((g) => g.types));
}

/** Pul boyutu: metrikte aynı, sac vidasında (ST) diş dış çapını geçen en küçük metrik pul */
const ST_WASHER = { 'ST2.2': 'M2.5', 'ST2.9': 'M3', 'ST3.5': 'M4', 'ST4.2': 'M4' };
export const washerSizeFor = (size) => ST_WASHER[size] || size;

/** Vida malzemesi: seçim tipte izinliyse o, değilse tipin varsayılanı (listenin ilki) */
export function resolveScrewMaterial(ttype, want, materials) {
  const allowed = ttype?.materials || [];
  const id = want && want !== 'auto' && allowed.includes(want) ? want : allowed[0];
  return materials.find((m) => m.id === id) || null;
}

/** Pul malzemesi: 'pa66' (yalıtım) ya da vidaya uygun olan */
export function resolveWasherMaterial(wtype, want, screwMat, materials) {
  const allowed = wtype?.materials || [];
  let id;
  if (want === 'pa66' && allowed.includes('pa66')) id = 'pa66';
  else if (screwMat?.family === 'stainless') id = 'a2';
  else if (screwMat?.family === 'plastic') id = allowed.includes('pa66') ? 'pa66' : 'a2';
  else if (screwMat?.family === 'brass') id = allowed.includes('brass') ? 'brass' : 'a2';
  else id = wtype?.kind === 'flat' ? 'st200zn' : 'springzn';
  if (!allowed.includes(id)) id = allowed[0];
  return materials.find((m) => m.id === id) || null;
}

/**
 * VDI 2230 yaklaşımıyla vida ön yükü ve en büyük sıkma torku.
 * d, P: diş; rp: akma (MPa); mu: sürtünme; nu: kullanım oranı; dw: baş/pul oturma çapı; dh: delik çapı.
 * Dönen kT: birim ön yük başına tork (N·mm/N) — bağlantı sınırlarını torka çevirmek için.
 */
export function screwTorque({ d, P, rp, mu, nu = 0.9, dw, dh, countersunk = false }) {
  const d2 = d - 0.6495 * P;
  const d3 = d - 1.2269 * P;
  const ds = (d2 + d3) / 2;
  const As = (Math.PI / 4) * ds * ds;
  const k = 1.5 * (d2 / ds) * (P / (Math.PI * d2) + 1.155 * mu);
  const F = (nu * rp * As) / Math.sqrt(1 + 3 * k * k);
  const muK = countersunk ? mu / Math.cos(Math.PI / 4) : mu;
  const Dkm = (dw + dh) / 2;
  const kT = 0.16 * P + 0.58 * mu * d2 + (muK * Dkm) / 2;
  return { F, T: (F * kT) / 1000, kT };
}

const roundTorque = (t) => (t >= 1 ? Math.round(t * 10) / 10 : Math.round(t * 100) / 100);
const LIMIT_TEXT = {
  screw: 'vida dayanımı', bearing_lid: 'kapakta baş/pul baskısı', bearing_pcb: 'PCB yüzeyinde baş/pul baskısı',
  strip: 'gövdede diş sıyırma', insert: 'insertin plastikten sökülmesi', helicoil: 'Helicoil yuvası (gövde)',
  nut_bearing: 'somunun gövdeye baskısı', standoff: 'aralayıcı dişi',
};
export const torqueLimitText = (k) => LIMIT_TEXT[k] || k;

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

/** Yuvarlatılmış dikdörtgen yol (conta orta çizgisi) üzerinde noktanın yol parametresi ve uzaklığı */
function roundedRectPath(cx, cy, L, W, r) {
  const pts = [];
  const hx = L / 2 - r;
  const hy = W / 2 - r;
  const corners = [[hx, -hy, -Math.PI / 2], [hx, hy, 0], [-hx, hy, Math.PI / 2], [-hx, -hy, Math.PI]];
  for (const [ox, oy, a0] of corners) {
    for (let k = 0; k <= 8; k++) {
      const a = a0 + (k / 8) * (Math.PI / 2);
      pts.push([cx + ox + r * Math.cos(a), cy + oy + r * Math.sin(a)]);
    }
  }
  const segs = [];
  let s0 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    segs.push({ p, q, s0, len });
    s0 += len;
  }
  return {
    length: s0,
    project(x, y) {
      let best = null;
      for (const g of segs) {
        const dx = g.q[0] - g.p[0];
        const dy = g.q[1] - g.p[1];
        const t = g.len > 1e-9 ? Math.max(0, Math.min(1, ((x - g.p[0]) * dx + (y - g.p[1]) * dy) / (g.len * g.len))) : 0;
        const px = g.p[0] + t * dx;
        const py = g.p[1] + t * dy;
        const dist = Math.hypot(x - px, y - py);
        if (!best || dist < best.dist) best = { s: g.s0 + t * g.len, dist };
      }
      return best;
    },
  };
}

/** Düşey parça (x, y, z0..z1) ile kutu arasındaki 3B en kısa uzaklık */
function distSegBox(box, x, y, z0, z1) {
  const dxy = distToBoxXY(box, x, y);
  const lo = Math.min(z0, z1);
  const hi = Math.max(z0, z1);
  const dz = hi < box.min[2] ? box.min[2] - hi : lo > box.max[2] ? lo - box.max[2] : 0;
  return Math.hypot(dxy, dz);
}

/** İki kutu arası 3B en kısa uzaklık */
function distBoxBox(a, b) {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.max(0, a.min[k] - b.max[k], b.min[k] - a.max[k]);
    s += d * d;
  }
  return Math.sqrt(s);
}

const ceil01 = (v) => Math.ceil(v * 10 - 1e-6) / 10;
const ceil005 = (v) => Math.round(Math.ceil(v / 0.05 - 1e-6) * 0.05 * 100) / 100;

export function computeDesign(analysis, rules, params, options = {}) {
  const checks = [];
  // Kontrol (bulgu) kaydı: { level, text, fix, cat, focus, rule, measured, limit, op, unit, part }
  // fix: { key, value, label, auto? } — arayüzde tek tıkla uygulanabilecek öneri; auto: false ise döngü uygulamaz (yalnızca öneri)
  // cat: genel | surec | port | kapak | baglanti | montaj | panel | ip | rf; focus: { partId } — 3B'de vurgulanacak bileşen
  // rule: dfm/catalog.js kural kimliği; measured/limit/op/unit: sayısal karşılaştırma (ör. 1,0 >= 1,2 mm)
  let cat = 'genel';
  const add = (level, text, fix = null, focus = null, rule = null, meta = null) => {
    const c = { level, text, fix, cat, focus, rule };
    if (meta) {
      for (const k of ['measured', 'limit', 'op', 'unit', 'part']) if (meta[k] !== undefined && meta[k] !== null) c[k] = meta[k];
      if (meta.cat) c.cat = meta.cat;
    }
    checks.push(c);
  };
  // Alt planlayıcıların (panel, montaj, kenar tutucu) nesne biçimli kontrolleri
  const addC = (c) => add(c.level, c.text, c.fix ?? null, c.focus ?? null, c.rule ?? null, c);
  const num = (v) => Math.round(v * 100) / 100;
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
  // Kapak ayrı süreç/malzemeden olabilir (ör. CNC alüminyum gövde + akrilik kapak): kapak kuralları lr
  const lr = options.lidRules || rules;
  const mixedLid = lr !== rules && lr.id !== rules.id;
  const lidT = mixedLid ? Math.max(wall, lr.min_wall) : wall;
  // Tolerans ve geçme (malzeme + süreç + kullanıcı düzeltmesi); kapak dili boşluğu kart boyuna göre
  const tol = toleranceOf(rules, options.tolerance);
  const lidTol = mixedLid ? toleranceOf(lr, options.lidTolerance) : tol;
  const fitSel = { lid: 'normal', screw: 'normal', ...(options.fits || {}) };
  const fitL = Math.max(b.box.max[0] - b.box.min[0], b.box.max[1] - b.box.min[1]) + 2 * p.pcbClearance;
  // Farklı malzemede: iki malzemenin kapak boşluğu ortalaması + ısıl genleşme farkı (ΔT = 40 K, her yan yarısı)
  const cteMismatch = mixedLid && rules.cte_um_mk && lr.cte_um_mk ? (Math.abs(rules.cte_um_mk - lr.cte_um_mk) * 1e-6 * fitL * 40) / 2 : 0;
  const fit = mixedLid
    ? Math.round(((lidGap(tol, fitSel.lid, fitL) + lidGap(lidTol, fitSel.lid, fitL)) / 2 + cteMismatch) * 100) / 100
    : lidGap(tol, fitSel.lid, fitL);
  const lipT = lr.lid_lip_thickness;
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
      add('info', `PCB–duvar boşluğu ${f(clr)} mm'den ${f(need)} mm'ye çıkarıldı: ${f(rIn)} mm iç köşe radyüsü PCB köşelerine değmesin.`,
        null, null, 'GEN-CORNER-CLEARANCE', { measured: num(clr), limit: num(need), op: '>=', unit: 'mm' });
      clr = need;
    }
  }
  const cav = {
    min: [b.box.min[0] - clr, b.box.min[1] - clr],
    max: [b.box.max[0] + clr, b.box.max[1] + clr],
  };
  // Kartın dışına taşan ama dışarıdan erişim gerektirmeyen parçalar (ör. modülün PCB anteni) kutunun içine alınır:
  // adı anten olanlar kendiliğinden, diğerleri port listesinde "İçeri al" ile. encloseOverrides: Map(partId → true/false)
  const encOv = options.encloseOverrides || new Map();
  const enclosed = [];
  for (const pt of analysis.parts) {
    if (pt.isBoard || !pt.box || !(pt.edges || []).some((e) => e.kind === 'overhang')) continue;
    const auto = isAntennaName(pt.name) && !isConnectorName(pt.name);
    const want = encOv.has(pt.id) ? encOv.get(pt.id) : auto;
    if (!want) continue;
    for (const k of [0, 1]) {
      cav.min[k] = Math.min(cav.min[k], pt.box.min[k] - clr);
      cav.max[k] = Math.max(cav.max[k], pt.box.max[k] + clr);
    }
    enclosed.push({ partId: pt.id, name: pt.name, auto });
  }
  // --- Köşe kapak vidaları (Paket C): boss'lar PCB köşesine çarpmasın diye kavite bir eksende uzatılır ---
  const cornerMode = (options.lidMode || 'screw') === 'corner';
  const cplan = cornerMode ? planCorner(options, rules) : null;
  let cornerPad = null;
  if (cplan) {
    const need = 2 * cplan.Rb + 0.5; // duvardan PCB kenarına gereken boşluk
    const extra = Math.max(0, need - clr);
    // Konnektör/taşan bileşen olan kenarları uzatmamaya çalış
    const occ = { '-X': 0, '+X': 0, '-Y': 0, '+Y': 0 };
    for (const pt of analysis.parts) for (const e of pt.edges || []) if (e.side in occ) occ[e.side] += e.kind === 'overhang' ? 2 : 1;
    const cost = { X: occ['-X'] + occ['+X'], Y: occ['-Y'] + occ['+Y'] };
    let axis = options.cornerAxis === 'x' ? 0 : options.cornerAxis === 'y' ? 1 : null;
    if (axis === null) axis = cost.X < cost.Y ? 0 : cost.Y < cost.X ? 1 : (cav.max[0] - cav.min[0] >= cav.max[1] - cav.min[1] ? 0 : 1);
    if (extra > 0) {
      cav.min[axis] -= extra;
      cav.max[axis] += extra;
    }
    cornerPad = { axis, extra, need, occupied: axis === 0 ? cost.X : cost.Y };
  }
  const cavL = cav.max[0] - cav.min[0];
  const cavW = cav.max[1] - cav.min[1];
  const center = [(cav.min[0] + cav.max[0]) / 2, (cav.min[1] + cav.max[1]) / 2];

  // --- Düşey ölçüler ---
  if (p.standoffHeight < below + 0.2) {
    const needSo = ceil01(below + (rules.under_board_clearance ?? 1));
    add('error', `PCB altı yükseklik ${f(p.standoffHeight)} mm, kartın altından taşan ${f(below)} mm pin/bileşen için yetersiz: tabana çarpar.`,
      { key: 'standoffHeight', value: needSo, label: `${f(needSo)} mm uygula` }, analysis.maxBelow?.partId != null ? { partId: analysis.maxBelow.partId } : null,
      'GEN-STANDOFF-BELOW', { measured: num(p.standoffHeight), limit: num(below + 0.2), op: '>=', unit: 'mm' });
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
  // Köşe boss'ları varsa dil uçları boss'tan önce biter
  const lipEnd = cplan ? Math.max(rIn, 2 * cplan.Rb + 0.4) : rIn;
  const sideRects = [
    { side: '-X', min: [cav.min[0] + fit, cav.min[1] + lipEnd], max: [cav.min[0] + fit + lipT, cav.max[1] - lipEnd] },
    { side: '+X', min: [cav.max[0] - fit - lipT, cav.min[1] + lipEnd], max: [cav.max[0] - fit, cav.max[1] - lipEnd] },
    { side: '-Y', min: [cav.min[0] + lipEnd, cav.min[1] + fit], max: [cav.max[0] - lipEnd, cav.min[1] + fit + lipT] },
    { side: '+Y', min: [cav.min[0] + lipEnd, cav.max[1] - fit - lipT], max: [cav.max[0] - lipEnd, cav.max[1] - fit] },
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
    const depth = Math.min(lr.lid_lip_depth, allowed);
    if (depth >= lr.lid_lip_min_depth) {
      lipBars.push({ side: s.side, min: [s.min[0], s.min[1], cavTop - depth], max: [s.max[0], s.max[1], cavTop], depth });
      if (depth < lr.lid_lip_depth - 1e-6) lipShortened.push({ side: s.side, depth, who });
    } else {
      lipRemoved.push({ side: s.side, who, allowed });
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
        ipPortIssues.push({ level: 'error', text: `${pt.name} (${pt.side}): çentik açıklık duvar üstündeki conta kanalını keser; ${seal.label} için pencere seçilmeli.`,
          fix: { key: 'portStyle', value: `${pt.key}|window`, label: 'Pencere yap' }, focus: { partId: pt.partId }, rule: 'IP-PORT-NOTCH' });
      } else if (bridge < need - 1e-6) {
        const extra = Math.ceil((need - bridge) * 10) / 10;
        ipPortIssues.push({ level: 'error', text: `${pt.name} (${pt.side}): açıklığın üstünde ${f(Math.max(bridge, 0))} mm duvar kalıyor; conta kanalı ve et payı için en az ${f(need)} mm gerekir.`,
          fix: { key: 'topClearance', value: Math.round((p.topClearance + extra) * 10) / 10, label: `üst boşluğu ${f(p.topClearance + extra)} mm yap` }, focus: { partId: pt.partId },
          rule: 'IP-PORT-BRIDGE', measured: num(Math.max(bridge, 0)), limit: num(need), op: '>=', unit: 'mm' });
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
  // Gövde tarafı (Toolbox › dişli burçlar): 'auto' = kural dosyası, 'none' = doğrudan kılavuz, ya da burç tipi.
  // Sac vidası dişini plastikte kendisi açar: süreçten ve burç seçiminden bağımsız olarak gövdede ön delik.
  const insertTypes = options.toolbox?.inserts || [];
  const ispec = { type: 'auto', variant: 'auto', nut: 'iso4032', standoff: 'hex-ff', standoffMat: 'auto', ...(options.insertSpec || {}) };
  const ruleMethod = rules.fastening || 'insert';
  let method;
  let itype = null;
  // Somun cebi (ISO › Somunlar) ve hazır aralayıcı (DIN · üretici › Aralayıcılar)
  const ntype = ispec.type === 'nut' ? (options.toolbox?.nuts || []).find((x) => x.id === ispec.nut) || (options.toolbox?.nuts || [])[0] || null : null;
  const sotype = ispec.type === 'standoff' ? (options.toolbox?.standoffs || []).find((x) => x.id === ispec.standoff) || (options.toolbox?.standoffs || [])[0] || null : null;
  if (tapping) method = 'self_tap';
  else if (ispec.type === 'auto') method = ruleMethod;
  else if (ispec.type === 'none') method = 'tapped';
  else if (ispec.type === 'nut' && ntype) method = 'nut';
  else if (ispec.type === 'standoff' && sotype) method = 'standoff';
  else {
    itype = insertTypes.find((t) => t.id === ispec.type) || null;
    method = itype ? (itype.kind === 'helicoil' ? 'helicoil' : 'insert') : ruleMethod;
  }
  if (!itype && (method === 'insert' || method === 'helicoil')) {
    itype = insertTypes.find((t) => t.kind === (method === 'helicoil' ? 'helicoil' : 'heatset')) || null;
  }
  const table = screwTable(fasteners, ttype).map((r) => adjustScrewRow(r, tol, fitSel.screw));
  // Kapaktaki geçiş delikleri kapak malzemesinin delik telafisiyle (ISO 273 serisi aynı)
  const lidClr = (s) => (mixedLid ? Math.round((s.clearance - (tol.hole_comp || 0) + (lidTol.hole_comp || 0)) * 100) / 100 : s.clearance);
  const mountHoles = (analysis.holes || []).map((h, i) => ({ ...h, index: i })).filter((h) => h.mount);
  const usedHoles = options.selectedHoles ? mountHoles.filter((h) => options.selectedHoles.has(h.index)) : mountHoles;
  const standoffs = [];
  // Tüm standoff delik çapları (yalnızca ilk eleman değil): "4 / 3,2"
  const holeDiaList = () => [...new Set(standoffs.map((s) => f(s.holeD)))].join(' / ') || '–';
  const lidTubes = [];
  const cornerBosses = [];
  const lidHoles = [];
  let cornerInfo = null;
  const screws = [];
  const fastenChecks = [];
  const lengthIssues = new Map(); // aynı vida boyu sorunu tüm deliklerde tek satır
  const depthIssues = new Map(); // aynı derinlik sorunu tüm deliklerde tek satır
  const at = (h) => `(${f(h.x)}; ${f(h.y)})`;
  const available = p.standoffHeight + floor - MIN_FLOOR_UNDER_HOLE;

  const typeSizes = ttype ? Object.keys(ttype.sizes) : null;
  const countersunk = !!ttype && ttype.head === 'countersunk';
  const specIssues = new Map();
  // Aynı metinli bağlantı notu tüm deliklerde tek satır (rule: katalog kimliği, meta: sayısal karşılaştırma)
  const noteSpec = (level, text, fix = null, rule = null, meta = null) => {
    if (!specIssues.has(text)) specIssues.set(text, { level, text, fix, rule, ...(meta || {}) });
  };
  let fastenInfo = null;
  // Malzeme / kaplama, baş altı pulu ve tork modeli (Toolbox)
  const matList = options.toolbox?.materials || [];
  const tmodel = { nu: 0.9, plastic_safety: 2, metal_safety: 1.25, pcb_bearing_mpa: 100, ...(options.toolbox?.model || {}) };
  const screwMat = resolveScrewMaterial(ttype, spec.material, matList);
  const wtype = !spec.washer || spec.washer === 'none' ? null
    : (options.toolbox?.washers || []).find((w) => w.id === spec.washer) || null;
  if (wtype && countersunk) noteSpec('info', `Havşa başlı vidada baş altı pulu kullanılmaz; ${wtype.code} yok sayıldı.`, null, 'FAS-WASHER');
  const useWasher = wtype && !countersunk ? wtype : null;
  const washerMat = useWasher ? resolveWasherMaterial(useWasher, spec.washerMaterial, screwMat, matList) : null;
  const torqueOf = []; // her vida için tork özeti

  if (fasteners) {
    for (const h of usedHoles) {
      let s;
      if (spec.size === 'auto') {
        s = pickScrew(h.d, table, typeSizes);
        if (!s) {
          noteSpec('error', `Ø${f(h.d)} delikten geçen ${ttype ? ttype.code + ' ' : ''}vida boyutu yok; başka bir vida tipi seç.`, null, 'FAS-SCREW-FIT', { measured: num(h.d), unit: 'mm' });
          continue;
        }
      } else {
        s = table.find((x) => x.size === spec.size);
        if (!s) continue;
        if (ttype && !typeSize(ttype, s.size)) {
          noteSpec('error', `${ttype.code} ${s.size} boyutunda tanımlı değil; listeden başka bir boyut seç.`, null, 'FAS-TYPE-SIZE');
        }
        if (s.min_pcb_hole > h.d + 1e-6) {
          const fit = pickScrew(h.d, table, typeSizes);
          noteSpec('error', `${s.size} vida Ø${f(h.d)} PCB deliğinden geçmez (en az Ø${f(s.min_pcb_hole)} gerekir).${fit ? ` ${fit.size} seçilebilir.` : ''}`,
            fit ? { key: 'screwSize', value: fit.size, label: `${fit.size} seç` } : null, 'FAS-SCREW-FIT', { measured: num(h.d), limit: num(s.min_pcb_hole), op: '>=', unit: 'mm' });
        }
      }
      const ts = typeSize(ttype, s.size);
      const headD = ts ? ts.dk : s.head_d;
      const headH = ts ? ts.k : s.head_h;
      const lengths = ts ? ts.lengths : fasteners.standard_lengths;
      // Gövde tarafı deliği: insert deliği / Helicoil matkabı / kılavuz matkabı / sac vidası ön deliği
      const ins = method === 'insert' || method === 'helicoil' ? insertFor(itype, s.size, ispec, rules) : null;
      let avail = available; // vida ucunun inebileceği derinlik (PCB altından)
      let integral = true; // gövdeyle tek parça boss (hazır aralayıcıda yok)
      let nutGeo = null;
      let soGeo = null;
      let soMat = null;
      let bottomScrew = null;
      // Plastikte sac vidası: en az 2·d diş boyu, boss dış çapı ≥ 2,5 × ön delik
      const engageD = tapping ? Math.max(2, rules.thread_engagement_d) : rules.thread_engagement_d;
      let featureD;
      let required;
      let minEngage;
      if (method === 'insert') {
        // Kör delik = insert boyu + 1 mm (CNC Kitchen): eriyen plastik ve insert ucu için pay
        const L = ins ? ins.v.L : s.insert_length;
        featureD = ins ? ins.v.hole : s.insert_hole;
        required = L + INSERT_HOLE_EXTRA;
        minEngage = 0.7 * L;
      } else if (method === 'helicoil' && ins) {
        // Kör delik: burç boyu + 1·P diş + ~2,5·P kılavuz ucu payı; vida burcun tamamını kavramalı
        featureD = ins.drill;
        required = ins.v.L + 3.5 * ins.P + 0.5;
        minEngage = ins.v.L;
      } else if (method === 'nut' && ntype.sizes[s.size]) {
        // Somun cebi: vida standoff'tan geçer, somunda tutunur. Altıgen somun tabandan cebe, kare somun yandan yuvaya
        const nz = ntype.sizes[s.size];
        const Pn = ts?.P ?? 0.5;
        const pocketS = pocketAf(nz.s, tol); // somun cebi: elle oturan geçme + FDM telafisi
        featureD = s.clearance;
        if (ntype.kind === 'square') {
          const topWall = Math.max(1.2, 2 * Pn);
          const nutTop = b.bottom - topWall;
          const nutBot = nutTop - nz.m - 0.2;
          minEngage = b.bottom - nutBot + Pn;
          required = topWall + nz.m + 0.2 + Pn + 1.0;
          const dx = (cav.min[0] + cav.max[0]) / 2 - h.x;
          const dy = (cav.min[1] + cav.max[1]) / 2 - h.y;
          const axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
          nutGeo = { shape: 'square', s: pocketS, z0: nutBot, z1: nutTop, axis, dir: Math.sign(axis === 0 ? dx : dy) || 1,
            area: nz.s * nz.s - (Math.PI / 4) * s.clearance * s.clearance, nz };
        } else {
          // Cep derinliği vida boyuna göre ayarlanır: somun, vida ucu somundan 1,5·P taşacak yükseklikte durur.
          // En az tutunma = somun üstünde PCB altına 1,2 mm et + somun + 1,5·P; en fazla = uç tabandan 0,8 mm içeride.
          minEngage = 1.2 + nz.m + 1.5 * Pn;
          required = minEngage + 0.3;
          nutGeo = { shape: 'hex', s: pocketS, z0, depth: nz.m + 0.6, nutTop: z0 + nz.m + 0.6, Pn,
            area: 0.866 * nz.s * nz.s - (Math.PI / 4) * s.clearance * s.clearance, nz };
        }
      } else if (method === 'standoff' && sotype.sizes[s.size]) {
        // Hazır aralayıcı: gövdede boss yok; aralayıcı tabana alttan vida (dişi-dişi) ya da somunla (erkek-dişi) bağlanır
        const sz = sotype.sizes[s.size];
        integral = false;
        const Ls = p.standoffHeight;
        if (!sz.lengths.some((x) => Math.abs(x - Ls) < 0.05)) {
          const next = sz.lengths.find((x) => x >= Ls - 1e-6) ?? sz.lengths[sz.lengths.length - 1];
          noteSpec('error', `Hazır aralayıcı boyu = PCB altı yükseklik (${f(Ls)} mm) standart değil; ${next} mm aralayıcı için PCB altı yüksekliği ${next} mm yap.`,
            { key: 'standoffHeight', value: next, label: `${next} mm uygula` }, 'FAS-STANDOFF');
        }
        soMat = resolveScrewMaterial(sotype, ispec.standoffMat, matList);
        featureD = s.clearance;
        required = 0;
        if (sotype.ends === 'ff') {
          // Alttan vida: üst ve alt vida aralayıcının yarısını paylaşır
          const half = Ls / 2 - 0.25;
          const gB = floor;
          const minB = Math.min(s.d, half - 0.25);
          const Lb = lengths.find((x) => x - gB >= minB - 1e-9 && x - gB <= half + 1e-9) ?? lengths.find((x) => x - gB >= minB - 1e-9) ?? null;
          const eB = Lb !== null ? Math.min(half, Lb - gB) : half;
          if (Lb === null || Lb - gB > half + 1e-9) noteSpec('warn', `${s.size} alttan vida için ${f(Ls)} mm aralayıcıda uygun standart boy yok; daha uzun aralayıcı seç.`, null, 'FAS-STANDOFF');
          bottomScrew = { L: Lb, eng: eB };
          avail = Ls - eB - 0.2;
          minEngage = Math.max(0.6 * s.d, Math.min(s.d, avail - 0.3));
          if (avail - 0.3 < 0.8 * s.d) noteSpec('info', `${f(Ls)} mm aralayıcıda üst ve alt vida yalnızca ~${f(Math.max(0, avail - 0.3))} mm tutunur (< 0,8·d); daha uzun aralayıcı önerilir.`, null, 'FAS-STANDOFF', { measured: num(Math.max(0, avail - 0.3)), limit: num(0.8 * s.d), op: '>=', unit: 'mm' });
        } else {
          const fd = Math.max(2.5, Math.round(0.65 * Ls * 10) / 10);
          avail = fd + 0.3;
          minEngage = Math.min(s.d, fd - 0.2);
          const nutM = (options.toolbox?.nuts || []).find((x) => x.id === 'iso4032')?.sizes[s.size]?.m ?? 0.8 * s.d;
          const Pn = ts?.P ?? 0.5;
          if (sz.male < floor + nutM + Pn - 1e-9) {
            noteSpec('warn', `Erkek-dişi aralayıcının ${sz.male} mm erkek dişi, ${f(floor)} mm taban + ${f(nutM)} mm somunu geçmiyor; dişi-dişi aralayıcı + alttan vida seç.`,
              { key: 'standoffType', value: 'hex-ff', label: 'Dişi-dişi seç' }, 'FAS-STANDOFF', { measured: num(sz.male), limit: num(floor + nutM + Pn), op: '>=', unit: 'mm' });
          }
        }
        soGeo = { sw: sz.sw, L: Ls, ends: sotype.ends, male: sz.male || 0 };
      } else {
        featureD = method === 'self_tap' ? s.selftap_pilot : s.tap_drill;
        // Kılavuzlu kör delik: diş boyu + matkap ucu payı (Xometry, NASA JSC-67701); sac vidasında uç payı 0,5 mm
        required = engageD * s.d + (method === 'tapped' || (method === 'helicoil' && !ins) ? tapOverrun(s.d, pitchOf(ts, s.d)) : 0.5);
        minEngage = engageD * s.d;
        if (method === 'helicoil') noteSpec('warn', `${s.size} için Helicoil verisi yok; doğrudan kılavuz olarak hesaplandı.`, null, 'FAS-DATA');
        if (method === 'nut') noteSpec('error', `${ntype.code} ${s.size} boyutunda yok; başka somun ya da vida boyutu seç.`, null, 'FAS-DATA');
        if (method === 'standoff') noteSpec('error', `${sotype.name} ${s.size} boyutunda yok (yalnızca ${Object.keys(sotype.sizes).join(', ')}).`, null, 'FAS-DATA');
      }
      let od = Math.max(rules.boss_min_diameter, featureD + 2 * rules.boss_outer_wall);
      if (method === 'self_tap') od = Math.max(od, 2.2 * s.d, tapping ? 2.5 * featureD : 0);
      if (method === 'insert' && ins) od = Math.max(od, ins.v.d1 + 2 * ins.v.wall);
      if (method === 'helicoil' && ins) od = Math.max(od, ins.dhc + 2 * rules.boss_outer_wall);
      if (nutGeo) od = Math.max(od, nutGeo.nz.e + (nutGeo.s - nutGeo.nz.s) + 2 * 1.2);
      if (soGeo) od = soGeo.sw * 1.155;

      if (avail < required - 1e-6) {
        const need = Math.ceil((required - floor + MIN_FLOOR_UNDER_HOLE) * 10) / 10;
        // Kural: ısıyla gömülen insert (FDM) / kılavuzlu kör delik (CNC) / genel vida derinliği
        const rule = method === 'insert' && rules.process === 'fdm' ? 'FDM-INSERT-DEPTH'
          : (method === 'tapped' || (method === 'helicoil' && !ins)) && rules.process === 'cnc' ? 'CNC-TAP-DEPTH' : 'FAS-DEPTH';
        const why = method === 'insert' ? ` (insert boyu + ${f(INSERT_HOLE_EXTRA)} mm)`
          : method === 'tapped' || (method === 'helicoil' && !ins) ? ` (diş ${f(engageD * s.d)} + matkap ucu payı ${f(tapOverrun(s.d, pitchOf(ts, s.d)))} mm)` : '';
        const text = `${s.size} ${METHOD_TEXT[method]} için ${f(required)} mm kör delik derinliği gerekir${why}; PCB altı yükseklik + taban ${f(avail)} mm veriyor.`;
        if (!depthIssues.has(text)) {
          depthIssues.set(text, { count: 0, where: at(h), text, rule, measured: num(avail), limit: num(required),
            fix: { key: 'standoffHeight', value: need, label: `${f(need)} mm uygula` } });
        }
        depthIssues.get(text).count++;
      }
      const under = obstacles.find((o) => o.box.max[2] > floorTop + 0.01 && o.box.min[2] < b.bottom - 0.01 &&
        distToBoxXY(o.box, h.x, h.y) < od / 2 + FASTENER_OBSTACLE_GAP);
      if (under) {
        // Bu noktaya sığabilecek en büyük boss çapı: kullanıcı küçük aralayıcıya geçebilir ya da deliği bırakabilir
        const dmax = Math.max(0, 2 * (distToBoxXY(under.box, h.x, h.y) - FASTENER_OBSTACLE_GAP));
        fastenChecks.push({ level: 'error', text: `Standoff ${at(h)} (Ø${f(od)}), kartın altındaki ${under.name} ile çakışıyor; bu noktada en fazla Ø${f(dmax)} boss sığar. Daha küçük vida/aralayıcı seçin ya da bu deliği kullanmayın.`,
          fix: { key: 'holeOff', value: h.index, label: 'Bu deliği kullanma' }, focus: partIdByName(under.name), rule: 'FAS-COLLIDE',
          measured: num(od), limit: num(dmax), op: '<=', unit: 'mm' });
      }

      // Kapak borusu: deliğin üstündeki sütun boşsa kapaktan PCB'ye iner
      let tube = null;
      if (lidMode === 'screw') {
        const tubeOd = Math.max(lr.boss_min_diameter, lidClr(s) + 2 * lr.boss_outer_wall);
        const above = obstacles.find((o) => o.box.max[2] > b.top + 0.01 && o.box.min[2] < cavTop &&
          distToBoxXY(o.box, h.x, h.y) < tubeOd / 2 + FASTENER_OBSTACLE_GAP);
        if (above) {
          fastenChecks.push({ level: 'info', text: `Delik ${at(h)}: üstünde ${above.name} olduğu için kapak borusu yok, yalnızca PCB vidası.`,
            focus: partIdByName(above.name), rule: 'LID-TUBE-NONE' });
        } else {
          tube = { x: h.x, y: h.y, od: tubeOd, holeD: lidClr(s), z0: b.top + TUBE_GAP, z1: cavTop, length: cavTop - b.top - TUBE_GAP };
          lidTubes.push(tube);
        }
      }

      // Havşa başlı vida yalnızca kapakta (havşa açılabilen yüzeyde) kullanılabilir
      if (countersunk) {
        if (tube) {
          const dTop = headD + 0.3;
          const depthC = (dTop - lidClr(s)) / 2; // 90° havşa
          tube.countersink = { dTop, depth: depthC };
          const dAtPlateBottom = dTop - 2 * lidT;
          if (dAtPlateBottom > tube.od - 0.8) {
            const needT = Math.ceil(((dTop - tube.od + 0.8) / 2) * 10) / 10;
            noteSpec('error', `${s.size} havşası (Ø${f(dTop)}, derinlik ${f(depthC)} mm) ${f(lidT)} mm kapağı ve boruyu deler; kapak/et kalınlığı en az ${f(needT)} mm olmalı ya da silindir başlı vida seç.`,
              { key: 'wall', value: needT, label: `${f(needT)} mm uygula` }, 'FAS-CSK', { measured: num(lidT), limit: needT, op: '>=', unit: 'mm', part: 'lid' });
          } else if (depthC > lidT + 1e-6) {
            noteSpec('info', `${s.size} havşası ${f(depthC)} mm derin; ${f(lidT)} mm kapağın altında vida borusunun içinde devam ediyor.`, null, 'FAS-CSK', { part: 'lid' });
          }
        } else {
          const alt = (options.toolbox?.types || []).find((t) => t.id === ttype.alt);
          noteSpec('error', `${ttype.code} havşa başlı vida yalnızca kapak vidası olarak kullanılabilir; PCB yüzeyine havşa açılamaz.` +
            (alt ? ` Bu delikler için ${alt.code} (${alt.short.toLocaleLowerCase('tr')}) seç.` : ''),
            alt ? { key: 'screwType', value: alt.id, label: `${alt.code} seç` } : null, 'FAS-CSK');
        }
      }

      // Vida boyu: baş kapak (veya PCB) üstünde, uç standoff deliğinde.
      // Havşa başlıda boy başı da kapsar ve baş kapakla aynı hizada biter: uç yine üst yüz − L'dedir.
      // Baş altı pulu kalınlığı sıkıştırılan boya eklenir (yaylı rondelada ezilmiş kalınlık s)
      const wz = useWasher ? useWasher.sizes[washerSizeFor(s.size)] || null : null;
      if (useWasher && !wz) noteSpec('info', `${useWasher.code} ${washerSizeFor(s.size)} boyutunda yok; bu deliklerde pul kullanılmadı.`, null, 'FAS-DATA');
      const ws = wz ? wz.s : 0;
      // Gömme baş (oyuk): yalnızca kapakta (sandviç vidası); PCB üstüne oyuk açılamaz
      let cbore = null;
      if (spec.headSeat === 'counterbore' && !countersunk) {
        if (tube) {
          cbore = counterboreFor(ts?.dk_actual ?? headD, headH, wz, lidTol.hole_comp);
          tube.counterbore = cbore;
          tube.od = Math.max(tube.od, cbore.d + 1.6);
        } else noteSpec('info', 'Gömme baş yalnızca kapak vidalarına uygulanır; yalnızca PCB vidalarında baş yüzeyde kalır.', null, 'FAS-CBORE');
      }
      const grip = (tube ? zTop - b.bottom : b.thickness) + ws - (cbore ? cbore.depth : 0);
      // Yalnızca PCB vidası: baş/pul kart üstündeki bileşenlere değmemeli
      if (!tube) {
        const headR = (wz ? Math.max(wz.d2, ts?.dk_actual ?? headD) : ts?.dk_actual ?? headD) / 2;
        const hit = obstacles.find((o) => o.box.max[2] > b.top + 0.01 && o.box.min[2] < b.top + ws + headH &&
          distToBoxXY(o.box, h.x, h.y) < headR + 0.2);
        if (hit) {
          fastenChecks.push({ level: 'warn', text: `Delik ${at(h)}: vida başı${wz ? '/pul' : ''} (Ø${f(2 * headR)}) ${hit.name} bileşenine değiyor; daha küçük başlı vida ya da pulsuz montaj seç.`,
            focus: partIdByName(hit.name), rule: 'FAS-HEAD-CLEAR' });
        }
        // Tornavida / anahtar erişimi: başın üstünde (kapak kapanmadan önce) bileşen olmamalı
        const headTopZ = b.top + ws + headH;
        const toolR = Math.max((ts?.dk_actual ?? headD) / 2, 0.6 * s.d) + 0.3;
        const blocker = obstacles.find((o) => o.box.min[2] >= headTopZ - 0.05 && o.box.min[2] < cavTop && distToBoxXY(o.box, h.x, h.y) < toolR);
        if (blocker) {
          fastenChecks.push({ level: 'warn', text: `Delik ${at(h)}: vida başının üstünde ${blocker.name} var; tornavida/anahtar erişemez. Vidayı bileşen takılmadan önce sık ya da deliği seçimden çıkar.`,
            fix: { key: 'holeOff', value: h.index, label: 'Bu deliği kullanma' }, focus: partIdByName(blocker.name), rule: 'FAS-TOOL-ACCESS' });
        }
      }
      if (!fastenInfo || (tube && !fastenInfo.lidScrew)) {
        fastenInfo = { grip, available: avail, method, size: s.size, lidScrew: !!tube, minEngage, lengths, floor, required,
          insert: ins ? { type: itype.id, kind: itype.kind, variant: ins.v.id, L: ins.v.L } : null };
      }
      // Seçilen boy kapak vidalarına uygulanır; kapak borusu olmayan (yalnızca PCB) deliklerde boy otomatik kalır
      const explicitLength = spec.length !== 'auto' && (tube || lidMode !== 'screw');
      if (spec.length !== 'auto' && !explicitLength) {
        noteSpec('info', 'Seçilen vida boyu kapak vidalarına uygulandı; üstü dolu (yalnızca PCB) deliklerde boy otomatik seçildi.', null, 'FAS-LENGTH');
      }
      let len;
      if (!explicitLength) {
        len = pickLength(lengths, grip, avail, minEngage);
      } else {
        const L = Number(spec.length);
        const st = lengthStatus({ grip, available: avail, minEngage }, L);
        len = { L, engagement: st.engagement, ok: st.status === 'ok', next: null };
        if (st.status === 'long') {
          // Seçilen vida korunur: standoff yükseltilerek delik derinleştirilir (otomatik parametrede uygulanır)
          const shorter = [...lengths].reverse().find((x) => x - grip <= avail - 0.3 && x - grip >= minEngage);
          const needStandoff = Math.ceil((L - grip + 0.3 - floor + MIN_FLOOR_UNDER_HOLE) * 10) / 10;
          noteSpec('error', `${s.size}×${L} vida standoff deliğinin dibine dayanır (bu tasarımda en fazla ${f(grip + avail - 0.3)} mm). ` +
            `PCB altı yükseklik ${f(needStandoff)} mm yapılırsa sığar${shorter ? `; ya da ${s.size}×${shorter} seç` : ''}.`,
            { key: 'standoffHeight', value: needStandoff, label: `${f(needStandoff)} mm uygula` }, 'FAS-LENGTH',
            { measured: num(L), limit: num(grip + avail - 0.3), op: '<=', unit: 'mm' });
        } else if (st.status === 'short') {
          const longer = lengths.find((x) => x - grip >= minEngage && x - grip <= avail - 0.3);
          noteSpec('warn', st.engagement <= 0
            ? `${s.size}×${L} vida standoff'a ulaşmıyor: kapak + kart ${f(grip)} mm, en az ${f(grip + minEngage)} mm boy gerekir.`
            : `${s.size}×${L} vida yalnızca ${f(st.engagement)} mm tutunur (en az ${f(minEngage)} mm önerilir).`,
            longer ? { key: 'screwLength', value: longer, label: `${s.size}×${longer} seç` } : null, 'FAS-LENGTH',
            { measured: num(st.engagement), limit: num(minEngage), op: '>=', unit: 'mm' });
        }
      }
      const depth = method === 'nut' && nutGeo ? b.bottom - z0 + 0.5 : method === 'standoff' && soGeo ? floor + 0.5
        : Math.min(avail, Math.max(required, (len.L ? len.L - grip : 0) + 0.5));
      if (!explicitLength && !len.ok) {
        const needAvail = len.next !== null ? len.next - grip + 0.3 : null;
        let needStandoff = needAvail !== null ? Math.ceil((needAvail - floor + MIN_FLOOR_UNDER_HOLE) * 10) / 10 : null;
        if (soGeo && needAvail !== null) {
          // Hazır aralayıcı: bir sonraki standart boy (dişi derinliği / alt vidayla paylaşım buna göre)
          const series = sotype.sizes[s.size].lengths;
          const availFor = (Ls) => (soGeo.ends === 'ff' ? Ls - (bottomScrew?.eng ?? Ls / 2) - 0.2 : Math.max(2.5, 0.65 * Ls) + 0.3);
          needStandoff = series.find((Ls) => Ls > soGeo.L + 1e-6 && availFor(Ls) >= needAvail - 1e-6) ?? null;
        }
        const text = (len.L ? `${s.size}×${len.L} vida yalnızca ${f(len.engagement)} mm tutunur (en az ${f(minEngage)} mm önerilir).` : `${s.size} için uygun standart boy yok.`) +
          (needStandoff !== null ? ` PCB altı yüksekliği ${f(needStandoff)} mm yapılırsa ${s.size}×${len.next} tam oturur.` : '');
        const key = text;
        if (!lengthIssues.has(key)) {
          lengthIssues.set(key, {
            count: 0, where: at(h), text, measured: num(Math.max(0, len.engagement ?? 0)), limit: num(minEngage),
            fix: needStandoff !== null ? { key: 'standoffHeight', value: needStandoff, label: `${f(needStandoff)} mm uygula` } : null,
          });
        }
        lengthIssues.get(key).count++;
      }
      // Altıgen somun cebi: seçilen boya göre somun yüksekliği (uç somundan 1,5·P taşar)
      if (nutGeo && nutGeo.shape === 'hex' && len.engagement !== undefined && len.engagement !== null) {
        const tipZ = b.bottom - len.engagement;
        const nutBot = Math.max(z0 + 0.6, tipZ + 1.5 * nutGeo.Pn);
        nutGeo.nutTop = nutBot + nutGeo.nz.m;
        nutGeo.depth = nutGeo.nutTop - z0 + 0.1;
      }
      // Sıkma torku: vida dayanımı, baş/pul altı yüzey basıncı ve gövdede diş/burç sıyırma sınırlarının en küçüğü
      let tqInfo = null;
      if (screwMat && screwMat.rp) {
        const P = ts?.P ?? 0.15 * s.d + 0.05;
        const dw = wz ? wz.d2 : (ts?.dk_actual ?? headD);
        const dh = tube ? lidClr(s) : h.d;
        const tq = screwTorque({ d: s.d, P, rp: screwMat.rp, mu: screwMat.mu, nu: screwMat.nu || tmodel.nu, dw, dh, countersunk });
        const limits = [{ key: 'screw', T: tq.T }];
        const pAllow = tube ? lr.bearing_pressure_mpa : tmodel.pcb_bearing_mpa;
        if (pAllow) {
          const A = (Math.PI / 4) * Math.max(0, dw * dw - dh * dh);
          limits.push({ key: tube ? 'bearing_lid' : 'bearing_pcb', T: (tq.kT * pAllow * A) / 1000 });
        }
        if (method === 'nut' && nutGeo && rules.bearing_pressure_mpa) {
          // Çelik somun dişi güçlü; sınır somunun gövde malzemesine yaptığı baskı
          limits.push({ key: 'nut_bearing', T: (tq.kT * rules.bearing_pressure_mpa * nutGeo.area) / 1000 });
        } else if (method === 'standoff' && soGeo) {
          const Le = Math.max(0, len.engagement ?? 0);
          if (Le > 0) limits.push({ key: 'standoff', T: (tq.kT * 0.6 * (soMat?.rm || 400) * Math.PI * s.d * Le * 0.6 / tmodel.metal_safety) / 1000 });
        } else if (rules.tensile_strength_mpa) {
          const tau = 0.6 * rules.tensile_strength_mpa;
          const S = rules.conductive ? tmodel.metal_safety : tmodel.plastic_safety;
          const Le = Math.max(0, Math.min(len.engagement ?? 0, depth));
          let A = null;
          let key = 'strip';
          if (method === 'insert') { A = Math.PI * (ins ? ins.v.d1 : s.insert_hole) * (ins ? ins.v.L : s.insert_length) * 0.6; key = 'insert'; }
          else if (method === 'helicoil' && ins) { A = Math.PI * ins.dhc * ins.v.L * 0.6; key = 'helicoil'; }
          else if (Le > 0) A = Math.PI * s.d * Le * 0.6;
          if (A) limits.push({ key, T: (tq.kT * (tau * A) / S) / 1000 });
        }
        const lim = limits.reduce((a, c) => (c.T < a.T ? c : a));
        tqInfo = { lid: !!tube, role: tube ? 'sandwich' : 'pcb', T: roundTorque(lim.T), limit: lim.key, limits, preload: (lim.T * 1000) / tq.kT, Tscrew: tq.T };
        torqueOf.push(tqInfo);
      }
      // Helicoil girişinde 90° havşa (Ø yuva dişi dış çapı + 0,1, Böllhoff); burç bilgisi 3B önizleme ve BOM içindir
      let insertInfo = ins ? (itype.kind === 'helicoil'
        ? { kind: 'helicoil', id: ins.v.id, L: ins.v.L, dOut: ins.dhc, dIn: s.d, drill: ins.drill, P: ins.P, csk: ins.dhc + 0.1 }
        : { kind: 'heatset', id: ins.v.id, L: ins.v.L, dOut: ins.v.d1, d2: ins.v.d2, dIn: s.d, hole: ins.v.hole, wall: ins.v.wall, P: ts?.P ?? null }) : null;
      const nutMat = nutGeo ? resolveScrewMaterial(ntype, screwMat?.family === 'stainless' ? 'a2' : screwMat?.family === 'plastic' ? 'pa66' : screwMat?.family === 'brass' ? 'brass' : 'st88zn', matList) : null;
      if (nutGeo) {
        insertInfo = {
          kind: 'nut', id: `${ntype.code} ${s.size}`, type: ntype.id, code: ntype.code, name: ntype.name, shape: nutGeo.shape, locking: !!ntype.locking,
          s: nutGeo.nz.s, pocket: nutGeo.s, e: nutGeo.nz.e, m: nutGeo.nz.m, dIn: s.d, P: ts?.P ?? null,
          zTop: nutGeo.shape === 'hex' ? nutGeo.nutTop : nutGeo.z1, axis: nutGeo.axis, dir: nutGeo.dir,
          material: nutMat ? { id: nutMat.id, tag: nutMat.tag, finish: nutMat.finish } : null,
        };
      }
      let bottom = null;
      if (soGeo) {
        // Alt bağlantı: dişi-dişide alttan vida (aynı tip ve malzeme), erkek-dişide taban altında ISO 4032 somun
        const bNut = (options.toolbox?.nuts || []).find((x) => x.id === 'iso4032');
        const bNutZ = bNut?.sizes[s.size] || null;
        bottom = soGeo.ends === 'ff'
          ? { kind: 'screw', length: bottomScrew?.L ?? null, eng: bottomScrew?.eng ?? null }
          : { kind: 'nut', code: 'ISO 4032', s: bNutZ?.s ?? 1.8 * s.d, e: bNutZ?.e ?? 2 * s.d, m: bNutZ?.m ?? 0.8 * s.d,
            material: (() => { const m = resolveScrewMaterial(bNut, screwMat?.family === 'stainless' ? 'a2' : 'st88zn', matList); return m ? { id: m.id, tag: m.tag, finish: m.finish } : null; })() };
        insertInfo = {
          kind: 'standoff', id: `${s.size} × ${soGeo.L} ${sotype.name.toLocaleLowerCase('tr')}`, type: sotype.id, ends: soGeo.ends,
          sw: soGeo.sw, L: soGeo.L, male: soGeo.male, dIn: s.d, P: ts?.P ?? null, zBottom: floorTop, zTop: b.bottom, zBase: z0,
          material: soMat ? { id: soMat.id, tag: soMat.tag, label: soMat.label, finish: soMat.finish } : null, bottom,
        };
      }
      const bottomCsk = soGeo && soGeo.ends === 'ff' && countersunk ? { dTop: headD + 0.3, depth: (headD + 0.3 - s.clearance) / 2 } : null;
      standoffs.push({
        x: h.x, y: h.y, od, holeD: soGeo && soGeo.ends === 'mf' ? s.d + 0.4 : featureD, depth,
        z0: floorTop, z1: integral ? b.bottom : floorTop, screw: s.size, insert: insertInfo, integral,
        countersink: insertInfo && insertInfo.kind === 'helicoil' ? { dTop: insertInfo.csk, depth: (insertInfo.csk - featureD) / 2 } : null,
        nutPocket: nutGeo ? (nutGeo.shape === 'hex'
          ? { shape: 'hex', s: nutGeo.s, z0: z0 - 0.5, z1: z0 + nutGeo.depth }
          : { shape: 'square', s: nutGeo.s, z0: nutGeo.z0, z1: nutGeo.z1, axis: nutGeo.axis, dir: nutGeo.dir, reach: od / 2 + 1 }) : null,
        bottomCountersink: bottomCsk ? { ...bottomCsk, zBase: z0 } : null,
      });
      screws.push({
        size: s.size, length: len.L, engagement: len.engagement, ok: len.ok, lid: !!tube, x: h.x, y: h.y, role: tube ? 'sandwich' : 'pcb',
        zSeat: tube ? zTop - (cbore ? cbore.depth : 0) : b.top, counterbore: cbore,
        head_d: headD, head_h: headH, head_d_actual: ts?.dk_actual ?? headD, head: ttype ? ttype.head : 'pan', d: s.d, grip,
        type: ttype ? ttype.id : null, code: ttype ? ttype.code : null, name: ttype ? ttype.name : 'vida',
        driveKind: ttype ? ttype.drive_kind : null, driveText: driveText(ttype, ts),
        driveVal: ts ? ts.drive : null, driveA: ts?.A ?? null, driveM: ts?.m ?? null,
        designation: ttype ? designation(ttype, s.size, len.L) + (screwMat ? ` - ${screwMat.tag}` : '') : null,
        P: ts?.P ?? null, tapping,
        material: screwMat ? { id: screwMat.id, tag: screwMat.tag, label: screwMat.label, finish: screwMat.finish } : null,
        seat: ws,
        washer: wz ? { type: useWasher.id, code: useWasher.code, name: useWasher.name, kind: useWasher.kind, size: washerSizeFor(s.size),
          d1: wz.d1, d2: wz.d2, s: wz.s, teeth: wz.teeth || null, b: wz.b || null,
          material: washerMat ? { id: washerMat.id, tag: washerMat.tag, finish: washerMat.finish } : null } : null,
        torque: tqInfo,
      });
    }
    // --- Köşe kapak vidaları: duvara yaslı köşe boss'ları, kapakta geçiş deliği (+ havşa / gömme oyuk) ---
    if (cplan) {
      const cp = cplan;
      const s = cp.s;
      const ts = cp.ts;
      const cSunk = cp.ctype?.head === 'countersunk';
      const cm = resolveScrewMaterial(cp.ctype, cp.spec.material, matList);
      const cwt = cp.spec.washer && cp.spec.washer !== 'none' && !cSunk ? (options.toolbox?.washers || []).find((w) => w.id === cp.spec.washer) || null : null;
      const cwz = cwt ? cwt.sizes[washerSizeFor(cp.size)] || null : null;
      const cws = cwz ? cwz.s : 0;
      const cwMat = cwz ? resolveWasherMaterial(cwt, cp.spec.washerMaterial, cm, matList) : null;
      const headDc = ts ? ts.dk : s.head_d;
      const headHc = ts ? ts.k : s.head_h;
      const headDA = ts?.dk_actual ?? headDc;
      const cb = cp.spec.headSeat === 'counterbore' && !cSunk ? counterboreFor(headDA, headHc, cwz, lidTol.hole_comp) : null;
      const csk = cSunk ? { dTop: headDc + 0.3, depth: (headDc + 0.3 - lidClr(s)) / 2 } : null;
      // Kapak kalınlığı oyuğa/havşaya yetmezse kapağın altına boss'a oturan bir yastık eklenir
      const padH = Math.max(0, Math.max(cb ? cb.depth : 0, csk ? csk.depth : 0) + 0.8 - lidT);
      const bossTop = cavTop - padH;
      const grip = lidT + padH + cws - (cb ? cb.depth : 0);
      const availC = bossTop - floorTop + floor - MIN_FLOOR_UNDER_HOLE;
      const lengthsC = ts ? ts.lengths : fasteners.standard_lengths;
      let Lc;
      if (cp.spec.length !== 'auto') Lc = Number(cp.spec.length);
      else {
        Lc = lengthsC.find((L) => L - grip >= cp.fullEngage - 1e-9 && L - grip <= availC - 0.3)
          ?? lengthsC.find((L) => L - grip >= cp.minEngage - 1e-9 && L - grip <= availC - 0.3) ?? null;
      }
      const engC = Lc !== null ? Lc - grip : 0;
      if (Lc === null) noteSpec('warn', `Köşe vidası ${cp.size} için uygun standart boy yok.`, null, 'FAS-CORNER');
      else if (engC > availC - 0.3 + 1e-9) noteSpec('error', `Köşe vidası ${cp.size}×${f(Lc)} boss deliğinin dibine dayanır (en fazla ${f(grip + availC - 0.3)} mm).`, null, 'FAS-CORNER', { measured: num(Lc), limit: num(grip + availC - 0.3), op: '<=', unit: 'mm' });
      else if (engC < cp.minEngage - 1e-9) noteSpec('warn', `Köşe vidası ${cp.size}×${f(Lc)} yalnızca ${f(Math.max(0, engC))} mm tutunur (en az ${f(cp.minEngage)} mm).`, null, 'FAS-CORNER', { measured: num(Math.max(0, engC)), limit: num(cp.minEngage), op: '>=', unit: 'mm' });
      const depthC = Math.min(availC, Math.max(cp.required, engC + 0.5));
      if (availC < cp.required - 1e-6) {
        // Boss boyu PCB altı yükseklikle uzar (taban aşağı iner)
        const needC = ceil01(p.standoffHeight + cp.required - availC);
        noteSpec('error', `Köşe boss'u ${cp.size} ${METHOD_TEXT[cp.method]} için kısa: ${f(cp.required)} mm delik derinliği gerekir, ${f(availC)} mm var.`,
          { key: 'standoffHeight', value: needC, label: `PCB altı ${f(needC)} mm` },
          cp.method === 'insert' && rules.process === 'fdm' ? 'FDM-INSERT-DEPTH' : cp.method === 'tapped' && rules.process === 'cnc' ? 'CNC-TAP-DEPTH' : 'FAS-DEPTH',
          { measured: num(availC), limit: num(cp.required), op: '>=', unit: 'mm' });
      }
      // Tork: kapakta baş baskısı, gövdede diş/burç
      let cTq = null;
      if (cm && cm.rp) {
        const P = ts?.P ?? 0.15 * s.d + 0.05;
        const dw = cwz ? cwz.d2 : headDA;
        const tq = screwTorque({ d: s.d, P, rp: cm.rp, mu: cm.mu, nu: cm.nu || tmodel.nu, dw, dh: lidClr(s), countersunk: cSunk });
        const limits = [{ key: 'screw', T: tq.T }];
        if (lr.bearing_pressure_mpa) limits.push({ key: 'bearing_lid', T: (tq.kT * lr.bearing_pressure_mpa * (Math.PI / 4) * Math.max(0, dw * dw - lidClr(s) * lidClr(s))) / 1000 });
        if (rules.tensile_strength_mpa) {
          const tau = 0.6 * rules.tensile_strength_mpa;
          const S = rules.conductive ? tmodel.metal_safety : tmodel.plastic_safety;
          let A = null;
          let key = 'strip';
          if (cp.method === 'insert') { A = Math.PI * (cp.ins ? cp.ins.v.d1 : s.insert_hole) * (cp.ins ? cp.ins.v.L : s.insert_length) * 0.6; key = 'insert'; }
          else if (cp.method === 'helicoil' && cp.ins) { A = Math.PI * cp.ins.dhc * cp.ins.v.L * 0.6; key = 'helicoil'; }
          else if (engC > 0) A = Math.PI * s.d * engC * 0.6;
          if (A) limits.push({ key, T: (tq.kT * (tau * A) / S) / 1000 });
        }
        const lim = limits.reduce((a, c) => (c.T < a.T ? c : a));
        cTq = { lid: null, role: 'corner', T: roundTorque(lim.T), limit: lim.key, limits, preload: (lim.T * 1000) / tq.kT, Tscrew: tq.T };
        torqueOf.push(cTq);
      }
      const insC = cp.ins ? (cp.itype.kind === 'helicoil'
        ? { kind: 'helicoil', id: cp.ins.v.id, L: cp.ins.v.L, dOut: cp.ins.dhc, dIn: s.d, drill: cp.ins.drill, P: cp.ins.P, csk: cp.ins.dhc + 0.1 }
        : { kind: 'heatset', id: cp.ins.v.id, L: cp.ins.v.L, dOut: cp.ins.v.d1, d2: cp.ins.v.d2, dIn: s.d, hole: cp.ins.v.hole, wall: cp.ins.v.wall, P: ts?.P ?? null }) : null;
      const R = cp.Rb;
      const pts = [[cav.min[0] + R, cav.min[1] + R, cav.min[0], cav.min[1]], [cav.max[0] - R, cav.min[1] + R, cav.max[0], cav.min[1]],
        [cav.max[0] - R, cav.max[1] - R, cav.max[0], cav.max[1]], [cav.min[0] + R, cav.max[1] - R, cav.min[0], cav.max[1]]];
      for (const [x, y, wx, wy] of pts) {
        // PCB ve bileşenlerle çakışma
        const boardHit = distToBoxXY(b.box, x, y) < R + 0.2 && b.box.min[2] < bossTop && b.box.max[2] > floorTop;
        const compHit = obstacles.find((o) => o.box.max[2] > floorTop + 0.01 && o.box.min[2] < bossTop - 0.01 && distToBoxXY(o.box, x, y) < R + 0.2);
        if (boardHit) noteSpec('error', 'Köşe boss\'u PCB\'ye çarpıyor; kavite payı yetmedi. Köşe payı eksenini değiştir ya da PCB vidalı kapak kullan.', null, 'FAS-CORNER');
        else if (compHit) fastenChecks.push({ level: 'error', text: `Köşe boss'u (${f(x)}; ${f(y)}) ${compHit.name} ile çakışıyor.`, focus: partIdByName(compHit.name), rule: 'FAS-CORNER' });
        cornerBosses.push({ x, y, od: cp.od, z0: floorTop, z1: bossTop, holeD: cp.featureD, depth: depthC, wall: [wx, wy], insert: insC,
          countersink: insC && insC.kind === 'helicoil' ? { dTop: insC.csk, depth: (insC.csk - cp.featureD) / 2 } : null });
        lidHoles.push({ x, y, holeD: lidClr(s), countersink: csk, counterbore: cb, pad: padH > 0 ? { od: Math.max(cp.od, (cb ? cb.d : csk ? csk.dTop : 0) + 1.6), h: padH } : null });
        screws.push({
          size: s.size, length: Lc, engagement: engC, ok: engC >= cp.minEngage, lid: true, x, y, role: 'corner',
          zSeat: zTop - (cb ? cb.depth : 0), counterbore: cb,
          head_d: headDc, head_h: headHc, head_d_actual: headDA, head: cp.ctype ? cp.ctype.head : 'pan', d: s.d, grip,
          type: cp.ctype?.id ?? null, code: cp.ctype?.code ?? null, name: cp.ctype?.name ?? 'vida',
          driveKind: cp.ctype?.drive_kind ?? null, driveText: driveText(cp.ctype, ts),
          driveVal: ts ? ts.drive : null, driveA: ts?.A ?? null, driveM: ts?.m ?? null,
          designation: cp.ctype ? designation(cp.ctype, s.size, Lc) + (cm ? ` - ${cm.tag}` : '') : null,
          P: ts?.P ?? null, tapping: cp.tapping,
          material: cm ? { id: cm.id, tag: cm.tag, label: cm.label, finish: cm.finish } : null,
          seat: cws,
          washer: cwz ? { type: cwt.id, code: cwt.code, name: cwt.name, kind: cwt.kind, size: washerSizeFor(s.size), d1: cwz.d1, d2: cwz.d2, s: cwz.s,
            teeth: cwz.teeth || null, b: cwz.b || null, material: cwMat ? { id: cwMat.id, tag: cwMat.tag, finish: cwMat.finish } : null } : null,
          torque: cTq,
        });
      }
      cornerInfo = { grip, available: availC, minEngage: cp.minEngage, size: cp.size, floor, lengths: lengthsC, target: cp.fullEngage, method: cp.method };
      if (cornerPad) {
        fastenChecks.push({ level: 'info', text: `Kapak 4 köşe vidasıyla (${cp.ctype ? cp.ctype.code + ' ' : ''}${cp.size}) bağlanır; köşe boss'u Ø${f(cp.od)}.` +
          (cornerPad.extra > 0 ? ` Boss'lar PCB'ye çarpmasın diye kavite ${cornerPad.axis === 0 ? 'X' : 'Y'} ekseninde her iki uçta ${f(cornerPad.extra)} mm uzatıldı.` : ''), rule: 'FAS-CORNER' });
        if (cornerPad.extra > 0 && cornerPad.occupied > 0) {
          fastenChecks.push({ level: 'warn', text: `Kavite ${cornerPad.axis === 0 ? 'X' : 'Y'} ekseninde ${f(cornerPad.extra)} mm/uç uzatıldı ama bu kenarlarda konnektör var; konnektörler duvara ulaşmayabilir. Köşe payı eksenini değiştirmeyi dene.`,
            fix: { key: 'cornerAxis', value: cornerPad.axis === 0 ? 'y' : 'x', label: `${cornerPad.axis === 0 ? 'Y' : 'X'} ekseni` }, rule: 'FAS-CORNER-AXIS' });
        }
      }
    }
    // Malzeme, pul ve tork kontrolleri
    if (usedHoles.length && screwMat) {
      const toWasher = (id, label) => ({ key: 'washer', value: id, label });
      for (const lidSide of [true, false]) {
        const t = torqueOf.find((x) => x.lid === lidSide);
        if (!t) continue;
        const where = lidSide ? 'Kapak vidaları' : 'PCB vidaları';
        if ((t.limit === 'bearing_lid' || t.limit === 'bearing_pcb') && t.T < 0.6 * t.Tscrew) {
          const size = screws.find((x) => x.lid === lidSide)?.size;
          const big = (options.toolbox?.washers || []).find((w) => w.id === 'iso7093' && w.sizes[washerSizeFor(size)]);
          const norm = (options.toolbox?.washers || []).find((w) => w.id === 'iso7089');
          const sugg = !countersunk && (!useWasher || useWasher.id !== 'iso7093') ? (big && useWasher?.id !== 'iso7093' ? big : !useWasher ? norm : null) : null;
          noteSpec('info', `${where}: sıkma torku ${f(t.T)} N·m ile sınırlı (${torqueLimitText(t.limit)}).` +
            (sugg ? ` ${sugg.code} pul baskıyı yayar, torku artırır.` : ''), sugg ? toWasher(sugg.id, `${sugg.code} pul ekle`) : null, 'FAS-TORQUE', { measured: t.T, unit: 'N·m' });
        } else if (['strip', 'insert', 'helicoil'].includes(t.limit) && t.T < 0.6 * t.Tscrew) {
          noteSpec('info', `${where}: sıkma torku ${f(t.T)} N·m ile sınırlı (${torqueLimitText(t.limit)}). Daha fazla sıkma dişi sıyırabilir; ` +
            (method === 'helicoil' ? 'daha uzun Helicoil (ör. 2,5d) seçilebilir.' : method === 'insert' ? 'daha uzun insert seçilebilir.' : 'insert ya da Helicoil kullanılabilir.'), null, 'FAS-TORQUE', { measured: t.T, unit: 'N·m' });
        }
      }
      if (useWasher && (useWasher.kind === 'spring' || useWasher.kind === 'serrated')) {
        noteSpec('info', `${useWasher.code} geri çekilmiş standarttır ve titreşimde gevşemeyi güvenilir biçimde önlemez (VDI 2230); kilit için sıvı vida sabitleyici kullanın.` +
          (useWasher.kind === 'serrated' ? ' Tırtıllı pul boya/eloksali delerek topraklama teması sağlamak için uygundur.' : ''), null, 'FAS-LOCK-WASHER');
      }
      if (rules.conductive && (screwMat.family === 'stainless' || screwMat.family === 'brass')) {
        noteSpec('info', `${rules.label} gövdede ${screwMat.tag} vida: nemli ortamda galvanik korozyon riski. İç ortamda sorun değildir; dış ortamda yalıtım pulu, montaj macunu ya da A4 + kaplama önerilir.`, null, 'FAS-GALVANIC');
      }
      if (rules.conductive && screwMat.conductive) {
        noteSpec('info', 'Vida ve standoff PCB montaj pedini gövdeye (şase) bağlar. Yalıtım gerekiyorsa PA66 vida ya da PA66 pul seç.', null, 'FAS-CHASSIS');
      }
      // Anten/RF parçası: ad belirteç (token) bazında tanınır (ör. "Tantalum", "smart" RF sayılmaz)
      const antenna = (analysis.parts || []).find((pt) => !pt.isBoard && (isAntennaName(pt.name || '') || isRfName(pt.name || '')));
      if (antenna && screwMat.magnetic) {
        const nonMag = (ttype?.materials || []).map((id) => matList.find((m) => m.id === id)).find((m) => m && !m.magnetic);
        noteSpec('info', `Kartta ${antenna.name} var: anten/RF yakınında manyetik olmayan vida tercih edilir (${screwMat.tag} manyetiktir).`,
          nonMag ? { key: 'screwMaterial', value: nonMag.id, label: `${nonMag.tag} seç` } : null, 'RF-MAGNETIC', { cat: 'rf' });
      }
      if (screwMat.family === 'plastic') {
        noteSpec('info', `${screwMat.tag} vida yalıtkan ve manyetik değildir; dayanımı düşüktür (önerilen tork ≈ ${f(torqueOf[0]?.T ?? 0)} N·m), 80 °C üstünde ve titreşimde gevşeyebilir.`, null, 'FAS-PLASTIC-SCREW');
      }
    }
    // Vida tipi ile gövde süreci uyumu
    if (usedHoles.length && ttype) {
      const tapAlt = (options.toolbox?.types || []).find((t) => t.id === (ttype.head === 'countersunk' ? 'iso7050' : 'iso7049'));
      const machineAlt = (options.toolbox?.types || []).find((t) => t.id === (ttype.head === 'countersunk' ? 'iso7046' : 'iso7045'));
      if (tapping && rules.conductive) {
        noteSpec('warn', `${ttype.code} sac vidası metal gövdeye önerilmez: metrik vida + ${METHOD_TEXT[rules.fastening || 'tapped']} kullan.`,
          machineAlt ? { key: 'screwType', value: machineAlt.id, label: `${machineAlt.code} seç` } : null, 'FAS-SCREW-PROCESS');
      } else if (tapping && rules.process === 'fdm') {
        noteSpec('info', `Sac vidası baskı gövdeye dişini kendisi açar (Ø${holeDiaList()} ön delik). Sık sökülüp takılacaksa ısıyla gömülen insert + metrik vida daha dayanıklıdır.`, null, 'FAS-SCREW-PROCESS');
      } else if (!tapping && method === 'self_tap') {
        noteSpec('warn', `${rules.label} gövdede vida dişini plastiğe kendisi açmalı: metrik ${ttype.code} yerine sac vidası seç.`,
          tapAlt ? { key: 'screwType', value: tapAlt.id, label: `${tapAlt.code} seç` } : null, 'FAS-SCREW-PROCESS');
      }
    }
    // Burç ile süreç / malzeme uyumu
    if (usedHoles.length) {
      const mat = rules.material;
      const toHeli = { key: 'insertType', value: 'helicoil-fr', label: 'Helicoil seç' };
      const toHeat = { key: 'insertType', value: 'rx-heatset', label: 'Isıyla gömülen insert seç' };
      if (tapping && ispec.type !== 'auto') {
        const machineAlt = (options.toolbox?.types || []).find((t) => t.id === (ttype.head === 'countersunk' ? 'iso7046' : 'iso7045'));
        noteSpec('warn', `Sac vidası seçili: gövdede burç kullanılmaz, vida dişini kendisi açar. Burç için metrik vida seç.`,
          machineAlt ? { key: 'screwType', value: machineAlt.id, label: `${machineAlt.code} seç` } : null, 'FAS-INSERT-PROCESS');
      } else if (method === 'insert' && rules.conductive) {
        noteSpec('error', 'Isıyla gömülen insert metal gövdeye uygulanamaz: Helicoil ya da doğrudan kılavuz kullan.', toHeli, 'FAS-INSERT-PROCESS');
      } else if (method === 'insert' && mat === 'ptfe') {
        noteSpec('warn', 'PTFE erimeden yumuşar ve yapışmaz: ısıyla gömülen insert tutunmaz. Helicoil kullan.', toHeli, 'FAS-INSERT-PROCESS');
      } else if (method === 'insert' && mat === 'peek') {
        noteSpec('warn', 'PEEK\'e ısıyla gömme ~380–400 °C ve özel uç ister; talaşlı parçada Helicoil daha güvenilirdir.', toHeli, 'FAS-INSERT-PROCESS');
      } else if (method === 'insert' && mat === 'pom') {
        noteSpec('info', 'POM\'da ısıyla gömülen insertin tutunması ABS\'e göre düşüktür; sık sökülecekse Helicoil önerilir.', toHeli, 'FAS-INSERT-PROCESS');
      } else if (method === 'insert' && rules.process === 'fdm') {
        noteSpec('info', `İnsert deliği Ø${holeDiaList()}, kör delik insert boyu + ${f(INSERT_HOLE_EXTRA)} mm; baskıda delik küçük çıkarsa 0,1 mm büyütün (CNC Kitchen: düz delik, ağız pahı gerekmez).`, null, 'FAS-INSERT-PROCESS');
      } else if (method === 'helicoil' && rules.process === 'fdm') {
        noteSpec('info', 'Baskı parçada Helicoil için STI kılavuzla diş açılır; ısıyla gömülen insert genelde daha pratiktir.', toHeat, 'FAS-INSERT-PROCESS');
      } else if (method === 'helicoil' && rules.process === 'injection') {
        noteSpec('warn', 'Enjeksiyon parçada Helicoil sonradan delme + kılavuz ister; ısıyla/ultrasonik gömülen insert daha uygundur.', toHeat, 'FAS-INSERT-PROCESS');
      } else if (method === 'tapped' && rules.process === 'fdm') {
        noteSpec('warn', 'Baskıda doğrudan çekilen diş birkaç sökme-takmada aşınır; ısıyla gömülen insert önerilir.', toHeat, 'FAS-INSERT-PROCESS');
      } else if (method === 'tapped' && mat === 'ptfe') {
        noteSpec('warn', 'PTFE\'de doğrudan çekilen diş sünme yüzünden gevşer: Helicoil kullan.', toHeli, 'FAS-INSERT-PROCESS');
      } else if (method === 'tapped' && mat === 'peek') {
        noteSpec('info', 'PEEK\'te doğrudan diş çekilebilir; sık sökülecekse Helicoil daha dayanıklıdır.', toHeli, 'FAS-INSERT-PROCESS');
      } else if (method === 'nut' && ntype) {
        if (ntype.kind === 'square') {
          noteSpec('info', rules.process === 'fdm'
            ? `${ntype.code} kare somun standoff yanındaki yuvaya PCB takılmadan önce sürülür; yuva üstü köprü olarak basılır.`
            : `Standoff yanındaki kare somun yuvası ${rules.process === 'cnc' ? 'CNC\'de yandan frezeleme' : 'kalıpta yan maça'} ister; altıgen cep ya da insert daha uygundur.`,
          rules.process === 'fdm' ? null : { key: 'nutType', value: 'iso4032', label: 'Altıgen cep seç' }, 'FAS-INSERT-PROCESS');
        } else {
          noteSpec('info', rules.process === 'cnc'
            ? 'Somun cebi tabandan açılır: CNC\'de ikinci bağlama gerekir; kılavuz ya da Helicoil daha pratiktir.'
            : `Somun tabandaki altıgen cebe bastırılır ve vidayla yukarı çekilir; cep tabandan açık kalır${tol.hole_comp ? ` (cep, telafi dahil SW + ${f(pocketAf(0, tol))} mm)` : ''}.`, null, 'FAS-INSERT-PROCESS');
          if (ntype.locking) noteSpec('info', `${ntype.code} naylon kilitli somun titreşimde gevşemeyi önler; vida ucu somundan en az 1–2 diş taşmalıdır (boy buna göre seçildi).`, null, 'FAS-INSERT-PROCESS');
        }
      } else if (method === 'standoff' && sotype) {
        noteSpec('info', `Hazır aralayıcı tabana ${sotype.ends === 'ff' ? 'alttan vidayla' : 'erkek dişi ve altta somunla'} bağlanır; ${countersunk && sotype.ends === 'ff' ? 'havşa başlı alt vidalar tabanla aynı hizada kalır.' : 'tabandaki vida başları/somunlar dışarıda kalır, lastik ayak önerilir.'}`, null, 'FAS-STANDOFF');
      }
    }
    for (const c of specIssues.values()) fastenChecks.push(c);
    for (const di of depthIssues.values()) {
      fastenChecks.push({ level: 'error', text: (di.count > 1 ? `${di.count} delikte: ` : `Delik ${di.where}: `) + di.text, fix: di.fix,
        rule: di.rule, measured: di.measured, limit: di.limit, op: '>=', unit: 'mm' });
    }
    for (const li of lengthIssues.values()) {
      fastenChecks.push({ level: 'warn', text: (li.count > 1 ? `${li.count} delikte: ` : `Delik ${li.where}: `) + li.text, fix: li.fix,
        rule: 'FAS-LENGTH', measured: li.measured, limit: li.limit, op: '>=', unit: 'mm' });
    }
  }

  // Malzeme listesi (BOM)
  const bom = [];
  // Yapılandırılmış malzeme listesi (CSV, tercihli parça eşleştirme, montaj paftası balonları)
  // { qty, kind, standard, name, size, length, material, spec, where, at: [x,y,z], part: 'base'|'lid' }
  const parts = [];
  const addPart = (pp) => parts.push({ standard: '', size: '', length: null, material: '', spec: '', where: '', at: null, part: 'base', ...pp });
  const groups = new Map();
  for (const sc of screws) {
    const key = `${sc.code}|${sc.size}|${sc.length}|${sc.role}|${sc.material?.id}`;
    if (!groups.has(key)) groups.set(key, { ...sc, count: 0 });
    groups.get(key).count++;
  }
  for (const g of groups.values()) {
    const drive = g.driveText ? ` (${g.driveText})` : '';
    const len = g.length === null || g.length === undefined ? '?' : f(g.length);
    const mat = g.material ? ` ${g.material.tag}` : '';
    const where = { sandwich: 'kapak + PCB', pcb: 'PCB', corner: 'kapak (köşe)' }[g.role] || (g.lid ? 'kapak + PCB' : 'PCB');
    bom.push(`${g.count} × ${g.code ? g.code + ' ' : ''}${g.size}×${len}${mat} ${g.name.toLocaleLowerCase('tr')}${drive}${g.counterbore ? ', gömme' : ''} — ${where}`);
    addPart({ qty: g.count, kind: 'screw', standard: g.code || '', name: g.name, size: g.size, length: g.length ?? null, material: g.material?.tag || '',
      spec: [g.driveText, g.counterbore ? 'gömme baş' : ''].filter(Boolean).join(', '), where, at: [g.x, g.y, g.zSeat ?? (g.lid ? zTop : b.top)], part: g.lid ? 'lid' : 'base' });
  }
  // Köşe boss'larının gövde tarafı
  if (cornerBosses.length && cplan) {
    const ci = cornerBosses[0].insert;
    const n = cornerBosses.length;
    const cs = cplan.s;
    bom.push(ci
      ? (ci.kind === 'helicoil'
        ? `${n} × Helicoil ${cs.size} × ${ci.id.replace('.', ',')} (${f(ci.L)} mm) — köşe boss'larına (Ø${f(ci.drill)} matkap, STI kılavuz)`
        : `${n} × ${ci.id} ısıyla gömülen pirinç insert — köşe boss'larına (delik Ø${f(ci.hole)})`)
      : cplan.method === 'self_tap' ? `Köşe boss'ları: ${n} × Ø${f(cs.selftap_pilot)} ön delik (sac vidası)` : `Köşe boss'ları: ${n} × ${cs.size} kılavuz (matkap Ø${f(cs.tap_drill)})`);
  }
  if (cornerBosses.length && cplan && cornerBosses[0].insert) {
    const ci = cornerBosses[0].insert;
    const c0 = cornerBosses[0];
    addPart(ci.kind === 'helicoil'
      ? { qty: cornerBosses.length, kind: 'helicoil', standard: 'DIN 8140', name: 'Helicoil tel dişli burç, serbest dönen', size: cplan.s.size, length: ci.L, material: 'A2', spec: ci.id, where: 'köşe boss', at: [c0.x, c0.y, c0.z1] }
      : { qty: cornerBosses.length, kind: 'insert', standard: 'ruthex RX', name: 'Isıyla gömülen pirinç insert', size: cplan.s.size, length: ci.L, material: 'CuZn', spec: ci.id, where: 'köşe boss', at: [c0.x, c0.y, c0.z1] });
  }
  // Baş altı pulları (tip + boyut + malzeme gruplanır)
  const wgroups = new Map();
  for (const sc of screws) {
    if (!sc.washer) continue;
    const w = sc.washer;
    const key = `${w.type}|${w.size}|${w.material?.id}`;
    if (!wgroups.has(key)) wgroups.set(key, { ...w, count: 0, at: [sc.x, sc.y, sc.zSeat ?? (sc.lid ? zTop : b.top)], lid: sc.lid });
    wgroups.get(key).count++;
  }
  for (const w of wgroups.values()) {
    bom.push(`${w.count} × ${w.code} ${w.size.replace(/^M/, '')}${w.material ? ' ' + w.material.tag : ''} ${w.name.toLocaleLowerCase('tr')} (Ø${f(w.d1)}/Ø${f(w.d2)} × ${f(w.s)}) — vida başı altı`);
    addPart({ qty: w.count, kind: 'washer', standard: w.code, name: w.name, size: w.size, material: w.material?.tag || '', spec: `Ø${f(w.d1)}/Ø${f(w.d2)} × ${f(w.s)}`, where: 'vida başı altı', at: w.at, part: w.lid ? 'lid' : 'base' });
  }
  // Sıkma torku (kapak ve yalnızca PCB vidaları ayrı)
  const tqText = (t) => `${f(t.T)} N·m (${torqueLimitText(t.limit)})`;
  const tLid = torqueOf.find((t) => t.role === 'sandwich');
  const tPcb = torqueOf.find((t) => t.role === 'pcb');
  const tCorner = torqueOf.find((t) => t.role === 'corner');
  const torqueLine = tLid || tPcb || tCorner
    ? `Sıkma torku: ${[tLid ? `kapak vidaları ${tqText(tLid)}` : null, tCorner ? `köşe kapak vidaları ${tqText(tCorner)}` : null,
      tPcb ? `PCB vidaları ${tqText(tPcb)}` : null].filter(Boolean).join(' · ')}` +
      (rules.conductive ? '' : '; plastikte ilk parçada deneyle doğrulayın')
    : null;
  if (standoffs.length && fasteners) {
    const s = table.find((x) => x.size === standoffs[0].screw);
    const ins = standoffs[0].insert;
    const st0 = standoffs[0];
    const stAt = [st0.x, st0.y, st0.z1];
    if (method === 'insert') {
      addPart({ qty: standoffs.length, kind: 'insert', standard: ins ? 'ruthex RX' : '', name: 'Isıyla gömülen pirinç insert', size: s.size, length: ins ? ins.L : s.insert_length, material: 'CuZn', spec: ins ? ins.id : '', where: 'standoff', at: stAt });
      bom.push(ins
        ? `${standoffs.length} × ${ins.id} ısıyla gömülen pirinç insert (${s.size}; Ø${f(ins.dOut)} × ${f(ins.L)}) — delik Ø${f(ins.hole)}`
        : `${standoffs.length} × ${s.size} ısıyla gömülen insert (L ${f(s.insert_length)}; delik Ø${f(s.insert_hole)})`);
    }
    if (method === 'helicoil' && ins) {
      bom.push(`${standoffs.length} × Helicoil ${s.size} × ${ins.id.replace('.', ',')} (${f(ins.L)} mm), serbest dönen, paslanmaz — DIN 8140`);
      addPart({ qty: standoffs.length, kind: 'helicoil', standard: 'DIN 8140', name: 'Helicoil tel dişli burç, serbest dönen', size: s.size, length: ins.L, material: 'A2', spec: ins.id, where: 'standoff', at: stAt });
      bom.push(`Gövde: Ø${f(ins.drill)} matkap, ${s.size} STI (Helicoil) kılavuz, girişte 90° havşa Ø${f(ins.csk)}; montaj aleti ve tang kırıcı`);
    }
    if (method === 'tapped' || (method === 'helicoil' && !ins)) bom.push(`${standoffs.length} × ${s.size} kılavuz (matkap Ø${f(s.tap_drill)})`);
    if (method === 'nut' && ins && ins.kind === 'nut') {
      addPart({ qty: standoffs.length, kind: 'nut', standard: ins.code, name: ins.name, size: s.size, material: ins.material?.tag || '', spec: ins.shape === 'hex' ? 'tabandan cebe' : 'yan yuvaya', where: 'standoff', at: [st0.x, st0.y, ins.zTop] });
      bom.push(`${standoffs.length} × ${ins.code} ${s.size}${ins.material ? ' ' + ins.material.tag : ''} ${ins.name.toLocaleLowerCase('tr')} — ` +
        (ins.shape === 'hex' ? `tabandan cebe (cep SW ${f(ins.pocket ?? ins.s)})` : 'standoff yanındaki yuvaya'));
    }
    if (method === 'standoff' && ins && ins.kind === 'standoff') {
      addPart({ qty: standoffs.length, kind: 'standoff', name: `Altıgen aralayıcı, ${ins.ends === 'ff' ? 'dişi-dişi' : 'erkek-dişi'}`, size: s.size, length: ins.L, material: ins.material?.tag || '', spec: `SW ${f(ins.sw)}`, where: 'taban', at: [st0.x, st0.y, (ins.zBottom + ins.zTop) / 2] });
      bom.push(`${standoffs.length} × ${s.size} × ${f(ins.L)} ${ins.ends === 'ff' ? 'dişi-dişi' : 'erkek-dişi'} altıgen aralayıcı, SW ${f(ins.sw)}${ins.material ? ' ' + ins.material.label.toLocaleLowerCase('tr') : ''}` +
        (ins.ends === 'mf' ? ` (erkek diş ${f(ins.male)} mm)` : ''));
      const sc0 = screws[0];
      if (ins.bottom?.kind === 'screw') {
        bom.push(`${standoffs.length} × ${sc0?.code ? sc0.code + ' ' : ''}${s.size}×${ins.bottom.length ?? '?'}${sc0?.material ? ' ' + sc0.material.tag : ''} ${sc0?.name.toLocaleLowerCase('tr') ?? 'vida'} — tabandan aralayıcıya`);
        addPart({ qty: standoffs.length, kind: 'screw', standard: sc0?.code || '', name: sc0?.name || 'Vida', size: s.size, length: ins.bottom.length ?? null, material: sc0?.material?.tag || '', spec: sc0?.driveText || '', where: 'tabandan aralayıcıya', at: [st0.x, st0.y, z0] });
      } else if (ins.bottom?.kind === 'nut') {
        bom.push(`${standoffs.length} × ${ins.bottom.code} ${s.size}${ins.bottom.material ? ' ' + ins.bottom.material.tag : ''} altıgen somun — taban altında aralayıcıya`);
        addPart({ qty: standoffs.length, kind: 'nut', standard: ins.bottom.code, name: 'Altıgen somun, normal', size: s.size, material: ins.bottom.material?.tag || '', where: 'taban altı', at: [st0.x, st0.y, z0] });
      }
    }
    if (method === 'self_tap' && tapping) bom.push(`Gövde: ${standoffs.length} × Ø${f(s.selftap_pilot)} ön delik (${s.size} sac vidası dişini kendisi açar; insert gerekmez)`);
    if (method === 'self_tap' && !tapping) bom.push(`Vidalar plastik için sac vidası tipinde seçilmeli (ön delik Ø${f(s.selftap_pilot)})`);
  }
  if (torqueLine) bom.push(torqueLine);

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
    addPart({ qty: 1, kind: 'seal', name: 'Silikon kordon conta', size: `Ø${f(seal.cord_d)}`, length: Math.ceil(cordLength + 10), material: 'VMQ', spec: 'uçlar yapıştırılarak halka', where: 'duvar üstü kanal', at: [center[0] + gL / 2, center[1], cavTop - groove.depth / 2] });
    const lidCount = screws.filter((s) => s.lid).length;
    if (lidCount && !countersunk) {
      bom.push(`${lidCount} × ${screws.find((s) => s.lid).size} sızdırmazlık pulu (vida başı altına)`);
      addPart({ qty: lidCount, kind: 'sealwasher', name: 'Sızdırmazlık pulu', size: screws.find((s) => s.lid).size, where: 'kapak vida başı altı' });
    }
    if (lidCount && countersunk) bom.push(`Sıvı sızdırmazlık / vida sabitleyici (havşa başlı ${lidCount} kapak vidası için)`);
  }

  // --- Panel elemanları (Toolbox Paket D): RF konnektör, rakor, basınç dengeleme, ışık borusu, ayak, özel delik ---
  const rfAll = analysis.parts.filter((pt) => !pt.isBoard && isRfName(pt.name));
  const portIds = new Set(ports.filter((pt) => pt.enabled).map((pt) => pt.partId));
  const panel = planPanel({
    specs: options.panelParts || [], types: options.toolbox?.panel || [], analysis, rules, p, cav, center, wall, floorTop, cavTop, zTop, z0,
    lidT, rIn, rOut, outer, fit, lipT, lipBars, standoffs, lidTubes, cornerBosses, lidHoles, screws, ports, groove, seal,
    obstacles, boardObstacles, boardTop: b.top, tol, lidTol,
    rfParts: rfAll.filter((pt) => !portIds.has(pt.id)).length ? rfAll.filter((pt) => !portIds.has(pt.id)) : rfAll,
  });
  bom.push(...panel.bom);
  parts.push(...panel.parts);

  // --- Kutunun bağlanması: montaj kulakları ya da tabandan içten vida ---
  const mount = planMount({
    mount: options.mount, rules, tol, fitSel, fasteners, washers: options.toolbox?.washers || [], outer, center, z0, wall, floor,
    floorTop, rIn, rOut, cav, ports, panelItems: panel.items, standoffs, cornerBosses, bottomBump: panel.bottomBump || 0,
    hasFeet: panel.items.some((it) => it.kind === 'foot'), p, below, seal,
  });
  bom.push(...mount.bom);
  if (mount.din) {
    const dn = mount.din;
    const where = 'DIN klipsi – kutu tabanı';
    const at = (h) => [h.x, h.y, floorTop];
    addPart({ qty: 2, kind: 'screw', standard: dn.method === 'self_tap' ? '' : 'ISO 7045', name: dn.method === 'self_tap' ? 'Plastik için diş açan vida' : 'Yıldız başlı silindir vida', size: dn.method === 'self_tap' ? 'Ø3' : 'M3', length: dn.len, material: screwMat?.tag || '', spec: 'içeriden, + pul', where, at: at(mount.floorHoles[0]) });
    if (dn.method === 'insert') addPart({ qty: 2, kind: 'insert', standard: '', name: 'Isıyla gömülen insert', size: 'M3', spec: `delik Ø${f(dn.holeD)}`, where: 'DIN klipsi', at: [mount.floorHoles[1].x, mount.floorHoles[1].y, z0 - 1], part: 'clip' });
  }

  // --- Kart kenarı tutucu: montaj deliği yoksa (ya da istenirse) alt destek + kapak baskısı ---
  const lidItems = [];
  for (const it of panel.items) {
    if (it.face === 'lid' && Number.isFinite(it.x) && it.E) lidItems.push({ box: { min: [it.x - it.E / 2, it.y - it.E / 2, cavTop - (it.pd?.inner || 5)], max: [it.x + it.E / 2, it.y + it.E / 2, cavTop] }, name: it.title });
    for (const q of it.positions || []) if (it.kind === 'lightpipe' && Number.isFinite(q.top)) lidItems.push({ box: { min: [q.x - 2, q.y - 2, q.top], max: [q.x + 2, q.y + 2, cavTop] }, name: 'ışık borusu' });
  }
  const edge = planEdgeHold({
    mode: options.edgeHold, hasHoles: usedHoles.length > 0, b, cav, floorTop, cavTop, rIn, fit, clr, obstacles, standoffs, cornerBosses,
    lidTubes, lidHoles, floorHoles: mount.floorHoles, lidItems, rules,
  });

  // --- DFM kontrolleri: her bulgu dfm/catalog.js'teki bir kurala bağlıdır (rule) ---
  const proc = rules.process;
  cat = 'genel';
  const wallMeta = { measured: num(wall), unit: 'mm' };
  if (wall < rules.min_wall - 1e-9) {
    add('error', `Et kalınlığı ${f(wall)} mm, ${rules.label} için en az ${f(rules.min_wall)} mm olmalı.`,
      { key: 'wall', value: rules.min_wall, label: `${f(rules.min_wall)} mm uygula` }, null, 'GEN-WALL-MIN', { ...wallMeta, limit: rules.min_wall, op: '>=' });
  } else if (seal && wall > rules.recommended_wall_max && wall <= groove.rimNeed + 0.5 && proc !== 'injection') {
    add('info', `Et kalınlığı ${f(wall)} mm: ${seal.label} conta kanalı için önerilen aralığın üst sınırı (${f(rules.recommended_wall_max)} mm) aşıldı.`,
      null, null, 'GEN-WALL-RANGE', { ...wallMeta, limit: rules.recommended_wall_max, op: '<=' });
  } else if (wall < rules.recommended_wall_min || wall > rules.recommended_wall_max) {
    const low = wall < rules.recommended_wall_min;
    add('warn', `Et kalınlığı ${f(wall)} mm, ${rules.label} için önerilen aralığın (${f(rules.recommended_wall_min)}–${f(rules.recommended_wall_max)} mm) ${low ? 'altında' : 'üstünde'}.` +
      (seal && proc === 'injection' && !low ? ' Enjeksiyonda kalın duvar çöküntü ve uzun soğuma süresi demek; IP için duvar yerine çevresel flanş (sonraki sürüm) daha uygun.' : ''),
      low ? { key: 'wall', value: rules.recommended_wall_min, label: `${f(rules.recommended_wall_min)} mm uygula` } : null, null, 'GEN-WALL-RANGE',
      { ...wallMeta, limit: [rules.recommended_wall_min, rules.recommended_wall_max], op: 'in' });
  } else {
    add('ok', `Et kalınlığı ${f(wall)} mm, önerilen aralıkta (${f(rules.recommended_wall_min)}–${f(rules.recommended_wall_max)} mm).`,
      null, null, 'GEN-WALL-RANGE', { ...wallMeta, limit: [rules.recommended_wall_min, rules.recommended_wall_max], op: 'in' });
  }
  // İç köşe radyüsü: CNC'de takım kuralı (CNC-CORNER-TOOL, tek bulgu), diğer süreçlerde kural dosyasının en azı
  if (proc !== 'cnc' && rIn < rules.corner_radius_min - 1e-6) {
    add('warn', `İç köşe radyüsü ${f(rIn)} mm, ${rules.label} için kural değerinin (${f(rules.corner_radius_min)} mm) altında.`,
      { key: 'cornerRadius', value: rules.corner_radius_min, label: `${f(rules.corner_radius_min)} mm uygula` }, null, 'GEN-CORNER-MIN',
      { measured: num(rIn), limit: rules.corner_radius_min, op: '>=', unit: 'mm' });
  }

  // Kapak ayrı malzemeden
  if (mixedLid) {
    add('info', `Kapak ${lr.label} (${{ fdm: 'FDM', cnc: 'CNC', injection: 'enjeksiyon' }[lr.process] || lr.process}), gövde ${rules.label}: kapak kalınlığı ${f(lidT)} mm${lidT > wall + 1e-6 ? ` (kapak malzemesinin en az et kalınlığı)` : ''}; kapak dili boşluğu iki malzemenin ortalaması${cteMismatch > 0.005 ? ` + ısıl genleşme farkı payı ${f(cteMismatch)} mm (ΔT 40 K)` : ''} = ${f(fit)} mm/kenar.`,
      null, null, 'LID-MIXED', { part: 'lid' });
    if (lr.process === 'fdm' && proc !== 'fdm') add('info', 'Kapak FDM: dış yüzü tablaya gelecek şekilde basılır; delikler kapak malzemesinin telafisiyle çizildi.', null, null, 'FDM-PRINT-ORIENT', { part: 'lid' });
    if (lr.process === 'cnc' && proc !== 'cnc') add('info', `Kapak CNC (${lr.label}): iç köşe ve dil uçları takım yarıçapına göre işlenir.`, null, null, 'LID-MIXED', { part: 'lid' });
  }

  cat = 'surec';
  if (proc === 'fdm') {
    const nz = rules.process_params.nozzle_diameter;
    const n = wall / nz;
    if (Math.abs(n - Math.round(n)) > 0.05) {
      const up = Math.round(Math.ceil(n - 1e-9) * nz * 100) / 100;
      add('warn', `Et kalınlığı ${f(wall)} mm, ${f(nz)} mm nozul çapının katı değil; çevreler arasında boşluk kalabilir. ${f(Math.floor(n) * nz)} veya ${f(up)} mm önerilir.`,
        { key: 'wall', value: up, label: `${f(up)} mm uygula` }, null, 'FDM-WALL-NOZZLE', { ...wallMeta, limit: up, op: 'multiple' });
    } else {
      add('ok', `Et kalınlığı ${f(wall)} mm, nozul çapının katı (${Math.round(n)} çevre).`, null, null, 'FDM-WALL-NOZZLE', { ...wallMeta, limit: num(Math.round(n) * nz), op: 'multiple' });
    }
    if (rIn < nz - 1e-6) {
      add('warn', `İç köşe radyüsü ${f(rIn)} mm, ${f(nz)} mm nozul çapından küçük: dikey köşe baskıda nozul çapı kadar yuvarlak çıkar, model ile parça örtüşmez.`,
        { key: 'cornerRadius', value: ceil005(nz), label: `${f(ceil005(nz))} mm uygula` }, null, 'FDM-CORNER-NOZZLE', { measured: num(rIn), limit: nz, op: '>=', unit: 'mm' });
    }
    // Destek gereksinimi tasarımdan türetilir: uzun pencere köprüleri ve büyük yatay delikler
    const sag = [];
    for (const pt of ports) if (pt.enabled && pt.style === 'window' && pt.openWidth > 10) sag.push(`${pt.name} penceresi (${f(pt.openWidth)} mm köprü)`);
    for (const it of panel.items) {
      if (['-X', '+X', '-Y', '+Y'].includes(it.face) && it.pd?.hole && it.pd.hole.d >= 8 && it.pd.hole.shape !== 'D') sag.push(`${it.title} deliği (Ø${f(it.pd.hole.d)})`);
    }
    if (!sag.length) {
      add('ok', 'Gövde ağzı yukarı, kapak dış yüzü tablaya gelecek şekilde basılır: duvarlar dik, köprüler ≤ 10 mm, destek gerekmez.', null, null, 'FDM-PRINT-ORIENT');
    } else {
      add('info', `Gövde ağzı yukarı, kapak dış yüzü tablaya gelecek şekilde basılır; destek gerekmez ama ${sag.slice(0, 3).join(', ')}${sag.length > 3 ? '…' : ''} köprü olarak basılır ve sarkabilir.`,
        null, null, 'FDM-PRINT-ORIENT');
    }
    if (['abs', 'asa', 'pc', 'pa12'].includes(rules.material)) {
      add('info', `${rules.label} soğurken çeker: ${f(outer.L)} × ${f(outer.W)} mm tabanda köşeler tabladan kalkabilir. Kapalı yazıcı, brim ve düşük fan önerilir; köşe radyüsü ve taban pahı çarpılmayı azaltır.`,
        null, null, 'FDM-WARP', { measured: num(Math.max(outer.L, outer.W)), unit: 'mm' });
    }
  }

  if (proc === 'cnc') {
    const tool = rules.process_params.tool_diameter;
    const rTool = tool / 2;
    // Tek kural: takım yarıçapının altı işlenemez (hata), 1,3 × takım yarıçapının altı takımı köşede tam temasa sokar (uyarı)
    const rNeed = Math.max(rules.corner_radius_min, ceil005(1.3 * rTool));
    const rMin = Math.max(rules.corner_radius_min, rTool);
    const cMeta = { measured: num(rIn), limit: rNeed, op: '>=', unit: 'mm' };
    if (rIn < rMin - 1e-6) {
      add('error', `İç köşe radyüsü ${f(rIn)} mm, Ø${f(tool)} takımla işlenemez: en az ${f(rMin)} mm gerekir, ${f(rNeed)} mm (1,3 × takım yarıçapı) önerilir.`,
        { key: 'cornerRadius', value: rNeed, label: `${f(rNeed)} mm uygula` }, null, 'CNC-CORNER-TOOL', cMeta);
    } else if (rIn < rNeed - 1e-6) {
      add('warn', `İç köşe radyüsü ${f(rIn)} mm, Ø${f(tool)} takımın yarıçapına çok yakın: takım köşede tam temasla keser (titreşim, kötü yüzey). ${f(rNeed)} mm (1,3 × takım yarıçapı) önerilir.`,
        { key: 'cornerRadius', value: rNeed, label: `${f(rNeed)} mm uygula` }, null, 'CNC-CORNER-TOOL', cMeta);
    } else {
      add('ok', `İç köşe radyüsü ${f(rIn)} mm ≥ 1,3 × Ø${f(tool)} takım yarıçapı (${f(rNeed)} mm).`, null, null, 'CNC-CORNER-TOOL', cMeta);
    }
    const depth = cavTop - floorTop;
    // Radyüs/derinlik: R ≥ d/4 ideal, d/8'e kadar mümkün (Xometry) — yalnızca öneri, döngü uygulamaz
    const rIdeal = ceil005(depth / 4);
    const rPossible = ceil005(depth / 8);
    if (rIn < rPossible - 1e-6) {
      add('warn', `İç köşe radyüsü ${f(rIn)} mm, ${f(depth)} mm cep derinliğinin 1/8'inden (${f(rPossible)} mm) küçük: uzun, ince takım gerekir; süre ve maliyet artar. R ≥ ${f(rIdeal)} mm (derinlik/4) idealdir.`,
        { key: 'cornerRadius', value: rPossible, label: `${f(rPossible)} mm yap`, auto: false }, null, 'CNC-CORNER-DEPTH', { measured: num(rIn), limit: rPossible, op: '>=', unit: 'mm' });
    } else if (rIn < rIdeal - 1e-6) {
      add('info', `İç köşe radyüsü ${f(rIn)} mm, ${f(depth)} mm cep derinliği için işlenebilir (≥ derinlik/8); ideal R ≥ derinlik/4 = ${f(rIdeal)} mm.`,
        { key: 'cornerRadius', value: rIdeal, label: `${f(rIdeal)} mm yap`, auto: false }, null, 'CNC-CORNER-DEPTH', { measured: num(rIn), limit: rIdeal, op: '>=', unit: 'mm' });
    } else {
      add('ok', `İç köşe radyüsü ${f(rIn)} mm ≥ cep derinliği/4 (${f(rIdeal)} mm).`, null, null, 'CNC-CORNER-DEPTH', { measured: num(rIn), limit: rIdeal, op: '>=', unit: 'mm' });
    }
    const ratio = depth / tool;
    const dMeta = { measured: num(ratio), limit: rules.process_params.max_depth_ratio, op: '<=', unit: '×D' };
    if (ratio > rules.process_params.max_depth_ratio) {
      add('warn', `Cep derinliği ${f(depth)} mm, Ø${f(tool)} takım için ${f(ratio)}×D (öneri ≤ ${f(rules.process_params.max_depth_ratio)}×D). Daha büyük takım ve iç köşe radyüsü (ör. Ø6 için ≥ 3,9 mm) ya da gövdeyi yükseklikte ikiye bölmek gerekebilir.`,
        null, null, 'CNC-POCKET-DEPTH', dMeta);
    } else {
      add('ok', `Cep derinliği ${f(depth)} mm, Ø${f(tool)} takım için uygun (${f(ratio)}×D).`, null, null, 'CNC-POCKET-DEPTH', dMeta);
    }
  }

  if (proc === 'injection') {
    // Draft: en az kural değeri; 25 mm derinlik başına ~1° (Protolabs); 50 mm üstünde 3°
    const depthInj = cavTop - floorTop;
    const draftNeed = Math.max(rules.draft_angle_min || 0.5, depthInj > 50 ? 3 : Math.ceil((depthInj / 25.4) * 2 - 1e-9) / 2);
    add('info', `Kalıp çıkma açısı: ${f(depthInj)} mm derin yan duvarlara ve iç yüzeylere en az ${f(draftNeed)}° draft uygulanmalı (≥ 0,5°, tipik 1–2°, 25 mm derinlik başına ~1°); katı modelde uygulandığı oluşturma sonrası doğrulanır.`,
      null, null, 'INJ-DRAFT', { limit: draftNeed, op: '>=', unit: '°' });
    // İç köşe ≥ 0,5·t (DuPont/Ticona); IP'de duvar conta payına çıkacağı için etkin kalınlık kullanılır
    const wallEff = seal ? Math.max(wall, groove.rimNeed) : wall;
    const rInj = Math.max(0.5 * wallEff, 0.5);
    if (rIn < rInj - 1e-6) {
      add('warn', `İç köşe radyüsü ${f(rIn)} mm, ${f(wallEff)} mm et kalınlığının yarısından (${f(rInj)} mm) küçük: köşede gerilme yığılması artar (Kt ≈ 1,5 → 3) ve dolum zorlaşır.`,
        { key: 'cornerRadius', value: ceil005(rInj), label: `${f(ceil005(rInj))} mm uygula` }, null, 'INJ-CORNER-RADIUS', { measured: num(rIn), limit: num(rInj), op: '>=', unit: 'mm' });
    } else {
      add('ok', `İç köşe radyüsü ${f(rIn)} mm ≥ 0,5 × et kalınlığı; dış radyüs ${f(rOut)} mm = iç + et (köşede üniform et).`, null, null, 'INJ-CORNER-RADIUS',
        { measured: num(rIn), limit: num(rInj), op: '>=', unit: 'mm' });
    }
    const ratio = lipT / wall;
    if (ratio > rules.rib_ratio_max) {
      add('warn', `Kapak dili kalınlığı ${f(lipT)} mm, et kalınlığının %${Math.round(ratio * 100)}'i: çöküntü (sink) riski. En fazla %${Math.round(rules.rib_ratio_max * 100)} önerilir.`,
        null, null, 'INJ-LIP-RATIO', { measured: num(ratio), limit: rules.rib_ratio_max, op: '<=', unit: '' });
    } else {
      add('ok', `Kapak dili / et kalınlığı oranı %${Math.round(ratio * 100)}: çöküntü riski düşük.`, null, null, 'INJ-LIP-RATIO', { measured: num(ratio), limit: rules.rib_ratio_max, op: '<=', unit: '' });
    }
    // Üniform et: kalın bloklar ve ani kalınlık değişimleri tasarımdan çıkarılır
    const thick = [];
    const fr = floor / wall;
    if (fr < 0.6 || fr > 1 / 0.6) thick.push(`taban ${f(floor)} mm / duvar ${f(wall)} mm`);
    if (cornerBosses.length) thick.push(`${cornerBosses.length} köşe boss'u duvar köşesine dolu blokla bağlı (Ø${f(cornerBosses[0].od)})`);
    if (edge.pads.length) thick.push(`${edge.pads.length} kart kenarı desteği dolu blok`);
    if (lidHoles.some((hh) => hh.pad)) thick.push('kapak altındaki köşe vidası yastıkları');
    for (const it of panel.items) {
      if (it.spot && it.pd?.panelMax && it.face !== 'lid' && it.pd.panelMax / wall < 0.6) thick.push(`${it.title} lambası duvarı ${f(it.pd.panelMax)} mm'ye inceltiyor (%${Math.round((100 * it.pd.panelMax) / wall)})`);
    }
    if (!thick.length) {
      add('ok', `Taban, duvar ve kapak aynı kalınlıkta (${f(wall)} mm); kalın blok ya da ani kalınlık değişimi yok.`, null, null, 'INJ-UNIFORM-WALL', { measured: num(fr), unit: '' });
    } else {
      add('warn', `Et kalınlığı üniform değil: ${thick.join('; ')}. Kalın bölgeler çöküntü (sink) ve boşluk yapar; içten boşaltın, kalınlık geçişini ≥ 3:1 eğimle yapın.`,
        null, null, 'INJ-UNIFORM-WALL');
    }
    // Boss duvarı ≤ 0,6·t: tüm standoff, kapak borusu ve köşe boss'ları; en kötü durum raporlanır
    const bosses = [
      ...standoffs.filter((s) => s.integral !== false).map((s) => ({ w: (s.od - s.holeD) / 2, t: wall, what: 'standoff', x: s.x, y: s.y })),
      ...lidTubes.map((t) => ({ w: (t.od - t.holeD) / 2, t: lidT, what: 'kapak borusu', x: t.x, y: t.y })),
      ...cornerBosses.map((c) => ({ w: (c.od - c.holeD) / 2, t: wall, what: "köşe boss'u", x: c.x, y: c.y })),
    ];
    if (bosses.length) {
      const over = bosses.filter((q) => q.w > 0.6 * q.t + 1e-6);
      const worst = bosses.reduce((a, q) => (q.w / q.t > a.w / a.t ? q : a));
      const bMeta = { measured: num(worst.w), limit: num(0.6 * worst.t), op: '<=', unit: 'mm' };
      if (over.length) {
        add('warn', `Boss duvarı ${f(worst.w)} mm (${worst.what}, ${f(worst.x)}; ${f(worst.y)}), ${f(worst.t)} mm et kalınlığının %60'ını (${f(0.6 * worst.t)} mm) aşıyor; ${over.length}/${bosses.length} boss'ta karşı yüzde çöküntü riski. Boss'u içten boşaltın ve yan duvara kaburgayla bağlayın.`,
          null, null, 'INJ-BOSS-WALL', bMeta);
      } else {
        add('ok', `${bosses.length} boss'un duvarı ≤ 0,6 × et kalınlığı (en kalın ${f(worst.w)} mm).`, null, null, 'INJ-BOSS-WALL', bMeta);
      }
    }
    const nf4 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 4 });
    add('info', `Çekme payı %${f(rules.shrink_factor * 100)}: kalıp ölçüsü = parça ölçüsü × ${nf4.format(1 + rules.shrink_factor)}.`, null, null, 'INJ-SHRINK');
  }

  // --- RF / anten: parçalar ad belirteçleriyle (isAntennaName/isRfName) tanınır ---
  const antennaParts = analysis.parts.filter((pt) => !pt.isBoard && pt.box && isAntennaName(pt.name) && !isConnectorName(pt.name));
  const rfModules = analysis.parts.filter((pt) => !pt.isBoard && pt.box && isRfName(pt.name) && !isConnectorName(pt.name) && !antennaParts.includes(pt));
  const rfConnectors = analysis.parts.filter((pt) => !pt.isBoard && isRfName(pt.name) && isConnectorName(pt.name));
  // Ayrı anten parçası yoksa RF modülü (ör. Wi-Fi/Bluetooth kalkanı) anten bölgesi sayılır
  const antZone = antennaParts.length ? antennaParts : rfModules;
  const antNames = antZone.map((pt) => pt.name).slice(0, 2).join(', ');
  const antFocus = antZone.length ? { partId: antZone[0].id } : null;
  const conductiveBody = !!rules.conductive || rules.conductive_filler === true;
  const lidConductive = mixedLid ? (!!lr.conductive || lr.conductive_filler === true) : conductiveBody;
  if (conductiveBody) {
    cat = 'genel';
    add('info', `${rules.label} muhafaza iletkendir: PCB ile duvar, vida ve aralayıcılar arasındaki boşluğu ve topraklamayı kontrol et.`, null, null, 'GEN-CONDUCTIVE');
  }
  cat = 'rf';
  if (antZone.length) {
    if (conductiveBody && panel.hasRf) {
      add('ok', `Metal muhafaza RF sinyalini keser; kartın RF bileşeni (${antNames}) panel RF konnektörü üzerinden dış antene bağlanıyor.`, null, antFocus, 'RF-METAL-BODY');
    } else if (conductiveBody && mixedLid && !lidConductive) {
      add('info', `Metal gövde RF sinyalini keser, ${lr.label} kapak geçirir: kartın RF bileşeni (${antNames}) yalnızca kapak yönünde yayın yapar; anteni kapağa yakın tutun.`, null, antFocus, 'RF-METAL-BODY');
    } else if (conductiveBody) {
      add('error', `${rules.label} gövde kartın dahili antenini (${antNames}) tamamen perdeler: panel RF konnektörüyle dış anten, plastik kapak ya da RF penceresi gerekir.`,
        { key: 'panelAdd', value: 'sma-bh', label: 'SMA panel konnektörü ekle' }, antFocus, 'RF-METAL-BODY');
    } else if (mixedLid && lidConductive && !panel.hasRf) {
      add('warn', `${lr.label} kapak kartın dahili antenini (${antNames}) üstten perdeler; anten yalnızca yan duvarlardan yayın yapar.`, null, antFocus, 'RF-METAL-BODY', { part: 'lid' });
    }
    const lossyBody = !conductiveBody && (CARBON_FILLED.has(rules.material) || rules.carbon_filled === true);
    const lossyLid = mixedLid && !lidConductive && (CARBON_FILLED.has(lr.material) || lr.carbon_filled === true);
    if ((lossyBody || lossyLid) && !panel.hasRf) {
      add('warn', `${lossyBody ? rules.label : lr.label} karbon fiber katkılıdır (iletken, kayıplı): dahili anten (${antNames}) zayıflar ve detune olur. Anten bölgesinde katkısız plastik (PETG, ASA, PC) ya da panel konnektörüyle dış anten önerilir.`,
        null, antFocus, 'RF-LOSSY-MATERIAL', { part: lossyBody ? 'base' : 'lid' });
    }
    // Anten çevresinde metal parça: vida, insert/Helicoil/somun/aralayıcı, tabandaki montaj vidası, DIN rayı
    const metals = [];
    const holeIdxAt = (x, y) => mountHoles.find((hh) => Math.abs(hh.x - x) < 1e-6 && Math.abs(hh.y - y) < 1e-6)?.index ?? null;
    const isMetal = (mat) => (mat ? matList.find((m) => m.id === mat.id)?.conductive !== false : true);
    for (const sc of screws) {
      if (!isMetal(sc.material)) continue;
      const top = sc.zSeat ?? b.top;
      metals.push({ what: `${sc.size} vida`, x: sc.x, y: sc.y, z0: top - (sc.length ?? sc.grip ?? 5), z1: top, hole: sc.role === 'corner' ? null : holeIdxAt(sc.x, sc.y), screw: true });
    }
    for (const st of [...standoffs, ...cornerBosses]) {
      const ins = st.insert;
      if (!ins) continue;
      if (ins.kind === 'standoff' && ins.material && !isMetal(ins.material)) continue;
      const what = { heatset: 'pirinç insert', helicoil: 'Helicoil', nut: 'somun', standoff: 'metal aralayıcı' }[ins.kind] || 'metal burç';
      metals.push({ what, x: st.x, y: st.y, z0: st.z0, z1: st.z1 ?? b.bottom, hole: holeIdxAt(st.x, st.y) });
    }
    for (const hh of mount.floorHoles || []) metals.push({ what: 'tabandaki montaj vidası', x: hh.x, y: hh.y, z0: z0 - 6, z1: floorTop + 4, hole: null });
    let rail = null;
    if (mount.din) {
      const dn = mount.din;
      const halfW = 17.5;
      const big = Math.max(outer.L, outer.W) + 200;
      const bx = dn.axis === 0 ? [center[0] - big, center[0] + big] : [center[0] - halfW, center[0] + halfW];
      const by = dn.axis === 0 ? [center[1] - halfW, center[1] + halfW] : [center[1] - big, center[1] + big];
      rail = { min: [bx[0], by[0], z0 - dn.tp - 7.5], max: [bx[1], by[1], z0 - dn.tp] };
    }
    let nearest = null;
    const near = [];
    for (const ant of antZone) {
      for (const m of metals) {
        const d = distSegBox(ant.box, m.x, m.y, m.z0, m.z1);
        if (d < RF_KEEPOUT - 1e-6) near.push({ ...m, d, ant });
        if (!nearest || d < nearest.d) nearest = { ...m, d, ant };
      }
      if (rail) {
        const d = distBoxBox(ant.box, rail);
        const m = { what: 'DIN rayı (çelik)', d, ant };
        if (d < RF_KEEPOUT - 1e-6) near.push(m);
        if (!nearest || d < nearest.d) nearest = m;
      }
    }
    if (near.length) {
      const w = near.reduce((a, q) => (q.d < a.d ? q : a));
      const plastic = (ttype?.materials || []).map((id) => matList.find((m) => m.id === id)).find((m) => m && m.conductive === false);
      const fix = w.screw && plastic ? { key: 'screwMaterial', value: plastic.id, label: `${plastic.tag} (plastik) vida seç` }
        : w.hole !== null && w.hole !== undefined ? { key: 'holeOff', value: w.hole, label: 'Bu deliği kullanma' } : null;
      add('warn', `${near.length} metal parça ${w.ant.name} anteninin ${RF_KEEPOUT} mm yakınında (en yakın: ${w.what}, ${f(w.d)} mm): anten detune olur, verim 3–10 dB düşebilir. Metal parçayı uzaklaştırın ya da plastik vida/burç kullanın.`,
        fix, { partId: w.ant.id }, 'RF-KEEPOUT-METAL', { measured: num(w.d), limit: RF_KEEPOUT, op: '>=', unit: 'mm' });
    } else {
      add('ok', `${antNames} çevresinde ${RF_KEEPOUT} mm içinde metal vida, insert ya da aralayıcı yok${nearest ? ` (en yakın ${nearest.what}, ${f(nearest.d)} mm)` : ''}.`,
        null, antFocus, 'RF-KEEPOUT-METAL', { measured: nearest ? num(nearest.d) : null, limit: RF_KEEPOUT, op: '>=', unit: 'mm' });
    }
    if (!conductiveBody) {
      add('info', `Plastik duvar ve kapak ${antNames} antenini detune eder (rezonans düşer): eşleştirme son muhafaza içinde ölçülüp ayarlanmalı (S11 ≤ −10 dB).`, null, antFocus, 'RF-DETUNE');
    }
  } else if (conductiveBody && rfConnectors.length) {
    add('ok', `Kartın RF çıkışı (${rfConnectors.slice(0, 2).map((pt) => pt.name).join(', ')}) konnektörle dışarı veriliyor; metal gövde dış anteni etkilemez.`, null, { partId: rfConnectors[0].id }, 'RF-METAL-BODY');
  }

  // Port açıklıkları
  cat = 'port';
  for (const en of enclosed) {
    add('info', `${en.name} kartın dışına taşıyor; ${en.auto ? 'anten olduğu için' : 'seçiminizle'} duvardan açıklık açılmadı, kavite onu içine alacak kadar büyütüldü.`, null, { partId: en.partId }, 'PORT-ENCLOSED');
  }
  const styleText = (s) => (s === 'notch' ? 'çentik (üstten açık)' : 'pencere');
  let sideMachining = false;
  for (const pt of ports) {
    const focus = { partId: pt.partId };
    if (!pt.enabled) {
      if (pt.crossing) {
        add('error', `${pt.name} ${pt.side} duvarından geçiyor ama açıklığı kapalı: kart kutuya yerleştirilemez.`,
          { key: 'portEnable', value: pt.key, label: 'Açıklığı aç' }, focus, 'PORT-CROSS-CLOSED');
      }
      continue;
    }
    add('ok', `${pt.name}: ${pt.side} duvarında ${styleText(pt.style)} açıklık ${f(pt.openWidth)} × ${f(pt.openHeight)} mm.`, null, focus, 'PORT-OPEN');
    if (pt.autoNotch) {
      add('info', `${pt.name}: açıklığın üstünde yalnızca ${f(Math.max(pt.bridge, 0))} mm duvar kalacağı için açıklık üst kenara kadar uzatıldı; kapak üstünü kapatır.`, null, focus, 'PORT-AUTO-NOTCH',
        { measured: num(Math.max(pt.bridge, 0)), limit: num(minBridge), op: '>=', unit: 'mm' });
    }
    if (pt.clippedBottom) add('warn', `${pt.name}: açıklık tabana kadar inemeyeceği için alt kısmı kırpıldı.`, null, focus, 'PORT-CLIPPED');
    if (pt.recess > 1.5) {
      add('warn', `${pt.name}: ön yüzü dış yüzeyden ${f(pt.recess)} mm içeride; fiş gövdesi duvara takılabilir. Açıklığı fiş ölçüsüne göre büyüt veya PCB–duvar boşluğunu azalt.`, null, focus, 'PORT-RECESS',
        { measured: num(pt.recess), limit: 1.5, op: '<=', unit: 'mm' });
    } else if (pt.recess < -0.05) {
      add('info', `${pt.name}: ön yüzü dış yüzeyden ${f(-pt.recess)} mm dışarı taşıyor.`, null, focus, 'PORT-RECESS', { measured: num(pt.recess), unit: 'mm' });
    }
    if (pt.cornerGap < rules.min_wall) {
      add('warn', `${pt.name}: açıklık köşeye çok yakın (${f(Math.max(pt.cornerGap, 0))} mm duvar kalıyor); köşe zayıflar.`, null, focus, 'PORT-CORNER-WEB',
        { measured: num(Math.max(pt.cornerGap, 0)), limit: rules.min_wall, op: '>=', unit: 'mm' });
    }
    if (proc === 'injection') {
      if (pt.style === 'window') {
        add('warn', `${pt.name}: kapalı pencere kalıpta yan maça (slider) gerektirir; çentik seçilirse gerekmez.`,
          seal ? null : { key: 'portStyle', value: `${pt.key}|notch`, label: 'Çentik yap' }, focus, 'INJ-SIDE-ACTION');
      }
    } else if (proc === 'fdm' && pt.style === 'window') {
      // Pencere tavanı köprüdür: ≤ 5 mm temiz, 5–10 mm hafif sarkma, > 10 mm geometri değişikliği (Hubs; He vd. 2026)
      const bMeta = { measured: num(pt.openWidth), limit: 10, op: '<=', unit: 'mm' };
      if (pt.openWidth > 10) {
        add('warn', `${pt.name}: pencerenin üst kenarı ${f(pt.openWidth)} mm köprü (> 10 mm); baskıda sarkar. Çentik açıklık (üstten açık) ya da üst kenara pah/kemer önerilir.`,
          seal ? null : { key: 'portStyle', value: `${pt.key}|notch`, label: 'Çentik yap' }, focus, 'FDM-BRIDGE', bMeta);
      } else if (pt.openWidth > 5) {
        add('info', `${pt.name}: pencerenin üst kenarı ${f(pt.openWidth)} mm köprü (5–10 mm); baskıda hafif sarkma olabilir.`, null, focus, 'FDM-BRIDGE', bMeta);
      } else {
        add('ok', `${pt.name}: pencerenin üst kenarı ${f(pt.openWidth)} mm köprü (≤ 5 mm), temiz basılır.`, null, focus, 'FDM-BRIDGE', bMeta);
      }
    }
    if (proc === 'cnc') sideMachining = true;
  }
  if (sideMachining) add('info', `Yan duvar açıklıkları ikinci bağlama veya 4. eksen ister; köşe radyüsü takıma göre R${f(cutR)}.`, null, null, 'CNC-SETUPS');
  if (proc === 'injection' && ports.some((pt) => pt.enabled && pt.style === 'notch')) {
    add('ok', 'Çentik tipi açıklıklar ana kalıp açılma yönünde: yan maça gerekmez.', null, null, 'INJ-SIDE-ACTION');
  }
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) {
      const A = ports[i], B = ports[j];
      if (!A.enabled || !B.enabled || A.side !== B.side) continue;
      const gap = Math.max(A.a0, B.a0) - Math.min(A.a1, B.a1);
      if (gap < rules.min_wall) {
        add('warn', `${A.name} ile ${B.name} açıklıkları arasında ${f(Math.max(gap, 0))} mm duvar kalıyor (${A.side}).`, null, { partId: A.partId }, 'PORT-WEB',
          { measured: num(Math.max(gap, 0)), limit: rules.min_wall, op: '>=', unit: 'mm' });
      }
    }
  }

  cat = 'kapak';
  for (const r of lipRemoved) {
    add('info', `Kapak dili ${r.side} kenarında kaldırıldı: altında yüksek bileşen var${r.who ? ` (${r.who})` : ''}.`, null, r.who ? partIdByName(r.who) : null, 'LID-LIP-REMOVED', { part: 'lid' });
  }
  for (const s of lipShortened) {
    add('info', `Kapak dili ${s.side} kenarında ${f(s.depth)} mm'ye kısaltıldı${s.who ? ` (${s.who})` : ''}.`, null, s.who ? partIdByName(s.who) : null, 'LID-LIP-SHORT', { part: 'lid' });
  }
  if (lipBars.length === 0) {
    // En az bir kenarda dil sığsın diye gereken üst boşluk (bileşen üstüne)
    const extras = lipRemoved.filter((r) => Number.isFinite(r.allowed)).map((r) => lr.lid_lip_min_depth - r.allowed);
    const extra = extras.length ? Math.min(...extras) : null;
    const tc = extra !== null && extra > 0 && extra < 30 ? ceil01(p.topClearance + extra) : null;
    add('warn', 'Kapağı konumlayacak dil hiçbir kenara sığmadı: kapak gövdeye göre kayabilir.' + (tc ? ` Bileşen üstü boşluk ${f(tc)} mm olursa en az bir kenarda dil sığar.` : ' Bileşen üstü boşluğu artırmayı dene.'),
      tc ? { key: 'topClearance', value: tc, label: `üst boşluğu ${f(tc)} mm yap` } : null, null, 'LID-LIP-NONE', { part: 'lid' });
  }

  // Bağlantı kontrolleri
  cat = 'baglanti';
  if (!mountHoles.length) {
    if (!edge.active) {
      add('warn', 'Kartta montaj deliği bulunamadı: PCB tutucu (standoff) üretilmedi, kart muhafaza içinde serbest kalır.',
        { key: 'edgeHold', value: 'on', label: 'Kart kenarı tutucu' }, null, 'FAS-NO-HOLES');
    }
    if (lidMode === 'screw') {
      add('info', 'Kapak vidası montaj deliklerine bağlı olduğundan kapak yalnızca geçmeyle tutunur; vidalı kapak için köşe vidaları seçin.',
        { key: 'lidMode', value: 'corner', label: 'Köşe vidaları' }, null, 'LID-NO-SCREW');
    }
  } else if (!usedHoles.length) {
    if (!edge.active) add('warn', 'Hiçbir montaj deliği seçilmedi: PCB tutucu üretilmedi.', { key: 'edgeHold', value: 'on', label: 'Kart kenarı tutucu' }, null, 'FAS-NO-HOLES');
  }
  for (const c of edge.checks) addC(c);
  for (const c of fastenChecks) addC(c);
  if (standoffs.length) {
    // İnce uzunluk: tüm (gövdeyle tek parça) standoff'lar; en kötü durum
    const sl = standoffs.filter((s) => s.integral !== false).map((s) => ({ s, r: (s.z1 - s.z0) / s.od }));
    const worst = sl.length ? sl.reduce((a, q) => (q.r > a.r ? q : a)) : null;
    const over = sl.filter((q) => q.r > 4);
    if (worst && over.length) {
      add('warn', `Standoff boyu/çapı oranı ${f(worst.r)} (${f(worst.s.z1 - worst.s.z0)} mm / Ø${f(worst.s.od)}, ${over.length}/${sl.length} standoff'ta > 4): ince uzun, kırılma ve titreşim riski. Duvara kaburgayla bağlamayı düşün.`,
        null, null, 'FAS-STANDOFF-SLENDER', { measured: num(worst.r), limit: 4, op: '<=', unit: '' });
    } else {
      const st = standoffs[0];
      add('ok', `${standoffs.length} standoff (Ø${[...new Set(standoffs.map((s) => f(s.od)))].join(' / ')} × ${f(p.standoffHeight)} mm), ${METHOD_TEXT[method]} ile.`,
        null, null, 'FAS-STANDOFF-SLENDER', worst ? { measured: num(worst.r), limit: 4, op: '<=', unit: '' } : { measured: num(p.standoffHeight / st.od), unit: '' });
    }
    if (method === 'insert' && proc === 'fdm') {
      add('info', rules.insert_temp_c
        ? `İnsertleri havya ucuyla dik bastır: ${rules.label} için uç sıcaklığı ≈ ${rules.insert_temp_c} °C (baskı sıcaklığı + 10–20 °C); derinliğin ~%90'ı eritilir, kalanı düz uçla yüzeyle aynı hizaya bastırılır.`
        : 'İnsertleri havya ucuyla dik bastır (PLA ~225 °C, PETG ~245 °C, ABS ~265 °C); derinliğin ~%90\'ı eritilir, kalanı düz uçla bastırılır.', null, null, 'FDM-INSERT-TEMP');
    }
  }
  if (lidTubes.length) {
    // Kapak boruları: tümü; en kötü boy/çap oranı
    const worstT = lidTubes.reduce((a, t) => (t.length / t.od > a.length / a.od ? t : a));
    const ratio = worstT.length / worstT.od;
    const tMeta = { measured: num(ratio), limit: lr.process === 'cnc' ? 3 : 6, op: '<=', unit: '', part: 'lid' };
    if (lr.process === 'cnc' && ratio > 3) {
      add('warn', `Kapaktaki ${f(worstT.length)} mm boyundaki borular (boy/çap ${f(ratio)}) CNC'de çok malzeme kaldırmayı gerektirir; hazır metal aralayıcı (spacer) kullanmayı düşün.`, null, null, 'LID-TUBE-SLENDER', tMeta);
    } else if (ratio > 6) {
      add('warn', `Kapak boruları ince uzun (boy/çap ${f(ratio)}, ${f(worstT.length)} mm): ${lr.process === 'injection' ? 'maça pimi eğilebilir, dolum zorlaşır' : 'baskıda titreşebilir'}.`, null, null, 'LID-TUBE-SLENDER', tMeta);
    } else {
      add('ok', `${lidTubes.length} kapak borusu kapak ile PCB'yi aynı vidayla sıkıştırıyor (en ince boy/çap ${f(ratio)}).`, null, null, 'LID-TUBE-SLENDER', tMeta);
    }
  } else if (standoffs.length && lidMode === 'screw') {
    add('warn', 'Hiçbir montaj deliğinin üstü boş değil: kapak borusu yapılamadı, kapak yalnızca geçmeyle tutunur.', { key: 'lidMode', value: 'corner', label: 'Köşe vidaları' }, null, 'LID-TUBE-NONE');
  } else if (lidMode === 'none') {
    add('info', fitSel.lid === 'press'
      ? `Kapak vidasız: dil gövdeye sıkı geçer (kenar boşluğu ${f(fit)} mm); ilk baskıda takıp çıkararak deneyin.`
      : 'Kapak vidasız: yalnızca konumlandırma diliyle tutunur; sürtünmeyle tutması için kapak geçmesini Sıkı seçin.',
    fitSel.lid === 'press' ? null : { key: 'fitLid', value: 'press', label: 'Sıkı geçme' }, null, 'LID-SNAP', { part: 'lid' });
  }

  // Kutunun bağlanması (montaj)
  cat = 'montaj';
  for (const c of mount.checks) addC(c);

  // Panel elemanları
  cat = 'panel';
  for (const c of panel.checks) addC(c);

  // Sızdırmazlık (IP) kontrolleri
  cat = 'ip';
  if (seal) {
    if (wall < groove.rimNeed - 1e-6) {
      add('error', `${seal.label} conta kanalı (${f(groove.width)} × ${f(groove.depth)} mm) ve iki yanındaki ${f(seal.land)} mm et payı için et kalınlığı en az ${f(groove.rimNeed)} mm olmalı; şu an ${f(wall)} mm.`,
        { key: 'wall', value: groove.rimNeed, label: `${f(groove.rimNeed)} mm uygula` }, null, 'IP-RIM', { measured: num(wall), limit: groove.rimNeed, op: '>=', unit: 'mm' });
    } else {
      add('ok', `Conta kanalı ${f(groove.width)} × ${f(groove.depth)} mm: Ø${f(seal.cord_d)} kordon %${Math.round(seal.squeeze * 100)} sıkışır, kanal doluluğu %${Math.round(groove.fill * 100)}.`,
        null, null, 'IP-RIM', { measured: num(wall), limit: groove.rimNeed, op: '>=', unit: 'mm' });
    }
    // Kanal köşe radyüsü ≥ 3 × kordon çapı (Parker ORD 5700 §4.3): kanal orta çizgisi radyüsü = iç radyüs + et/2
    const gr = rIn + wall / 2;
    const grNeed = 3 * seal.cord_d;
    if (gr < grNeed - 1e-6) {
      // Et kalınlığı conta payına çıkacaksa (IP-RIM) gerekli iç radyüs o kalınlığa göre
      const crNeed = ceil005(grNeed - Math.max(wall, groove.rimNeed) / 2);
      add('warn', `Conta kanalı köşe radyüsü ${f(gr)} mm, Ø${f(seal.cord_d)} kordon için en az ${f(grNeed)} mm (3 × kordon çapı) olmalı: kordon köşede ezilir ya da kalkar.`,
        crNeed > p.cornerRadius + 1e-6 ? { key: 'cornerRadius', value: crNeed, label: `iç köşe radyüsü ${f(crNeed)} mm` } : null, null, 'IP-GROOVE-RADIUS',
        { measured: num(gr), limit: num(grNeed), op: '>=', unit: 'mm' });
    } else {
      add('ok', `Conta kanalı köşe radyüsü ${f(gr)} mm ≥ 3 × Ø${f(seal.cord_d)} kordon (${f(grNeed)} mm).`, null, null, 'IP-GROOVE-RADIUS', { measured: num(gr), limit: num(grNeed), op: '>=', unit: 'mm' });
    }
    const lidScrewList = screws.filter((s) => s.lid);
    if (!lidScrewList.length) {
      add('error', `${seal.label} için kapak contayı sıkıştıracak vidalarla bağlanmalı; şu an vidalı kapak yok (montaj deliği veya köşe vidaları gerekir).`,
        lidMode !== 'corner' ? { key: 'lidMode', value: 'corner', label: 'Köşe vidaları' } : null, null, 'IP-CLAMP-NONE');
    } else {
      // Sıkıştırma noktaları conta orta çizgisine izdüşürülür; en büyük boşluk aranır. Köşe vidaları duvara bağlıdır;
      // PCB vidaları ancak conta çizgisine yakınsa (et/2 + 3 × kapak kalınlığı) kapağı duvar üstüne bastırır.
      const path = roundedRectPath(center[0], center[1], grooveGeom.L, grooveGeom.W, grooveGeom.r);
      const reach = wall / 2 + 3 * lidT;
      const clamps = lidScrewList.map((s) => ({ s, pr: path.project(s.x, s.y) })).filter((c) => c.s.role === 'corner' || c.pr.dist <= reach + 1e-6);
      const ss = clamps.map((c) => c.pr.s).sort((a, b2) => a - b2);
      let maxGap = path.length;
      if (ss.length >= 2) {
        maxGap = path.length - ss[ss.length - 1] + ss[0];
        for (let i = 1; i < ss.length; i++) maxGap = Math.max(maxGap, ss[i] - ss[i - 1]);
      }
      const excluded = lidScrewList.length - clamps.length;
      const pMeta = { measured: num(maxGap), limit: seal.max_clamp_pitch, op: '<=', unit: 'mm' };
      if (maxGap > seal.max_clamp_pitch) {
        add('warn', `Conta boyunca en büyük sıkıştırma aralığı ${f(maxGap)} mm (${clamps.length} vida contaya yakın${excluded ? `; conta çizgisine ${f(reach)} mm'den uzak ${excluded} vida sayılmadı` : ''}); ${seal.label} için ≤ ${seal.max_clamp_pitch} mm önerilir. Kapak aralığın ortasında esneyip contayı yeterince sıkıştırmayabilir; ${lidMode === 'corner' ? 'daha kalın kapak ya da ek kenar vidası gerekir' : 'köşe vidalarıyla kapak bağlantısı önerilir'}.`,
          lidMode === 'corner' ? null : { key: 'lidMode', value: 'corner', label: 'Köşe vidaları' }, null, 'IP-CLAMP-PITCH', pMeta);
      } else {
        add('ok', `Conta boyunca en büyük sıkıştırma aralığı ${f(maxGap)} mm (≤ ${seal.max_clamp_pitch} mm, ${clamps.length} vida).`, null, null, 'IP-CLAMP-PITCH', pMeta);
      }
      add('info', countersunk
        ? 'Kapak vidaları conta halkasının içinden geçiyor: havşa başlı vidada pul kullanılamaz, havşaya sıvı sızdırmazlık / vida sabitleyici sür (ya da silindir başlı vida + sızdırmazlık pulu seç).'
        : 'Kapak vidaları conta halkasının içinden geçiyor: her vida başının altına sızdırmazlık pulu koy.', null, null, 'IP-SEAL-WASHER');
    }
    for (const c of ipPortIssues) addC(c);
    if (ports.some((pt) => pt.enabled)) {
      add('warn', `Açık port var: ${seal.label} için konnektörlerin IP sınıflı panel tipi olması ya da port contası / kablo rakoru kullanılması gerekir.`, null, null, 'IP-OPEN-PORT');
    }
    if (proc === 'fdm') {
      add('info', 'FDM parçada katmanlar arasından sızma olabilir: en az 5 çevre, %100 dış katman ve gerekirse iç yüzeye vernik/epoksi önerilir.', null, null, 'IP-FDM-POROSITY');
    }
    add('info', `${seal.label}: ${seal.desc}. Seviye, IEC 60529 testiyle doğrulanmalıdır.`, null, null, 'IP-TEST');
  }

  return {
    ok: !checks.some((c) => c.level === 'error'),
    rulesId: rules.id,
    params: { ...p, pcbClearanceEff: clr, floor, lidT, rIn, rOut, fit, lipT },
    tolerance: { ...tol, fitSel, lidGap: fit, fitL },
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
      standoffs: standoffs.map((s) => ({
        x: s.x, y: s.y, od: s.od, holeD: s.holeD, depth: s.depth, z0: s.z0, z1: s.z1, countersink: s.countersink,
        integral: s.integral !== false, nutPocket: s.nutPocket || null, bottomCountersink: s.bottomCountersink || null,
      })),
      lidTubes: lidTubes.map((t) => ({ x: t.x, y: t.y, od: t.od, holeD: t.holeD, z0: t.z0, z1: t.z1, countersink: t.countersink || null, counterbore: t.counterbore || null })),
      cornerBosses,
      lidHoles,
      cutouts,
      groove: grooveGeom,
      panelHoles: panel.holes,
      panelSpots: panel.spots,
      ears: mount.ears,
      mountHoles: mount.floorHoles,
      din: mount.din,
      edgePads: edge.pads,
      edgePressers: edge.pressers,
    },
    panel: { items: panel.items, visuals: panel.visuals },
    mount: { type: mount.type, info: mount.info, footprint: mount.footprint, holes: mount.holes, din: !!mount.din },
    edgeHold: { active: edge.active, info: edge.info, pads: edge.pads.length, pressers: edge.pressers.length },
    enclosed,
    sealing: seal ? { id: seal.id, label: seal.label, cord_d: seal.cord_d, squeeze: seal.squeeze, groove, cordLength } : null,
    ports,
    lipBars,
    lipRemoved,
    mountHoles,
    standoffs,
    lidTubes,
    screws,
    bom,
    parts,
    screwSpec: spec,
    insertSpec: ispec,
    insertType: itype ? { id: itype.id, kind: itype.kind, code: itype.code, name: itype.name } : null,
    screwType: ttype ? { id: ttype.id, code: ttype.code, name: ttype.name, head: ttype.head } : null,
    screwMaterial: screwMat ? { id: screwMat.id, tag: screwMat.tag, label: screwMat.label } : null,
    washer: useWasher ? { id: useWasher.id, code: useWasher.code, material: washerMat ? washerMat.tag : null } : null,
    torque: { lid: tLid || null, pcb: tPcb || null, corner: tCorner || null },
    cornerInfo,
    cornerPlan: cplan ? { size: cplan.size, method: cplan.method, od: cplan.od, axis: cornerPad?.axis ?? null, extra: cornerPad?.extra ?? 0, spec: cplan.spec } : null,
    cornerBosses,
    fastenInfo,
    usedHoleMinD: usedHoles.length ? Math.min(...usedHoles.map((h) => h.d)) : null,
    fasteningMethod: method,
    lidMaterial: mixedLid ? { id: lr.id, label: lr.label, process: lr.process, density: lr.density_g_cm3, conductive: !!lr.conductive } : null,
    lidTolerance: mixedLid ? { ...lidTol, lidGap: fit, fitSel } : null,
    checks,
  };
}
