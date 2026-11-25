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
    case 'wall': return `kural: ${f(rules.recommended_wall_min)}–${f(rules.recommended_wall_max)} (en az ${f(rules.min_wall)})`;
    case 'pcbClearance': return `kural: ${f(rules.pcb_clearance_xy)}`;
    case 'topClearance': return `kural: ${f(rules.component_clearance_z)}`;
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
  if (options.fasteners && analysis.board && (analysis.holes || []).some((h) => h.mount)) {
    for (let i = 0; i < 4; i++) {
      const d = computeDesign(analysis, rules, params, options);
      const fixes = (d.checks || []).filter((c) => c.fix && c.fix.key === 'standoffHeight' && c.fix.value > params.standoffHeight + 1e-9);
      if (!fixes.length) break;
      params.standoffHeight = Math.max(...fixes.map((c) => c.fix.value));
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

/** PCB deliğinden geçebilecek en büyük metrik vida */
export function pickScrew(holeD, screws) {
  let best = null;
  for (const s of screws) if (s.min_pcb_hole <= holeD + 1e-6 && (!best || s.d > best.d)) best = s;
  return best;
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
  const add = (level, text, fix = null) => checks.push({ level, text, fix });
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

  // --- Duvarla çakışan bileşenler (port adayları, M3'te açıklık açılacak) ---
  const portMap = new Map();
  for (const o of obstacles) {
    const bx = o.box;
    if (bx.max[2] <= z0 || bx.min[2] >= cavTop) continue;
    const crossings = [];
    if (bx.min[0] < cav.min[0]) crossings.push('-X');
    if (bx.max[0] > cav.max[0]) crossings.push('+X');
    if (bx.min[1] < cav.min[1]) crossings.push('-Y');
    if (bx.max[1] > cav.max[1]) crossings.push('+Y');
    for (const side of crossings) {
      const key = o.name + '|' + side;
      if (!portMap.has(key)) portMap.set(key, { name: o.name, side, min: [...bx.min], max: [...bx.max] });
      const pm = portMap.get(key);
      for (let k = 0; k < 3; k++) { pm.min[k] = Math.min(pm.min[k], bx.min[k]); pm.max[k] = Math.max(pm.max[k], bx.max[k]); }
    }
  }
  const ports = [...portMap.values()].map((pm) => {
    const along = pm.side.endsWith('X') ? 1 : 0; // duvar düzlemindeki yatay eksen
    return { ...pm, width: pm.max[along] - pm.min[along], height: pm.max[2] - pm.min[2] };
  });

  // --- Bağlantı (M2): montaj deliklerinden standoff, kapak borusu ve vidalar ---
  const fasteners = options.fasteners;
  const lidMode = options.lidMode || 'screw';
  const method = rules.fastening || 'insert';
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

  if (fasteners) {
    for (const h of usedHoles) {
      const s = pickScrew(h.d, fasteners.screws);
      if (!s) { fastenChecks.push(['warn', `Ø${f(h.d)} delik ${at(h)} için tablodaki vidalardan hiçbiri uygun değil.`]); continue; }
      const featureD = method === 'insert' ? s.insert_hole : method === 'tapped' ? s.tap_drill : s.selftap_pilot;
      const required = method === 'insert' ? s.insert_length + 0.5 : rules.thread_engagement_d * s.d + 0.5;
      const minEngage = method === 'insert' ? 0.7 * s.insert_length : rules.thread_engagement_d * s.d;
      let od = Math.max(rules.boss_min_diameter, featureD + 2 * rules.boss_outer_wall);
      if (method === 'self_tap') od = Math.max(od, 2.2 * s.d);

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

      // Vida boyu: baş kapak (veya PCB) üstünde, uç standoff deliğinde
      const grip = tube ? zTop - b.bottom : b.thickness;
      const len = pickLength(fasteners.standard_lengths, grip, available, minEngage);
      const depth = Math.min(available, Math.max(required, (len.L ? len.L - grip : 0) + 0.5));
      if (!len.ok) {
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
      screws.push({ size: s.size, length: len.L, engagement: len.engagement, ok: len.ok, lid: !!tube, x: h.x, y: h.y, head_d: s.head_d, head_h: s.head_h, d: s.d, grip });
    }
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
    bom.push(`${g.count} × ${g.size}×${g.length ?? '?'} yıldız başlı vida (ISO 7045) — ${g.lid ? 'kapak + PCB' : 'PCB'}`);
  }
  if (standoffs.length && fasteners) {
    const s = fasteners.screws.find((x) => x.size === standoffs[0].screw);
    if (method === 'insert') bom.push(`${standoffs.length} × ${s.size} ısıyla gömülen insert (L ${f(s.insert_length)}; delik Ø${f(s.insert_hole)})`);
    if (method === 'tapped') bom.push(`${standoffs.length} × ${s.size} kılavuz (matkap Ø${f(s.tap_drill)})`);
    if (method === 'self_tap') bom.push(`Vidalar plastik için sac vidası tipinde seçilmeli (ön delik Ø${f(s.selftap_pilot)})`);
  }

  // --- DFM kontrolleri ---
  if (wall < rules.min_wall) {
    add('error', `Et kalınlığı ${f(wall)} mm, ${rules.label} için en az ${f(rules.min_wall)} mm olmalı.`);
  } else if (wall < rules.recommended_wall_min || wall > rules.recommended_wall_max) {
    add('warn', `Et kalınlığı ${f(wall)} mm, önerilen aralığın (${f(rules.recommended_wall_min)}–${f(rules.recommended_wall_max)} mm) dışında.`);
  } else {
    add('ok', `Et kalınlığı ${f(wall)} mm, önerilen aralıkta.`);
  }
  if (rIn < rules.corner_radius_min - 1e-6) {
    add(rules.process === 'cnc' ? 'error' : 'warn', `İç köşe radyüsü ${f(rIn)} mm, kural değerinin (${f(rules.corner_radius_min)} mm) altında.`);
  }

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

  for (const port of ports) {
    add('warn', `${port.name}: ${port.side} duvarından geçiyor (kesit ${f(port.width)} × ${f(port.height)} mm). Port açıklığı M3'te otomatik açılacak.`);
  }
  for (const r of lipRemoved) {
    add('info', `Kapak dili ${r.side} kenarında kaldırıldı: altında yüksek bileşen var${r.who ? ` (${r.who})` : ''}.`);
  }
  for (const s of lipShortened) {
    add('info', `Kapak dili ${s.side} kenarında ${f(s.depth)} mm'ye kısaltıldı${s.who ? ` (${s.who})` : ''}.`);
  }
  if (lipBars.length === 0) add('warn', 'Kapağı konumlayacak dil hiçbir kenara sığmadı; bileşen üstü boşluğu artırmayı dene.');

  // Bağlantı kontrolleri
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
      lidTubes: lidTubes.map((t) => ({ x: t.x, y: t.y, od: t.od, holeD: t.holeD, z0: t.z0, z1: t.z1 })),
    },
    ports,
    lipBars,
    lipRemoved,
    mountHoles,
    standoffs,
    lidTubes,
    screws,
    bom,
    fasteningMethod: method,
    checks,
  };
}
