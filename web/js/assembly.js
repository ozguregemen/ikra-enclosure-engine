/*
 * Montaj: bağlantı ve panel elemanlarının basitleştirilmiş katı tanımları (STEP montajı ve montaj paftası için).
 * Diş, tahrik izi, tırtıl yoktur; baş, gövde, somun ve burç dış hatları doğru ölçüdedir.
 * Çıktı yalnızca sayıdır; katı model cad-worker.js'te replicad ile kurulur.
 *
 * İlkel tipler (eksen yönü dir, başlangıç noktası p, boy h):
 *   cyl  { p, dir, h, r, rIn? }            silindir (rIn: delikli)
 *   cone { p, h, r0, r1 }                  düşey kesik koni (p alt merkez, r0 alt, r1 üst yarıçap)
 *   hex  { p, dir, h, af, rIn? }           altıgen prizma (eksen X, Y ya da Z boyunca)
 *   box  { min, max }                      kutu (kare somun)
 */

const add3 = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const UP = [0, 0, 1];
const DOWN = [0, 0, -1];
const COLOR = { steel: '#b9c0c8', brass: '#c9a54a', black: '#2c2e33', nylon: '#ece7da', plastic: '#3b3e44', gray: '#9aa0a6', clear: '#d8eefc', rubber: '#1d1e21', gold: '#e2b858' };
const finishColor = (f) => ({ brass: COLOR.brass, black: COLOR.black, nylon: COLOR.nylon }[f] || COLOR.steel);
const fmt = (v) => String(Math.round(v * 100) / 100).replace('.', ',');

/** Vida: başın oturduğu nokta (x, y, z) ve shank yönü; havşa başta baş deliğin içindedir */
function screwPrims(s, z, down = true) {
  const dir = down ? DOWN : UP;
  const L = s.length || 0;
  const k = s.head_h || 0.6 * s.d;
  const dk = s.head_d_actual || s.head_d || 1.8 * s.d;
  const p0 = [s.x, s.y, z];
  if (s.head === 'countersunk') {
    // Baş z−k … z (yukarıda geniş), gövde z−L … z−k; ters vidada simetrik
    const headBase = down ? z - k : z;
    return [
      down ? { k: 'cone', p: [s.x, s.y, headBase], h: k, r0: s.d / 2, r1: dk / 2 } : { k: 'cone', p: [s.x, s.y, headBase], h: k, r0: dk / 2, r1: s.d / 2 },
      { k: 'cyl', p: add3(p0, dir, k), dir, h: Math.max(L - k, 0.1), r: s.d / 2 },
    ];
  }
  return [
    { k: 'cyl', p: p0, dir: down ? UP : DOWN, h: k, r: dk / 2 },
    { k: 'cyl', p: p0, dir, h: Math.max(L, 0.1), r: s.d / 2 },
  ];
}

/**
 * d: computeDesign() sonucu, boardTop: PCB üst yüzü
 * Dönüş: [{ name, part: 'base'|'lid'|'clip', color, prims }]  (clip: DIN ray klipsiyle birlikte hareket eder)
 */
