/*
 * Muhafaza üretim işçisi (modül Web Worker).
 * replicad + OpenCascade (WebAssembly) ile alt gövde ve kapağı katı model olarak üretir,
 * önizleme ağlarını, hacimleri ve STEP/STL çıktılarını ana iş parçacığına gönderir.
 * Geometri tanımı design.js'teki computeDesign() çıktısından gelir (yalnızca sayılar).
 */
import opencascade from 'https://cdn.jsdelivr.net/npm/replicad-opencascadejs@1.2.1/dist/replicad_single.js';
import {
  setOC,
  drawRoundedRectangle,
  drawCircle,
  draw,
  makeBox,
  makeCylinder,
  makeCompound,
  exportSTEP,
  measureVolume,
  drawProjection,
  ProjectionCamera,
  getOC,
  cast,
} from 'https://cdn.jsdelivr.net/npm/replicad@1.2.1/+esm';

// Teknik resim görünüşleri. replicad'de kamera yönü nesneden İZLEYİCİYE doğrudur;
// xAxis kağıtta sağ, yön × xAxis kağıtta yukarı olacak şekilde seçildi (aynalanma yok).
const VIEW_CAMERAS = {
  top: { dir: [0, 0, 1], x: [1, 0, 0] },
  bottom: { dir: [0, 0, -1], x: [1, 0, 0] },
  front: { dir: [0, -1, 0], x: [1, 0, 0] },
  back: { dir: [0, 1, 0], x: [-1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 1, 0] },
  left: { dir: [-1, 0, 0], x: [0, -1, 0] },
  // Montaj paftası: önden-sağdan-üstten izometrik (kağıtta yukarı ≈ +Z)
  iso: { dir: [1, -1, 1], x: [1, 1, 0] },
};

let lastShapes = null;

const WASM_URL = 'https://cdn.jsdelivr.net/npm/replicad-opencascadejs@1.2.1/dist/replicad_single.wasm';
const MESH_OPTS = { tolerance: 0.03, angularTolerance: 0.2 };
const STL_OPTS = { binary: true, tolerance: 0.01, angularTolerance: 0.1 };

let ready = null;
function init() {
  if (!ready) {
    ready = opencascade({ locateFile: () => WASM_URL }).then((oc) => { setOC(oc); });
    ready.catch(() => { ready = null; });
  }
  return ready;
}

function roundedSlab(L, W, r, cx, cy, z, h) {
  return drawRoundedRectangle(L, W, r).sketchOnPlane('XY', [cx, cy, z]).extrude(h);
}

/**
 * Duvarı boydan boya kesen açıklık prizması.
 * c: { axis (0:X duvarı, 1:Y duvarı), along, a0, a1 (duvar boyunca), z0, z1, n0, n1 (duvar kalınlığı yönü), r }
 * replicad düzlemleri: 'YZ' → yerel x=Y, y=Z, normal +X;  'ZX' → yerel x=Z, y=X, normal +Y
 */
function cutoutPrism(c) {
  const w = c.a1 - c.a0;
  const h = c.z1 - c.z0;
  const depth = c.n1 - c.n0;
  const ac = (c.a0 + c.a1) / 2;
  const zc = (c.z0 + c.z1) / 2;
  if (c.r > 0.01) {
    return c.axis === 0
      ? drawRoundedRectangle(w, h, c.r).sketchOnPlane('YZ', [c.n0, ac, zc]).extrude(depth)
      : drawRoundedRectangle(h, w, c.r).sketchOnPlane('ZX', [ac, c.n0, zc]).extrude(depth);
  }
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  min[c.axis] = c.n0; max[c.axis] = c.n1;
  min[c.along] = c.a0; max[c.along] = c.a1;
  min[2] = c.z0; max[2] = c.z1;
  return makeBox(min, max);
}

/**
 * 90° havşa: geçiş deliği çapından (alt) üst yüzde dTop çapına genişleyen kesik koni.
 * Üst yüzün 0,5 mm üstüne kadar uzatılır (temiz boolean). Doğrusal profil ile uçtaki ölçek = üst/alt yarıçap.
 */
function countersinkCone(t, zTop) {
  const rb = t.holeD / 2;
  const depth = t.countersink.depth;
  const over = 0.5;
  const rt = t.countersink.dTop / 2 + over; // 45° yan yüz: 0,5 mm yukarıda yarıçap 0,5 mm büyür
  return drawCircle(rb)
    .sketchOnPlane('XY', [t.x, t.y, zTop - depth])
    .extrude(depth + over, { extrusionProfile: { profile: 'linear', endFactor: rt / rb } });
}

/**
 * Somun cebi. Altıgen: tabandan açık altıgen prizma (anahtar ağzı s, köşeler X ekseninde).
 * Kare: standoff ekseninden kavite merkezine doğru açılan yuva (genişlik s, yükseklik z0..z1).
 */
function nutPocketShape(st) {
  const p = st.nutPocket;
  if (p.shape === 'hex') {
    const R = p.s / Math.sqrt(3);
    let pen = draw([st.x + R, st.y]);
    for (let i = 1; i < 6; i++) pen = pen.lineTo([st.x + R * Math.cos((Math.PI / 3) * i), st.y + R * Math.sin((Math.PI / 3) * i)]);
    return pen.close().sketchOnPlane('XY', p.z0).extrude(p.z1 - p.z0);
  }
  const h = p.s / 2;
  const min = [st.x - h, st.y - h, p.z0];
  const max = [st.x + h, st.y + h, p.z1];
  if (p.dir > 0) max[p.axis] = (p.axis === 0 ? st.x : st.y) + p.reach;
  else min[p.axis] = (p.axis === 0 ? st.x : st.y) - p.reach;
  return makeBox(min, max);
}

/**
 * Panel elemanı deliği: eksen boyunca silindir; D-delikte düzlük çizgisinin ötesi kutuyla kırpılır (silindir ∩ kutu).
 * h: { axis (0|1|2), p: başlangıç noktası, len, r, flat: { axis, at } | null }
 */
function panelHoleShape(h) {
  const dir = [0, 0, 0];
  dir[h.axis] = 1;
  let s = makeCylinder(h.r, h.len, h.p, dir);
  if (h.flat) {
    const min = h.p.map((v) => v - h.r - 1);
    const max = h.p.map((v) => v + h.r + 1);
    min[h.axis] = h.p[h.axis] - 1;
    max[h.axis] = h.p[h.axis] + h.len + 1;
    max[h.flat.axis] = h.flat.at;
    s = s.intersect(makeBox(min, max));
  }
  return s;
}

function buildEnclosure(g) {
  const [cx, cy] = g.center;
  const hBase = g.cavTop - g.z0;

  // Alt gövde: dış blok − iç cep (cep üstten açık)
  const outerBlock = roundedSlab(g.outer.L, g.outer.W, g.outer.r, cx, cy, g.z0, hBase);
  const pocket = roundedSlab(g.cavity.L, g.cavity.W, g.cavity.r, cx, cy, g.z0 + g.floor, hBase);
  let base = outerBlock.cut(pocket);
  const up = [0, 0, 1];

  // Standoff'lar: tabandan PCB alt yüzüne silindir (tabana 0,5 mm gömülü başlar)
  const standoffs = g.standoffs || [];
  for (const s of standoffs) {
    // Hazır aralayıcıda gövdeyle tek parça boss yok (yalnızca tabanda delik)
    if (s.integral === false) continue;
    base = base.fuse(makeCylinder(s.od / 2, s.z1 - s.z0 + 0.5, [s.x, s.y, s.z0 - 0.5], up));
  }
  // İnsert / kılavuz / sac vidası deliği: üstten açık, kör delik (somun cebinde ve aralayıcıda boydan boya)
  for (const s of standoffs) {
    base = base.cut(makeCylinder(s.holeD / 2, s.depth + 0.5, [s.x, s.y, s.z1 - s.depth], up));
    // Helicoil yuvası girişinde 90° havşa
    if (s.countersink) base = base.cut(countersinkCone({ x: s.x, y: s.y, holeD: s.holeD, countersink: s.countersink }, s.z1));
    // Somun cebi: altıgen tabandan, kare somun yandan yuva
    if (s.nutPocket) base = base.cut(nutPocketShape(s));
    // Aralayıcının alt vidası havşa başlıysa tabanın altına havşa
    if (s.bottomCountersink) {
      const c = s.bottomCountersink;
      const rb = s.holeD / 2;
      const over = 0.5;
      const rt = c.dTop / 2 + over;
      base = base.cut(drawCircle(rt).sketchOnPlane('XY', [s.x, s.y, c.zBase - over])
        .extrude(c.depth + over, { extrusionProfile: { profile: 'linear', endFactor: rb / rt } }));
    }
  }
  // Kart kenarı tutucu: tabana ve duvara bağlı alt destekler (kartı kenar bandından taşır)
  for (const pd of g.edgePads || []) base = base.fuse(makeBox(pd.min, pd.max));
  // Köşe kapak vidası boss'ları: duvarlara yaslı silindir + köşeyi dolduran blok, üstten vida deliği
  for (const c of g.cornerBosses || []) {
    base = base.fuse(makeCylinder(c.od / 2, c.z1 - c.z0 + 0.5, [c.x, c.y, c.z0 - 0.5], up));
    const [wx, wy] = c.wall;
    base = base.fuse(makeBox([Math.min(wx, c.x), Math.min(wy, c.y), c.z0 - 0.5], [Math.max(wx, c.x), Math.max(wy, c.y), c.z1]));
  }
  for (const c of g.cornerBosses || []) {
    base = base.cut(makeCylinder(c.holeD / 2, c.depth + 0.5, [c.x, c.y, c.z1 - c.depth], up));
    if (c.countersink) base = base.cut(countersinkCone({ x: c.x, y: c.y, holeD: c.holeD, countersink: c.countersink }, c.z1));
  }
  // Port açıklıkları (konnektörler için duvar kesimi)
  for (const c of g.cutouts || []) {
    base = base.cut(cutoutPrism(c));
  }
  // Montaj kulakları: taban hizasında, duvara 0,8 mm gömülü dil + yuvarlak uç; delik (ya da uzun delik)
  for (const ear of g.ears || []) {
    const c = [ear.hx, ear.hy];
    const min = [0, 0, ear.z0];
    const max = [0, 0, ear.z0 + ear.t];
    min[ear.axis] = Math.min(ear.wallOut - ear.dir * 0.8, c[ear.axis]);
    max[ear.axis] = Math.max(ear.wallOut - ear.dir * 0.8, c[ear.axis]);
    min[ear.along] = ear.a - ear.w / 2;
    max[ear.along] = ear.a + ear.w / 2;
    base = base.fuse(makeBox(min, max)).fuse(makeCylinder(ear.w / 2, ear.t, [c[0], c[1], ear.z0], up));
  }
  for (const ear of g.ears || []) {
    const r = ear.d / 2;
    const h = ear.t + 1;
    const zc = ear.z0 - 0.5;
    if (ear.slot > 0) {
      const o = [0, 0];
      o[ear.slotAxis] = ear.slot / 2;
      const min = [ear.hx - (ear.slotAxis === 0 ? ear.slot / 2 : r), ear.hy - (ear.slotAxis === 1 ? ear.slot / 2 : r), zc];
      const max = [ear.hx + (ear.slotAxis === 0 ? ear.slot / 2 : r), ear.hy + (ear.slotAxis === 1 ? ear.slot / 2 : r), zc + h];
      base = base.cut(makeBox(min, max))
        .cut(makeCylinder(r, h, [ear.hx - o[0], ear.hy - o[1], zc], up))
        .cut(makeCylinder(r, h, [ear.hx + o[0], ear.hy + o[1], zc], up));
    } else {
      base = base.cut(makeCylinder(r, h, [ear.hx, ear.hy, zc], up));
    }
  }
  // Tabandan içten vidalı montaj delikleri
  for (const mh of g.mountHoles || []) base = base.cut(makeCylinder(mh.d / 2, g.floor + 1, [mh.x, mh.y, g.z0 - 0.5], up));
  // Panel elemanları: lamba (yerel et inceltme) ve D/yuvarlak delikler
  for (const sp of (g.panelSpots || []).filter((x) => x.part === 'base')) {
    const dir = [0, 0, 0];
    dir[sp.axis] = 1;
    base = base.cut(makeCylinder(sp.r, sp.len, sp.p, dir));
  }
  for (const h of (g.panelHoles || []).filter((x) => x.part === 'base')) base = base.cut(panelHoleShape(h));
  // IP conta kanalı: duvar üstünde, orta çizgi boyunca halka
  if (g.groove) {
    const gr = g.groove;
    const z = g.cavTop - gr.depth;
    const outerRing = roundedSlab(gr.L + gr.width, gr.W + gr.width, gr.r + gr.width / 2, cx, cy, z, gr.depth + 1);
    const innerRing = roundedSlab(gr.L - gr.width, gr.W - gr.width, Math.max(gr.r - gr.width / 2, 0.1), cx, cy, z, gr.depth + 1);
    base = base.cut(outerRing.cut(innerRing));
  }

  // Kapak: düz plaka + kenarlara konumlandırma dili + PCB'ye inen vida boruları
  let lid = roundedSlab(g.outer.L, g.outer.W, g.outer.r, cx, cy, g.cavTop, g.lidT);
  // Kart kenarı tutucu: kapaktan inen baskı dilleri (kapak kapanınca kartı üstten sıkıştırır)
  for (const pr of g.edgePressers || []) lid = lid.fuse(makeBox(pr.min, pr.max));
  for (const bar of g.lipBars) {
    lid = lid.fuse(makeBox(bar.min, bar.max));
  }
  const tubes = g.lidTubes || [];
  for (const t of tubes) {
    lid = lid.fuse(makeCylinder(t.od / 2, t.z1 - t.z0 + 0.5, [t.x, t.y, t.z0], up));
  }
  for (const t of tubes) {
    lid = lid.cut(makeCylinder(t.holeD / 2, g.zTop - t.z0 + 1, [t.x, t.y, t.z0 - 0.5], up));
    if (t.countersink) lid = lid.cut(countersinkCone(t, g.zTop));
    if (t.counterbore) lid = lid.cut(makeCylinder(t.counterbore.d / 2, t.counterbore.depth + 0.5, [t.x, t.y, g.zTop - t.counterbore.depth], up));
  }
  // Köşe vidası kapak delikleri: gerekirse kapağın altına boss'a oturan yastık, geçiş deliği, havşa ya da gömme oyuk
  for (const hh of g.lidHoles || []) {
    if (hh.pad) lid = lid.fuse(makeCylinder(hh.pad.od / 2, hh.pad.h + 0.3, [hh.x, hh.y, g.cavTop - hh.pad.h], up));
  }
  for (const hh of g.lidHoles || []) {
    const zb = g.cavTop - (hh.pad ? hh.pad.h : 0) - 0.5;
    lid = lid.cut(makeCylinder(hh.holeD / 2, g.zTop - zb + 0.5, [hh.x, hh.y, zb], up));
    if (hh.countersink) lid = lid.cut(countersinkCone({ x: hh.x, y: hh.y, holeD: hh.holeD, countersink: hh.countersink }, g.zTop));
    if (hh.counterbore) lid = lid.cut(makeCylinder(hh.counterbore.d / 2, hh.counterbore.depth + 0.5, [hh.x, hh.y, g.zTop - hh.counterbore.depth], up));
  }
  // Panel elemanları kapakta: rakor / basınç elemanı / özel delik, ışık borusu delikleri ve iç lamba
  for (const sp of (g.panelSpots || []).filter((x) => x.part === 'lid')) lid = lid.cut(makeCylinder(sp.r, sp.len, sp.p, up));
  for (const h of (g.panelHoles || []).filter((x) => x.part === 'lid')) lid = lid.cut(panelHoleShape(h));
  return { base, lid, clip: g.din ? buildClip(g.din) : null };
}

