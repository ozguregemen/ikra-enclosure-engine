/*
 * Kutunun bağlanması (montaj): dışta taban hizasında montaj kulakları ya da tabandan içten vidalı delikler.
 * computeDesign() içinden çağrılır; yalnızca sayı üretir (katı model cad-worker.js'te).
 *
 * options.mount = { type: 'none'|'ears'|'floor'|'din', size: 'M3'..'M6', count: 2|4, axis: 'auto'|'x'|'y', hole: 'round'|'slot' }
 * DIN'de axis ray yönüdür; klips ayrı bir parçadır (out.din), kutu tabanına içeriden iki M3 ile bağlanır.
 */
import { ISO273 } from './fits.js';

const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const f = (v) => nf.format(Math.round(v * 100) / 100);
const r1 = (v) => Math.round(v * 10) / 10;
const CLASS_INDEX = { press: 0, normal: 1, loose: 2 };
export const MOUNT_TYPES = [
  { id: 'none', label: 'Yok' },
  { id: 'ears', label: 'Montaj kulağı' },
  { id: 'floor', label: 'Tabandan vida' },
  { id: 'din', label: 'DIN ray (TS35)' },
];
export const MOUNT_SIZES = ['M3', 'M4', 'M5', 'M6'];
const SLOT_EXTRA = 3; // mm: uzun delikte merkezler arası ek boy (hizalama payı)

// EN 60715 TS35×7,5 ray: 35 mm genişlik, 1 mm flanş, flanşlar arası kanal ≈25 mm, kanal derinliği 6,5 mm
const RAIL = { w: 35, flange: 1, channel: 25, depth: 6.5, h: 7.5 };
// Klips: ayrı basılan plaka + sabit kanca (+v) + iki esnek kilit dili (−v, plaka düzleminde esner)
const CLIP = { L: 45, tp: 4, side: 0.2, under: 1.0, lipGap: 0.2, hookH: 2.7, wall: 2.5, slot: 1.5, root: 6, hookL: 8, boss: 4, tMin: 1.6 };
// Yaklaşık izin verilen geçme (snap-fit) uzaması, % — birkaç kez takılıp sökülen dil için başlangıç değeri
const SNAP_STRAIN = {
  pla: 1.5, petg: 2.5, abs: 2, asa: 2, pc: 3, pa12: 4, pacf: 1, petgcf: 1,
  pom: 4, pomh: 4, pa6: 3, pa66: 3, pet: 2.5, peek: 3, pei: 3, ptfe: 5, uhmw: 5, pp: 5, pmma: 1.2, pvc: 1.5,
  pcabs: 2.5, al6061: 0.4,
};
const STD_LEN = [4, 5, 6, 8, 10, 12, 14, 16, 20, 25];

/**
 * ctx: { mount, rules, tol, fitSel, fasteners, washers, outer, center, z0, wall, floor, floorTop, rIn, rOut, cav,
 *        ports, panelItems, standoffs, cornerBosses, bottomBump, p, below, seal }
 * Dönüş: { ears, floorHoles, holes (çizim/delik listesi), checks, bom, footprint, info }
 */
