/*
 * Kutunun bağlanması (montaj): dışta taban hizasında montaj kulakları ya da tabandan içten vidalı delikler.
 * computeDesign() içinden çağrılır; yalnızca sayı üretir (katı model cad-worker.js'te).
 *
 * options.mount = { type: 'none'|'ears'|'floor', size: 'M3'..'M6', count: 2|4, axis: 'auto'|'x'|'y', hole: 'round'|'slot' }
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
];
export const MOUNT_SIZES = ['M3', 'M4', 'M5', 'M6'];
const SLOT_EXTRA = 3; // mm: uzun delikte merkezler arası ek boy (hizalama payı)

/**
 * ctx: { mount, rules, tol, fitSel, fasteners, washers, outer, center, z0, wall, floor, floorTop, rIn, rOut, cav,
 *        ports, panelItems, standoffs, cornerBosses, bottomBump, p, below, seal }
 * Dönüş: { ears, floorHoles, holes (çizim/delik listesi), checks, bom, footprint, info }
 */
export function planMount(ctx) {
  const m = { type: 'none', size: 'M4', count: 4, axis: 'auto', hole: 'round', ...(ctx.mount || {}) };
  const out = { type: m.type, ears: [], floorHoles: [], holes: [], checks: [], bom: [], footprint: null, info: null };
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

  // Tabandan içten vida: kutu, kart takılmadan önce içeriden yüzeye vidalanır
  const count = m.count === 2 ? 2 : 4;
  const margin = rIn + hd / 2 + 1;
  const holders = [...(ctx.standoffs || []).map((s) => ({ x: s.x, y: s.y, r: (s.insert?.kind === 'standoff' ? s.insert.sw * 0.58 : s.od / 2) })),
    ...(ctx.cornerBosses || []).map((c) => ({ x: c.x, y: c.y, r: c.od / 2 + Math.max(Math.abs(c.wall[0] - c.x), Math.abs(c.wall[1] - c.y)) }))];
  const clearOf = (x, y) => holders.every((h) => Math.hypot(h.x - x, h.y - y) >= h.r + hd / 2 + 1);
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
    // Vida başı kartın altına sığmalı
    const room = ctx.p.standoffHeight - ctx.below;
    if (room < hk + 0.5 - 1e-6) {
      const need = Math.ceil((ctx.below + hk + 0.5) * 10) / 10;
      add('error', `Taban montaj vidasının başı (${f(hk)} mm) PCB altına sığmıyor: kartın altında ${f(Math.max(room, 0))} mm boşluk var.`,
        { key: 'standoffHeight', value: need, label: `PCB altı ${f(need)} mm` });
    }
    if (ctx.seal) add('warn', `${ctx.seal.label}: tabandaki montaj delikleri sızdırmazlığı bozar; her vidaya sızdırmazlık pulu (ya da O-ring) kullanın veya dıştan montaj kulağı seçin.`,
      { key: 'mountType', value: 'ears', label: 'Montaj kulağı' });
    if (ctx.hasFeet) add('info', 'Lastik ayaklar tabandan vidalı montajda kutuyu yüzeyden ayırır; vidalar ayak yüksekliği kadar uzun seçilmeli.');
    out.bom.push(`Montaj: ${out.floorHoles.length} × ${m.size} vida (+ pul) — tabanda Ø${f(d)} delik, içeriden; aralık ${[sx, sy].filter((v) => v > 0.05).map(f).join(' × ')} mm`);
  }
  return out;
}