export function assemblyItems(d, boardTop) {
  const items = [];
  if (!d || !d.geometry) return items;
  const zTop = d.geometry.zTop;
  let n = 0;
  for (const s of d.screws || []) {
    if (!s.length) continue;
    const seat = (s.zSeat ?? (s.lid ? zTop : boardTop)) + (s.seat || 0);
    const part = s.lid ? 'lid' : 'base';
    items.push({ name: `${s.code ? s.code + ' ' : ''}${s.size}x${fmt(s.length)} #${++n}`, part, color: finishColor(s.material?.finish), prims: screwPrims(s, seat, true) });
    if (s.washer) {
      const w = s.washer;
      items.push({ name: `${w.code} ${w.size} #${n}`, part, color: finishColor(w.material?.finish),
        prims: [{ k: 'cyl', p: [s.x, s.y, seat - (s.seat || w.s)], dir: UP, h: w.s, r: w.d2 / 2, rIn: w.d1 / 2 }] });
    }
  }
  // DIN ray klipsi vidaları (içeriden, tabana oturur) ve klipsteki insertler (klipsle birlikte)
  const dn = d.geometry.din;
  if (dn) {
    const ft = d.z?.floorTop ?? d.geometry.z0 + d.geometry.floor;
    (d.geometry.mountHoles || []).forEach((h, i) => {
      items.push({ name: `${dn.method === "self_tap" ? "Vida 3" : "ISO 7045 M3"}x${fmt(dn.len)} DIN #${i + 1}`, part: 'base', color: COLOR.steel,
        prims: screwPrims({ x: h.x, y: h.y, d: 3, length: dn.len, head_d: 5.6, head_h: 2.4 }, ft, true) });
      if (dn.method === 'insert') {
        items.push({ name: `Insert M3 DIN #${i + 1}`, part: 'clip', color: COLOR.brass,
          prims: [{ k: 'cyl', p: [h.x, h.y, dn.z0 - dn.insertL], dir: UP, h: dn.insertL, r: dn.holeD / 2 + 0.25, rIn: 1.5 }] });
      }
    });
  }
  let m = 0;
  const holders = [...(d.standoffs || []), ...(d.cornerBosses || [])];
  for (const st of holders) {
    const b = st.insert;
    if (!b) continue;
    m++;
    if (b.kind === 'heatset' || b.kind === 'helicoil') {
      items.push({ name: `${b.kind === 'helicoil' ? 'Helicoil' : 'Insert'} ${b.id} #${m}`, part: 'base', color: b.kind === 'helicoil' ? COLOR.steel : COLOR.brass,
        prims: [{ k: 'cyl', p: [st.x, st.y, st.z1 - b.L], dir: UP, h: b.L, r: b.dOut / 2, rIn: b.dIn / 2 }] });
    } else if (b.kind === 'nut') {
      const color = finishColor(b.material?.finish);
      if (b.shape === 'hex') {
        items.push({ name: `${b.id} #${m}`, part: 'base', color, prims: [{ k: 'hex', p: [st.x, st.y, b.zTop - b.m], dir: UP, h: b.m, af: b.s, rIn: b.dIn / 2 }] });
      } else {
        items.push({ name: `${b.id} #${m}`, part: 'base', color, prims: [{ k: 'box', min: [st.x - b.s / 2, st.y - b.s / 2, b.zTop - b.m], max: [st.x + b.s / 2, st.y + b.s / 2, b.zTop] }] });
      }
    } else if (b.kind === 'standoff') {
      const color = finishColor(b.material?.finish);
      const prims = [{ k: 'hex', p: [st.x, st.y, b.zBottom], dir: UP, h: b.L, af: b.sw, rIn: b.dIn / 2 }];
      if (b.ends === 'mf' && b.male) prims.push({ k: 'cyl', p: [st.x, st.y, b.zBottom], dir: DOWN, h: b.male, r: b.dIn / 2 });
      items.push({ name: `Aralayıcı ${b.dIn ? 'M' + fmt(b.dIn) : ''}x${fmt(b.L)} #${m}`, part: 'base', color, prims });
      if (b.bottom?.kind === 'screw' && b.bottom.length) {
        const top = (d.screws || []).find((s) => Math.abs(s.x - st.x) < 1e-6 && Math.abs(s.y - st.y) < 1e-6) || d.screws?.[0];
        if (top) items.push({ name: `Alt vida ${top.size}x${fmt(b.bottom.length)} #${m}`, part: 'base', color: finishColor(top.material?.finish), prims: screwPrims({ ...top, length: b.bottom.length }, b.zBase, false) });
      } else if (b.bottom?.kind === 'nut') {
        items.push({ name: `${b.bottom.code} somun #${m}`, part: 'base', color: finishColor(b.bottom.material?.finish),
          prims: [{ k: 'hex', p: [st.x, st.y, b.zBase], dir: DOWN, h: b.bottom.m, af: b.bottom.s, rIn: b.dIn / 2 }] });
      }
    }
  }
  // Panel elemanları (görsel tanımlarından): dış yüz noktası + dışa bakan yön
  let k = 0;
  for (const v of d.panel?.visuals || []) {
    const pd = v.pd || {};
    const dir = v.dir;
    const inv = dir.map((x) => -x);
    const t = v.t || 2;
    const a = v.anchor;
    const prims = [];
    let color = COLOR.steel;
    let name = '';
    if (v.kind === 'foot') {
      prims.push({ k: 'cyl', p: a, dir, h: v.h, r: v.d / 2 }); color = COLOR.rubber; name = `Lastik ayak Ø${fmt(v.d)}`;
    } else if (v.kind === 'lightpipe') {
      prims.push({ k: 'cyl', p: a, dir: inv, h: v.L, r: v.d / 2 }); color = COLOR.clear; name = `Işık borusu Ø${fmt(v.d)}x${fmt(v.L)}`;
    } else if (v.kind === 'rf') {
      const af = pd.af || 7.94;
      prims.push({ k: 'cyl', p: add3(a, inv, t + 2), dir, h: t + 2 + (pd.outer || 9), r: 3.175 });
      prims.push({ k: 'hex', p: a, dir, h: 2.4, af, rIn: 3.2 });
      prims.push({ k: 'hex', p: add3(a, inv, t), dir: inv, h: 2, af });
      color = COLOR.gold; name = 'SMA panel konnektörü';
    } else if (v.kind === 'gland' || v.kind === 'vent') {
      const dd = pd.size && /^M\d+/.test(pd.size) ? Number(pd.size.slice(1)) : 12;
      const af = pd.af || dd * 1.2;
      const hexH = Math.min(4, (pd.outer || dd) * 0.3);
      prims.push({ k: 'hex', p: a, dir, h: hexH, af });
      prims.push({ k: 'cyl', p: add3(a, dir, hexH), dir, h: Math.max((pd.outer || dd) - hexH, 1), r: (v.kind === 'vent' ? (pd.eo || af + 3) : af * 1.1) / 2 });
      prims.push({ k: 'cyl', p: a, dir: inv, h: t + (pd.inner || 7) - 0.5, r: dd / 2 });
      prims.push({ k: 'hex', p: add3(a, inv, t), dir: inv, h: Math.max(3, dd * 0.28), af, rIn: dd / 2 });
      color = v.kind === 'vent' ? COLOR.gray : COLOR.plastic;
      name = v.kind === 'vent' ? 'Basınç dengeleme M12' : `Kablo rakoru ${pd.size || ''}`;
    } else {
      const r = Math.max(0.5, (pd.holeD || 6) / 2 - 0.15);
      prims.push({ k: 'cyl', p: add3(a, inv, t + (pd.inner || 8)), dir, h: t + (pd.inner || 8) + (pd.outer || 8), r });
      if (pd.af) prims.push({ k: 'hex', p: a, dir, h: Math.min(3, (pd.outer || 8) * 0.4), af: pd.af, rIn: r });
      name = 'Özel panel elemanı';
    }
    items.push({ name: `${name} #${++k}`, part: v.part, color, prims });
  }
  return items;
}