/**
 * DIN ray klipsi (ayrı parça). mount.js'teki yerel çerçevede kurulur: u = X (ray boyunca), v = Y, z = 0 klips üst yüzü;
 * sonra ray Y yönündeyse Z etrafında 90° döndürülüp kutu tabanının altına taşınır.
 */
function buildClip(dn) {
  // Kesit v–z düzleminde ('YZ': yerel x = Y, yerel y = Z, normal +X), ray boyunca çekilir
  let pen = draw(dn.profile[0]);
  for (const p of dn.profile.slice(1)) pen = pen.lineTo(p);
  let clip = pen.close().sketchOnPlane('YZ', [-dn.L / 2, 0, 0]).extrude(dn.L);
  // Kilit kancası yalnızca dil uçlarında; ortası alınır. Dil yarıkları plakadan boydan boya
  const lc = dn.latchCut;
  clip = clip.cut(makeBox([lc.u0, lc.v0, lc.z0], [lc.u1, lc.v1, lc.z1]));
  for (const s of dn.slots) clip = clip.cut(makeBox([s.u0, s.v0, s.z0], [s.u1, s.v1, s.z1]));
  // Vida boss'ları ray kanalına iner; üstten insert / diş deliği
  const up = [0, 0, 1];
  for (const b of dn.bosses) clip = clip.fuse(makeCylinder(dn.bossD / 2, -dn.tp + 0.5 - dn.bossZ, [b.u, b.v, dn.bossZ], up));
  for (const b of dn.bosses) clip = clip.cut(makeCylinder(dn.holeD / 2, dn.depth + 0.5, [b.u, b.v, -dn.depth], up));
  if (dn.axis === 1) clip = clip.rotate(90, [0, 0, 0], [0, 0, 1]);
  return clip.translate([dn.center[0], dn.center[1], dn.z0]);
}

/* ======================================================================
 * DFM kenar işlemleri (politika: treat.js). geometry.treat yoksa yukarıdaki buildEnclosure() aynen kullanılır.
 * Strateji: işlemler basit ilkellere ve 2B profillere boolean'dan ÖNCE işlenir (çıkma açılı loft, ilkel üstünde
 * pah/radyüs, dönel boss profili, 2B köşe radyüsleri); özellik boolean'ları toplu (tek BRepAlgoAPI çağrısı) yapılır;
 * küçük sonradan işlemler basamaklı geri çekilir [r, 0,6r, 0,3r, (radyüste) 0,5r pah, atla].
 * Her işlem ve her özellik boolean'ı başarısız olursa işlemsiz geometriye düşer ve treatReport'a yazılır.
 * ====================================================================== */

const DEG = Math.PI / 180;
const tanD = (deg) => Math.tan((deg || 0) * DEG);
const r3 = (v) => Math.round(v * 1000) / 1000;
const S2 = Math.SQRT1_2;
const EAR_EMBED = 0.8; // kulak duvara bu kadar gömülür (eski geometriyle aynı)
const RAIL_CHANNEL_HALF = 12.5; // EN 60715 TS35: flanşlar arası kanal 25 mm (mount.js RAIL.channel)
const numTr = (v) => String(Math.round(v * 100) / 100).replace('.', ',');

function errText(err) {
  if (err && err.message) return err.message;
  if (typeof err === 'number') return 'OCCT istisnası';
  return String(err);
}

/** İşlem raporu: aynı parça+anahtar birleştirilir (count), ok hepsi tam uygulandıysa true */
function makeReport() {
  const map = new Map();
  return {
    add(e) {
      const k = `${e.part}|${e.key}`;
      const prev = map.get(k);
      const entry = { part: e.part, key: e.key, feature: e.feature, kind: e.kind, size: r3(e.size || 0), ok: !!e.ok, applied: r3(e.applied || 0), count: 1, note: e.note || '' };
      // dv: işlemin hacim etkisi (mm³; yalnız kenar işlemlerinde ölçülür) — denetimde beklenen değerle karşılaştırmak için
      if (Number.isFinite(e.dv)) entry.dv = Math.round(e.dv * 10) / 10;
      if (!prev) { map.set(k, entry); return; }
      prev.count += 1;
      prev.ok = prev.ok && entry.ok;
      prev.applied = Math.min(prev.applied, entry.applied);
      if (Number.isFinite(entry.dv)) prev.dv = Math.round(((prev.dv || 0) + entry.dv) * 10) / 10;
      if (entry.note && !prev.note.includes(entry.note)) prev.note = prev.note ? `${prev.note}; ${entry.note}` : entry.note;
    },
    list: () => [...map.values()],
  };
}

/** Katı geçerli mi (BRepCheck), hacim beklenen yönde mi değişti (sign −1: azalmalı, +1: artmalı) */
function validSolid(s, { v0 = null, sign = 0, geom = false } = {}) {
  if (!s || !s.wrapped || s.wrapped.IsNull()) return false;
  const oc = getOC();
  const an = new oc.BRepCheck_Analyzer(s.wrapped, geom);
  const ok = an.IsValid();
  an.delete();
  if (!ok) return false;
  if (v0 === null) return true;
  const v = measureVolume(s);
  if (!(v > 1e-6)) return false;
  if (sign < 0 && v > v0 + 1e-3) return false;
  if (sign > 0 && v < v0 - 1e-3) return false;
  return true;
}

function edgePts(e) {
  const a = e.startPoint;
  const b = e.endPoint;
  const m = e.pointAt(0.5);
  return { a: [a.x, a.y, a.z], b: [b.x, b.y, b.z], m: [m.x, m.y, m.z] };
}
const inZ = (q, z) => Math.abs(q.a[2] - z) < 1e-4 && Math.abs(q.b[2] - z) < 1e-4 && Math.abs(q.m[2] - z) < 1e-4;

/**
 * Kenar işlemi, basamaklı geri çekilme ile. weightOf(edge) → ölçü katsayısı (1 = tam) ya da null (işlem yok).
 * Dönüş { shape, factor (0 = uygulanamadı), kind (son kullanılan), note }
 */
function edgeLadder(shape, kind, size, weightOf, { geom = true } = {}) {
  const steps = [[kind, 1], [kind, 0.6], [kind, 0.3]];
  if (kind === 'fillet') steps.push(['chamfer', 0.5]);
  const v0 = measureVolume(shape);
  let note = '';
  for (const [k, f] of steps) {
    const r = size * f;
    if (r < 0.03) continue;
    try {
      const fn = (e) => { const w = weightOf(e); return w ? w * r : null; };
      const s = k === 'fillet' ? shape.fillet(fn) : shape.chamfer(fn);
      if (validSolid(s, { v0, sign: -1, geom })) return { shape: s, factor: f, kind: k, note: '', dv: measureVolume(s) - v0 };
      note = 'geçersiz katı';
    } catch (err) {
      note = errText(err);
      if (/no edge/i.test(note)) return { shape, factor: 0, kind, note: 'kenar bulunamadı' };
    }
  }
  return { shape, factor: 0, kind, note: note || 'uygulanamadı' };
}

function recordLadder(rep, part, key, feature, kind, size, res, extra = '') {
  const applied = res.factor ? size * res.factor : 0;
  const ok = res.factor === 1 && res.kind === kind;
  const parts = [extra];
  if (!ok) parts.push(res.factor ? `${res.kind !== kind ? 'pah olarak ' : ''}${numTr(applied)} mm'ye küçültüldü` : `uygulanamadı (${res.note})`);
  rep.add({ part, key, feature, kind, size, ok, applied, note: parts.filter(Boolean).join('; '), dv: res.factor ? res.dv : undefined });
}

/** Tek kenar zinciri işlemi: kenar seçimi + basamaklı uygulama + kayıt */
function treatEdges(rep, part, key, feature, kind, size, shape, weightOf, extra = '') {
  if (!(size > 0.02)) return shape;
  const res = edgeLadder(shape, kind, size, weightOf);
  recordLadder(rep, part, key, feature, kind, size, res, extra);
  return res.shape;
}

/** İşlemli ilkel üret; hata olursa null (çağıran işlemsiz ilkele düşer) */
function tryMake(fn) {
  try {
    const s = fn();
    return s && s.wrapped && !s.wrapped.IsNull() ? { shape: s, err: '' } : { shape: null, err: 'boş katı' };
  } catch (err) {
    return { shape: null, err: errText(err) };
  }
}

/** Çok araçlı boolean (tek BRepAlgoAPI çağrısı, küçük bulanıklık payı) */
function multiBool(op, shape, tools) {
  const oc = getOC();
  const A = new oc.NCollection_List_TopoDS_Shape();
  const T = new oc.NCollection_List_TopoDS_Shape();
  const b = op === 'cut' ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Fuse();
  try {
    A.Append(shape.wrapped);
    for (const t of tools) T.Append(t.wrapped);
    b.SetArguments(A);
    b.SetTools(T);
    b.SetFuzzyValue(1e-5);
    b.Build();
    if (b.HasErrors()) throw new Error(`${op} başarısız`);
    b.SimplifyResult(true, true, 1e-3);
    return cast(b.Shape());
  } finally {
    b.delete();
    A.delete();
    T.delete();
  }
}