export function planMount(ctx) {
  const m = { type: 'none', size: 'M4', count: 4, axis: 'auto', hole: 'round', ...(ctx.mount || {}) };
  if (m.type === 'din') m.size = 'M3'; // klips vidaları sabit M3 (klipsin içinde insert / diş)
  const out = { type: m.type, ears: [], floorHoles: [], holes: [], checks: [], bom: [], footprint: null, info: null, din: null };
  if (m.type === 'none') return out;
  const add = (level, text, fix = null) => out.checks.push([level, text, fix]);
  const { rules, tol, fitSel, outer, center, z0, wall, rOut, cav, rIn } = ctx;
  const row = (ctx.fasteners?.screws || []).find((s) => s.size === m.size);
  if (!row) { add('error', `Montaj vidası ${m.size} için ölçü tablosu yok.`); return out; }
  const iso = ISO273[m.size];
  const clr = (iso ? iso[CLASS_INDEX[fitSel?.screw] ?? 1] : row.clearance) + (tol?.hole_comp || 0);
  const wz = ctx.washers?.find((w) => w.id === 'iso7089')?.sizes?.[m.size];
  const hd = Math.max(row.head_d || 1.8 * row.d, wz ? wz.d2 : 0); // baş ya da pul çapı (oturma yüzeyi)
  const hk = row.head_h || 0.7 * row.d;
  const d = r1(clr);

  if (m.type === 'ears') {
    // Kulak: taban hizasında (kutu yüzeye düz oturur), duvardan dışa çıkan yuvarlak uçlu dil
    const t = r1(Math.max(3, 1.5 * wall, 0.8 * row.d));
    const e = r1(Math.max(hd / 2 + 1.5, d / 2 + 2)); // delik merkezi – dış duvar: baş/pul + tornavida payı
    const w = r1(Math.max(hd + 3, 2.4 * d));
    const slot = m.hole === 'slot' ? SLOT_EXTRA : 0;
    const reach = z0 + t + hk + 6; // kulak + vida başı + el/fiş payı yüksekliği
    // Bir duvar çifti için kulak yerleşimi ve kulak üstündeki port/panel elemanı çakışmaları
    const layout = (axis) => {
      const along = 1 - axis;
      const straight = (along === 0 ? outer.L : outer.W) / 2 - rOut; // düz duvar yarı boyu
      const notes = [];
      let offs = [0];
      if (m.count !== 2) {
        const a = straight - w / 2 - 0.5;
        if (a < w / 2 + 2) notes.push(['warn', `Duvar dört kulak için kısa (düz kısım ${f(2 * straight)} mm); her duvara bir kulak kondu.`]);
        else offs = [-a, a];
      }
      if (w / 2 > straight + 1e-6) notes.push(['warn', `Kulak genişliği (${f(w)} mm) duvarın düz kısmından (${f(2 * straight)} mm) büyük; köşe radyüsüne biner.`]);
      const ears = [];
      for (const dir of [-1, 1]) {
        const wallOut = center[axis] + dir * (axis === 0 ? outer.L : outer.W) / 2;
        for (const o of offs) {
          const c = [0, 0];
          c[axis] = wallOut + dir * e;
          c[along] = center[along] + o;
          ears.push({ axis, dir, along, wallOut, a: c[along], hx: c[0], hy: c[1], e, w, t, z0, d, slot, slotAxis: along, side: `${dir > 0 ? '+' : '-'}${axis === 0 ? 'X' : 'Y'}` });
        }
      }
      const conflicts = [];
      for (const ear of ears) {
        const pt = (ctx.ports || []).find((x) => x.enabled && x.side === ear.side && x.a1 > ear.a - w / 2 - 2 && x.a0 < ear.a + w / 2 + 2 && x.zLo < reach);
        if (pt) conflicts.push(`${pt.name} açıklığı ${ear.side} kulağının hemen üstünde: fiş takılırken kulağa ya da montaj vidası başına çarpabilir`);
        const it = (ctx.panelItems || []).find((x) => {
          if (x.face !== ear.side || !Number.isFinite(x.z)) return false;
          const a = ear.axis === 0 ? x.y : x.x;
          const half = (x.pd?.eo || 10) / 2;
          return a + half > ear.a - w / 2 - 1 && a - half < ear.a + w / 2 + 1 && x.z - half < reach;
        });
        if (it) conflicts.push(`${it.title} ${ear.side} kulağının üstünde: dış gövdesi kulağa ya da vida başına yakın`);
      }
      const load = ['+', '-'].reduce((s, sg) => s + (ctx.ports || []).filter((pt) => pt.enabled && pt.side === `${sg}${axis === 0 ? 'X' : 'Y'}`).length
        + (ctx.panelItems || []).filter((x) => x.face === `${sg}${axis === 0 ? 'X' : 'Y'}`).length, 0);
      return { axis, ears, notes, conflicts, load };
    };
    // Otomatik: çakışması az olan duvar çifti; eşitse port/panel yükü az olan; o da eşitse kısa duvarlar (kulak aralığı uzun eksende)
    let L;
    if (m.axis === 'x' || m.axis === 'y') L = layout(m.axis === 'x' ? 0 : 1);
    else {
      const [lx, ly] = [layout(0), layout(1)];
      const key = (o) => [o.conflicts.length, o.load];
      const [kx, ky] = [key(lx), key(ly)];
      L = kx[0] !== ky[0] ? (kx[0] < ky[0] ? lx : ly) : kx[1] !== ky[1] ? (kx[1] < ky[1] ? lx : ly) : (outer.W <= outer.L ? lx : ly);
    }
    const axis = L.axis;
    for (const [lv, tx] of L.notes) add(lv, tx);
    out.ears = L.ears;
    for (const ear of L.ears) out.holes.push({ x: ear.hx, y: ear.hy, d, slot, slotAxis: ear.along, kind: 'ear' });
    const P = e + w / 2;
    out.footprint = axis === 0 ? { L: outer.L + 2 * P, W: outer.W } : { L: outer.L, W: outer.W + 2 * P };
    // Delik aralıkları (montaj yüzeyine işaretlenecek)
    const xs = [...new Set(out.holes.map((h) => r1(h.x)))].sort((a, b) => a - b);
    const ys = [...new Set(out.holes.map((h) => r1(h.y)))].sort((a, b) => a - b);
    const sx = xs.length > 1 ? xs[xs.length - 1] - xs[0] : 0;
    const sy = ys.length > 1 ? ys[ys.length - 1] - ys[0] : 0;
    out.info = { count: out.ears.length, axis, t, e, w, d, hd, spacing: [r1(sx), r1(sy)], P: r1(P) };
    add('ok', `${out.ears.length} montaj kulağı (${axis === 0 ? '±X' : '±Y'} duvarlarında, taban hizasında): ${m.size} için Ø${f(d)}${slot ? ` × ${f(d + slot)} uzun` : ''} delik, kalınlık ${f(t)} mm; delik aralığı ${[sx, sy].filter((v) => v > 0).map(f).join(' × ')} mm.`);
    add('info', `Kulaklarla kutunun taban izi ${f(out.footprint.L)} × ${f(out.footprint.W)} mm; delik merkezi duvardan ${f(e)} mm (Ø${f(hd)} vida başı/pul + tornavida payı).`);

    // Kulak üstündeki portlar ve panel elemanları: fiş / dış gövde kulağa ya da vida başına çarpabilir
    if (L.conflicts.length) {
      const other = layout(1 - axis);
      const fix = other.conflicts.length < L.conflicts.length
        ? { key: 'mountAxis', value: axis === 0 ? 'y' : 'x', label: `Kulakları ${axis === 0 ? '±Y' : '±X'} duvarlarına al` }
        : m.count !== 2 ? { key: 'mountCount', value: 2, label: '2 kulak (duvar ortasında)' } : null;
      for (const c of [...new Set(L.conflicts)]) add('warn', `${c}.`, fix);
    }
    if (ctx.hasFeet) add('warn', 'Lastik ayak ve montaj kulağı birlikte: kutu ayaklara oturur, kulaklar yüzeye değmez. Duvara montajda ayakları kaldırın.');
    if (ctx.bottomBump > 0) add('warn', `Tabandan ${f(ctx.bottomBump)} mm vida başı/somun çıkıyor: kutu montaj yüzeyine düz oturmaz. Havşa başlı alt vida ya da somun cebi seçin.`);
    if (rules.process === 'cnc') add('info', 'CNC\'de kulaklar ham malzeme (stok) boyunu kulak çıkıntısı kadar büyütür; çok sayıda parçada ayrı sac braket daha ekonomik olabilir.');
    if (rules.process === 'fdm') add('ok', 'Kulaklar taban hizasında: baskı tablasına oturur, destek gerekmez.');
    out.bom.push(`Montaj: ${out.ears.length} × ${m.size} vida (+ ISO 7089 pul) — kulaklarda Ø${f(d)}${slot ? `×${f(d + slot)} uzun` : ''} delik, aralık ${[sx, sy].filter((v) => v > 0).map(f).join(' × ')} mm; vida/dübel montaj yüzeyine göre seçilir`);
    return out;
  }

  const holders = [...(ctx.standoffs || []).map((s) => ({ x: s.x, y: s.y, r: (s.insert?.kind === 'standoff' ? s.insert.sw * 0.58 : s.od / 2) })),
    ...(ctx.cornerBosses || []).map((c) => ({ x: c.x, y: c.y, r: c.od / 2 + Math.max(Math.abs(c.wall[0] - c.x), Math.abs(c.wall[1] - c.y)) }))];
  const clearOf = (x, y) => holders.every((h) => Math.hypot(h.x - x, h.y - y) >= h.r + hd / 2 + 1);
  const headRoom = () => {
    // Vida başı kartın altına sığmalı
    const room = ctx.p.standoffHeight - ctx.below;
    if (room < hk + 0.5 - 1e-6) {
      const need = Math.ceil((ctx.below + hk + 0.5) * 10) / 10;
      add('error', `Montaj vidasının başı (${f(hk)} mm) PCB altına sığmıyor: kartın altında ${f(Math.max(room, 0))} mm boşluk var.`,
        { key: 'standoffHeight', value: need, label: `PCB altı ${f(need)} mm` });
    }
  };

  if (m.type === 'din') return planDin(ctx, m, out, add, { row, d, hd, hk, clearOf, headRoom });

  // Tabandan içten vida: kutu, kart takılmadan önce içeriden yüzeye vidalanır
  const count = m.count === 2 ? 2 : 4;
  const margin = rIn + hd / 2 + 1;
  const cx = (cav.min[0] + cav.max[0]) / 2;
  const cy = (cav.min[1] + cav.max[1]) / 2;
  const hx = (cav.max[0] - cav.min[0]) / 2 - margin;
  const hy = (cav.max[1] - cav.min[1]) / 2 - margin;
  const longX = cav.max[0] - cav.min[0] >= cav.max[1] - cav.min[1];
  const starts = count === 4 ? [[-1, -1], [1, -1], [1, 1], [-1, 1]] : longX ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
  for (const [sx, sy] of starts) {
    // Köşeden merkeze doğru kayarak standoff ve köşe boss'larından uzak ilk konum
    let pos = null;
    for (let k = 0; k <= 1.0001 && !pos; k += 0.05) {
      const x = cx + sx * hx * (1 - k);
      const y = cy + sy * hy * (1 - k);
      if (clearOf(x, y)) pos = [x, y];
    }
    if (!pos) { add('error', 'Tabanda standoff ve boss\'lardan uzak montaj deliği yeri bulunamadı.'); continue; }
    out.floorHoles.push({ x: pos[0], y: pos[1], d });
    out.holes.push({ x: pos[0], y: pos[1], d, slot: 0, kind: 'floor' });
  }
  if (out.floorHoles.length) {
    const xs = out.floorHoles.map((h) => h.x);
    const ys = out.floorHoles.map((h) => h.y);
    const sx = Math.max(...xs) - Math.min(...xs);
    const sy = Math.max(...ys) - Math.min(...ys);
    out.info = { count: out.floorHoles.length, d, hd, spacing: [r1(sx), r1(sy)] };
    add('ok', `${out.floorHoles.length} taban montaj deliği (${m.size}, Ø${f(d)}): vidalar içeriden, kart takılmadan önce sıkılır; delik aralığı ${[sx, sy].filter((v) => v > 0.05).map(f).join(' × ')} mm.`);
    headRoom();
    if (ctx.seal) add('warn', `${ctx.seal.label}: tabandaki montaj delikleri sızdırmazlığı bozar; her vidaya sızdırmazlık pulu (ya da O-ring) kullanın veya dıştan montaj kulağı seçin.`,
      { key: 'mountType', value: 'ears', label: 'Montaj kulağı' });
    if (ctx.hasFeet) add('info', 'Lastik ayaklar tabandan vidalı montajda kutuyu yüzeyden ayırır; vidalar ayak yüksekliği kadar uzun seçilmeli.');
    out.bom.push(`Montaj: ${out.floorHoles.length} × ${m.size} vida (+ pul) — tabanda Ø${f(d)} delik, içeriden; aralık ${[sx, sy].filter((v) => v > 0.05).map(f).join(' × ')} mm`);
  }
  return out;
}

