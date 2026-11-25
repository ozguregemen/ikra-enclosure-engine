/*
 * Panel elemanları (Toolbox › Panel elemanları · Paket D).
 * RF panel konnektörleri (D-delik), kablo rakorları, basınç dengeleme elemanı, ışık boruları, lastik ayaklar ve
 * veri sayfasından girilen özel delikler için yerleşim (otomatik ya da elle), çakışma ve kenar kontrolleri,
 * kalın duvarda yerel et inceltme (lamba), katı model delik tanımları, 3B görsel ve malzeme listesi.
 * computeDesign() içinden çağrılır; yalnızca sayı üretir.
 *
 * Konum: duvarda u = duvar boyunca kavite merkezinden (X ya da Y), v = gövde alt yüzünden yükseklik (Z);
 * kapakta u, v = kavite merkezinden X, Y. null = otomatik.
 */

import { pressHole, compHole } from './fits.js';

const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const f = (v) => nf.format(Math.round(v * 100) / 100);
const r1 = (v) => Math.round(v * 10) / 10;
const HEX_E = 2 / Math.sqrt(3); // altıgen: köşeden köşeye / anahtar ağzı
const GAP = 0.5; // mm: panel elemanı ile komşu geometri arası en az boşluk
const WALL_FACES = ['-Y', '+X', '+Y', '-X'];
const LED_RE = /(?:^|[^a-z])leds?(?:[^a-z]|$)|ws2812|sk6812|apa10[02]/i;
const PIGTAIL_LENGTHS = [50, 100, 150, 200, 300];

export const FACE_LABEL = { '-X': '−X duvarı', '+X': '+X duvarı', '-Y': '−Y duvarı', '+Y': '+Y duvarı', lid: 'kapak', bottom: 'taban', auto: 'LED üstü' };
export const isLedName = (name) => LED_RE.test(name || '');
export const holeText = (h) => (!h ? '' : h.shape === 'D' ? `D Ø${f(h.d)} × ${f(h.flat)}` : `Ø${f(h.d)}`);

/** Kütüphane tipi + seçim → ölçüler. spec: { size, custom: { d, flat, af, panelMax, inner, outer } } */
export function panelData(t, spec = {}) {
  if (!t) return null;
  const sizeKeys = t.sizes ? Object.keys(t.sizes) : [];
  const size = sizeKeys.length ? (t.sizes[spec.size] ? spec.size : (t.sizes[t.defaultSize] ? t.defaultSize : sizeKeys[0])) : null;
  const z = size ? t.sizes[size] : {};
  const c = t.kind === 'custom' ? { ...t.custom, ...(spec.custom || {}) } : null;
  const src = c || { ...t, ...z };
  let hole = null;
  if (c) hole = c.flat > 0 && c.flat < c.d - 0.05 ? { shape: 'D', d: c.d, flat: c.flat } : { shape: 'round', d: c.d };
  else if (typeof src.hole === 'number') hole = { shape: 'round', d: src.hole };
  else if (src.hole) hole = { ...src.hole };
  const af = src.af || null;
  const e = af ? af * HEX_E : hole ? hole.d + 3 : src.d || 0;
  return {
    type: t, id: t.id, kind: t.kind, code: t.code, name: t.name, short: t.short, note: t.note, size, hole, af, e,
    eo: Math.max(e, src.outerD || 0), panelMax: src.panelMax ?? null, inner: src.inner ?? 0, outer: src.outer ?? 0,
    clamp: src.clamp || null, d: src.d ?? null, h: src.h ?? null, faces: t.faces || ['wall'], custom: c,
  };
}

/** Kısa ad: "M16×1,5 kablo rakoru", "SMA panel"… */
export function panelTitle(pd) {
  if (!pd) return '';
  switch (pd.kind) {
    case 'gland': return `${pd.size}×1,5 kablo rakoru`;
    case 'lightpipe': return `${pd.size} ışık borusu`;
    case 'foot': return `${pd.size} lastik ayak`;
    case 'custom': return `Özel delik ${holeText(pd.hole)}`;
    default: return pd.code;
  }
}

const cylBox = (x, y, d, za, zb) => ({ min: [x - d / 2, y - d / 2, Math.min(za, zb)], max: [x + d / 2, y + d / 2, Math.max(za, zb)] });
const hit = (a, b, g = GAP) => a.min[0] < b.max[0] + g && a.max[0] > b.min[0] - g &&
  a.min[1] < b.max[1] + g && a.max[1] > b.min[1] - g && a.min[2] < b.max[2] + g && a.max[2] > b.min[2] - g;
const rectHit = (a, b, g = GAP) => a.a0 < b.a1 + g && a.a1 > b.a0 - g && a.z0 < b.z1 + g && a.z1 > b.z0 - g;
const names = (list) => [...new Set(list.map((s) => s.name))].slice(0, 2).join(', ');

/** lo..hi aralığında 0,5 mm'ye yuvarlı, en çok ~n adımlı değerler (pref değeri de eklenir) */
function steps(lo, hi, n, pref) {
  if (hi < lo - 1e-9) return [];
  const a = Math.ceil(lo * 2 - 1e-9) / 2;
  const b = Math.floor(hi * 2 + 1e-9) / 2;
  if (b < a) return [r1((lo + hi) / 2)];
  const st = Math.max(0.5, Math.round(((b - a) / n) * 2) / 2);
  const out = [];
  for (let v = a; v <= b + 1e-9; v += st) out.push(Math.round(v * 2) / 2);
  const pr = Math.round(Math.min(Math.max(pref, a), b) * 2) / 2;
  if (!out.includes(pr)) out.push(pr);
  return out;
}

/**
 * ctx: computeDesign ara sonuçları (kavite, z seviyeleri, dil, standoff, kapak delikleri, portlar, engeller...)
 * Dönüş: { items, holes, spots, visuals, bom, checks: [[level, text, fix, focus]] , hasRf }
 */
