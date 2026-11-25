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
    const { base, lid, clip } = buildEnclosure(geometry);
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
    self.postMessage({ id, type: 'result', meshes, volumes, files: { step, stlBase, stlLid, stlClip }, buildMs }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
