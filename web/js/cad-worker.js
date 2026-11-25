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
  makeBox,
  makeCylinder,
  exportSTEP,
  measureVolume,
} from 'https://cdn.jsdelivr.net/npm/replicad@1.2.1/+esm';

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

self.onmessage = async (ev) => {
  const { id, geometry, names } = ev.data;
  try {
    self.postMessage({ id, type: 'progress', stage: 'engine' });
    await init();
    self.postMessage({ id, type: 'progress', stage: 'build' });

    const t0 = performance.now();
    const { base, lid } = buildEnclosure(geometry);
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