/**
 * Özellik listesini topluca ekle/çıkar. items: [{ key, feature, shape (işlemli ya da null), plain: () => Shape, treats: [...] }]
 * Toplu boolean başarısızsa tek tek: önce işlemli, olmazsa işlemsiz araç; o da olmazsa özellik atlanır.
 * Her öğenin işlemleri (treats) son duruma göre kaydedilir.
 */
function applyBatch(rep, part, op, shape, items, tag = '') {
  if (!items.length) return shape;
  const sign = op === 'cut' ? -1 : 1;
  const label = (op === 'cut' ? 'kesme' : 'ekleme') + (tag ? ` · ${tag}` : '');
  const bkey = `bool.${op}${tag ? `.${tag}` : ''}`;
  const tools = items.map((it) => it.shape || null);
  const finish = (used) => {
    items.forEach((it, i) => {
      for (const t of it.treats || []) {
        // t.applied / t.limited: geometri yüzünden kaynak değerinin altında kalan işlem (uygulandı ama tam değil)
        const done = used[i] === 'treated';
        const ok = done && !t.limited;
        rep.add({ part, key: t.key, feature: t.feature, kind: t.kind, size: t.size, ok, applied: done ? t.applied ?? t.size : 0,
          note: done ? t.note || '' : used[i] === 'plain' ? `işlemsiz geometriye düşüldü${it.err ? ` (${it.err})` : ''}` : 'özellik eklenemedi' });
      }
      if (used[i] === 'none') rep.add({ part, key: `${it.key}.bool`, feature: it.feature, kind: 'boolean', size: 1, ok: false, applied: 0, note: `${label} başarısız: özellik atlandı` });
    });
  };
  // 1) toplu: işlemli araçlar (yoksa işlemsiz)
  const v0 = measureVolume(shape);
  const batch = [];
  const used = [];
  for (let i = 0; i < items.length; i++) {
    let t = tools[i];
    used[i] = t ? 'treated' : 'plain';
    if (!t) t = tryMake(items[i].plain).shape;
    if (!t) used[i] = 'none';
    else batch.push(t);
  }
  try {
    const r = multiBool(op, shape, batch);
    if (validSolid(r, { v0, sign })) {
      rep.add({ part, key: bkey, feature: `özellik ${label} (toplu)`, kind: 'boolean', size: items.length, ok: true, applied: batch.length, note: '' });
      finish(used);
      return r;
    }
  } catch (err) { /* tek tek denenecek */ }
  // 2) tek tek
  let cur = shape;
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    used[i] = 'none';
    for (const variant of ['treated', 'plain']) {
      const t = variant === 'treated' ? tools[i] : tryMake(it.plain).shape;
      if (!t) continue;
      try {
        const vc = measureVolume(cur);
        const r = op === 'cut' ? cur.cut(t) : cur.fuse(t);
        if (validSolid(r, { v0: vc, sign })) { cur = r; used[i] = variant; break; }
      } catch (err) { /* sonraki seçenek */ }
    }
    if (used[i] !== 'none') n++;
  }
  rep.add({ part, key: bkey, feature: `özellik ${label} (tek tek)`, kind: 'boolean', size: items.length, ok: n === items.length, applied: n,
    note: 'toplu boolean başarısız, özellikler tek tek uygulandı' });
  finish(used);
  return cur;
}

