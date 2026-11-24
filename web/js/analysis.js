/*
 * PCB montaj analizi (M0).
 * Girdi: occt-import-js'in düğüm ağacı ve üçgen ağları (dünya koordinatında, mm).
 * Çıktı: PCB'nin konumu/ölçüsü, bileşenlerin taraf ve yükseklikleri,
 *        kart kenarına yakın veya taşan bileşenler (konnektör adayları).
 * Saf fonksiyonlardır; three.js veya DOM'a bağımlı değildir.
 */

export const AXES = ['X', 'Y', 'Z'];

const BOARD_NAME = /(pcb|board|kart|plaket)/i;
const BOARD_MIN_THICKNESS = 0.2; // mm
const BOARD_MAX_THICKNESS = 6.0; // mm (kalın / metal çekirdekli kartlar dahil)
const OVERHANG_TOL = 0.05; // mm

export const DEFAULT_OPTIONS = {
  edgeMargin: 1.0, // mm: kart kenarına bu kadar yakın bileşen "kenarda" sayılır
};

function emptyBox() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function isEmptyBox(b) {
  return !(b.min[0] <= b.max[0]);
}

function unionInto(target, b) {
  for (let k = 0; k < 3; k++) {
    if (b.min[k] < target.min[k]) target.min[k] = b.min[k];
    if (b.max[k] > target.max[k]) target.max[k] = b.max[k];
  }
  return target;
}

export function boxSize(b) {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

function boxCenter(b, k) {
  return (b.min[k] + b.max[k]) / 2;
}

export function computeBox(position) {
  const b = emptyBox();
  for (let i = 0; i < position.length; i += 3) {
    const x = position[i], y = position[i + 1], z = position[i + 2];
    if (x < b.min[0]) b.min[0] = x;
    if (x > b.max[0]) b.max[0] = x;
    if (y < b.min[1]) b.min[1] = y;
    if (y > b.max[1]) b.max[1] = y;
    if (z < b.min[2]) b.min[2] = z;
    if (z > b.max[2]) b.max[2] = z;
  }
  return b;
}

function gatherMeshes(node, out) {
  if (node.meshes) out.push(...node.meshes);
  if (node.children) for (const c of node.children) gatherMeshes(c, out);
  return out;
}

function makePart(id, name, meshIdx, meshBoxes) {
  const box = emptyBox();
  for (const i of meshIdx) unionInto(box, meshBoxes[i]);
  return { id, name, meshIdx, box, isBoard: false, side: null, height: 0, above: 0, below: 0, edges: [], outside: false };
}

/**
 * Bileşen seviyesini bulur: kökten başlayıp tek çocuklu sarmalayıcı düğümleri atlar
 * (ör. kök → kart montajı → bileşenler). Bulunan düğümün her çocuğu bir bileşendir.
 */
function collectParts(root, meshes, meshBoxes) {
  let node = root;
  while (node.children && node.children.length === 1 && !(node.meshes && node.meshes.length)) {
    node = node.children[0];
  }

  const groups = [];
  if (!node.children || node.children.length === 0) {
    groups.push({ node, name: node.name });
  } else {
    if (node.meshes && node.meshes.length) groups.push({ node: { meshes: node.meshes }, name: node.name });
    for (const c of node.children) groups.push({ node: c, name: c.name });
  }

  const parts = [];
  for (const g of groups) {
    const idx = gatherMeshes(g.node, []);
    if (!idx.length) continue;
    const name = g.name || meshes[idx[0]].name || `Parça ${parts.length + 1}`;
    parts.push(makePart(parts.length, name, idx, meshBoxes));
  }
  return parts;
}

/** 'Modul.step-1-solid3' → 'Modul' gibi CAD eklerini temizler. */
export function cleanComponentName(seg) {
  return String(seg || '')
    .replace(/-solid\d+$/i, '')
    .replace(/\.(step|stp)(-\d+)?$/i, '')
    .replace(/-solid\d+$/i, '')
    .trim();
}

/**
 * Tek gövdeye düzleştirilmiş montajlarda gövdeleri ad yoluna göre bileşenlere ayırır.
 * Ör. 'Kart_i.step-1/Waveshare.step-1/Waveshare-0.step-1-solid9' → bileşen 'Waveshare'.
 * Ortak kök segmenti (üst montaj adı) atılır. İsimsiz gövdeler tek başına kalır.
 */
function splitByNamePath(meshIdx, meshes, meshBoxes) {
  const segs = meshIdx.map((i) => (meshes[i].name || '').split('/').map((s) => s.trim()));
  let drop = 0;
  while (segs[0][drop] && segs.every((s) => s.length > drop + 1 && s[drop] === segs[0][drop])) drop++;

  const groups = new Map();
  meshIdx.forEach((mi, k) => {
    const raw = segs[k][drop] || '';
    const key = cleanComponentName(raw);
    const mapKey = key ? 'n:' + key : 'm:' + mi;
    if (!groups.has(mapKey)) groups.set(mapKey, { name: key, meshIdx: [] });
    groups.get(mapKey).meshIdx.push(mi);
  });

  let unnamed = 0;
  return [...groups.values()].map((g, id) =>
    makePart(id, g.name || `Gövde ${++unnamed}`, g.meshIdx, meshBoxes));
}

/** İnce ve geniş plaka olan parçaya yüksek puan verir; isim eşleşmesi puanı artırır. */
function boardScore(part) {
  const s = boxSize(part.box).slice().sort((a, b) => a - b);
  const [t, b, a] = s;
  if (!(t >= BOARD_MIN_THICKNESS && t <= BOARD_MAX_THICKNESS)) return 0;
  if (b < 5 * t || b < 5) return 0;
  let score = a * b;
  if (BOARD_NAME.test(part.name)) score *= 4;
  return score;
}

function argMin(arr) {
  let k = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] < arr[k]) k = i;
  return k;
}