export function planPanel(ctx) {
  const {
    specs = [], types = [], analysis, rules, p, cav, center, wall, floorTop, cavTop, zTop, z0, lidT, rIn, rOut, outer, fit, lipT,
    lipBars = [], standoffs = [], lidTubes = [], cornerBosses = [], lidHoles = [], screws = [], ports = [], groove, seal,
    obstacles = [], boardObstacles = [], rfParts = [], boardTop, tol = null, lidTol = null,
  } = ctx;
  const out = { items: [], holes: [], spots: [], visuals: [], bom: [], parts: [], checks: [], hasRf: false };
  // Yapılandırılmış malzeme listesi satırı (design.js parts biçimi)
  const part = (pd, o, face, at, onLid) => ({
    qty: 1, kind: o.kind || 'panel', standard: o.code ?? pd.code, name: o.name || pd.name, size: o.size ?? pd.size ?? '', length: o.length ?? null,
    material: o.material || '', spec: o.spec || '', where: FACE_LABEL[face] || '', at, part: onLid ? 'lid' : 'base', type: pd.id,
  });
  const add = (level, text, fix = null, focus = null) => out.checks.push([level, text, fix, focus]);
  const partId = (name) => {
    const pt = analysis.parts.find((x) => x.name === name);
    return pt ? { partId: pt.id } : null;
  };

  // --- Engeller: bileşenler, PCB, kapak dili, standoff/boss/boru ---
  const solids = [];
  for (const o of obstacles) solids.push({ box: o.box, name: o.name, comp: true });
  for (const o of boardObstacles) solids.push({ box: o.box, name: 'PCB', board: true });
  for (const l of lipBars) solids.push({ box: { min: l.min, max: l.max }, name: 'kapak dili', lip: true });
  for (const s of standoffs) {
    const so = s.insert?.kind === 'standoff';
    solids.push({ box: cylBox(s.x, s.y, so ? s.insert.sw * HEX_E : s.od, s.z0, so ? s.insert.zTop : s.z1), name: 'standoff' });
  }
  for (const t of lidTubes) solids.push({ box: cylBox(t.x, t.y, t.od, t.z0, cavTop), name: 'kapak borusu' });
  for (const c of cornerBosses) {
    solids.push({
      box: { min: [Math.min(c.wall[0], c.x - c.od / 2), Math.min(c.wall[1], c.y - c.od / 2), c.z0], max: [Math.max(c.wall[0], c.x + c.od / 2), Math.max(c.wall[1], c.y + c.od / 2), c.z1] },
      name: 'köşe boss',
    });
  }
  for (const hh of lidHoles) if (hh.pad) solids.push({ box: cylBox(hh.x, hh.y, hh.pad.od, cavTop - hh.pad.h, cavTop), name: 'köşe vidası yastığı' });
  for (const s of screws) if (s.role === 'pcb') solids.push({ box: cylBox(s.x, s.y, s.head_d, boardTop, boardTop + s.head_h), name: 'vida başı' });

  // Kapak üstündeki dolu daireler (vida başları); ışık boruları ve kapak elemanları eklendikçe büyür
  const lidDiscs = screws.filter((s) => s.lid).map((s) => ({ x: s.x, y: s.y, r: Math.max(s.head_d, s.counterbore?.d || 0) / 2, name: 'kapak vidası' }));

  const frames = {};
  for (const face of WALL_FACES) {
    const axis = face[1] === 'X' ? 0 : 1;
    const dir = face[0] === '+' ? 1 : -1;
    const along = 1 - axis;
    const inner = dir > 0 ? cav.max[axis] : cav.min[axis];
    const lip = lipBars.find((l) => l.side === face);
    frames[face] = { face, axis, dir, along, inner, outerPlane: inner + dir * wall, aMin: cav.min[along], aMax: cav.max[along], aC: center[along], lipDepth: lip ? lip.depth : 0 };
  }
  const portRects = (face) => ports.filter((pt) => pt.enabled && pt.side === face)
    .map((pt) => ({ a0: pt.a0, a1: pt.a1, z0: pt.zLo, z1: Math.min(pt.zHi, cavTop), name: `${pt.name} açıklığı` }));

  // --- Ayaklar önce: yükseklikleri dıştaki gövdelerin taban altına inmesine izin verir ---
  const resolved = specs.map((sp) => ({ sp, t: types.find((x) => x.id === sp.type) })).filter((x) => x.t);
  const feet = resolved.filter((x) => x.t.kind === 'foot');
  let footH = 0;
  // Tabandan çıkan vida başı / somun
  const bottomBumps = [];
  for (const s of standoffs) {
    const ins = s.insert;
    if (ins?.kind !== 'standoff' || s.bottomCountersink) continue;
    const sc = screws.find((q) => Math.abs(q.x - s.x) < 1e-6 && Math.abs(q.y - s.y) < 1e-6);
    const h = ins.bottom?.kind === 'screw' ? sc?.head_h ?? 0 : ins.bottom?.kind === 'nut' ? (ins.bottom.m || 0) + 1 : 0;
    const dd = ins.bottom?.kind === 'screw' ? sc?.head_d ?? 4 : (ins.bottom?.e || 6);
    if (h > 0) bottomBumps.push({ x: s.x, y: s.y, h, r: dd / 2, what: ins.bottom.kind === 'screw' ? 'vida başı' : 'somun' });
  }
  const bottomOpen = standoffs.filter((s) => s.nutPocket?.shape === 'hex' || s.bottomCountersink).map((s) => ({ x: s.x, y: s.y, r: (s.nutPocket?.s || s.bottomCountersink?.dTop || 4) / 2 + 0.5 }));
  const bump = bottomBumps.reduce((m, b) => Math.max(m, b.h), 0);
  out.bottomBump = bump;

  for (const { sp, t } of feet) {
    const pd = panelData(t, sp);
    const inset = Math.max(pd.d / 2 + 2, rOut - (rOut - pd.d / 2 - 1) / Math.SQRT2);
    const hx = outer.L / 2 - inset;
    const hy = outer.W / 2 - inset;
    const pos = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({ x: center[0] + sx * hx, y: center[1] + sy * hy }));
    const issues = [];
    if (bump > pd.h - 0.5 + 1e-9) {
      issues.push({ level: 'error', text: `tabandan ${f(bump)} mm ${bottomBumps[0].what} çıkıyor; ${f(pd.h)} mm ayak kutuyu yerden kaldırmaz (en az ${f(bump + 0.5)} mm gerekir)` });
    }
    for (const q of pos) {
      for (const b of [...bottomBumps, ...bottomOpen]) {
        if (Math.hypot(q.x - b.x, q.y - b.y) < pd.d / 2 + b.r + 0.5) { issues.push({ level: 'warn', text: 'ayak tabandaki bir vida/somun deliğinin üstüne geliyor' }); break; }
      }
      if (issues.some((x) => x.level === 'warn')) break;
    }
    if (hx < pd.d / 2 + 1 || hy < pd.d / 2 + 1) issues.push({ level: 'error', text: 'taban dört ayak için çok küçük' });
    footH = Math.max(footH, pd.h);
    const item = baseItem(sp, pd, 'bottom', issues);
    item.positions = pos;
    out.items.push(item);
    for (const q of pos) out.visuals.push({ kind: 'foot', part: 'base', anchor: [q.x, q.y, z0], dir: [0, 0, -1], d: pd.d, h: pd.h });
    out.bom.push(`4 × ${pd.size} mm yapışkanlı lastik ayak — taban köşeleri (köşeden ${f(inset)} mm)`);
    out.parts.push({ ...part(pd, { name: 'Yapışkanlı lastik ayak', spec: `köşeden ${f(inset)} mm`, material: 'kauçuk' }, 'bottom', [pos[0].x, pos[0].y, z0 - pd.h / 2], false), qty: 4 });
  }
  if (bump > 0 && !feet.length) {
    add('warn', `Tabandan ${f(bump)} mm ${bottomBumps[0].what} çıkıyor: kutu düz oturmaz. Gömme baş (havşa) seçin ya da en az ${f(bump + 0.5)} mm lastik ayak ekleyin.`,
      { key: 'panelAdd', value: 'bumper', label: 'Lastik ayak ekle' });
  }

  // --- Işık boruları: LED üstüne kapakta delik ---
  const leds = analysis.parts.filter((pt) => !pt.isBoard && isLedName(pt.name) && pt.box && pt.box.min[2] >= boardTop - 0.5);
  for (const { sp, t } of resolved.filter((x) => x.t.kind === 'lightpipe')) {
    const pd0 = panelData(t, sp);
    // Işık borusu kapağa sıkı geçer: çubuk Ø + malzemenin sıkı geçme boşluğu + FDM delik telafisi
    const ltol = lidTol || tol;
    const pd = ltol ? { ...pd0, hole: { shape: 'round', d: pressHole(pd0.d, ltol) } } : pd0;
    const issues = [];
    const pos = [];
    if (!leds.length) issues.push({ level: 'warn', text: 'kartta adında "LED" geçen bileşen bulunamadı; delik açılmadı' });
    for (const led of leds) {
      const x = (led.box.min[0] + led.box.max[0]) / 2;
      const y = (led.box.min[1] + led.box.max[1]) / 2;
      const top = led.box.max[2];
      const L = r1(zTop - top - 0.3);
      const rh = pd.hole.d / 2;
      // Kart kenarındaki LED: boru duvar üstüne biner → delik açılmaz (yan ışık borusu gerekir)
      if (x - rh < cav.min[0] + 0.2 || x + rh > cav.max[0] - 0.2 || y - rh < cav.min[1] + 0.2 || y + rh > cav.max[1] - 0.2) {
        issues.push({ level: 'warn', text: `${led.name} duvara çok yakın: Ø${f(pd.hole.d)} boru duvarın üstüne biner, delik açılmadı (duvarda yan ışık borusu ya da daha ince boru gerekir)`, focus: { partId: led.id } });
        continue;
      }
      if (lipBars.some((l) => x + rh > l.min[0] && x - rh < l.max[0] && y + rh > l.min[1] && y - rh < l.max[1])) {
        issues.push({ level: 'info', text: `${led.name} üstündeki boru kapak dilinin içinden geçer; dil o noktada delinir`, focus: { partId: led.id } });
      }
      const col = cylBox(x, y, pd.hole.d, top + 0.3, cavTop);
      const hits = solids.filter((s) => !s.lip && !s.board && s.name !== led.name && hit(col, s.box, 0.2) && s.box.max[2] > top + 0.3);
      if (hits.length) issues.push({ level: 'error', text: `${led.name} üstündeki boru yolu ${names(hits)} ile kesişiyor`, focus: { partId: led.id } });
      const disc = lidDiscs.find((q) => Math.hypot(q.x - x, q.y - y) < q.r + pd.hole.d / 2 + GAP);
      if (disc) issues.push({ level: 'error', text: `${led.name} üstündeki delik ${disc.name} ile çakışıyor`, focus: { partId: led.id } });
      if (L / pd.d > 10) issues.push({ level: 'info', text: `${led.name}: boru ${f(L)} mm, çapın ${f(L / pd.d)} katı; ışık kaybı artar (Ø5 ya da LED'e yakın kapak önerilir)` });
      pos.push({ x, y, top, L, led: led.name, partId: led.id });
      lidDiscs.push({ x, y, r: pd.hole.d / 2, name: `${led.name} ışık borusu` });
      out.holes.push({ part: 'lid', axis: 2, p: [x, y, top + 0.2], len: zTop + 0.5 - (top + 0.2), r: pd.hole.d / 2, flat: null });
      out.visuals.push({ kind: 'lightpipe', part: 'lid', anchor: [x, y, zTop], dir: [0, 0, 1], d: pd.d, L });
    }
    const item = baseItem(sp, pd, 'lid', issues);
    item.positions = pos;
    out.items.push(item);
    if (pos.length) {
      const Ls = [...new Set(pos.map((q) => q.L))];
      out.bom.push(`${pos.length} × ${pd.size} ışık borusu (akrilik/PC çubuk), L ${Ls.map((v) => f(v)).join(' / ')} mm — ${pos.map((q) => q.led).slice(0, 3).join(', ')}${pos.length > 3 ? '…' : ''} üstü; kapak deliği Ø${f(pd.hole.d)}`);
      for (const Lx of Ls) {
        const at = pos.find((q) => q.L === Lx);
        out.parts.push({ ...part(pd, { name: 'Işık borusu (akrilik/PC çubuk)', length: Lx, material: 'PMMA/PC', spec: `kapak deliği Ø${f(pd.hole.d)}` }, 'lid', [at.x, at.y, zTop - Lx / 2], true), qty: pos.filter((q) => q.L === Lx).length, where: 'LED üstü' });
      }
    }
  }

  // --- Duvar ve kapak elemanları: önce elle konumlananlar, sonra otomatikler ---
  const placed = []; // { face, a0, a1, z0, z1 (duvar) | x, y, r (kapak), name, box (iç hacim) }
  const panelItems = resolved.filter((x) => !['foot', 'lightpipe'].includes(x.t.kind))
    .map((x, i) => ({ ...x, i, auto: x.sp.face == null || x.sp.u == null || x.sp.v == null }));
  panelItems.sort((a, b) => (a.auto === b.auto ? a.i - b.i : a.auto ? 1 : -1));

  const spotFor = (pd, onLid) => {
    const t = onLid ? lidT : wall;
    if (!pd.panelMax || t <= pd.panelMax + 1e-6) return null;
    const side = !onLid && rules.process === 'cnc' ? 'outer' : 'inner';
    return { side, depth: r1(t - pd.panelMax), d: r1(side === 'inner' ? pd.e + 1 : pd.e + 3) };
  };
  const envelope = (pd, spot) => Math.max(pd.e, spot && spot.side === 'inner' ? spot.d : 0);

  function innerBox(fr, a, z, E, depth) {
    const min = [0, 0, z - E / 2];
    const max = [0, 0, z + E / 2];
    min[fr.along] = a - E / 2; max[fr.along] = a + E / 2;
    const n1 = fr.inner - fr.dir * depth;
    min[fr.axis] = Math.min(fr.inner, n1); max[fr.axis] = Math.max(fr.inner, n1);
    return { min, max };
  }

  function wallIssues(pd, fr, a, z, E, spot) {
    const iss = [];
    const m = rIn + (pd.kind === 'gland' ? 2 : GAP); // rakorda kontra somun için anahtar payı
    if (a - E / 2 < fr.aMin + m - 1e-6 || a + E / 2 > fr.aMax - m + 1e-6) iss.push({ code: 'corner', level: 'error', text: 'yan duvara / köşeye çok yakın' });
    if (z - E / 2 < floorTop + GAP - 1e-6) iss.push({ code: 'floor', level: 'error', text: 'tabana çok yakın: içteki somun/gövde tabana oturur' });
    if (z + E / 2 > cavTop - GAP + 1e-6) iss.push({ code: 'top', level: 'error', text: 'duvarın üst kenarına (kapağa) çok yakın' });
    const r = Math.max(pd.hole.d / 2, spot ? spot.d / 2 : 0);
    if (groove && z + r > cavTop - groove.depth - (seal?.land ?? 1) + 1e-6) iss.push({ code: 'groove', level: 'error', text: `${spot ? 'delik/lamba' : 'delik'} duvar üstündeki conta kanalına çok yakın` });
    if (spot?.side === 'outer' && z + spot.d / 2 > cavTop - GAP + 1e-6) iss.push({ code: 'spot', level: 'error', text: 'dış lamba duvarın üst kenarına taşıyor' });
    if (z - pd.eo / 2 < z0 - footH - 1e-6) iss.push({ code: 'below', level: 'warn', text: 'dıştaki gövde/somun kutunun alt yüzeyinin altına iniyor (kutu düz oturmaz)' });
    if (spot?.side === 'outer' && z - spot.d / 2 < z0 + 0.5) iss.push({ code: 'spot', level: 'error', text: 'dış lamba tabana taşıyor' });
    const box = innerBox(fr, a, z, E, pd.inner);
    const hs = solids.filter((s) => hit(box, s.box));
    if (hs.length) iss.push({ code: 'hit', level: 'error', text: `içteki gövde ve kablo payı ${names(hs)} ile çakışıyor`, who: hs });
    const rect = { a0: a - Math.max(E, pd.eo) / 2, a1: a + Math.max(E, pd.eo) / 2, z0: z - Math.max(E, pd.eo) / 2, z1: z + Math.max(E, pd.eo) / 2 };
    for (const q of [...portRects(fr.face), ...placed.filter((x) => x.face === fr.face)]) {
      if (rectHit(rect, q)) { iss.push({ code: 'overlap', level: 'error', text: `${q.name} ile çakışıyor` }); break; }
    }
    for (const q of placed.filter((x) => x.box && x.face !== fr.face)) {
      if (hit(box, q.box, 0.2)) { iss.push({ code: 'overlap', level: 'error', text: `${q.name} ile içeride çakışıyor` }); break; }
    }
    return iss;
  }

  function lidIssues(pd, x, y, E) {
    const iss = [];
    const m = fit + lipT + GAP;
    if (x - E / 2 < cav.min[0] + m - 1e-6 || x + E / 2 > cav.max[0] - m + 1e-6 || y - E / 2 < cav.min[1] + m - 1e-6 || y + E / 2 > cav.max[1] - m + 1e-6) {
      iss.push({ code: 'edge', level: 'error', text: 'kapak kenarına (konumlandırma diline) çok yakın' });
    }
    const box = { min: [x - E / 2, y - E / 2, cavTop - pd.inner], max: [x + E / 2, y + E / 2, cavTop] };
    const hs = solids.filter((s) => hit(box, s.box));
    if (hs.length) iss.push({ code: 'hit', level: 'error', text: `içteki gövde ${names(hs)} ile çakışıyor`, who: hs });
    for (const q of lidDiscs) {
      if (Math.hypot(q.x - x, q.y - y) < q.r + pd.eo / 2 + GAP) { iss.push({ code: 'overlap', level: 'error', text: `${q.name} ile çakışıyor` }); break; }
    }
    for (const q of placed.filter((z) => z.face === 'lid')) {
      if (Math.hypot(q.x - x, q.y - y) < q.r + pd.eo / 2 + GAP) { iss.push({ code: 'overlap', level: 'error', text: `${q.name} ile çakışıyor` }); break; }
    }
    for (const q of placed.filter((z) => z.box && z.face !== 'lid')) {
      if (hit(box, q.box, 0.2)) { iss.push({ code: 'overlap', level: 'error', text: `${q.name} ile içeride çakışıyor` }); break; }
    }
    return iss;
  }

  const target = rfParts.length ? rfParts.map((pt) => pt.box).find(Boolean) : null;
  const targetC = target ? [0, 1, 2].map((k) => (target.min[k] + target.max[k]) / 2) : null;
  const faceLoad = (face) => portRects(face).length + placed.filter((x) => x.face === face).length;

  /** Otomatik yerleşim: geçerli konumlar arasında en iyi puanlı (RF: u.FL'ye en yakın; diğerleri: boş duvarın ortası) */
  function search(pd, sp) {
    const allowed = pd.faces.flatMap((fc) => (fc === 'wall' ? WALL_FACES : fc === 'lid' ? ['lid'] : []));
    const faces = sp.face && sp.face !== 'auto' ? [sp.face] : allowed.filter((fc) => fc !== 'lid');
    let best = null;
    for (const face of faces) {
      if (face === 'lid') {
        const spot = spotFor(pd, true);
        const E = envelope(pd, spot);
        const m = fit + lipT + GAP + E / 2;
        const us = sp.u != null ? [sp.u] : steps(cav.min[0] + m - center[0], cav.max[0] - m - center[0], 30, 0);
        const vs = sp.v != null ? [sp.v] : steps(cav.min[1] + m - center[1], cav.max[1] - m - center[1], 30, 0);
        for (const u of us) for (const v of vs) {
          if (lidIssues(pd, center[0] + u, center[1] + v, E).some((x) => x.level === 'error')) continue;
          const sc = Math.hypot(u, v);
          if (!best || sc < best.score) best = { face, u, v, score: sc };
        }
        continue;
      }
      const fr = frames[face];
      const spot = spotFor(pd, false);
      const E = envelope(pd, spot);
      const mA = rIn + (pd.kind === 'gland' ? 2 : GAP) + E / 2;
      const zLo = floorTop + GAP + E / 2 - z0;
      const zHi = cavTop - GAP - E / 2 - z0;
      const zPref = pd.kind === 'gland' || pd.kind === 'vent' ? zLo + (zHi - zLo) * 0.3 : (zLo + zHi) / 2;
      const us = sp.u != null ? [sp.u] : steps(fr.aMin + mA - fr.aC, fr.aMax - mA - fr.aC, 40, 0);
      const vs = sp.v != null ? [sp.v] : steps(zLo, zHi, 30, zPref);
      const load = faceLoad(face);
      for (const u of us) for (const v of vs) {
        const iss = wallIssues(pd, fr, fr.aC + u, z0 + v, E, spot);
        if (iss.some((x) => x.level === 'error' || x.code === 'below')) continue;
        let sc;
        if (pd.kind === 'rf' && targetC) {
          const pt = [0, 0, z0 + v];
          pt[fr.axis] = fr.inner; pt[fr.along] = fr.aC + u;
          sc = Math.hypot(pt[0] - targetC[0], pt[1] - targetC[1], pt[2] - targetC[2]) + load * 3;
        } else {
          sc = load * 30 + Math.abs(u) * 0.4 + Math.abs(v - zPref) * 0.6;
        }
        if (!best || sc < best.score) best = { face, u, v, score: sc };
      }
    }
    if (!best && !sp.face && allowed.includes('lid')) return search(pd, { ...sp, face: 'lid' });
    return best;
  }

  /** Hiçbir duvara sığmıyorsa: üst boşluk ne kadar artarsa sığar (bileşenlerin üstüne) */
  function heightNeed(pd, faces) {
    const spot = spotFor(pd, false);
    const E = envelope(pd, spot);
    let need = Infinity;
    for (const face of faces) {
      const fr = frames[face];
      const mA = rIn + (pd.kind === 'gland' ? 2 : GAP) + E / 2;
      for (const u of steps(fr.aMin + mA - fr.aC, fr.aMax - mA - fr.aC, 40, 0)) {
        const a = fr.aC + u;
        const col = innerBox(fr, a, 0, E, pd.inner);
        col.min[2] = -1e9; col.max[2] = 1e9;
        let zHigh = floorTop;
        for (const s of solids) if (!s.lip && hit(col, s.box)) zHigh = Math.max(zHigh, s.box.max[2]);
        const zc = zHigh + GAP + E / 2;
        let top = zc + E / 2 + GAP + (fr.lipDepth > 0 ? fr.lipDepth + GAP : 0);
        if (groove) top = Math.max(top, zc + Math.max(pd.hole.d / 2, spot ? spot.d / 2 : 0) + groove.depth + (seal?.land ?? 1));
        need = Math.min(need, top - cavTop);
      }
    }
    return need;
  }

  for (const it of panelItems) {
    const { sp, t } = it;
    const pd0 = panelData(t, sp);
    if (!pd0.hole) continue;
    // Üretici kesim ölçüsü + FDM delik telafisi (dikey ve yatay delikler küçük çıkar)
    const cmp = (v) => (tol ? compHole(v, tol) : v);
    const pd = { ...pd0, hole: { ...pd0.hole, d: cmp(pd0.hole.d), ...(pd0.hole.flat ? { flat: cmp(pd0.hole.flat) } : {}) } };
    let face = sp.face && sp.face !== 'auto' ? sp.face : null;
    let u = sp.u ?? null;
    let v = sp.v ?? null;
    let autoFail = false;
    let best = null;
    if (it.auto) {
      best = search(pd, { face, u, v });
      if (best) { face = best.face; u = best.u; v = best.v; } else autoFail = true;
    }
    // Sığmadıysa varsayılan: izinli ilk duvarın ortası
    if (!face) face = pd.faces.includes('wall') ? '-Y' : 'lid';
    const onLid = face === 'lid';
    const spot = spotFor(pd, onLid);
    const E = envelope(pd, spot);
    if (u == null) u = 0;
    if (v == null) v = onLid ? 0 : r1((floorTop + cavTop) / 2 - z0);
    let issues;
    let x, y, z;
    if (onLid) {
      x = center[0] + u; y = center[1] + v; z = zTop;
      issues = lidIssues(pd, x, y, E);
    } else {
      const fr = frames[face];
      const a = fr.aC + u;
      z = z0 + v;
      const c3 = [0, 0, z];
      c3[fr.axis] = fr.outerPlane; c3[fr.along] = a;
      [x, y] = c3;
      issues = wallIssues(pd, fr, a, z, E, spot);
    }
    const item = baseItem(sp, pd, face, issues);
    Object.assign(item, { u, v, uAuto: sp.u == null || sp.face == null, vAuto: sp.v == null || sp.face == null, faceAuto: !sp.face, x, y, z, spot, E, autoFail });
    if (!onLid) item.uAxis = frames[face].along === 0 ? 'X' : 'Y';
    // Elle konumda hata varsa: otomatik konum öner
    if (!it.auto && issues.some((q) => q.level === 'error')) {
      const same = search(pd, { face: sp.face });
      const alt = same || search(pd, {});
      if (alt) item.fix = { key: 'panelAuto', value: `${sp.uid}:${same ? 'uv' : 'all'}`, label: same ? 'bu duvarda otomatik konuma al' : 'otomatik konuma al' };
    }
    if (autoFail && !onLid) {
      const need = heightNeed(pd, sp.face ? [sp.face] : pd.faces.includes('wall') ? WALL_FACES : []);
      if (Number.isFinite(need) && need > 0 && need < 60) {
        const tc = Math.ceil((p.topClearance + need) * 10) / 10;
        item.fix = { key: 'topClearance', value: tc, label: `üst boşluğu ${f(tc)} mm yap` };
      }
    }
    // Duvara izinli parça yükseklik yetmediği için kapağa konduysa: duvara almak için gereken üst boşluk
    if (onLid && !sp.face && !autoFail && pd.faces.includes('wall')) {
      const need = heightNeed(pd, WALL_FACES);
      if (Number.isFinite(need) && need > 0 && need < 60) item.wallNeed = Math.ceil((p.topClearance + need) * 10) / 10;
    }
    out.items.push(item);

    // Bu elemanın kapladığı yer (sonrakiler için)
    const nm = panelTitle(pd);
    if (onLid) {
      placed.push({ face: 'lid', x, y, r: pd.eo / 2, name: nm, box: { min: [x - E / 2, y - E / 2, cavTop - pd.inner], max: [x + E / 2, y + E / 2, cavTop] } });
    } else {
      const fr = frames[face];
      const a = fr.aC + u;
      const W = Math.max(E, pd.eo);
      placed.push({ face, a0: a - W / 2, a1: a + W / 2, z0: z - W / 2, z1: z + W / 2, name: nm, box: innerBox(fr, a, z, E, pd.inner) });
    }

    // Katı model: delik (+ D düzlüğü) ve lamba
    const r = pd.hole.d / 2;
    if (onLid) {
      // Kapak ayrı malzemedeyse delik telafisi kapak malzemesinden
      const lh = lidTol && lidTol !== tol ? { d: compHole(pd0.hole.d, lidTol), flat: pd0.hole.flat ? compHole(pd0.hole.flat, lidTol) : null } : pd.hole;
      const lrr = lh.d / 2;
      out.holes.push({ part: 'lid', axis: 2, p: [x, y, cavTop - 1], len: lidT + 2, r: lrr, flat: pd.hole.shape === 'D' ? { axis: 1, at: y - lrr + lh.flat } : null });
      if (spot) out.spots.push({ part: 'lid', axis: 2, p: [x, y, cavTop - 0.5], len: spot.depth + 0.5, r: spot.d / 2 });
    } else {
      const fr = frames[face];
      const a = fr.aC + u;
      const pt = [0, 0, z];
      pt[fr.along] = a;
      pt[fr.axis] = Math.min(fr.inner, fr.outerPlane) - 1;
      out.holes.push({ part: 'base', axis: fr.axis, p: pt, len: wall + 2, r, flat: pd.hole.shape === 'D' ? { axis: 2, at: z - r + pd.hole.flat } : null });
      if (spot) {
        const sp0 = spot.side === 'inner' ? fr.inner : fr.outerPlane;
        const n0 = spot.side === 'inner' ? sp0 - fr.dir * 0.5 : sp0 + fr.dir * 0.5;
        const n1 = spot.side === 'inner' ? sp0 + fr.dir * spot.depth : sp0 - fr.dir * spot.depth;
        const q = [...pt];
        q[fr.axis] = Math.min(n0, n1);
        out.spots.push({ part: 'base', axis: fr.axis, p: q, len: Math.abs(n1 - n0), r: spot.d / 2 });
      }
    }

    // 3B görsel: dış yüz noktası, dışa bakan yön, panel kalınlığı
    const panelT = spot ? pd.panelMax : onLid ? lidT : wall;
    if (onLid) {
      out.visuals.push({ kind: pd.kind, id: pd.id, part: 'lid', anchor: [x, y, zTop - (spot?.side === 'outer' ? spot.depth : 0)], dir: [0, 0, 1], t: panelT, pd: visualDims(pd) });
    } else {
      const fr = frames[face];
      const dv = [0, 0, 0]; dv[fr.axis] = fr.dir;
      const an = [x, y, z];
      if (spot?.side === 'outer') an[fr.axis] -= fr.dir * spot.depth;
      out.visuals.push({ kind: pd.kind, id: pd.id, part: 'base', anchor: an, dir: dv, t: panelT, pd: visualDims(pd) });
    }

    // Malzeme listesi
    const where = `${FACE_LABEL[face]}, delik ${holeText(pd.hole)}${spot ? `, ${spot.side === 'inner' ? 'içten' : 'dıştan'} lamba Ø${f(spot.d)} × ${f(spot.depth)}` : ''}`;
    if (pd.kind === 'rf') {
      out.hasRf = true;
      let pig = '';
      if (targetC) {
        const dist = Math.hypot(x - targetC[0], y - targetC[1], z - targetC[2]) + 25;
        const Lp = PIGTAIL_LENGTHS.find((Lx) => Lx >= dist) || PIGTAIL_LENGTHS[PIGTAIL_LENGTHS.length - 1];
        item.pigtail = Lp;
        pig = `; u.FL (IPEX) – ${pd.code.replace(' panel', '')} pigtail kablo Ø1,13 mm, ${Lp} mm`;
      }
      out.bom.push(`1 × ${pd.name.replace(/\s*\(.*\)$/, '')}, somun + tırtıllı pul ile — ${where}${pig}`);
      out.parts.push(part(pd, { name: pd.name.replace(/\s*\(.*\)$/, ''), spec: `delik ${holeText(pd.hole)}, somun SW ${f(pd.af)}` }, face, [x, y, z], onLid));
      if (item.pigtail) out.parts.push(part(pd, { kind: 'cable', code: '', name: `u.FL (IPEX) – ${pd.code.replace(' panel', '')} pigtail kablo`, size: 'Ø1,13', length: item.pigtail, spec: 'koaksiyel' }, face, null, onLid));
    } else if (pd.kind === 'gland') {
      out.bom.push(`1 × ${pd.size}×1,5 kablo rakoru (kablo Ø${f(pd.clamp[0])}–${f(pd.clamp[1])} mm, IP68) + ${pd.size}×1,5 kontra somun — ${where}`);
      out.parts.push(part(pd, { name: 'Kablo rakoru, plastik, kontra somunlu', size: `${pd.size}×1,5`, spec: `kablo Ø${f(pd.clamp[0])}–${f(pd.clamp[1])}, IP68` }, face, [x, y, z], onLid));
    } else if (pd.kind === 'vent') {
      out.bom.push(`1 × M12×1,5 basınç dengeleme elemanı (membranlı) + kontra somun — ${where}`);
      out.parts.push(part(pd, { name: 'Basınç dengeleme elemanı, membranlı', size: 'M12×1,5', spec: 'kontra somunlu' }, face, [x, y, z], onLid));
    } else {
      out.bom.push(`1 × özel panel elemanı (${holeText(pd.hole)}${pd.af ? `, somun SW ${f(pd.af)}` : ''}) — ${where}`);
      out.parts.push(part(pd, { name: 'Özel panel elemanı', size: holeText(pd.hole), spec: pd.af ? `somun SW ${f(pd.af)}` : '' }, face, [x, y, z], onLid));
    }
  }

  // --- Kontroller ---
  const label = (it) => `${it.title} (${FACE_LABEL[it.face]})`;
  for (const it of out.items) {
    const errs = it.issues.filter((q) => q.level === 'error');
    const focusOf = (q) => q.focus || (q.who ? q.who.filter((s) => s.comp).map((s) => partId(s.name)).find(Boolean) : null) || null;
    if (it.autoFail) {
      // Otomatik yerleşim başarısız: tek satır (neden + düzeltme önerisi)
      const why = errs[0] ? ` Gösterilen konumda ${errs[0].text}.` : '';
      const where = it.faceAuto ? `hiçbir ${it.pd.faces.includes('lid') ? 'duvara ya da kapağa' : 'duvara'}` : `${FACE_LABEL[it.face]} üzerinde ${it.uAuto && it.vAuto ? 'hiçbir yere' : 'verilen hizada'}`;
      add('error', `${label(it)}: ${where} çakışmasız sığmadı.${why}`, it.fix || null, errs[0] ? focusOf(errs[0]) : null);
      for (const q of it.issues.filter((x) => x.level !== 'error')) add(q.level, `${label(it)}: ${q.text}.`, null, focusOf(q));
    } else {
      let fixUsed = false;
      for (const q of it.issues) {
        const fx = q.level === 'error' && it.fix && !fixUsed ? it.fix : null;
        if (fx) fixUsed = true;
        add(q.level, `${label(it)}: ${q.text}.`, fx, focusOf(q));
      }
    }
    if (!errs.length && !it.autoFail && it.kind !== 'foot' && it.kind !== 'lightpipe') {
      const pos = it.face === 'lid' ? `X ${f(it.u)} / Y ${f(it.v)}` : `${it.uAxis} ${f(it.u)} / Z ${f(it.v)}`;
      add('ok', `${label(it)}: ${holeText(it.pd.hole)} delik, merkez ${pos} mm${it.uAuto || it.vAuto ? ' (otomatik)' : ''}${it.pd.inner ? `; içeride ${f(it.pd.inner)} mm boşluk var` : ''}.`);
    }
    if (it.kind === 'lightpipe' && !errs.length && it.positions.length) {
      add('ok', `${it.positions.length} LED üstüne kapakta Ø${f(it.pd.hole.d)} delik; boru boyu ${[...new Set(it.positions.map((q) => f(q.L)))].join(' / ')} mm.`);
    }
    if (it.kind === 'foot' && !errs.length) add('ok', `4 × ${it.size} lastik ayak taban köşelerinde${bump > 0 ? `; tabandan çıkan ${f(bump)} mm ${bottomBumps[0].what} yere değmez` : ''}.`);
    if (it.spot) {
      const t0 = it.face === 'lid' ? lidT : wall;
      add('info', `${label(it)}: et ${f(t0)} mm, parça en fazla ${f(it.pd.panelMax)} mm panele oturur; ${it.spot.side === 'inner' ? 'içten' : 'dıştan'} Ø${f(it.spot.d)} × ${f(it.spot.depth)} mm lamba ile yerel inceltildi.`);
      if (it.face !== 'lid' && rules.process === 'injection') add('warn', `${label(it)}: yan duvardaki lamba ve delik kalıpta yan maça ister.`);
      if (it.face !== 'lid' && rules.process === 'cnc') add('info', `${label(it)}: lamba dış yüzde (iç yüzdeki lamba 3 eksende işlenemez); somun lamba içinde kalır, lokma anahtar gerekir.`);
    }
    if (it.wallNeed) {
      // Sayısal anahtar kullanılmaz: varsayılan parametreler bunu kendiliğinden uygulamasın (kullanıcı kararı)
      add('info', `${label(it)}: duvar yüksekliği yetmediği için kapağa kondu. Duvara almak için bileşen üstü boşluk ${f(it.wallNeed)} mm olmalı.`,
        { key: 'setParam', value: `topClearance:${it.wallNeed}`, label: `${f(it.wallNeed)} mm yap` });
    }
    if (it.kind === 'rf' && it.pigtail) add('info', `${label(it)}: karttaki RF bileşenine yaklaşık ${it.pigtail} mm u.FL pigtail kablo yeter.`);
    if (it.kind === 'vent' && it.face === 'lid') add('info', `${label(it)}: membran yukarı bakıyor; yağmur ve su birikintisi alan yerde duvara (yana) alın.`);
    if (it.kind === 'gland') add('info', `${label(it)}: kablo dış çapı Ø${f(it.pd.clamp[0])}–${f(it.pd.clamp[1])} mm olmalı; kontra somun içten ${f(it.pd.af)} mm anahtarla sıkılır.`);
    if (it.face !== 'lid' && it.face !== 'bottom' && it.kind !== 'foot' && rules.process === 'fdm' && it.pd.hole && it.pd.hole.d >= 8 && it.pd.hole.shape !== 'D') {
      add('info', `${label(it)}: yan duvardaki Ø${f(it.pd.hole.d)} deliğin üst yarısı baskıda köprü yapar ve hafif sarkar; baskıdan sonra matkap/rayba ile ölçüye getirin.`);
    }
  }
  const wallParts = out.items.filter((it) => it.face && WALL_FACES.includes(it.face));
  if (wallParts.length && rules.process === 'injection' && !wallParts.some((it) => it.spot)) add('warn', 'Yan duvardaki panel delikleri kalıpta yan maça ister; ya da kalıptan sonra delinir.');
  if (wallParts.length && rules.process === 'cnc') add('info', 'Yan duvar panel delikleri ikinci bağlama ya da 4. eksen ister.');

  // Sızdırmazlık
  if (seal) {
    for (const it of out.items) {
      if (it.kind === 'rf') add('info', `${label(it)}: ${seal.label} için O-ringli (IP67) panel konnektör seçin; boştayken toz kapağı takın.`);
      if (it.kind === 'custom') add('info', `${label(it)}: ${seal.label} için IP sınıflı (contalı) parça seçin.`);
    }
    const glands = out.items.filter((it) => it.kind === 'gland' || it.kind === 'vent');
    if (glands.length) add('ok', `${glands.length} rakor / basınç elemanı IP68 sınıfında; conta yüzeyi düz ve temiz olmalı.`);
    if (/67|68/.test(seal.id) && !out.items.some((it) => it.kind === 'vent')) {
      add('info', `${seal.label} dış ortam kutusunda sıcaklık değişimi contayı zorlar ve yoğuşma yapar: basınç dengeleme elemanı önerilir.`,
        { key: 'panelAdd', value: 'vent-m12', label: 'Basınç dengeleme ekle' });
    }
  }
  return out;

  function baseItem(sp, pd, face, issues) {
    return { uid: sp.uid, type: pd.id, kind: pd.kind, title: panelTitle(pd), size: pd.size, face, pd, issues, hole: pd.hole };
  }
}

/** 3B model için gereken ölçüler */
function visualDims(pd) {
  return { kind: pd.kind, af: pd.af, e: pd.e, eo: pd.eo, holeD: pd.hole?.d, outer: pd.outer, inner: pd.inner, size: pd.size, clamp: pd.clamp };
}
