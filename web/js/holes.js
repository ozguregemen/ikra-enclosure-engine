/*
 * PCB montaj deliği tespiti (M2).
 * occt-import-js her ağ için B-rep yüzlerinin üçgen aralıklarını verir (faces[].first/last).
 * Kart gövdesindeki dikey (normali yatay) ve kart kalınlığı boyunca uzanan yüzlere
 * çember oturtulur; normali merkeze bakan (iç bükey) ve 360°'ye yakın kapsayan yüzler deliktir.
 * Saf fonksiyonlardır.
 */

const MAX_NORMAL_Z = 0.3;
const MIN_RADIUS = 0.3;
const MAX_RADIUS = 6;
const FULL_SPAN_DEG = 300;
export const MOUNT_MIN_D = 2.0; // mm: bundan küçük delikler pad/via sayılır
export const MOUNT_MAX_D = 6.5;

/** Kasa yöntemiyle en küçük kareler çember uydurma. pts: [[x, y], ...] */
export function fitCircle(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= n; my /= n;
  // u = x - mx, v = y - my; u² + v² + D u + E v + F = 0
  let suu = 0, suv = 0, svv = 0, su = 0, sv = 0, suz = 0, svz = 0, sz = 0;
  for (const [x, y] of pts) {
    const u = x - mx, v = y - my, z = u * u + v * v;
    suu += u * u; suv += u * v; svv += v * v; su += u; sv += v;
    suz += u * z; svz += v * z; sz += z;
  }
  // Normal denklemler: [suu suv su; suv svv sv; su sv n] [D E F]^T = -[suz svz sz]^T
  const A = [[suu, suv, su], [suv, svv, sv], [su, sv, n]];
  const b = [-suz, -svz, -sz];
  const sol = solve3(A, b);
  if (!sol) return null;
  const [D, E, F] = sol;
  const cx = -D / 2, cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  let err = 0;
  for (const [x, y] of pts) {
    const d = Math.hypot(x - mx - cx, y - my - cy) - r;
    err += d * d;
  }
  return { x: cx + mx, y: cy + my, r, rms: Math.sqrt(err / n) };
}

function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = m[r][c] / m[c][c];
      for (let j = c; j < 4; j++) m[r][j] -= k * m[c][j];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

function angularSpan(pts, cx, cy) {
  const a = pts.map(([x, y]) => Math.atan2(y - cy, x - cx)).sort((p, q) => p - q);
  let maxGap = a[0] + 2 * Math.PI - a[a.length - 1];
  for (let i = 1; i < a.length; i++) maxGap = Math.max(maxGap, a[i] - a[i - 1]);
  return 2 * Math.PI - maxGap;
}

/**
 * meshes: occt-import-js ağları; boardMeshIdx: kart parçasının ağ indeksleri;
 * board: analysis.board; obstacleBoxes: kart dışındaki gövdelerin kutuları.
 * Dönüş: { holes: [{x, y, d, mount, occupiedBy}], notches: n }
 */
export function detectBoardHoles(meshes, boardMeshIdx, board, obstacleBoxes = []) {
  const t = board.thickness;
  const cands = [];
  for (const mi of boardMeshIdx) {
    const m = meshes[mi];
    if (!m.faces || !m.faces.length || !m.normal) continue;
    for (const f of m.faces) {
      const vset = new Set();
      for (let tri = f.first; tri <= f.last; tri++) {
        for (let k = 0; k < 3; k++) vset.add(m.index[tri * 3 + k]);
      }
      if (vset.size < 6) continue;
      let ok = true;
      let zlo = Infinity, zhi = -Infinity;
      const pts = [];
      const nrm = [];
      for (const vi of vset) {
        const nz = m.normal[vi * 3 + 2];
        if (Math.abs(nz) > MAX_NORMAL_Z) { ok = false; break; }
        const z = m.position[vi * 3 + 2];
        if (z < zlo) zlo = z;
        if (z > zhi) zhi = z;
        pts.push([m.position[vi * 3], m.position[vi * 3 + 1]]);
        nrm.push([m.normal[vi * 3], m.normal[vi * 3 + 1]]);
      }
      if (!ok || zhi - zlo < 0.6 * t) continue;
      const c = fitCircle(pts);
      if (!c || c.r < MIN_RADIUS || c.r > MAX_RADIUS) continue;
      if (c.rms > 0.01 + 0.02 * c.r) continue;
      let dot = 0;
      pts.forEach(([x, y], i) => { dot += nrm[i][0] * (x - c.x) + nrm[i][1] * (y - c.y); });
      cands.push({ x: c.x, y: c.y, r: c.r, span: angularSpan(pts, c.x, c.y), concave: dot < 0 });
    }
  }

  // Aynı deliğe ait yüzleri birleştir (silindirler çoğu zaman iki yarım yüz olarak gelir)
  const groups = [];
  for (const c of cands) {
    const g = groups.find((q) => Math.hypot(q.x - c.x, q.y - c.y) < 0.05 && Math.abs(q.r - c.r) < 0.05 && q.concave === c.concave);
    if (g) g.span = Math.min(2 * Math.PI, g.span + c.span);
    else groups.push({ ...c });
  }

  const holes = [];
  let notches = 0;
  for (const g of groups) {
    if (!g.concave) continue;
    if (g.span * 180 / Math.PI < FULL_SPAN_DEG) { notches++; continue; }
    const d = 2 * g.r;
    // Delikten geçen bir gövde var mı (bacak, pin, vida)?
    let occupiedBy = null;
    for (const o of obstacleBoxes) {
      const b = o.box;
      if (b.max[2] < board.bottom || b.min[2] > board.top) continue;
      const nx = Math.max(b.min[0], Math.min(g.x, b.max[0]));
      const ny = Math.max(b.min[1], Math.min(g.y, b.max[1]));
      if (Math.hypot(nx - g.x, ny - g.y) < g.r - 0.05) { occupiedBy = o.name; break; }
    }
    holes.push({
      x: g.x,
      y: g.y,
      d,
      mount: d >= MOUNT_MIN_D && d <= MOUNT_MAX_D && !occupiedBy,
      occupiedBy,
    });
  }
  holes.sort((p, q) => q.d - p.d || p.y - q.y || p.x - q.x);
  return { holes, notches };
}