/**
 * DIN ray klipsi (EN 60715 TS35×7,5): kutunun altına içeriden iki M3 ile vidalanan ayrı parça.
 * Klips yerel çerçevesi: u ray boyunca, v raya dik (+v sabit kanca, −v iki esnek kilit dili), z = 0 klipsin üst yüzü
 * (kutu tabanı), aşağı negatif. Dünyaya: ray X'te (axis 0) → (cx + u, cy + v); ray Y'de (axis 1) → (cx − v, cy + u)
 * (Z etrafında +90° döndürme). Kilit dilleri plaka düzleminde (v yönünde) esner; baskıda katmanlar zorlanmaz.
 */
function planDin(ctx, m, out, add, s) {
  const { rules, outer, center, z0, floor, cav } = ctx;
  const { row, d, hd, hk, clearOf, headRoom } = s;
  const C = CLIP;
  const dimU = (ax) => (ax === 0 ? outer.L : outer.W);
  let axis;
  if (m.axis === 'x' || m.axis === 'y') axis = m.axis === 'x' ? 0 : 1;
  else {
    // Kısa kenar ray boyunca (DIN modülleri gibi rayda az yer kaplar); kutu klipsten kısaysa uzun kenar
    const shortAx = outer.L <= outer.W ? 0 : 1;
    axis = dimU(shortAx) >= C.L ? shortAx : 1 - shortAx;
  }
  const toWorld = (u, v) => (axis === 0 ? [center[0] + u, center[1] + v] : [center[0] - v, center[1] + u]);
  const latchSide = axis === 0 ? '−Y' : '+X';
  const fixedSide = axis === 0 ? '+Y' : '−X';

  // Esnek dil: plaka düzleminde esneyen ankastre kiriş; uzama ε ≈ 1,5·t·δ / L² (δ: dudağın flanşı geçmesi için esneme)
  const allow = SNAP_STRAIN[rules.material] ?? 2;
  const delta = C.under + 0.1;
  const Lt = (C.L - C.root) / 2;
  const Leff = Lt - C.hookL / 2;
  const tFit = (allow / 100) * Leff * Leff / (1.5 * delta);
  const t = Math.max(C.tMin, Math.min(C.wall, Math.floor(tFit * 10) / 10));
  const strain = (150 * t * delta) / (Leff * Leff);

  // Kesit (v, z): plaka + sabit kanca (+v) + kilit kancası (−v, rampalı dudak)
  const e = RAIL.w / 2; // flanş kenarı
  const vin = e + C.side; // kanca iç yüzü
  const vtip = e - C.under; // dudak ucu (flanşın altına binme)
  const zf = -C.tp - RAIL.flange - C.lipGap; // dudak tutma yüzü
  const zb = -C.tp - C.hookH; // kanca alt yüzü
  const vFix = vin + C.wall;
  const vLat = -(vin + t);
  const profile = [[vLat, 0], [vLat, zb], [-vin, zb], [-vtip, zf], [-vin, zf], [-vin, -C.tp], [vin, -C.tp], [vin, zf], [vtip, zf], [vtip, zb], [vFix, zb], [vFix, 0]]
    .map(([v, z]) => [Math.round(v * 1000) / 1000, Math.round(z * 1000) / 1000]);
  const width = vFix - vLat;

  // Klips vidaları: kutuda geçiş deliği, klipste insert / diş; ray kanalına inen boss içinde
  const method = rules.fastening === 'insert' ? 'insert' : rules.fastening === 'self_tap' ? 'self_tap' : 'tapped';
  const holeD = method === 'insert' ? row.insert_hole : method === 'self_tap' ? row.selftap_pilot : row.tap_drill;
  const bossD = r1(method === 'insert' ? holeD + 3.8 : holeD + 4.5);
  const bossDrop = method === 'insert' ? 4 : 5; // plakanın altına (ray kanalına) iniş
  const depth = C.tp + bossDrop - 0.5;
  const inCav = (x, y) => x > cav.min[0] + hd / 2 + 0.8 && x < cav.max[0] - hd / 2 - 0.8 && y > cav.min[1] + hd / 2 + 0.8 && y < cav.max[1] - hd / 2 - 0.8;
  const vMax = RAIL.channel / 2 - 0.5 - bossD / 2;
  let pick = null;
  for (const bv of [0, 3, -3, 6, -6].filter((v) => Math.abs(v) <= vMax)) {
    for (let su = 15; su >= 6 - 1e-9 && !pick; su -= 0.5) {
      const ps = [toWorld(-su, bv), toWorld(su, bv)];
      if (ps.every(([x, y]) => inCav(x, y) && clearOf(x, y))) pick = { su, bv, ps };
    }
    if (pick) break;
  }
  if (!pick) {
    add('error', 'DIN klipsinin iki vidası için tabanda standoff ve boss\'lardan uzak yer bulunamadı (klips ortasında, ray kanalı içinde).',
      { key: 'mountAxis', value: axis === 0 ? 'y' : 'x', label: `Rayı ${axis === 0 ? 'Y' : 'X'} yönüne al` });
    return out;
  }
  const emin = method === 'insert' ? Math.min(row.insert_length - 1, 1.5 * row.d) : Math.min((rules.thread_engagement_d || 2) * row.d, depth - 0.5);
  const lo = floor + emin;
  const hi = floor + depth - 0.3;
  let len = STD_LEN.find((l) => l >= lo - 1e-6 && l <= hi + 1e-6);
  if (!len) {
    len = STD_LEN.find((l) => l >= lo - 1e-6) || STD_LEN[STD_LEN.length - 1];
    add('warn', `Klips vidası için standart boy bulunamadı (taban ${f(floor)} + diş ${f(emin)} … ${f(depth - 0.3)} mm); ${method === "self_tap" ? "Ø3" : "M3"}×${len} seçildi, ucunu ${f(len - hi)} mm kısaltın.`);
  }
  const scr = method === 'self_tap' ? `Ø3×${len} diş açan vida` : `M3×${len}`;
  for (const [x, y] of pick.ps) {
    out.floorHoles.push({ x, y, d });
    out.holes.push({ x, y, d, slot: 0, kind: 'din' });
  }
  const sp = 2 * pick.su;
  out.din = {
    axis, center: [center[0], center[1]], z0, L: C.L, tp: C.tp, width, profile,
    latchCut: { u0: -C.L / 2 + C.hookL, u1: C.L / 2 - C.hookL, v0: vLat - 1, v1: -vtip + 0.3, z0: zb - 1, z1: -C.tp },
    slots: [[-C.L / 2 - 1, -C.root / 2], [C.root / 2, C.L / 2 + 1]].map(([u0, u1]) => ({ u0, u1, v0: -vin, v1: -vin + C.slot, z0: -C.tp - 0.1, z1: 0.1 })),
    bosses: [{ u: -pick.su, v: pick.bv }, { u: pick.su, v: pick.bv }], bossD, bossZ: -C.tp - bossDrop, holeD, depth, insertL: row.insert_length || 0,
    method, len, t, strain, allow, latchSide, fixedSide,
  };
  const railSpace = Math.max(dimU(axis), C.L);
  const modules = Math.ceil(railSpace / 18 - 1e-6);
  out.info = { count: 2, d, hd, spacing: axis === 0 ? [r1(sp), 0] : [0, r1(sp)], axis, len, method, clipL: C.L, clipW: r1(width), t, strain: r1(strain), allow, railSpace: r1(railSpace), modules, latchSide };

  add('ok', `DIN ray klipsi (EN 60715 TS35, ayrı parça ${f(C.L)} × ${f(width)} × ${f(C.tp + bossDrop)} mm): ray ${axis === 0 ? 'X' : 'Y'} yönünde; kutuya içeriden 2 × ${scr} ile bağlanır, delik aralığı ${f(sp)} mm.`);
  add('info', `Takma: ${fixedSide} tarafındaki sabit kancayı ray flanşına geçirip kutuyu raya bastırın, ${latchSide} tarafındaki iki esnek dil flanşın altına oturur. Sökme: düz tornavidayı plaka ucundan dil yarığına sokup dili dışa itin.`);
  if (allow < 1) {
    add('warn', `${rules.label} esnek dile uygun değil (izin verilen uzama ≈ %${f(allow)}, dilde ≈ %${f(strain)}): ticari yaylı DIN klipsi kullanın; kutudaki ${f(sp)} mm aralıklı delikler ona göre.`);
  } else if (strain > allow + 1e-6) {
    add('warn', `Kilit dilinde takarken uzama ≈ %${f(strain)}, ${rules.label} için izin ≈ %${f(allow)}: dil birkaç takma-sökmede çatlayabilir. Klips için PETG, ASA, PA ya da POM önerilir.`);
  } else {
    add('ok', `Kilit dili ${f(t)} mm genişlik × ${f(Lt)} mm boy; takarken uzama ≈ %${f(strain)} (${rules.label} için izin ≈ %${f(allow)}, yaklaşık değer).`);
  }
  if (rules.hdt_c && rules.hdt_c < 65) add('warn', `Pano içi sıcaklık 40–55 °C'ye çıkabilir; ${rules.label} (HDT ≈ ${rules.hdt_c} °C) klipste zamanla gevşer. PETG/ASA ya da daha yüksek sıcaklık dayanımlı malzeme önerilir.`);
  if (dimU(axis) < C.L - 1e-6) add('info', `Klips (${f(C.L)} mm) ray boyunca kutudan ${f((C.L - dimU(axis)) / 2)} mm taşar.`);
  if (dimU(1 - axis) < width - 1e-6) add('info', `Kutu raya dik yönde klipsten dar (${f(dimU(1 - axis))} < ${f(width)} mm): kancalar kutunun dışından görünür.`);
  add('info', `Rayda kapladığı yer ${f(r1(railSpace))} mm (≈ ${modules} modül × 18 mm); kutunun ray flanşından yüksekliği ${f(outer.H + C.tp)} mm, pano arka yüzünden ${f(outer.H + C.tp + RAIL.h)} mm.`);
  headRoom();
  if (ctx.seal) add('warn', `${ctx.seal.label}: klips vidalarının taban delikleri sızdırmazlığı bozar; iki vidaya sızdırmazlık pulu (ya da O-ring) kullanın.`);
  if (ctx.hasFeet) add('warn', 'Lastik ayaklar kutuyla klips arasına girer: DIN montajında ayakları kaldırın.');
  if (ctx.bottomBump > 0) add('warn', `Tabandan ${f(ctx.bottomBump)} mm vida başı/somun çıkıyor: klips plakası kutuya düz oturmayabilir. Havşa başlı alt vida ya da somun cebi seçin.`);
  if (rules.process === 'fdm') add('ok', 'Klips üst yüzü tablaya gelecek şekilde (kancalar yukarı) desteksiz basılır; dudak çıkıntısı 1,2 mm.');
  else if (rules.process === 'cnc') add('info', `CNC: klips ray yönünde sabit kesitli bir profil (dil yarıkları ve boss'lar ek işlem). Az adette ticari vidalı TS35 klipsi daha ekonomik olabilir; delik aralığı ${f(sp)} mm.`);
  else add('info', 'Kalıpta kanca dudakları yan maça ister: klipsi ayrı FDM parça olarak basmak ya da ticari TS35 klipsi kullanmak daha ucuzdur.');
  out.bom.push(`DIN ray klipsi (EN 60715 TS35): 1 adet, ayrı parça — ${rules.label}`);
  out.bom.push(`Klips bağlantısı: 2 × ${method === 'self_tap' ? `Ø3×${len} plastik için diş açan vida` : `M3×${len} vida`} (+ pul), içeriden; kutu tabanında Ø${f(d)} delik, aralık ${f(sp)} mm; klipste ${method === 'insert' ? `2 × M3 ısıyla gömülen insert (L ${f(row.insert_length)}, delik Ø${f(holeD)})` : method === 'self_tap' ? `Ø${f(holeD)} ön delik (sac vidası)` : `M3 kılavuz (matkap Ø${f(holeD)})`}`);
  return out;
}
