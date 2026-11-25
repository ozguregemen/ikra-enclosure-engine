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

export function paramHint(key, rules, analysis) {
  switch (key) {
    case 'wall': return `kural: ${f(rules.recommended_wall_min)}–${f(rules.recommended_wall_max)} (en az ${f(rules.min_wall)})`;
    case 'pcbClearance': return `kural: ${f(rules.pcb_clearance_xy)}`;
    case 'topClearance': return `kural: ${f(rules.component_clearance_z)}`;
    case 'standoffHeight': {
      const below = analysis.maxBelow ? analysis.maxBelow.value : 0;
      return `alttan taşan ${f(below)} + ${f(rules.under_board_clearance)}; en az ${f(rules.min_standoff_height)}`;
    }
    case 'cornerRadius': return rules.process === 'cnc'
      ? `takım Ø${f(rules.process_params.tool_diameter)} → en az ${f(rules.process_params.tool_diameter / 2)}`
      : `kural: en az ${f(rules.corner_radius_min)}`;
    default: return '';
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

export function defaultParams(analysis, rules) {
  const below = analysis.maxBelow ? analysis.maxBelow.value : 0;
  return {
    wall: rules.default_wall,
    pcbClearance: rules.pcb_clearance_xy,
    topClearance: rules.component_clearance_z,
    standoffHeight: round2(Math.max(rules.min_standoff_height, below + rules.under_board_clearance)),
    cornerRadius: rules.corner_radius_min,
  };
}

function overlaps2D(box, rect, gap) {
  return box.max[0] > rect.min[0] - gap && box.min[0] < rect.max[0] + gap &&
    box.max[1] > rect.min[1] - gap && box.min[1] < rect.max[1] + gap;
}

export function computeDesign(analysis, rules, params) {
  const checks = [];
  const add = (level, text) => checks.push({ level, text });
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
  add('info', `PCB tutucuları (standoff) ve vidalar M2'de eklenecek; şimdilik PCB altında ${f(p.standoffHeight)} mm boşluk bırakıldı.`);

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
      lipBars: lipBars.map((l) => ({ min: l.min, max: l.max })),
    },
    ports,
    lipBars,
    lipRemoved,
    checks,
  };
}