export function analyzeAssembly(root, meshes, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const warnings = [];
  const meshBoxes = meshes.map((m) => computeBox(m.position));
  const triangleCount = meshes.reduce((s, m) => s + m.index.length / 3, 0);

  let parts = collectParts(root, meshes, meshBoxes).filter((p) => !isEmptyBox(p.box));
  if (parts.length === 0) throw new Error('Dosyada 3B geometri bulunamadı.');

  if (parts.length === 1 && parts[0].meshIdx.length > 1) {
    const solidCount = parts[0].meshIdx.length;
    const namedCount = parts[0].meshIdx.filter((i) => meshes[i].name).length;
    parts = splitByNamePath(parts[0].meshIdx, meshes, meshBoxes);
    if (namedCount > 0 && parts.length < solidCount) {
      warnings.push({
        level: 'info',
        text: `Dosyada montaj yapısı yok (tek parça olarak kaydedilmiş). ${solidCount} gövde, adlarına göre ${parts.length} bileşene gruplandı.`,
      });
    } else {
      warnings.push({
        level: 'warn',
        text: `Dosyada montaj yapısı ve gövde adı yok; ${solidCount} gövdenin her biri ayrı bileşen sayıldı. Mümkünse STEP'i montaj olarak dışa aktar.`,
      });
    }
  }

  const assemblyBox = parts.reduce((acc, p) => unionInto(acc, p.box), emptyBox());

  // PCB tespiti
  let board = null;
  let bestScore = 0;
  for (const p of parts) {
    const s = boardScore(p);
    if (s > bestScore) { bestScore = s; board = p; }
  }

  const result = {
    units: 'mm',
    partCount: parts.length,
    meshCount: meshes.length,
    triangleCount,
    assemblyBox,
    assemblySize: boxSize(assemblyBox),
    board: null,
    maxAbove: null,
    maxBelow: null,
    envelope: null,
    counts: { top: 0, bottom: 0, edge: 0, overhang: 0, outside: 0 },
    parts,
    warnings,
    options: opts,
  };

  if (!board) {
    const trNum = (v) => String(v).replace('.', ',');
    warnings.push({
      level: 'warn',
      text: `PCB tespit edilemedi: ${trNum(BOARD_MIN_THICKNESS)}–${trNum(BOARD_MAX_THICKNESS)} mm kalınlıkta geniş bir plaka bulunamadı. Ölçüler tüm montaja göre verildi.`,
    });
    return result;
  }

  board.isBoard = true;
  board.side = 'board';
  const bs = boxSize(board.box);
  const n = argMin(bs);
  const [u, v] = [0, 1, 2].filter((k) => k !== n);
  const top = board.box.max[n];
  const bottom = board.box.min[n];
  const mid = (top + bottom) / 2;

  const detectedBy = [];
  if (BOARD_NAME.test(board.name)) detectedBy.push('isim');
  detectedBy.push('geometri');

  if (n !== 2) {
    warnings.push({
      level: 'warn',
      text: `Kart ${AXES[n]} eksenine dik duruyor (beklenen: Z). Yükseklikler ${AXES[n]} eksenine göre hesaplandı.`,
    });
  }

  let maxAbove = { value: 0, part: null };
  let maxBelow = { value: 0, part: null };
  const inPlane = { min: [board.box.min[u], board.box.min[v]], max: [board.box.max[u], board.box.max[v]] };
  const edgeMargin = opts.edgeMargin;

  for (const p of parts) {
    if (p === board) continue;
    p.above = Math.max(0, p.box.max[n] - top);
    p.below = Math.max(0, bottom - p.box.min[n]);
    p.side = boxCenter(p.box, n) >= mid ? 'top' : 'bottom';
    p.height = p.side === 'top' ? p.above : p.below;
    result.counts[p.side]++;
    if (p.above > maxAbove.value) maxAbove = { value: p.above, part: p };
    if (p.below > maxBelow.value) maxBelow = { value: p.below, part: p };

    p.outside = [u, v].some((k) => p.box.max[k] < board.box.min[k] || p.box.min[k] > board.box.max[k]);
    if (p.outside) result.counts.outside++;

    p.edges = [];
    for (const k of [u, v]) {
      const overMinus = board.box.min[k] - p.box.min[k];
      const overPlus = p.box.max[k] - board.box.max[k];
      const gapMinus = p.box.min[k] - board.box.min[k];
      const gapPlus = board.box.max[k] - p.box.max[k];
      if (overMinus > OVERHANG_TOL) p.edges.push({ side: '-' + AXES[k], kind: 'overhang', value: overMinus });
      else if (gapMinus <= edgeMargin) p.edges.push({ side: '-' + AXES[k], kind: 'near', value: Math.max(0, gapMinus) });
      if (overPlus > OVERHANG_TOL) p.edges.push({ side: '+' + AXES[k], kind: 'overhang', value: overPlus });
      else if (gapPlus <= edgeMargin) p.edges.push({ side: '+' + AXES[k], kind: 'near', value: Math.max(0, gapPlus) });
    }
    if (p.edges.length) result.counts.edge++;
    if (p.edges.some((e) => e.kind === 'overhang')) result.counts.overhang++;

    inPlane.min[0] = Math.min(inPlane.min[0], p.box.min[u]);
    inPlane.min[1] = Math.min(inPlane.min[1], p.box.min[v]);
    inPlane.max[0] = Math.max(inPlane.max[0], p.box.max[u]);
    inPlane.max[1] = Math.max(inPlane.max[1], p.box.max[v]);
  }

  const envBox = emptyBox();
  envBox.min[u] = inPlane.min[0]; envBox.max[u] = inPlane.max[0];
  envBox.min[v] = inPlane.min[1]; envBox.max[v] = inPlane.max[1];
  envBox.min[n] = bottom - maxBelow.value; envBox.max[n] = top + maxAbove.value;

  result.board = {
    partId: board.id,
    name: board.name,
    box: board.box,
    axes: { u: AXES[u], v: AXES[v], n: AXES[n] },
    length: bs[u],
    width: bs[v],
    thickness: bs[n],
    top,
    bottom,
    detectedBy,
  };
  const ref = (m) => ({ value: m.value, partId: m.part ? m.part.id : null, name: m.part ? m.part.name : null });
  result.maxAbove = ref(maxAbove);
  result.maxBelow = ref(maxBelow);
  result.envelope = {
    box: envBox,
    length: inPlane.max[0] - inPlane.min[0],
    width: inPlane.max[1] - inPlane.min[1],
    height: bs[n] + maxAbove.value + maxBelow.value,
  };

  if (result.counts.outside > 0) {
    warnings.push({
      level: 'warn',
      text: `${result.counts.outside} parça kartın izdüşümünün tamamen dışında (ör. kablo, ayrı mekanik parça). Zarf ölçüsüne dahil edildi.`,
    });
  }
  return result;
}
