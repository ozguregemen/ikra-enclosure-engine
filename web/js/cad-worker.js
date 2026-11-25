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
  makeBox,
  makeCylinder,
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
    base = base.fuse(makeCylinder(s.od / 2, s.z1 - s.z0 + 0.5, [s.x, s.y, s.z0 - 0.5], up));
  }
  // İnsert / kılavuz / sac vidası deliği: üstten açık, kör delik
  for (const s of standoffs) {
    base = base.cut(makeCylinder(s.holeD / 2, s.depth + 0.5, [s.x, s.y, s.z1 - s.depth], up));
    // Helicoil yuvası girişinde 90° havşa
    if (s.countersink) base = base.cut(countersinkCone({ x: s.x, y: s.y, holeD: s.holeD, countersink: s.countersink }, s.z1));
  }
  // Port açıklıkları (konnektörler için duvar kesimi)
  for (const c of g.cutouts || []) {
    base = base.cut(cutoutPrism(c));
  }
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
  }
  return { base, lid };
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

async function makeDrawing(id) {
  if (!lastShapes) throw new Error('Önce muhafaza oluşturulmalı.');
  const t0 = performance.now();
  const { base, lid } = lastShapes;
  const views = {
    base: Object.fromEntries(['top', 'front', 'back', 'right', 'left'].map((v) => [v, project(base, v)])),
    lid: Object.fromEntries(['top', 'bottom', 'front'].map((v) => [v, project(lid, v)])),
  };
  self.postMessage({ id, type: 'drawing', views, ms: performance.now() - t0 });
}

self.onmessage = async (ev) => {
  if (ev.data.type === 'drawing') {
    try {
      await init();
      await makeDrawing(ev.data.id);
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
    const { base, lid } = buildEnclosure(geometry);
    lastShapes = { base, lid };
    const meshes = { base: packMesh(base), lid: packMesh(lid) };
    const volumes = { base: measureVolume(base), lid: measureVolume(lid) };

    const step = await exportSTEP([
      { shape: base, name: names.base, color: '#8fa7bd' },
      { shape: lid, name: names.lid, color: '#c3d0dc' },
    ]).arrayBuffer();
    const stlBase = await base.blobSTL(STL_OPTS).arrayBuffer();
    const stlLid = await lid.blobSTL(STL_OPTS).arrayBuffer();
    const buildMs = performance.now() - t0;

    const transfer = [step, stlBase, stlLid];
    for (const m of Object.values(meshes)) transfer.push(m.position.buffer, m.normal.buffer, m.index.buffer);
    self.postMessage({ id, type: 'result', meshes, volumes, files: { step, stlBase, stlLid }, buildMs }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