function rrSketch(L, W, r, cx, cy, z) {
  return drawRoundedRectangle(L, W, Math.max(r, 0.05)).sketchOnPlane('XY', [cx, cy, z]);
}
/** Kesitleri { L, W, r, z } olan yuvarlatılmış dikdörtgen loft (çıkma açısı); düz kenar parçaları düzlem kalır */
function taperSlab(sections, cx, cy) {
  const [first, ...rest] = sections.map((s) => rrSketch(s.L, s.W, s.r, cx, cy, s.z));
  return first.loftWith(rest.length === 1 ? rest[0] : rest, { ruled: true });
}
/** Yuvarlatılmış dikdörtgende işaretli uzaklık (içeride negatif) */
function sdfRR(x, y, cx, cy, L, W, r) {
  const qx = Math.abs(x - cx) - (L / 2 - r);
  const qy = Math.abs(y - cy) - (W / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Dönel boss / boru: kök radyüsü (taban düzlemine teğet olmadan 10° önce biter → kesişim enine, boolean sağlam),
 * çıkma açısı (anma çapı uçta) ve uçta 45° pah. zTip > zRoot: yukarı (standoff), zTip < zRoot: aşağı (kapak borusu).
 */
function bossSolid({ x, y, zRoot, zTip, rTip, draftDeg = 0, rootR = 0, tipC = 0, embed = 0.5 }) {
  const s = Math.sign(zTip - zRoot) || 1;
  const h = Math.abs(zTip - zRoot);
  const ta = tanD(draftDeg);
  const al = Math.atan(ta);
  const rRoot = rTip + h * ta;
  const Z = (dz) => zRoot + s * dz;
  const P = (r, dz) => [r, Z(dz)];
  const rf = Math.min(rootR, 0.45 * h);
  const c = Math.min(tipC, 0.45 * h, 0.45 * rTip);
  let pen;
  if (rf > 0.02) {
    const sa = Math.sin(al);
    const ca = Math.cos(al);
    const t = (rf * (1 - sa)) / ca;
    const T1 = [rRoot - t * sa, t * ca];
    const F = [T1[0] + rf * ca, T1[1] + rf * sa];
    const d = 10 * DEG;
    const E = [F[0] - rf * Math.sin(d), F[1] - rf * Math.cos(d)];
    const am = (Math.PI + al + 1.5 * Math.PI - d) / 2;
    const M = [F[0] + rf * Math.cos(am), F[1] + rf * Math.sin(am)];
    pen = draw(P(0, -embed)).lineTo(P(E[0], -embed)).lineTo(P(E[0], E[1])).threePointsArcTo(P(T1[0], T1[1]), P(M[0], M[1]));
  } else {
    pen = draw(P(0, -embed)).lineTo(P(rRoot + embed * ta, -embed));
  }
  if (c > 0.02) pen = pen.lineTo(P(rTip + c * ta, h - c)).lineTo(P(rTip + c * ta - c, h));
  else pen = pen.lineTo(P(rTip, h));
  return pen.lineTo(P(0, h)).close().sketchOnPlane('XZ', [x, y, 0]).revolve([0, 0, 1], { origin: [x, y, 0] });
}

/**
 * Köşe boss'u 2B dış hattı (dünya XY): duvara gömülü dolgu + boss dairesi + iki duvar birleşiminde içbükey radyüs rc
 * (teğet silindir + kutu sivri boşluğu yok). Du/Dv: merkezin (kaydırılmış) duvar çizgilerine uzaklığı.
 */
function cornerOutline(c, shift, Rb, rc, e) {
  const [wx, wy] = c.wall;
  const mx = Math.sign(c.x - wx) || 1;
  const my = Math.sign(c.y - wy) || 1;
  const ox = wx - mx * shift;
  const oy = wy - my * shift;
  const W = ([u, v]) => [ox + mx * u, oy + my * v];
  const Du = Math.abs(c.x - ox);
  const Dv = Math.abs(c.y - oy);
  const C = [Du, Dv];
  const s1 = Math.sqrt(Math.max(0, (Rb + rc) ** 2 - (Dv - rc) ** 2));
  const s2 = Math.sqrt(Math.max(0, (Rb + rc) ** 2 - (Du - rc) ** 2));
  const F1 = [Du + s1, rc];
  const F2 = [rc, Dv + s2];
  const unit = (p) => { const l = Math.hypot(p[0], p[1]); return [p[0] / l, p[1] / l]; };
  const onBoss = (F) => { const d = unit([F[0] - Du, F[1] - Dv]); return [Du + d[0] * Rb, Dv + d[1] * Rb]; };
  const T1 = onBoss(F1);
  const T2 = onBoss(F2);
  const mid = (F, dirA) => { const dB = unit([C[0] - F[0], C[1] - F[1]]); const m = unit([dirA[0] + dB[0], dirA[1] + dB[1]]); return [F[0] + m[0] * rc, F[1] + m[1] * rc]; };
  return draw(W([-e, -e]))
    .lineTo(W([F1[0], -e]))
    .lineTo(W([F1[0], 0]))
    .threePointsArcTo(W(T1), W(mid(F1, [0, -1])))
    .threePointsArcTo(W(T2), W([Du + Rb * S2, Dv + Rb * S2]))
    .threePointsArcTo(W([0, F2[1]]), W(mid(F2, [-1, 0])))
    .lineTo(W([-e, F2[1]]))
    .close();
}

/** Kulak: duvara gömülü dil + yuvarlak uç; duvar birleşiminde plan radyüsü rc (2B) */
function earSolid(ear, rc) {
  const toW = (u, v) => { const p = [0, 0]; p[ear.axis] = ear.wallOut + ear.dir * u; p[ear.along] = ear.a + v; return p; };
  const hw = ear.w / 2;
  const k = rc * (1 - S2);
  let pen;
  if (rc > 0.02) {
    pen = draw(toW(-EAR_EMBED, -hw - rc)).lineTo(toW(0, -hw - rc)).threePointsArcTo(toW(rc, -hw), toW(k, -hw - rc + rc * S2))
      .lineTo(toW(ear.e, -hw)).threePointsArcTo(toW(ear.e, hw), toW(ear.e + hw, 0))
      .lineTo(toW(rc, hw)).threePointsArcTo(toW(0, hw + rc), toW(k, hw + rc - rc * S2))
      .lineTo(toW(-EAR_EMBED, hw + rc));
  } else {
    pen = draw(toW(-EAR_EMBED, -hw)).lineTo(toW(ear.e, -hw)).threePointsArcTo(toW(ear.e, hw), toW(ear.e + hw, 0)).lineTo(toW(-EAR_EMBED, hw));
  }
  return pen.close().sketchOnPlane('XY', ear.z0).extrude(ear.t);
}

/** Kart kenarı alt desteği: duvar birleşiminde plan radyüsü rc (CNC), duvara gömme payı emb */
function padSolid(pd, rc, emb) {
  const axis = pd.edge[1] === 'X' ? 0 : 1;
  const dir = pd.edge[0] === '-' ? -1 : 1;
  const along = 1 - axis;
  const wall = dir < 0 ? pd.min[axis] + 0.3 : pd.max[axis] - 0.3;
  const inner = dir < 0 ? pd.max[axis] : pd.min[axis];
  const U = Math.abs(inner - wall);
  const toW = (u, v) => { const p = [0, 0]; p[axis] = wall - dir * u; p[along] = v; return p; };
  const v0 = pd.min[along];
  const v1 = pd.max[along];
  const r = Math.min(rc, U - 0.2);
  const k = r * (1 - S2);
  let pen;
  if (r > 0.05) {
    pen = draw(toW(-emb, v0 - r)).lineTo(toW(0, v0 - r)).threePointsArcTo(toW(r, v0), toW(k, v0 - r + r * S2))
      .lineTo(toW(U, v0)).lineTo(toW(U, v1)).lineTo(toW(r, v1)).threePointsArcTo(toW(0, v1 + r), toW(k, v1 + r - r * S2))
      .lineTo(toW(-emb, v1 + r));
  } else {
    pen = draw(toW(-emb, v0)).lineTo(toW(U, v0)).lineTo(toW(U, v1)).lineTo(toW(-emb, v1));
  }
  return pen.close().sketchOnPlane('XY', pd.min[2]).extrude(pd.max[2] - pd.min[2]);
}

/** Kök radyüsü: yatay düzlem (malzeme üstte, z = Z) ile aşağı inen yüz çizgisi arasında; düzleme 10° kala biter */
function rootArc(Pc, u, n, rf) {
  const t = (-rf - rf * n[1]) / u[1];
  const T1 = [Pc[0] + t * u[0], Pc[1] + t * u[1]];
  const F = [T1[0] + rf * n[0], T1[1] + rf * n[1]];
  const d = 10 * DEG;
  // düzlem teğet yönü (0, +1)'den yüz normaline (−n) doğru d kadar döndür
  const a0 = Math.atan2(1, 0);
  const a1 = Math.atan2(-n[1], -n[0]);
  let da = a1 - a0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const aE = a0 + Math.sign(da) * d;
  const E = [F[0] + rf * Math.cos(aE), F[1] + rf * Math.sin(aE)];
  const aM = (aE + a0 + da) / 2;
  const M = [F[0] + rf * Math.cos(aM), F[1] + rf * Math.sin(aM)];
  return { T1, E, M };
}

/**
 * Kapak dili kesit profili (dile dik düzlemde) uzunluğu boyunca çekilir: kökte radyüs, iki uzun yüzde çıkma açısı,
 * uçta giriş pahı. s ekseni duvara doğru (+), z dünya Z. o: { soRoot, lipT, Z, Ztip, ao, ai, ri, ro, c, emb }
 */
function lipProfile(o) {
  const depth = o.Z - o.Ztip;
  const soTip = o.soRoot - depth * tanD(o.ao);
  const siRoot = o.soRoot - o.lipT;
  const siTip = siRoot + depth * tanD(o.ai);
  const unit = (p) => { const l = Math.hypot(p[0], p[1]); return [p[0] / l, p[1] / l]; };
  const uIn = unit([siTip - siRoot, o.Ztip - o.Z]);
  const uOut = unit([soTip - o.soRoot, o.Ztip - o.Z]);
  const nIn = [uIn[1], -uIn[0]]; // boşluk −s tarafında
  const nOut = [-uOut[1], uOut[0]]; // boşluk +s tarafında
  const top = o.Z + o.emb;
  const pts = [];
  // iç kök
  if (o.ri > 0.02) {
    const a = rootArc([siRoot, o.Z], uIn, nIn, o.ri);
    pts.push({ p: [a.E[0], top] }, { p: a.E }, { p: a.T1, via: a.M });
  } else {
    pts.push({ p: [siRoot, top] }, { p: [siRoot, o.Z] });
  }
  // uç pahları
  const c = o.c;
  if (c > 0.02) {
    pts.push({ p: [siTip - c * uIn[0], o.Ztip - c * uIn[1]] }, { p: [siTip + c, o.Ztip] }, { p: [soTip - c, o.Ztip] }, { p: [soTip - c * uOut[0], o.Ztip - c * uOut[1]] });
  } else {
    pts.push({ p: [siTip, o.Ztip] }, { p: [soTip, o.Ztip] });
  }
  // dış kök
  if (o.ro > 0.02) {
    const a = rootArc([o.soRoot, o.Z], uOut, nOut, o.ro);
    pts.push({ p: a.T1 }, { p: a.E, via: a.M }, { p: [a.E[0], top] });
  } else {
    pts.push({ p: [o.soRoot, o.Z] }, { p: [o.soRoot, top] });
  }
  return pts;
}

/** Kapak dili katısı: lipBar {min,max}, merkez, kaydırma ve işlem ölçüleri */
function lipSolid(bar, g, o) {
  const alongX = bar.max[0] - bar.min[0] >= bar.max[1] - bar.min[1];
  const ax = alongX ? 1 : 0; // kesit ekseni (dile dik)
  const sideSign = (bar.min[ax] + bar.max[ax]) / 2 > g.center[ax] ? 1 : -1;
  const outerFace = sideSign > 0 ? bar.max[ax] : bar.min[ax];
  const prof = lipProfile({ ...o, lipT: bar.max[ax] - bar.min[ax], Z: g.cavTop, Ztip: bar.min[2] });
  const toLocal = ([s, z]) => [outerFace + sideSign * s, z];
  let pen = draw(toLocal(prof[0].p));
  for (const q of prof.slice(1)) pen = q.via ? pen.threePointsArcTo(toLocal(q.p), toLocal(q.via)) : pen.lineTo(toLocal(q.p));
  const drawing = pen.close();
  if (alongX) return drawing.sketchOnPlane('YZ', [bar.min[0], 0, 0]).extrude(bar.max[0] - bar.min[0]);
  return drawing.sketchOnPlane('XZ', [0, bar.max[1], 0]).extrude(bar.max[1] - bar.min[1]);
}

/** Altıgen somun cebi CNC'de köşe boşaltmalı (dogbone, takım yarıçapı) */
function hexPocketDogbone(st, r) {
  const p = st.nutPocket;
  const R = p.s / Math.sqrt(3);
  const pt = (i) => [st.x + R * Math.cos((Math.PI / 3) * i), st.y + R * Math.sin((Math.PI / 3) * i)];
  let pen = draw(pt(0));
  for (let i = 1; i < 6; i++) pen = pen.lineTo(pt(i)).customCorner(r, 'dogbone');
  return pen.closeWithCustomCorner(r, 'dogbone').sketchOnPlane('XY', p.z0).extrude(p.z1 - p.z0);
}

/** Enjeksiyonda üstten açık çentik: yan yüzler çekme yönünde açılı (yamuk), alt köşeler r; dış uç taslak payı kadar uzatılmış */
function notchDrafted(c, ta, n0, n1) {
  const dz = c.z1 - c.z0;
  const q = [[c.a0, c.z0], [c.a1, c.z0], [c.a1 + dz * ta, c.z1], [c.a0 - dz * ta, c.z1]];
  const map = c.axis === 0 ? (p) => p : (p) => [p[1], p[0]];
  let pen = draw(map(q[0]));
  for (const p of q.slice(1)) pen = pen.lineTo(map(p));
  let dr = pen.close();
  if (c.r > 0.05) {
    for (const p of q.slice(0, 2)) {
      const m = map(p);
      dr = dr.fillet(c.r, (f) => f.inBox([m[0] - 1e-3, m[1] - 1e-3], [m[0] + 1e-3, m[1] + 1e-3]));
    }
  }
  return c.axis === 0 ? dr.sketchOnPlane('YZ', [n0, 0, 0]).extrude(n1 - n0) : dr.sketchOnPlane('ZX', [0, n0, 0]).extrude(n1 - n0);
}

/** Port açıklığı dış kenarına 45° pah (CNC çapak kırma): açıklık kesitinden büyüyen loft */
function cutoutCollar(c, outerPlane, dir, brk) {
  const w = c.a1 - c.a0;
  const h = c.z1 - c.z0;
  const ac = (c.a0 + c.a1) / 2;
  const zc = (c.z0 + c.z1) / 2;
  const r = Math.max(c.r, 0.05);
  const over = 0.5;
  const g = brk + over;
  const s0 = outerPlane - dir * brk;
  const s1 = outerPlane + dir * over;
  const sk = (ww, hh, rr, s) => (c.axis === 0
    ? drawRoundedRectangle(ww, hh, rr).sketchOnPlane('YZ', [s, ac, zc])
    : drawRoundedRectangle(hh, ww, rr).sketchOnPlane('ZX', [ac, s, zc]));
  return sk(w, h, r, s0).loftWith(sk(w + 2 * g, h + 2 * g, r + g, s1), { ruled: true });
}

/** IP conta kanalı aracı: dip radyüsü, (enjeksiyonda) yan yüz açısı, üst kenar kırma; orta çizgi kaydırma payı ile */
function grooveTool(gr, cx, cy, zBot, zTop, { ta = 0, brk = 0, shift = 0, bottomR = 0 }) {
  const depth = zTop - zBot;
  const offs = [{ z: zBot, o: gr.width / 2 }];
  if (brk > 0.02) {
    // yan yüz (açılı ya da dik) ağza brk kala biter, oradan 45° kırma ağzın 0,5 mm üstüne kadar sürer
    const oBrk = gr.width / 2 + (depth - brk) * ta;
    offs.push({ z: zTop - brk, o: oBrk });
    offs.push({ z: zTop + 0.5, o: oBrk + brk + 0.5 });
  } else {
    offs.push({ z: zTop + 1, o: gr.width / 2 + (depth + 1) * ta });
  }
  const ring = (sgn) => offs.map((q) => ({ L: gr.L + 2 * shift + sgn * 2 * q.o, W: gr.W + 2 * shift + sgn * 2 * q.o, r: Math.max(gr.r + shift + sgn * q.o, 0.1), z: q.z }));
  let tool = taperSlab(ring(1), cx, cy).cut(taperSlab(ring(-1), cx, cy));
  if (bottomR > 0.02) {
    const res = edgeLadder(tool, 'fillet', bottomR, (e) => (inZ(edgePts(e), zBot) ? 1 : null));
    tool = res.shape;
    tool.__bottomR = res.factor ? bottomR * res.factor : 0;
    tool.__bottomNote = res.note;
  }
  return tool;
}

function cone(t, zTop) {
  return countersinkCone({ x: t.x, y: t.y, holeD: t.holeD, countersink: t.countersink }, zTop);
}

/* ---------- Gövde ---------- */

function buildBaseTreated(g, T, rep, st) {
  const B = T.base;
  const P = 'base';
  const [cx, cy] = g.center;
  const up = [0, 0, 1];
  const floorTop = g.z0 + g.floor;
  const hBase = g.cavTop - g.z0;
  const ta = tanD(B.draftDeg);
  const cav = g.cavity;
  const plainOuter = () => roundedSlab(g.outer.L, g.outer.W, g.outer.r, cx, cy, g.z0, hBase);
  const plainPocket = () => roundedSlab(cav.L, cav.W, cav.r, cx, cy, floorTop, hBase);
  // Politika geometri yüzünden kaynak değerine ulaşamadıysa (ör. cep köşe radyüsü küçük) raporda görünsün
  for (const l of B.limited || []) rep.add({ part: P, key: `${l.key}.limit`, feature: l.feature, kind: l.kind, size: l.want, ok: false, applied: l.got, note: l.note });

  // 1) Dış blok: enjeksiyonda z0'da anma ölçüsü, ağza doğru büyüyen loft (paralel draft, IM-16)
  let outer = null;
  let outerDraft = 0;
  if (B.draftDeg > 0) {
    const gT = hBase * ta;
    const m = tryMake(() => taperSlab([
      { L: g.outer.L, W: g.outer.W, r: g.outer.r, z: g.z0 },
      { L: g.outer.L + 2 * gT, W: g.outer.W + 2 * gT, r: g.outer.r + gT, z: g.cavTop },
    ], cx, cy));
    if (m.shape && validSolid(m.shape)) { outer = m.shape; outerDraft = B.draftDeg; }
    rep.add({ part: P, key: 'draft.outer', feature: 'dış duvar çıkma açısı', kind: 'draft', size: B.draftDeg, ok: !!outer, applied: outer ? B.draftDeg : 0,
      note: outer ? `ağızda her yanda +${numTr(gT)} mm` : `uygulanamadı (${m.err || 'geçersiz katı'})` });
  }
  if (!outer) outer = plainOuter();
  // Alt dış kenar: FDM tabla pahı / CNC çapak kırma / enjeksiyon radyüsü (IM-08)
  const bottom = B.bedChamfer > 0 ? ['chamfer', B.bedChamfer, 'bed', 'dış alt kenar (tabla pahı)']
    : B.outerEdgeBreak > 0 ? ['chamfer', B.outerEdgeBreak, 'outer.bottom', 'dış alt kenar (çapak kırma)']
      : B.outerBottomFillet > 0 ? ['fillet', B.outerBottomFillet, 'outer.bottom', 'dış alt kenar radyüsü'] : null;
  if (bottom) {
    let size = bottom[1];
    let extra = '';
    if ((g.ears || []).length && size > EAR_EMBED - 0.1) { size = EAR_EMBED - 0.1; extra = `kulak kökü ${numTr(EAR_EMBED)} mm gömülü olduğundan ${numTr(size)} mm ile sınırlandı`; }
    size = Math.min(size, 0.45 * g.floor + (bottom[0] === 'fillet' ? g.floor : 0));
    outer = treatEdges(rep, P, bottom[2], bottom[3], bottom[0], size, outer, (e) => (inZ(edgePts(e), g.z0) ? 1 : null), extra);
    if (size < 0.9 * bottom[1]) {
      rep.add({ part: P, key: `${bottom[2]}.limit`, feature: bottom[3], kind: bottom[0], size: bottom[1], ok: false, applied: r3(size),
        note: extra || `taban kalınlığı nedeniyle ${numTr(size)} mm ile sınırlandı` });
    }
  }

  // 2) Cep: taban seviyesinde anma ölçüsü, yukarı büyür (PCB boşluğu hiçbir yükseklikte azalmaz)
  let pocket = null;
  let pocketGrow = 0;
  const zPt = g.cavTop + 1;
  if (B.draftDeg > 0) {
    const gP = (zPt - floorTop) * ta;
    const m = tryMake(() => taperSlab([
      { L: cav.L, W: cav.W, r: cav.r, z: floorTop },
      { L: cav.L + 2 * gP, W: cav.W + 2 * gP, r: cav.r + gP, z: zPt },
    ], cx, cy));
    if (m.shape && validSolid(m.shape)) { pocket = m.shape; pocketGrow = (g.cavTop - floorTop) * ta; }
    rep.add({ part: P, key: 'draft.pocket', feature: 'cep (iç duvar) çıkma açısı', kind: 'draft', size: B.draftDeg, ok: !!pocket, applied: pocket ? B.draftDeg : 0,
      note: pocket ? `taban seviyesinde anma ölçüsü, ağızda her yanda +${numTr(pocketGrow)} mm` : `uygulanamadı (${m.err || 'geçersiz katı'})` });
  }
  if (!pocket) pocket = plainPocket();
  if (B.floorFillet > 0) {
    pocket = treatEdges(rep, P, 'floor', 'taban–duvar iç köşesi', 'fillet', B.floorFillet, pocket, (e) => (inZ(edgePts(e), floorTop) ? 1 : null));
  }

  let base;
  try {
    base = outer.cut(pocket);
    if (!validSolid(base)) throw new Error('geçersiz katı');
  } catch (err) {
    rep.add({ part: P, key: 'core', feature: 'gövde kabuğu', kind: 'boolean', size: 1, ok: false, applied: 0, note: `işlemli kabuk kurulamadı, işlemsiz kabuğa düşüldü (${errText(err)})` });
    base = plainOuter().cut(plainPocket());
    outerDraft = 0;
    pocketGrow = 0;
  }
  const outerGrow = outerDraft ? hBase * tanD(outerDraft) : 0;
  st.rim = { L: g.outer.L + 2 * outerGrow, W: g.outer.W + 2 * outerGrow, r: g.outer.r + outerGrow };
  st.pocketGrow = pocketGrow;
  st.baseDraft = outerDraft && pocketGrow ? B.draftDeg : 0;

  // 3) Ağız kenarları (sade kabukta, topoloji temizken): iç kenar giriş pahı, dış kenar çapak kırma
  if (B.rimLeadIn > 0 || B.rimOuterBreak > 0) {
    const pc = { L: cav.L + 2 * pocketGrow, W: cav.W + 2 * pocketGrow, r: cav.r + pocketGrow };
    const kindOf = (e) => {
      const q = edgePts(e);
      if (!inZ(q, g.cavTop)) return null;
      const dIn = Math.abs(sdfRR(q.m[0], q.m[1], cx, cy, pc.L, pc.W, pc.r));
      const dOut = Math.abs(sdfRR(q.m[0], q.m[1], cx, cy, st.rim.L, st.rim.W, st.rim.r));
      return dIn < dOut ? 'in' : 'out';
    };
    const big = Math.max(B.rimLeadIn, B.rimOuterBreak);
    const res = edgeLadder(base, 'chamfer', big, (e) => {
      const k = kindOf(e);
      return k === 'in' ? B.rimLeadIn / big || null : k === 'out' ? B.rimOuterBreak / big || null : null;
    });
    base = res.shape;
    if (B.rimLeadIn > 0) recordLadder(rep, P, 'rim.in', 'ağız iç kenarı (giriş pahı)', 'chamfer', B.rimLeadIn, res);
    if (B.rimOuterBreak > 0) recordLadder(rep, P, 'rim.out', 'ağız dış kenarı (çapak kırma)', 'chamfer', B.rimOuterBreak, res);
  }
  if (B.process === 'injection') {
    rep.add({ part: P, key: 'parting', feature: 'ayırma çizgisi (ağız dış kenarı)', kind: 'sharp', size: 0, ok: true, applied: 0, note: 'keskin bırakıldı (IM-38)' });
  }

  // 4) Eklenen özellikler (tek toplu füzyon)
  const adds = [];
  const standoffs = g.standoffs || [];
  for (const s of standoffs) {
    if (s.integral === false) continue;
    const plain = () => makeCylinder(s.od / 2, s.z1 - s.z0 + 0.5, [s.x, s.y, s.z0 - 0.5], up);
    const tipC = Math.min(B.bossTipChamfer, 0.4 * (s.od - s.holeD) / 2);
    const treats = [];
    if (B.bossRootFillet > 0) treats.push({ key: 'standoff.root', feature: 'standoff kökü radyüsü', kind: 'fillet', size: B.bossRootFillet });
    if (tipC > 0.02) treats.push({ key: 'standoff.tip', feature: 'standoff ucu pahı', kind: 'chamfer', size: tipC });
    if (B.bossDraftDeg > 0) treats.push({ key: 'standoff.draft', feature: 'standoff çıkma açısı', kind: 'draft', size: B.bossDraftDeg });
    const m = treats.length ? tryMake(() => bossSolid({ x: s.x, y: s.y, zRoot: s.z0, zTip: s.z1, rTip: s.od / 2, draftDeg: B.bossDraftDeg, rootR: B.bossRootFillet, tipC, embed: 0.5 })) : { shape: null, err: '' };
    adds.push({ key: 'standoff', feature: 'standoff', shape: m.shape, err: m.err, plain, treats });
  }
  const injEmbed = (zTopFeature) => (st.pocketGrow ? Math.max(0, zTopFeature - floorTop) * tanD(st.baseDraft) + 0.05 : 0);
  for (const pd of g.edgePads || []) {
    const plain = () => makeBox(pd.min, pd.max);
    const rc = B.process === 'cnc' ? B.concaveMinR : 0;
    const emb = 0.3 + injEmbed(pd.max[2]);
    const treats = [];
    if (rc > 0) treats.push({ key: 'pad.concave', feature: 'kart desteği–duvar iç köşesi', kind: 'fillet', size: rc });
    if (emb > 0.3 + 1e-6) treats.push({ key: 'pad.embed', feature: 'kart desteği (açılı duvara gömme)', kind: 'embed', size: r3(emb) });
    const m = treats.length && pd.edge ? tryMake(() => padSolid(pd, rc, emb)) : { shape: null, err: '' };
    adds.push({ key: 'pad', feature: 'kart desteği', shape: m.shape, err: m.err, plain, treats });
  }
  // Köşe boss'ları: 2B dış hat, iki duvar birleşiminde içbükey radyüs; enjeksiyonda kesitler arası loft (açılı duvarı izler)
  for (const c of g.cornerBosses || []) {
    const plain = () => {
      const [wx, wy] = c.wall;
      return makeCylinder(c.od / 2, c.z1 - c.z0 + 0.5, [c.x, c.y, c.z0 - 0.5], up)
        .fuse(makeBox([Math.min(wx, c.x), Math.min(wy, c.y), c.z0 - 0.5], [Math.max(wx, c.x), Math.max(wy, c.y), c.z1]));
    };
    const R = c.od / 2;
    const tb = tanD(B.bossDraftDeg);
    const tw = st.pocketGrow ? tanD(st.baseDraft) : 0;
    const za = c.z0 - 0.5;
    const zb = c.z1;
    const RbRoot = R + (zb - za) * tb;
    // Kapak dili uçları köşe boss'unun yanında: radyüs teğet noktası dil ucuna 0,3 mm kala bitmeli
    const [wx, wy] = c.wall;
    const mx = Math.sign(c.x - wx) || 1;
    const my = Math.sign(c.y - wy) || 1;
    let clearU = Infinity;
    let clearV = Infinity;
    for (const b of g.lipBars || []) {
      const alongX = b.max[0] - b.min[0] >= b.max[1] - b.min[1];
      if (alongX && Math.abs((my > 0 ? b.min[1] : b.max[1]) - wy) < 3) clearU = Math.min(clearU, mx > 0 ? b.min[0] - wx : wx - b.max[0]);
      if (!alongX && Math.abs((mx > 0 ? b.min[0] : b.max[0]) - wx) < 3) clearV = Math.min(clearV, my > 0 ? b.min[1] - wy : wy - b.max[1]);
    }
    const need = Math.max(B.concaveMinR, 0.5);
    const tangentAt = (rc) => R + Math.sqrt(Math.max(0, (RbRoot + rc) ** 2 - (R - rc) ** 2));
    let rc = Math.min(need, 0.9 * R);
    const lim = Math.min(clearU, clearV) - 0.3;
    if (tangentAt(rc) > lim) {
      let lo = 0;
      let hi = rc;
      for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (tangentAt(mid) <= lim) lo = mid; else hi = mid; }
      rc = lo;
    }
    const treats = [];
    let note = '';
    if (rc < need - 1e-3) note = `kapak dili ucu nedeniyle ${numTr(rc)} mm ile sınırlandı${B.process === 'cnc' ? '; takım burada daha büyük radyüs bırakır' : ''}`;
    if (rc > 0.05) treats.push({ key: 'corner.concave', feature: "köşe boss'u–duvar birleşimi (içbükey radyüs)", kind: 'fillet', size: r3(need), applied: r3(rc), limited: rc < 0.9 * need, note });
    if (st.pocketGrow && tb > 0) treats.push({ key: 'corner.draft', feature: "köşe boss'u çıkma açısı", kind: 'draft', size: B.bossDraftDeg });
    const e = 0.4;
    const m = rc > 0.05 ? tryMake(() => {
      if (!st.pocketGrow) return cornerOutline(c, 0, R, rc, e).sketchOnPlane('XY', za).extrude(zb - za);
      const lower = cornerOutline(c, (za - floorTop) * tw, RbRoot, rc, e).sketchOnPlane('XY', za);
      const upper = cornerOutline(c, (zb - floorTop) * tw, R, rc, e).sketchOnPlane('XY', zb);
      return lower.loftWith(upper, { ruled: true });
    }) : { shape: null, err: '' };
    if (rc <= 0.05) rep.add({ part: P, key: 'corner.concave', feature: "köşe boss'u–duvar birleşimi (içbükey radyüs)", kind: 'fillet', size: need, ok: false, applied: 0, note: 'yer yok (kapak dili ucu)' });
    adds.push({ key: 'corner', feature: "köşe boss'u", shape: m.shape, err: m.err, plain, treats });
  }
  // Montaj kulakları: 2B dış hat + duvar birleşiminde plan radyüsü; tabla/çapak pahı ilkel üstünde (gömülü uç hariç)
  for (const ear of g.ears || []) {
    const c = [ear.hx, ear.hy];
    const plain = () => {
      const min = [0, 0, ear.z0];
      const max = [0, 0, ear.z0 + ear.t];
      min[ear.axis] = Math.min(ear.wallOut - ear.dir * EAR_EMBED, c[ear.axis]);
      max[ear.axis] = Math.max(ear.wallOut - ear.dir * EAR_EMBED, c[ear.axis]);
      min[ear.along] = ear.a - ear.w / 2;
      max[ear.along] = ear.a + ear.w / 2;
      return makeBox(min, max).fuse(makeCylinder(ear.w / 2, ear.t, [c[0], c[1], ear.z0], up));
    };
    const rc = Math.min(Math.max(B.concaveMinR, 0.5), ear.e - 0.5);
    const treats = [{ key: 'ear.concave', feature: 'kulak–duvar birleşimi (plan radyüsü)', kind: 'fillet', size: r3(rc) }];
    const m = tryMake(() => {
      let s = earSolid(ear, rc);
      const outside = (q) => ear.dir * (q.m[ear.axis] - ear.wallOut) > 0.01;
      const bot = B.bedChamfer > 0 ? B.bedChamfer : B.outerEdgeBreak;
      if (bot > 0) {
        const res = edgeLadder(s, 'chamfer', Math.min(bot, ear.t / 3), (e) => { const q = edgePts(e); return inZ(q, ear.z0) && outside(q) ? 1 : null; });
        recordLadder(rep, P, 'ear.bottom', B.bedChamfer > 0 ? 'kulak alt kenarı (tabla pahı)' : 'kulak alt kenarı (çapak kırma)', 'chamfer', Math.min(bot, ear.t / 3), res);
        s = res.shape;
      }
      if (B.outerEdgeBreak > 0) {
        const res = edgeLadder(s, 'chamfer', Math.min(B.outerEdgeBreak, ear.t / 3), (e) => { const q = edgePts(e); return inZ(q, ear.z0 + ear.t) && outside(q) ? 1 : null; });
        recordLadder(rep, P, 'ear.top', 'kulak üst kenarı (çapak kırma)', 'chamfer', Math.min(B.outerEdgeBreak, ear.t / 3), res);
        s = res.shape;
      }
      return s;
    });
    if (B.process === 'injection') rep.add({ part: P, key: 'ear.draft', feature: 'kulak çıkma açısı', kind: 'draft', size: B.draftDeg, ok: false, applied: 0, note: 'kulak, ağız ayırma çizgisine göre ters açı (yan maça ya da kademeli ayırma çizgisi gerekir); açı uygulanmadı' });
    adds.push({ key: 'ear', feature: 'montaj kulağı', shape: m.shape, err: m.err, plain, treats });
  }
  base = applyBatch(rep, P, 'fuse', base, adds);

  // 5) Kesen araçlar (tek toplu kesim)
  const cuts = [];
  const plainTool = (key, feature, fn) => cuts.push({ key, feature, shape: null, plain: fn, treats: [] });
  const hs = T.holes || {};
  standoffs.forEach((s, i) => {
    plainTool('hole.standoff', 'standoff deliği', () => makeCylinder(s.holeD / 2, s.depth + 0.5, [s.x, s.y, s.z1 - s.depth], up));
    if (s.countersink) plainTool('csk.helicoil', 'Helicoil havşası', () => countersinkCone({ x: s.x, y: s.y, holeD: s.holeD, countersink: s.countersink }, s.z1));
    const en = hs.standoffs?.[i]?.entry;
    if (en) {
      const m = tryMake(() => countersinkCone({ x: s.x, y: s.y, holeD: s.holeD, countersink: en }, s.z1));
      cuts.push({ key: 'entry.standoff', feature: 'standoff deliği girişi', shape: m.shape, err: m.err, plain: () => null,
        treats: [{ key: 'entry.standoff', feature: `standoff deliği girişi (${hs.standoffs[i].method})`, kind: 'countersink', size: en.depth, note: `90° Ø${numTr(en.dTop)}` }] });
    }
    if (s.nutPocket) {
      const plain = () => nutPocketShape(s);
      if (s.nutPocket.shape === 'hex' && B.nutDogbone > 0) {
        const m = tryMake(() => hexPocketDogbone(s, B.nutDogbone));
        cuts.push({ key: 'nut', feature: 'somun cebi', shape: m.shape, err: m.err, plain,
          treats: [{ key: 'nut.dogbone', feature: 'somun cebi köşe boşaltması (dogbone)', kind: 'dogbone', size: B.nutDogbone }] });
      } else plainTool('nut', 'somun cebi', plain);
    }
    if (s.bottomCountersink) {
      const c = s.bottomCountersink;
      plainTool('csk.bottom', 'alt havşa', () => {
        const rb = s.holeD / 2;
        const rt = c.dTop / 2 + 0.5;
        return drawCircle(rt).sketchOnPlane('XY', [s.x, s.y, c.zBase - 0.5]).extrude(c.depth + 0.5, { extrusionProfile: { profile: 'linear', endFactor: rb / rt } });
      });
    }
  });
  (g.cornerBosses || []).forEach((c, i) => {
    plainTool('hole.corner', "köşe boss'u deliği", () => makeCylinder(c.holeD / 2, c.depth + 0.5, [c.x, c.y, c.z1 - c.depth], up));
    if (c.countersink) plainTool('csk.helicoil', 'Helicoil havşası', () => countersinkCone({ x: c.x, y: c.y, holeD: c.holeD, countersink: c.countersink }, c.z1));
    const en = hs.corners?.[i]?.entry;
    if (en) {
      const m = tryMake(() => countersinkCone({ x: c.x, y: c.y, holeD: c.holeD, countersink: en }, c.z1));
      cuts.push({ key: 'entry.corner', feature: "köşe boss'u deliği girişi", shape: m.shape, err: m.err, plain: () => null,
        treats: [{ key: 'entry.corner', feature: `köşe boss'u deliği girişi (${hs.corners[i].method})`, kind: 'countersink', size: en.depth, note: `90° Ø${numTr(en.dTop)}` }] });
    }
  });
  // Port açıklıkları: enjeksiyonda dış uç açılı duvar payı kadar uzar, çentik yanları açılı; CNC'de dış kenara pah
  const outerExt = outerGrow + 0.5;
  for (const c of g.cutouts || []) {
    const mid = (c.n0 + c.n1) / 2;
    const dir = mid > g.center[c.axis] ? 1 : -1;
    const outerPlane = dir > 0 ? c.n1 - 1 : c.n0 + 1;
    const ext = outerGrow > 0 ? { ...c, n0: dir < 0 ? c.n0 - outerExt : c.n0, n1: dir > 0 ? c.n1 + outerExt : c.n1 } : c;
    const plain = () => cutoutPrism(ext);
    const isNotch = c.z1 > g.cavTop;
    if (st.baseDraft && isNotch) {
      const m = tryMake(() => notchDrafted(c, tanD(st.baseDraft), ext.n0, ext.n1));
      cuts.push({ key: 'cutout', feature: 'port çentiği', shape: m.shape, err: m.err, plain,
        treats: [{ key: 'cutout.draft', feature: 'port çentiği yan yüz çıkma açısı', kind: 'draft', size: st.baseDraft }] });
    } else {
      plainTool('cutout', 'port açıklığı', plain);
      if (st.baseDraft && !isNotch) rep.add({ part: P, key: 'cutout.window', feature: 'yan duvar penceresi', kind: 'draft', size: 0, ok: true, applied: 0, note: 'kapalı pencere kalıpta yan maça ister (IM-36); çekme yönünde açı gerekmez' });
    }
    if (B.cutoutBreak > 0) {
      const m = tryMake(() => cutoutCollar(c, outerPlane, dir, B.cutoutBreak));
      cuts.push({ key: 'cutout.break', feature: 'port açıklığı dış kenarı', shape: m.shape, err: m.err, plain: () => null,
        treats: [{ key: 'cutout.break', feature: 'port açıklığı dış kenarı (çapak kırma)', kind: 'chamfer', size: B.cutoutBreak }] });
    }
  }
  (g.ears || []).forEach((ear, i) => {
    const r = ear.d / 2;
    const h = ear.t + 1;
    const zc = ear.z0 - 0.5;
    if (ear.slot > 0) {
      const o = [0, 0];
      o[ear.slotAxis] = ear.slot / 2;
      const min = [ear.hx - (ear.slotAxis === 0 ? ear.slot / 2 : r), ear.hy - (ear.slotAxis === 1 ? ear.slot / 2 : r), zc];
      const max = [ear.hx + (ear.slotAxis === 0 ? ear.slot / 2 : r), ear.hy + (ear.slotAxis === 1 ? ear.slot / 2 : r), zc + h];
      plainTool('hole.ear', 'kulak uzun deliği', () => makeBox(min, max).fuse(makeCylinder(r, h, [ear.hx - o[0], ear.hy - o[1], zc], up)).fuse(makeCylinder(r, h, [ear.hx + o[0], ear.hy + o[1], zc], up)));
    } else {
      plainTool('hole.ear', 'kulak deliği', () => makeCylinder(r, h, [ear.hx, ear.hy, zc], up));
      const en = hs.ears?.[i]?.entry;
      if (en) {
        const m = tryMake(() => countersinkCone({ x: ear.hx, y: ear.hy, holeD: ear.d, countersink: en }, ear.z0 + ear.t));
        cuts.push({ key: 'entry.ear', feature: 'kulak deliği girişi', shape: m.shape, err: m.err, plain: () => null,
          treats: [{ key: 'entry.ear', feature: 'kulak deliği girişi (çapak kırma)', kind: 'countersink', size: en.depth }] });
      }
    }
  });
  for (const mh of g.mountHoles || []) plainTool('hole.mount', 'taban montaj deliği', () => makeCylinder(mh.d / 2, g.floor + 1, [mh.x, mh.y, g.z0 - 0.5], up));
  // Panel elemanları: enjeksiyonda duvar o yükseklikte dışa kaydığı için delik uzatılır, lamba duvarla birlikte kaydırılır
  const wallShift = (axis, p, z) => {
    const dir = p > g.center[axis] ? 1 : -1;
    const half = (axis === 0 ? cav.L : cav.W) / 2;
    const halfO = (axis === 0 ? g.outer.L : g.outer.W) / 2;
    const dIn = Math.abs(Math.abs(p - g.center[axis]) - half);
    const dOut = Math.abs(Math.abs(p - g.center[axis]) - halfO);
    const gz = dIn < dOut ? (z - floorTop) * tanD(st.baseDraft) : (z - g.z0) * tanD(st.baseDraft);
    return { dir, gz: Math.max(0, gz) };
  };
  for (const sp of (g.panelSpots || []).filter((x) => x.part === 'base')) {
    plainTool('panel.spot', 'panel lambası', () => {
      const dir = [0, 0, 0];
      dir[sp.axis] = 1;
      const p = [...sp.p];
      if (st.baseDraft && sp.axis !== 2) {
        const w = wallShift(sp.axis, sp.p[sp.axis] + sp.len / 2, sp.p[2]);
        p[sp.axis] += w.dir * w.gz;
      }
      return makeCylinder(sp.r, sp.len, p, dir);
    });
  }
  for (const h of (g.panelHoles || []).filter((x) => x.part === 'base')) {
    plainTool('panel.hole', 'panel deliği', () => {
      if (!st.baseDraft || h.axis === 2) return panelHoleShape(h);
      const ext = (h.p[2] - g.z0) * tanD(st.baseDraft) + 0.05;
      const dir = h.p[h.axis] + h.len / 2 > g.center[h.axis] ? 1 : -1;
      const p = [...h.p];
      if (dir < 0) p[h.axis] -= ext;
      return panelHoleShape({ ...h, p, len: h.len + ext });
    });
  }
  // IP conta kanalı: dip radyüsü (Parker), kenar kırma, enjeksiyonda yan yüz açısı; orta çizgi duvarla birlikte kayar
  if (g.groove) {
    const gr = g.groove;
    const z = g.cavTop - gr.depth;
    const plain = () => {
      const outerRing = roundedSlab(gr.L + gr.width, gr.W + gr.width, gr.r + gr.width / 2, cx, cy, z, gr.depth + 1);
      const innerRing = roundedSlab(gr.L - gr.width, gr.W - gr.width, Math.max(gr.r - gr.width / 2, 0.1), cx, cy, z, gr.depth + 1);
      return outerRing.cut(innerRing);
    };
    const shift = st.baseDraft ? (pocketGrow + outerGrow) / 2 : 0;
    const ta2 = st.baseDraft ? tanD(st.baseDraft) : 0;
    const treats = [];
    if (B.grooveEdgeBreak > 0) treats.push({ key: 'groove.break', feature: 'conta kanalı üst kenarları', kind: 'chamfer', size: B.grooveEdgeBreak });
    if (ta2 > 0) treats.push({ key: 'groove.draft', feature: 'conta kanalı yan yüz açısı (Parker 0–5°)', kind: 'draft', size: st.baseDraft });
    if (shift > 0) treats.push({ key: 'groove.shift', feature: 'conta kanalı orta çizgisi (açılı duvar)', kind: 'offset', size: r3(shift) });
    const m = tryMake(() => grooveTool(gr, cx, cy, z, g.cavTop, { ta: ta2, brk: B.grooveEdgeBreak, shift, bottomR: B.grooveBottomR }));
    if (B.grooveBottomR > 0) {
      const ap = m.shape ? m.shape.__bottomR || 0 : 0;
      rep.add({ part: P, key: 'groove.bottom', feature: 'conta kanalı dip radyüsü', kind: 'fillet', size: B.grooveBottomR, ok: ap >= B.grooveBottomR - 1e-6, applied: ap,
        note: m.shape ? (ap >= B.grooveBottomR - 1e-6 ? '' : `uygulanamadı (${m.shape.__bottomNote || ''})`) : `uygulanamadı (${m.err})` });
    }
    cuts.push({ key: 'groove', feature: 'conta kanalı', shape: m.shape, err: m.err, plain, treats });
  }
  base = applyBatch(rep, P, 'cut', base, cuts.filter((c) => c.shape || c.plain));
  return base;
}

/* ---------- Kapak ---------- */

function buildLidTreated(g, T, rep, st) {
  const L = T.lid;
  const B = T.base;
  const P = 'lid';
  const [cx, cy] = g.center;
  const up = [0, 0, 1];
  const rim = st.rim;
  const lidT = g.zTop - g.cavTop;
  const plainPlate = () => roundedSlab(rim.L, rim.W, rim.r, cx, cy, g.cavTop, lidT);
  let lid = null;
  if (L.draftDeg > 0) {
    const gT = lidT * tanD(L.draftDeg);
    const m = tryMake(() => taperSlab([
      { L: rim.L, W: rim.W, r: rim.r, z: g.cavTop },
      { L: rim.L - 2 * gT, W: rim.W - 2 * gT, r: Math.max(rim.r - gT, 0.05), z: g.zTop },
    ], cx, cy));
    if (m.shape && validSolid(m.shape)) lid = m.shape;
    rep.add({ part: P, key: 'draft.plate', feature: 'kapak yan yüzü çıkma açısı', kind: 'draft', size: L.draftDeg, ok: !!lid, applied: lid ? L.draftDeg : 0,
      note: lid ? 'ayırma çizgisi kapak alt dış kenarında, gövde ağız hattıyla aynı' : `uygulanamadı (${m.err || 'geçersiz katı'})` });
  }
  if (!lid) lid = plainPlate();
  if (st.rim.L > g.outer.L + 1e-6) rep.add({ part: P, key: 'outline', feature: 'kapak dış hattı = gövde ağız hattı', kind: 'offset', size: r3((st.rim.L - g.outer.L) / 2), ok: true, applied: r3((st.rim.L - g.outer.L) / 2), note: 'gövdenin açılı dış duvarına göre büyütüldü' });
  // Üst dış kenar: FDM tabla pahı (dış yüz tablada) / CNC çapak kırma / enjeksiyon kozmetik radyüs
  const top = L.bedChamfer > 0 ? ['chamfer', L.bedChamfer, 'bed', 'kapak üst dış kenarı (tabla pahı)']
    : L.outerEdgeBreak > 0 ? ['chamfer', L.outerEdgeBreak, 'outer.top', 'kapak üst dış kenarı (çapak kırma)']
      : L.outerTopFillet > 0 ? ['fillet', L.outerTopFillet, 'outer.top', 'kapak üst dış kenarı (kozmetik radyüs)'] : null;
  if (top) lid = treatEdges(rep, P, top[2], top[3], top[0], Math.min(top[1], 0.45 * lidT + (top[0] === 'fillet' ? 0.3 * lidT : 0)), lid, (e) => (inZ(edgePts(e), g.zTop) ? 1 : null));
  if (L.outerEdgeBreak > 0) lid = treatEdges(rep, P, 'outer.bottom', 'kapak alt dış kenarı (çapak kırma)', 'chamfer', Math.min(L.outerEdgeBreak, 0.3 * lidT), lid, (e) => (inZ(edgePts(e), g.cavTop) ? 1 : null));
  if (L.process === 'injection') rep.add({ part: P, key: 'parting', feature: 'ayırma çizgisi (kapak alt dış kenarı)', kind: 'sharp', size: 0, ok: true, applied: 0, note: 'keskin bırakıldı (IM-38)' });

  const adds = [];
  for (const pr of g.edgePressers || []) adds.push({ key: 'presser', feature: 'kart baskı dili', shape: null, plain: () => makeBox(pr.min, pr.max), treats: [] });
  // Kapak dili: kesit profili (kök radyüsü, iki yüzde açı, uç pahı), gövde cebi açılıysa dışa kaydırılır
  const fit = T.lipFit ?? 0.2;
  const tB = st.pocketGrow ? tanD(st.baseDraft) : 0;
  for (const bar of g.lipBars || []) {
    const plain = () => makeBox(bar.min, bar.max);
    const depth = bar.max[2] - bar.min[2];
    const lipT = Math.min(bar.max[0] - bar.min[0], bar.max[1] - bar.min[1]);
    let ao = L.lipDraftDeg;
    let ai = L.lipDraftDeg;
    // Uç kalınlığı kökün %60'ından aşağı inmesin
    const thin = depth * (tanD(ao) + tanD(ai));
    if (thin > 0.4 * lipT) { const k = (0.4 * lipT) / thin; ao = Math.atan(tanD(ao) * k) / DEG; ai = Math.atan(tanD(ai) * k) / DEG; }
    const shift = st.pocketGrow - depth * Math.max(0, tB - tanD(ao));
    const gapRoot = fit + depth * Math.max(0, tB - tanD(ao));
    // Kök radyüsü dil boyunun %40'ını ve dil kalınlığını geçmez; dış yüzde gövde ağzındaki boşluk + giriş pahı kadar
    const ri = Math.min(L.lipRootFillet, 0.4 * depth, lipT);
    const ro = Math.max(0, Math.min(ri, gapRoot + (B.rimLeadIn || 0) - 0.05));
    const c = Math.min(L.lipTipChamfer, 0.4 * (lipT - depth * (tanD(ao) + tanD(ai))), 0.4 * depth);
    const treats = [];
    if (ri > 0) treats.push({ key: 'lip.root', feature: 'kapak dili kökü radyüsü (iç / dış)', kind: 'fillet', size: ri, note: ro < ri - 1e-6 ? `dış yüzde ${numTr(ro)} mm (gövde ağzına boşluk)` : '' });
    if (c > 0.02) treats.push({ key: 'lip.tip', feature: 'kapak dili ucu (giriş pahı)', kind: 'chamfer', size: r3(c) });
    if (ao > 0) treats.push({ key: 'lip.draft', feature: 'kapak dili çıkma açısı', kind: 'draft', size: r3(ao) });
    if (shift > 1e-4) treats.push({ key: 'lip.shift', feature: 'kapak dili (açılı cebe göre dışa kaydırma)', kind: 'offset', size: r3(shift) });
    const m = treats.length ? tryMake(() => lipSolid(bar, g, { soRoot: shift, ao, ai, ri, ro, c, emb: 0.3 })) : { shape: null, err: '' };
    adds.push({ key: 'lip', feature: 'kapak dili', shape: m.shape, err: m.err, plain, treats });
  }
  for (const t of g.lidTubes || []) {
    const plain = () => makeCylinder(t.od / 2, t.z1 - t.z0 + 0.5, [t.x, t.y, t.z0], up);
    const tipC = Math.min(L.bossTipChamfer, 0.4 * (t.od - t.holeD) / 2);
    const treats = [];
    if (L.tubeRootFillet > 0) treats.push({ key: 'tube.root', feature: 'kapak borusu kökü radyüsü', kind: 'fillet', size: L.tubeRootFillet });
    if (tipC > 0.02) treats.push({ key: 'tube.tip', feature: 'kapak borusu ucu pahı', kind: 'chamfer', size: r3(tipC) });
    if (L.bossDraftDeg > 0) treats.push({ key: 'tube.draft', feature: 'kapak borusu çıkma açısı', kind: 'draft', size: L.bossDraftDeg });
    const m = treats.length ? tryMake(() => bossSolid({ x: t.x, y: t.y, zRoot: t.z1, zTip: t.z0, rTip: t.od / 2, draftDeg: L.bossDraftDeg, rootR: L.tubeRootFillet, tipC, embed: 0.5 })) : { shape: null, err: '' };
    adds.push({ key: 'tube', feature: 'kapak borusu', shape: m.shape, err: m.err, plain, treats });
  }
  for (const hh of g.lidHoles || []) {
    if (hh.pad) adds.push({ key: 'lidpad', feature: 'köşe vidası yastığı', shape: null, plain: () => makeCylinder(hh.pad.od / 2, hh.pad.h + 0.3, [hh.x, hh.y, g.cavTop - hh.pad.h], up), treats: [] });
  }
  lid = applyBatch(rep, P, 'fuse', lid, adds);

  const cuts = [];
  const plainTool = (key, feature, fn) => cuts.push({ key, feature, shape: null, plain: fn, treats: [] });
  const hs = T.holes || {};
  const entryCut = (key, feature, x, y, holeD, en) => {
    const m = tryMake(() => countersinkCone({ x, y, holeD, countersink: en }, g.zTop));
    cuts.push({ key, feature, shape: m.shape, err: m.err, plain: () => null, treats: [{ key, feature: `${feature} (çapak kırma)`, kind: 'countersink', size: en.depth }] });
  };
  (g.lidTubes || []).forEach((t, i) => {
    plainTool('hole.tube', 'kapak vida deliği', () => makeCylinder(t.holeD / 2, g.zTop - t.z0 + 1, [t.x, t.y, t.z0 - 0.5], up));
    if (t.countersink) plainTool('csk.tube', 'havşa', () => countersinkCone(t, g.zTop));
    if (t.counterbore) plainTool('cbore.tube', 'gömme oyuk', () => makeCylinder(t.counterbore.d / 2, t.counterbore.depth + 0.5, [t.x, t.y, g.zTop - t.counterbore.depth], up));
    const en = hs.lidTubes?.[i]?.entry;
    if (en) entryCut('entry.tube', 'kapak vida deliği girişi', t.x, t.y, t.holeD, en);
  });
  (g.lidHoles || []).forEach((hh, i) => {
    const zb = g.cavTop - (hh.pad ? hh.pad.h : 0) - 0.5;
    plainTool('hole.lid', 'köşe vidası deliği', () => makeCylinder(hh.holeD / 2, g.zTop - zb + 0.5, [hh.x, hh.y, zb], up));
    if (hh.countersink) plainTool('csk.lid', 'havşa', () => countersinkCone({ x: hh.x, y: hh.y, holeD: hh.holeD, countersink: hh.countersink }, g.zTop));
    if (hh.counterbore) plainTool('cbore.lid', 'gömme oyuk', () => makeCylinder(hh.counterbore.d / 2, hh.counterbore.depth + 0.5, [hh.x, hh.y, g.zTop - hh.counterbore.depth], up));
    const en = hs.lidHoles?.[i]?.entry;
    if (en) entryCut('entry.lid', 'köşe vidası deliği girişi', hh.x, hh.y, hh.holeD, en);
  });
  for (const sp of (g.panelSpots || []).filter((x) => x.part === 'lid')) plainTool('panel.spot', 'panel lambası', () => makeCylinder(sp.r, sp.len, sp.p, up));
  for (const h of (g.panelHoles || []).filter((x) => x.part === 'lid')) plainTool('panel.hole', 'panel deliği', () => panelHoleShape(h));
  lid = applyBatch(rep, P, 'cut', lid, cuts);
  return lid;
}

/* ---------- DIN klipsi ---------- */

/** Kilit dili yarığı: kök ucunda dil yüzüne teğet R ≥ 0,5·t daire (anahtar deliği), açık uç plaka dışında */
function keyholeSlot(s, R, slot) {
  const rootIsU1 = Math.abs(s.u1) < Math.abs(s.u0);
  const ur = rootIsU1 ? s.u1 : s.u0;
  const uo = rootIsU1 ? s.u0 : s.u1;
  const k = Math.sign(ur - uo) || 1;
  const v0 = s.v0;
  const cu = ur - k * R;
  const ux = cu - k * Math.sqrt(Math.max(0, R * R - (R - slot) ** 2));
  return draw([uo, v0]).lineTo([cu, v0]).threePointsArcTo([ux, v0 + slot], [ur, v0 + R]).lineTo([uo, v0 + slot]).close()
    .sketchOnPlane('XY', s.z0).extrude(s.z1 - s.z0);
}

function buildClipTreated(dn, T, rep) {
  const C = T.clip;
  const P = 'clip';
  const up = [0, 0, 1];
  let pen = draw(dn.profile[0]);
  for (const p of dn.profile.slice(1)) pen = pen.lineTo(p);
  let clip = pen.close().sketchOnPlane('YZ', [-dn.L / 2, 0, 0]).extrude(dn.L);
  // Üst yüz (kutuya oturan, FDM'de tablaya gelen) kenarları
  const topOp = C.bedChamfer > 0 ? [C.bedChamfer, 'bed', 'klips üst yüz kenarı (tabla pahı)'] : C.outerEdgeBreak > 0 ? [C.outerEdgeBreak, 'outer.top', 'klips üst yüz kenarı (çapak kırma)'] : null;
  if (topOp) clip = treatEdges(rep, P, topOp[1], topOp[2], 'chamfer', Math.min(topOp[0], 0.3 * dn.t), clip, (e) => (inZ(edgePts(e), 0) ? 1 : null));
  const lc = dn.latchCut;
  const cuts = [{ key: 'latchcut', feature: 'kilit kancası boşluğu', shape: null, plain: () => makeBox([lc.u0, lc.v0, lc.z0], [lc.u1, lc.v1, lc.z1]), treats: [] }];
  const slotW = dn.slots[0] ? dn.slots[0].v1 - dn.slots[0].v0 : 1.5;
  const R = Math.max(C.latchRootR, slotW / 2);
  for (const s of dn.slots) {
    const m = tryMake(() => keyholeSlot(s, R, slotW));
    cuts.push({ key: 'slot', feature: 'kilit dili yarığı', shape: m.shape, err: m.err, plain: () => makeBox([s.u0, s.v0, s.z0], [s.u1, s.v1, s.z1]),
      treats: [{ key: 'latch.root', feature: 'kilit dili kökü (yuvarlak yarık ucu)', kind: 'fillet', size: r3(R), note: `R ≥ 0,5·t (t ${numTr(dn.t)} mm)` }] });
  }
  clip = applyBatch(rep, P, 'cut', clip, cuts, 'yarık');
  const adds = [];
  for (const b of dn.bosses) {
    const plain = () => makeCylinder(dn.bossD / 2, -dn.tp + 0.5 - dn.bossZ, [b.u, b.v, dn.bossZ], up);
    const rootR = Math.max(0, Math.min(C.bossRootFillet, RAIL_CHANNEL_HALF - 0.1 - (Math.abs(b.v) + dn.bossD / 2)));
    const tipC = Math.min(C.bossTipChamfer, 0.4 * (dn.bossD - dn.holeD) / 2);
    const treats = [];
    if (C.bossRootFillet > 0) treats.push({ key: 'boss.root', feature: "klips boss'u kökü", kind: 'fillet', size: C.bossRootFillet, applied: r3(rootR), limited: rootR < 0.9 * C.bossRootFillet, note: rootR < C.bossRootFillet - 1e-6 ? 'ray kanalı (TS35) nedeniyle küçültüldü' : '' });
    if (tipC > 0.02) treats.push({ key: 'boss.tip', feature: "klips boss'u ucu pahı", kind: 'chamfer', size: r3(tipC) });
    const m = treats.length ? tryMake(() => bossSolid({ x: b.u, y: b.v, zRoot: -dn.tp, zTip: dn.bossZ, rTip: dn.bossD / 2, rootR, tipC, embed: 0.5 })) : { shape: null, err: '' };
    adds.push({ key: 'boss', feature: "klips boss'u", shape: m.shape, err: m.err, plain, treats });
  }
  clip = applyBatch(rep, P, 'fuse', clip, adds);
  const holes = [];
  const en = T.holes?.clip?.entry;
  for (const b of dn.bosses) {
    holes.push({ key: 'hole.clip', feature: 'klips vida deliği', shape: null, plain: () => makeCylinder(dn.holeD / 2, dn.depth + 0.5, [b.u, b.v, -dn.depth], up), treats: [] });
    if (en) {
      const m = tryMake(() => countersinkCone({ x: b.u, y: b.v, holeD: dn.holeD, countersink: en }, 0));
      holes.push({ key: 'entry.clip', feature: 'klips deliği girişi', shape: m.shape, err: m.err, plain: () => null,
        treats: [{ key: 'entry.clip', feature: `klips deliği girişi (${T.holes.clip.method})`, kind: 'countersink', size: en.depth }] });
    }
  }
  clip = applyBatch(rep, P, 'cut', clip, holes, 'delik');
  if (dn.axis === 1) clip = clip.rotate(90, [0, 0, 0], [0, 0, 1]);
  return clip.translate([dn.center[0], dn.center[1], dn.z0]);
}

/** İşlemli üretim: gövde, kapak, klips + işlem raporu. Beklenmedik hata olursa işlemsiz üretime düşer. */
function buildTreated(g) {
  const T = g.treat;
  const rep = makeReport();
  const st = { rim: { L: g.outer.L, W: g.outer.W, r: g.outer.r }, pocketGrow: 0, baseDraft: 0 };
  const legacy = () => buildEnclosure(g);
  let base;
  let lid;
  let clip = null;
  try {
    base = buildBaseTreated(g, T, rep, st);
  } catch (err) {
    rep.add({ part: 'base', key: 'all', feature: 'gövde (tüm işlemler)', kind: 'build', size: 1, ok: false, applied: 0, note: `işlemsiz gövdeye düşüldü (${errText(err)})` });
    st.rim = { L: g.outer.L, W: g.outer.W, r: g.outer.r };
    st.pocketGrow = 0;
    st.baseDraft = 0;
    base = null;
  }
  try {
    lid = buildLidTreated(g, T, rep, st);
  } catch (err) {
    rep.add({ part: 'lid', key: 'all', feature: 'kapak (tüm işlemler)', kind: 'build', size: 1, ok: false, applied: 0, note: `işlemsiz kapağa düşüldü (${errText(err)})` });
    lid = null;
  }
  if (g.din) {
    try {
      clip = T.clip ? buildClipTreated(g.din, T, rep) : buildClip(g.din);
    } catch (err) {
      rep.add({ part: 'clip', key: 'all', feature: 'DIN klipsi (tüm işlemler)', kind: 'build', size: 1, ok: false, applied: 0, note: `işlemsiz klipse düşüldü (${errText(err)})` });
      clip = null;
    }
  }
  if (!base || !lid || (g.din && !clip)) {
    const old = legacy();
    base = base || old.base;
    lid = lid || old.lid;
    if (g.din) clip = clip || old.clip;
  }
  return { base, lid, clip, treatReport: rep.list() };
}

/* ---------- Montaj: bağlantı ve panel elemanlarının basit katıları (assembly.js tanımlarından) ---------- */

const AX_PLANE = ['YZ', 'ZX', 'XY'];

function axisOf(dir) {
  const a = [0, 1, 2].reduce((best, k) => (Math.abs(dir[k]) > Math.abs(dir[best]) ? k : best), 0);
  return { a, s: Math.sign(dir[a]) || 1 };
}

function boreCut(shape, p, a, start, h, rIn) {
  if (!rIn) return shape;
  const d = [0, 0, 0];
  d[a] = 1;
  const q = [...p];
  q[a] = start - 0.1;
  return shape.cut(makeCylinder(rIn, h + 0.2, q, d));
}

function primShape(pr) {
  if (pr.k === 'box') return makeBox(pr.min, pr.max);
  if (pr.k === 'cone') {
    return drawCircle(pr.r0).sketchOnPlane('XY', pr.p).extrude(pr.h, { extrusionProfile: { profile: 'linear', endFactor: pr.r1 / pr.r0 } });
  }
  const { a, s } = axisOf(pr.dir);
  const start = s > 0 ? pr.p[a] : pr.p[a] - pr.h;
  const origin = [...pr.p];
  origin[a] = start;
  let shape;
  if (pr.k === 'hex') {
    const R = pr.af / Math.sqrt(3);
    let pen = draw([R, 0]);
    for (let i = 1; i < 6; i++) pen = pen.lineTo([R * Math.cos((Math.PI / 3) * i), R * Math.sin((Math.PI / 3) * i)]);
    shape = pen.close().sketchOnPlane(AX_PLANE[a], origin).extrude(pr.h);
  } else {
    const d = [0, 0, 0];
    d[a] = 1;
    shape = makeCylinder(pr.r, pr.h, origin, d);
  }
  return boreCut(shape, origin, a, start, pr.h, pr.rIn);
}

let itemCache = { key: null, shapes: null };
/** items: [{ name, part, color, prims }] → [{ shape, name, color, part }] (son istek önbellekte) */
function buildItems(items) {
  const key = JSON.stringify(items);
  if (itemCache.key === key) return itemCache.shapes;
  const shapes = [];
  for (const it of items) {
    try {
      const list = it.prims.map(primShape);
      shapes.push({ shape: list.length === 1 ? list[0] : makeCompound(list), name: it.name, color: it.color, part: it.part });
    } catch (err) {
      console.warn('Montaj elemanı kurulamadı:', it.name, err);
    }
  }
  itemCache = { key, shapes };
  return shapes;
}

/** Patlatılmış montaj (kapak ve kapak elemanları yukarı) — izdüşüm için tek bileşik */
function explodedAssembly(items, explode) {
  const { base, lid, clip } = lastShapes;
  const up = [0, 0, explode];
  const list = [base.clone(), lid.clone().translate(up)];
  const down = [0, 0, -Math.max(15, explode * 0.9)];
  if (clip) list.push(clip.clone().translate(down));
  for (const it of buildItems(items)) list.push(it.part === 'lid' ? it.shape.clone().translate(up) : it.part === 'clip' ? it.shape.clone().translate(down) : it.shape.clone());
  return makeCompound(list);
}

async function makeAssemblyStep(id, items, names) {
  if (!lastShapes) throw new Error('Önce muhafaza oluşturulmalı.');
  const { base, lid, clip } = lastShapes;
  const parts = buildItems(items);
  const step = await exportSTEP([
    { shape: base, name: names.base, color: '#8fa7bd' },
    { shape: lid, name: names.lid, color: '#c3d0dc' },
    ...(clip ? [{ shape: clip, name: names.clip || 'DIN_klipsi', color: '#6f8396' }] : []),
    ...parts.map((x) => ({ shape: x.shape, name: x.name, color: x.color })),
  ]).arrayBuffer();
  self.postMessage({ id, type: 'assemblyStep', step, count: parts.length }, [step]);
}

function packMesh(shape) {
  const m = shape.mesh(MESH_OPTS);
  return {
    position: new Float32Array(m.vertices),
    normal: new Float32Array(m.normals),
    index: new Uint32Array(m.triangles),
  };
}

function project(shape, view) {
  const cam = VIEW_CAMERAS[view];
  const p = drawProjection(shape, new ProjectionCamera([0, 0, 0], cam.dir, cam.x));
  return { visible: p.visible.toSVGPaths().flat(), hidden: p.hidden.toSVGPaths().flat() };
}

async function makeDrawing(id, assembly = null) {
  if (!lastShapes) throw new Error('Önce muhafaza oluşturulmalı.');
  const t0 = performance.now();
  const { base, lid } = lastShapes;
  const views = {
    base: Object.fromEntries(['top', 'front', 'back', 'right', 'left'].map((v) => [v, project(base, v)])),
    lid: Object.fromEntries(['top', 'bottom', 'front'].map((v) => [v, project(lid, v)])),
  };
  if (assembly) {
    try {
      views.assembly = { iso: project(explodedAssembly(assembly.items, assembly.explode), 'iso') };
    } catch (err) {
      console.warn('Montaj izdüşümü üretilemedi', err);
    }
  }
  self.postMessage({ id, type: 'drawing', views, ms: performance.now() - t0 });
}

self.onmessage = async (ev) => {
  if (ev.data.type === 'drawing' || ev.data.type === 'assemblyStep') {
    try {
      await init();
      if (ev.data.type === 'drawing') await makeDrawing(ev.data.id, ev.data.assembly || null);
      else await makeAssemblyStep(ev.data.id, ev.data.items || [], ev.data.names);
    } catch (err) {
      self.postMessage({ id: ev.data.id, type: 'error', message: (err && err.message) || String(err) });
    }
    return;
  }
  const { id, geometry, names } = ev.data;
  try {
    self.postMessage({ id, type: 'progress', stage: 'engine' });
    await init();
    self.postMessage({ id, type: 'progress', stage: 'build' });

    const t0 = performance.now();
    // geometry.treat (treat.js) varsa DFM kenar işlemleriyle; yoksa eski davranış aynen
    const { base, lid, clip, treatReport } = geometry.treat ? buildTreated(geometry) : buildEnclosure(geometry);
    const treatMs = performance.now() - t0;
    lastShapes = { base, lid, clip };
    const meshes = { base: packMesh(base), lid: packMesh(lid) };
    const volumes = { base: measureVolume(base), lid: measureVolume(lid) };
    if (clip) { meshes.clip = packMesh(clip); volumes.clip = measureVolume(clip); }

    const step = await exportSTEP([
      { shape: base, name: names.base, color: '#8fa7bd' },
      { shape: lid, name: names.lid, color: '#c3d0dc' },
      ...(clip ? [{ shape: clip, name: names.clip || 'DIN_klipsi', color: '#6f8396' }] : []),
    ]).arrayBuffer();
    const stlBase = await base.blobSTL(STL_OPTS).arrayBuffer();
    const stlLid = await lid.blobSTL(STL_OPTS).arrayBuffer();
    const stlClip = clip ? await clip.blobSTL(STL_OPTS).arrayBuffer() : null;
    const buildMs = performance.now() - t0;

    const transfer = [step, stlBase, stlLid, ...(stlClip ? [stlClip] : [])];
    for (const m of Object.values(meshes)) transfer.push(m.position.buffer, m.normal.buffer, m.index.buffer);
    const msg = { id, type: 'result', meshes, volumes, files: { step, stlBase, stlLid, stlClip }, buildMs };
    if (treatReport) {
      msg.treatReport = treatReport;
      msg.solidMs = treatMs;
      // Ölçülen sınır kutuları (çıkma açısı / kapak dış hattı denetimi için)
      const bb = (s) => { try { return s.boundingBox.bounds.map((p) => p.map(r3)); } catch (err) { return null; } };
      msg.bounds = { base: bb(base), lid: bb(lid), clip: clip ? bb(clip) : null };
    }
    self.postMessage(msg, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
