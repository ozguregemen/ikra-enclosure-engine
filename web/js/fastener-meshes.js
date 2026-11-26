/*
 * Bağlantı elemanlarının gerçekçi 3B modelleri (yalnızca görsel; katı modele girmez).
 * - Vida: döndürme profilli baş, başa oyulmuş tahrik izi (yıldız, yarık, altıgen, torx),
 *   helisel ISO diş profili (metrikte pahlı uç, sac vidasında sivri uç)
 * - Isıyla gömülen insert: ters yönlü iki helisel tırtıl bandı, ara kanal, iç metrik diş
 * - Helicoil: elmas kesitli helisel tel
 * Yerel koordinat: Z yukarı, 0 = oturma yüzü (vida) / üst yüz (burç).
 */
import * as THREE from 'three';
import { headProfile, headTop, driveOutline } from './screw-shapes.js';

const TAU = Math.PI * 2;
const HEX_E_VIS = 2 / Math.sqrt(3);
const COARSE_P = { M2: 0.4, 'M2.5': 0.45, M3: 0.5, M4: 0.7, M5: 0.8, M6: 1.0 };
export const pitchFor = (size, d) => COARSE_P[size] ?? Math.max(0.35, 0.15 * d);

/** Paylaşılan PBR malzemeler; envMap verilirse metal yansıması gerçekçi görünür */
export function createFastenerMaterials(envMap = null) {
  const common = envMap ? { envMap, envMapIntensity: 1.0 } : {};
  const pair = (color, metalness, roughness, recessColor) => ({
    body: new THREE.MeshStandardMaterial({ color, metalness, roughness, ...common }),
    recess: new THREE.MeshStandardMaterial({ color: recessColor, metalness, roughness: Math.min(1, roughness + 0.15), side: THREE.DoubleSide, ...common }),
  });
  const finishes = {
    stainless: pair(0xd3d7dc, 1.0, 0.3, 0x8e959c),
    zinc: pair(0xc3ccd9, 1.0, 0.35, 0x86909c),
    black: pair(0x2c2e33, 0.8, 0.45, 0x17181b),
    brass: pair(0xd9ad55, 1.0, 0.32, 0x9a7a35),
    nylon: pair(0xece7da, 0.0, 0.55, 0xc9c3b4),
  };
  return {
    steel: finishes.stainless.body,
    steelDark: finishes.stainless.recess,
    brass: finishes.brass.body,
    brassInner: new THREE.MeshStandardMaterial({ color: 0xb08a3c, metalness: 1.0, roughness: 0.4, side: THREE.BackSide, ...common }),
    wire: new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 1.0, roughness: 0.25, ...common }),
    finishes,
    // Panel elemanları
    gold: new THREE.MeshStandardMaterial({ color: 0xe2b858, metalness: 1.0, roughness: 0.22, ...common }),
    ptfe: new THREE.MeshStandardMaterial({ color: 0xf4f2ec, metalness: 0.0, roughness: 0.5, side: THREE.DoubleSide }),
    plasticDark: new THREE.MeshStandardMaterial({ color: 0x3b3e44, metalness: 0.0, roughness: 0.55, side: THREE.DoubleSide }),
    plasticGray: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.0, roughness: 0.5, side: THREE.DoubleSide }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1d1e21, metalness: 0.0, roughness: 0.92 }),
    cable: new THREE.MeshStandardMaterial({ color: 0x6b6f75, metalness: 0.0, roughness: 0.6 }),
    clear: new THREE.MeshPhysicalMaterial({ color: 0xe8f6ff, metalness: 0.0, roughness: 0.08, transparent: true, opacity: 0.55, clearcoat: 1, ...common }),
  };
}

const finishOf = (mats, finish) => mats.finishes?.[finish] || mats.finishes?.stainless || { body: mats.steel, recess: mats.steelDark };

/* ---------- Pul ---------- */

/**
 * w: { kind: 'flat' | 'serrated' | 'spring', d1, d2, s, teeth?, b?, material: { finish } }
 * Dönen grup alt yüz z=0, üst yüz z=s.
 */
export function buildWasher(w, mats) {
  const mat = finishOf(mats, w.material?.finish || 'stainless').body;
  const r1 = w.d1 / 2;
  const r2 = w.d2 / 2;
  const group = new THREE.Group();
  if (w.kind === 'flat') {
    const c = Math.min(0.08, w.s * 0.25);
    group.add(new THREE.Mesh(lathe([[r1, 0], [r2 - c, 0], [r2, c], [r2, w.s - c], [r2 - c, w.s], [r1, w.s], [r1, 0]], 48), mat));
    return group;
  }
  const shape = new THREE.Shape();
  if (w.kind === 'serrated') {
    // Dış dişli tırtıllı pul: dişler hafif bükük (üst yüzde çapraz eğim yerine basit sivri dişler)
    const n = (w.teeth || 9) * 2;
    for (let i = 0; i <= n * 3; i++) {
      const a = (i / (n * 3)) * TAU;
      const ph = (i % 3) / 3;
      const rr = i % 6 < 3 ? r2 - (r2 - r1) * 0.35 * ph : r2 - (r2 - r1) * 0.35 * (1 - ph);
      if (i === 0) shape.moveTo(rr * Math.cos(a), rr * Math.sin(a)); else shape.lineTo(rr * Math.cos(a), rr * Math.sin(a));
    }
    const hole = new THREE.Path();
    hole.absarc(0, 0, r1, 0, TAU, true);
    shape.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(shape, { depth: w.s, bevelEnabled: false, curveSegments: 32 });
    group.add(new THREE.Mesh(g, mat));
    return group;
  }
  // Yaylı rondela: yarıklı halka, yarık uçları kalınlık kadar ayrık (helisel)
  const gap = 0.12;
  shape.absarc(0, 0, r2, gap, TAU - gap, false);
  shape.absarc(0, 0, r1, TAU - gap, gap, true);
  const g = new THREE.ExtrudeGeometry(shape, { depth: w.s, bevelEnabled: false, curveSegments: 40 });
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const a = Math.atan2(pos.getY(i), pos.getX(i));
    const t = ((a + TAU) % TAU) / TAU; // 0..1 çevre boyunca
    pos.setZ(i, pos.getZ(i) + (t - 0.5) * w.s * 0.8);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.position.z = w.s * 0.4;
  group.add(m);
  return group;
}

/* ---------- Yardımcılar ---------- */

/**
 * Z ekseni çevresinde (θ, z) ızgarasından yüzey. rFn(θ, z) yarıçap verir.
 * inward: normaller eksene doğru (iç yüzey, ör. burç deliği).
 */
function revolvedGrid(z0, z1, rows, segs, rFn, inward = false) {
  const pos = new Float32Array((rows + 1) * (segs + 1) * 3);
  let k = 0;
  for (let i = 0; i <= rows; i++) {
    const z = z0 + ((z1 - z0) * i) / rows;
    for (let j = 0; j <= segs; j++) {
      const t = (j / segs) * TAU;
      const r = rFn(t, z);
      pos[k++] = r * Math.cos(t);
      pos[k++] = r * Math.sin(t);
      pos[k++] = z;
    }
  }
  const idx = [];
  const w = segs + 1;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * w + j;
      const b = a + 1;
      const c = a + w + 1;
      const d = a + w;
      if (inward) idx.push(a, c, b, a, d, c);
      else idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** ISO diş profili (bir adım içinde 0..1): tepe düzlüğü P/8, dip düzlüğü P/4, 60° yanaklar */
function threadProfile(u) {
  if (u < 0.125) return 1;
  if (u < 0.4375) return 1 - (u - 0.125) / 0.3125;
  if (u < 0.6875) return 0;
  return (u - 0.6875) / 0.3125;
}
const frac = (x) => x - Math.floor(x);

/** Profil noktalarından Z ekseni etrafında döndürme yüzeyi (LatheGeometry, Z yukarı) */
function lathe(points, segs) {
  const g = new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segs);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Çokgenin işaretli alanı (> 0: saat yönü tersi) */
function area(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Başa oyulmuş tahrik izi: üstte outline, derinlikte ölçeklenmiş alt kontur, tabanda merkeze koni.
 * Duvarlar ve taban tek geometri; iki yüzlü malzemeyle çizilir.
 */
function recessGeometry(outline, depth, bottomScale, cone) {
  const top = area(outline) < 0 ? [...outline].reverse() : outline;
  const n = top.length;
  const bot = top.map(([x, y]) => [x * bottomScale, y * bottomScale]);
  const v = [];
  const quad = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < n; i++) {
    const p = top[i];
    const q = top[(i + 1) % n];
    const pb = bot[i];
    const qb = bot[(i + 1) % n];
    quad([p[0], p[1], 0], [pb[0], pb[1], -depth], [qb[0], qb[1], -depth], [q[0], q[1], 0]);
  }
  // Taban: konik (altıgen/torx/yıldız) ya da düz (yarık)
  const zc = -depth - cone;
  for (let i = 0; i < n; i++) {
    const pb = bot[i];
    const qb = bot[(i + 1) % n];
    v.push(pb[0], pb[1], -depth, 0, 0, zc, qb[0], qb[1], -depth);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** Dışbükey küçük çentik (Pozidriv imi): düşey duvarlar ve düz taban */
function markGeometry(poly, depth) {
  const top = area(poly) < 0 ? [...poly].reverse() : poly;
  const n = top.length;
  const v = [];
  for (let i = 0; i < n; i++) {
    const p = top[i];
    const q = top[(i + 1) % n];
    v.push(p[0], p[1], 0, p[0], p[1], -depth, q[0], q[1], -depth, p[0], p[1], 0, q[0], q[1], -depth, q[0], q[1], 0);
  }
  for (let i = 1; i < n - 1; i++) v.push(top[0][0], top[0][1], -depth, top[i + 1][0], top[i + 1][1], -depth, top[i][0], top[i][1], -depth);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/* ---------- Vida ---------- */

/** Profilde (dış kenardan merkeze inen tepe kısmı) r yarıçapındaki yükseklik */
function profileHeightAt(prof, r) {
  for (let i = prof.length - 2; i >= 0; i--) {
    const [x0, y0] = prof[i];
    const [x1, y1] = prof[i + 1];
    if (x0 >= r && x1 <= r && x0 > x1) return y0 + ((y1 - y0) * (x0 - r)) / (x0 - x1);
  }
  return prof[prof.length - 1][1];
}

/**
 * s: { head, headD, headDActual, headH, headF?, headV?, d, length, P, tapping, driveKind, drive, driveA, driveM, recess? }
 * Dönen grup oturma yüzü z=0 olacak şekilde; çağıran (x, y, z) konumuna taşır.
 */
export function buildScrew(s, mats) {
  const fm = finishOf(mats, s.finish);
  const group = new THREE.Group();
  const k = s.headH;
  const sunk = s.head === 'countersunk';
  const shape = { head: s.head, dk: s.headD, dkActual: s.headDActual, k, d: s.d, driveKind: s.driveKind, drive: s.drive, A: s.driveA, m: s.driveM,
    f: s.headF || 0, v: s.headV || 0, recess: s.recess || null };

  // Baş: profilin dış kısmı (merkez diski hariç) + tahrik izi delikli üst yüz
  const prof = headProfile(shape);
  let outer = prof.slice(1, -1);
  outer.unshift([s.d / 2 * 0.98, prof[0][1]]);
  let flatR = outer[outer.length - 1][0];
  let topZ = headTop(shape);
  const rawOutlines = driveOutline(shape);
  if (shape.f > 0 || shape.v > 0) {
    // Bombeli tepe (ISO 7047/7051 bombeli havşa, DIN 7985): iz bombeye düz oyulur; profil izin sığdığı yarıçapta kesilir
    const rim = outer.reduce((m, [x]) => Math.max(m, x), 0);
    const need = rawOutlines.length ? Math.max(...rawOutlines.flat().map(([x, y]) => Math.hypot(x, y))) / 0.9 : 0.5 * rim;
    const rCut = Math.min(need, 0.85 * rim);
    const yCut = profileHeightAt(prof, rCut);
    const lastIn = outer.findIndex((p, i) => i > 1 && p[0] < rCut);
    outer = (lastIn > 0 ? outer.slice(0, lastIn) : outer).concat([[rCut, yCut]]);
    flatR = rCut;
    topZ = yCut;
  }
  if (s.head === 'socket') {
    // ISO 4762 başı: yan yüzde düz tırtıl (≈0,5 mm adım), alt halka ve üst pah döndürme profili
    const r = s.headD / 2;
    const ch = outer[2][1]; // pahın başladığı yükseklik
    const N = Math.max(18, Math.round((Math.PI * s.headD) / 0.5));
    const kd = Math.min(0.08, 0.015 * s.headD);
    group.add(new THREE.Mesh(lathe(outer.slice(0, 2), 48), fm.body));
    group.add(new THREE.Mesh(revolvedGrid(0, ch, 2, N * 4, (t) => {
      const w = frac((N * t) / TAU);
      return r - kd * 2 * Math.abs(w - 0.5);
    }), fm.body));
    group.add(new THREE.Mesh(lathe(outer.slice(2), 48), fm.body));
  } else {
    group.add(new THREE.Mesh(lathe(outer, 48), fm.body));
  }

  let outline = (rawOutlines[0] || []).map(([x, y]) => [x, y]);
  // Pozidriv imi (ince çentikler): yıldızla aynı ölçekte, sığ oyuk
  let marks = rawOutlines.slice(1);
  if (outline.length) {
    const maxR = Math.max(...outline.map(([x, y]) => Math.hypot(x, y)));
    if (maxR > 0.9 * flatR) {
      const sc = (0.9 * flatR) / maxR;
      outline = outline.map(([x, y]) => [x * sc, y * sc]);
      marks = marks.map((p) => p.map(([x, y]) => [x * sc, y * sc]));
    }
  }
  const face = new THREE.Shape();
  face.absarc(0, 0, flatR, 0, TAU, false);
  if (outline.length) face.holes.push(new THREE.Path(outline.map(([x, y]) => new THREE.Vector2(x, y))));
  for (const p of marks) face.holes.push(new THREE.Path(p.map(([x, y]) => new THREE.Vector2(x, y))));
  const faceGeom = new THREE.ShapeGeometry(face, 48);
  faceGeom.translate(0, 0, topZ);
  group.add(new THREE.Mesh(faceGeom, fm.body));
  for (const p of marks) {
    const mg = markGeometry(p, Math.min(0.12 * k, 0.25));
    mg.translate(0, 0, topZ);
    group.add(new THREE.Mesh(mg, fm.recess));
  }

  if (outline.length) {
    const kind = s.driveKind;
    const maxR = Math.max(...outline.map(([x, y]) => Math.hypot(x, y)));
    const depth = kind === 'cross' ? 0.55 * k : kind === 'slot' ? 0.5 * k : (s.head === 'button' ? 0.55 : 0.5) * k;
    const bottomScale = kind === 'cross' ? 0.3 : kind === 'slot' ? 1 : 0.94;
    const cone = kind === 'slot' ? 0 : kind === 'cross' ? 0.35 * maxR : maxR * 0.94 * Math.tan((31 * Math.PI) / 180);
    const rec = recessGeometry(outline, Math.min(depth, 0.85 * (sunk ? k : k)), bottomScale, cone);
    rec.translate(0, 0, topZ);
    group.add(new THREE.Mesh(rec, fm.recess));
  }

  // Gövde: helisel diş; metrikte 45° pah, sac vidasında sivri uç (form C)
  const P = s.P || pitchFor(s.size, s.d);
  const rMaj = s.d / 2;
  const depthT = s.tapping ? 0.33 * P : 0.6134 * P;
  const rMin = rMaj - depthT;
  const zTop = sunk ? -k + 0.01 : 0.01;
  const zTip = -s.length;
  const tipLen = s.tapping ? Math.min(1.8 * P, 0.45 * s.length) : Math.min(0.9 * P, 0.3 * s.length);
  const rTip = s.tapping ? 0.12 * s.d : rMin * 0.92;
  const turns = (zTop - zTip) / P;
  const rows = Math.max(12, Math.ceil(turns * 10));
  const shaft = revolvedGrid(zTip, zTop, rows, 40, (t, z) => {
    const u = frac((z - zTip) / P + t / TAU);
    let r = rMin + (rMaj - rMin) * threadProfile(u);
    const lim = rTip + ((z - zTip) / tipLen) * (rMaj - rTip);
    if (lim < r) r = Math.max(rTip, lim);
    return r;
  });
  group.add(new THREE.Mesh(shaft, fm.body));
  // Uç kapağı
  const cap = new THREE.CircleGeometry(rTip * 1.02, 24);
  cap.rotateX(Math.PI);
  cap.translate(0, 0, zTip);
  group.add(new THREE.Mesh(cap, fm.body));
  return group;
}

/* ---------- Dişli burçlar ---------- */

/**
 * b: { kind: 'heatset' | 'helicoil', L, dOut, d2?, dIn (vida çapı), P }
 * Dönen grup üst yüz z=0, aşağı doğru −L.
 */
export function buildInsert(b, mats) {
  const group = new THREE.Group();
  const P = b.P || pitchFor(null, b.dIn);
  const L = b.L;
  if (b.kind === 'helicoil') {
    // Elmas kesitli tel: yuva dişinin ortasından geçen helis
    const rMid = (b.dIn / 2 + b.dOut / 2) / 2;
    const turns = Math.max(1, L / P - 0.2);
    const wire = 0.36 * P;
    class Helix extends THREE.Curve {
      getPoint(t, target = new THREE.Vector3()) {
        const a = t * turns * TAU;
        return target.set(rMid * Math.cos(a), rMid * Math.sin(a), -0.5 * P - t * turns * P);
      }
    }
    const tube = new THREE.TubeGeometry(new Helix(), Math.ceil(turns * 28), wire, 4, false);
    group.add(new THREE.Mesh(tube, mats.wire));
    return group;
  }

  // Isıyla gömülen insert (ruthex RX biçimi): üstte ve altta ters yönlü tırtıl bantları, ortada kanal,
  // en altta kılavuz çap (d2); içte metrik diş
  const r1 = b.dOut / 2;
  const r2 = (b.d2 || b.dOut * 0.85) / 2;
  const kd = Math.min(0.18, 0.06 * b.dOut);
  const N = 18;
  const lead = 3.2 * b.dOut;
  const zBand1 = -0.42 * L;
  const zGroove = -0.54 * L;
  const zBand2 = -0.86 * L;
  const body = revolvedGrid(-L, 0, Math.max(60, Math.ceil(L * 14)), N * 6, (t, z) => {
    const knurl = (dir) => {
      const w = frac((N * t) / TAU + (dir * z) / lead * N);
      return r1 - kd * (1 - (1 - 2 * Math.abs(w - 0.5)));
    };
    if (z > -0.04 * L) return r1 - kd * 0.8; // üst pah
    if (z > zBand1) return knurl(1);
    if (z > zGroove) return r2 + 0.1 * (r1 - r2);
    if (z > zBand2) return knurl(-1);
    return r2;
  });
  group.add(new THREE.Mesh(body, mats.brass));
  // İç metrik diş (iç yüzey)
  const rMaj = b.dIn / 2 + 0.02;
  const rMin = rMaj - 0.54 * P;
  const bore = revolvedGrid(-L, 0, Math.max(16, Math.ceil((L / P) * 8)), 32, (t, z) => {
    const u = frac(-z / P + t / TAU);
    return rMin + (rMaj - rMin) * (1 - threadProfile(u));
  }, true);
  group.add(new THREE.Mesh(bore, mats.brassInner));
  // Üst ve alt halka yüzeyleri
  const ringTop = new THREE.RingGeometry(rMaj - 0.02, r1 - kd * 0.8, 48);
  group.add(new THREE.Mesh(ringTop, mats.brass));
  const ringBot = new THREE.RingGeometry(rMaj - 0.02, r2, 48);
  ringBot.rotateX(Math.PI);
  ringBot.translate(0, 0, -L);
  group.add(new THREE.Mesh(ringBot, mats.brass));
  return group;
}

/* ---------- Somun ve aralayıcı ---------- */

/** Dış dişli çubuk (z0 alt, z1 üst), metrik profil */
function threadedRod(d, P, z0, z1, mat) {
  const rMaj = d / 2;
  const rMin = rMaj - 0.6134 * P;
  const rows = Math.max(8, Math.ceil(((z1 - z0) / P) * 10));
  const g = revolvedGrid(z0, z1, rows, 36, (t, z) => {
    let r = rMin + (rMaj - rMin) * threadProfile(frac((z - z0) / P + t / TAU));
    const lim = rMin * 0.92 + (z - z0) * 1.0; // uçta 45° pah
    if (lim < r) r = Math.max(rMin * 0.92, lim);
    return r;
  });
  return new THREE.Mesh(g, mat);
}

/** İç diş (delik yüzeyi), normaller eksene doğru */
function threadedBore(d, P, z0, z1, mat) {
  const rMaj = d / 2 + 0.02;
  const rMin = rMaj - 0.54 * P;
  const rows = Math.max(8, Math.ceil(((z1 - z0) / P) * 8));
  return new THREE.Mesh(revolvedGrid(z0, z1, rows, 32, (t, z) => rMin + (rMaj - rMin) * (1 - threadProfile(frac(-z / P + t / TAU))), true), mat);
}

/** Delikli çokgen prizma (altıgen/kare), kenarları hafif pahlı; z 0..h */
function holedPrism(points, holeR, h, mat, bevel) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const hole = new THREE.Path();
  hole.absarc(0, 0, holeR, 0, TAU, true);
  shape.holes.push(hole);
  const b = Math.min(bevel, h * 0.2);
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, h - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 1, curveSegments: 28 });
  g.translate(0, 0, b);
  return new THREE.Mesh(g, mat);
}

const hexPoints = (s) => {
  const R = s / Math.sqrt(3);
  return Array.from({ length: 6 }, (_, i) => [R * Math.cos((Math.PI / 3) * i + Math.PI / 6), R * Math.sin((Math.PI / 3) * i + Math.PI / 6)]);
};

/**
 * Somun. b: { shape: 'hex'|'square', s, m, dIn, P, locking, material: { finish } }
 * Dönen grup üst yüz z=0, alt yüz z=−m (naylon halka alt tarafta, vidanın çıktığı yönde).
 */
export function buildNut(b, mats) {
  const fm = finishOf(mats, b.material?.finish || 'stainless');
  const group = new THREE.Group();
  const P = b.P || pitchFor(null, b.dIn);
  const metalH = b.locking ? 0.62 * b.m : b.m;
  const pts = b.shape === 'square'
    ? [[-b.s / 2, -b.s / 2], [b.s / 2, -b.s / 2], [b.s / 2, b.s / 2], [-b.s / 2, b.s / 2]]
    : hexPoints(b.s);
  const body = holedPrism(pts, b.dIn / 2 + 0.02, metalH, fm.body, 0.12);
  body.position.z = -metalH;
  group.add(body, threadedBore(b.dIn, P, -metalH, 0, fm.recess));
  if (b.locking) {
    // Naylon kilit halkası: daha küçük çaplı yuvarlak yaka + beyaz naylon iç halka
    const collarH = b.m - metalH;
    const rc = b.s * 0.47;
    const collar = new THREE.Mesh(lathe([[b.dIn / 2, 0], [rc, 0], [rc, collarH * 0.8], [rc - 0.15, collarH], [b.dIn / 2, collarH], [b.dIn / 2, 0]], 32), fm.body);
    collar.position.z = -b.m;
    const nylon = new THREE.Mesh(lathe([[b.dIn / 2 * 0.92, 0], [rc * 0.82, 0], [rc * 0.82, collarH * 0.55], [b.dIn / 2 * 0.92, collarH * 0.55], [b.dIn / 2 * 0.92, 0]], 32), finishOf(mats, 'nylon').body);
    nylon.position.z = -b.m - 0.01;
    group.add(collar, nylon);
  }
  return group;
}

/**
 * Altıgen aralayıcı. b: { ends: 'ff'|'mf', sw, L, male, dIn, P, material: { finish } }
 * Dönen grup alt yüz z=0 (taban üstü), üst yüz z=L; erkek diş z<0.
 */
export function buildStandoff(b, mats) {
  const fm = finishOf(mats, b.material?.finish || 'stainless');
  const group = new THREE.Group();
  const P = b.P || pitchFor(null, b.dIn);
  group.add(holedPrism(hexPoints(b.sw), b.dIn / 2 + 0.02, b.L, fm.body, 0.15));
  // İç diş: dişi-dişide boydan boya, erkek-dişide üstten ~0,65·L
  const fd = b.ends === 'ff' ? b.L : Math.max(2.5, 0.65 * b.L);
  group.add(threadedBore(b.dIn, P, b.L - fd, b.L, fm.recess));
  if (b.ends === 'mf' && b.male) group.add(threadedRod(b.dIn, P, -b.male, 0.05, fm.body));
  return group;
}

/* ---------- Panel elemanları ---------- */

/** Düz delikli disk/halka (z = 0 düzleminde, normal +Z) */
function ring(rIn, rOut, z, mat, flip = false) {
  const g = new THREE.RingGeometry(rIn, rOut, 48);
  if (flip) g.rotateX(Math.PI);
  g.translate(0, 0, z);
  return new THREE.Mesh(g, mat);
}

/**
 * Panel elemanı 3B modeli (yalnızca görsel). Yerel koordinat: +Z dışa doğru, z = 0 dış yüz, z = −t iç yüz.
 * v: { kind, t, d, h, L, pd: { af, e, eo, holeD, outer, inner, size, clamp } }
 */
export function buildPanelPart(v, mats) {
  const g = new THREE.Group();
  const pd = v.pd || {};
  const t = v.t || 2;
  if (v.kind === 'foot') {
    // Lastik ayak: kubbeli alt yüz; z = 0 tabana yapışan yüz, z = h yere basan yüz
    const R = v.d / 2;
    const h = v.h;
    const pts = [[0, 0], [R, 0], [R, h * 0.45]];
    for (let i = 1; i <= 8; i++) {
      const a = (i / 8) * (Math.PI / 2);
      pts.push([R * 0.62 + R * 0.38 * Math.cos(a), h * 0.45 + h * 0.55 * Math.sin(a)]);
    }
    pts.push([0, h]);
    g.add(new THREE.Mesh(lathe(pts, 40), mats.rubber));
    return g;
  }
  if (v.kind === 'lightpipe') {
    const r = v.d / 2;
    const pipe = new THREE.Mesh(lathe([[0, -v.L], [r * 0.9, -v.L], [r, -v.L + 0.2], [r, -0.15], [r * 0.85, 0], [0, 0]], 32), mats.clear);
    g.add(pipe);
    return g;
  }
  if (v.kind === 'rf') {
    // SMA / RP-SMA dişi panel konnektörü, arkadan somunlu: içte altıgen flanş, dışta tırtıllı pul + somun, 1/4"-36 dişli gövde
    const af = pd.af || 7.94;
    const dT = 6.35;
    const P = 25.4 / 36;
    const outer = pd.outer || 9;
    const nutH = 2.4;
    const ws = 0.45;
    const washer = new THREE.Mesh(lathe([[dT / 2 + 0.05, 0], [af * 0.56, 0], [af * 0.56, ws], [dT / 2 + 0.05, ws], [dT / 2 + 0.05, 0]], 36), mats.gold);
    g.add(washer);
    const nut = holedPrism(hexPoints(af), dT / 2 + 0.02, nutH, mats.gold, 0.2);
    nut.position.z = ws;
    g.add(nut);
    g.add(threadedRod(dT, P, -t - 0.2, outer, mats.gold));
    // Ön yüz: gövde ağzı, PTFE yalıtkan ve dişi kontak
    g.add(ring(2.1, dT / 2 - 0.35, outer, mats.gold));
    g.add(ring(0.55, 2.1, outer - 0.6, mats.ptfe));
    const bore = new THREE.Mesh(lathe([[2.1, outer], [2.1, outer - 0.6]], 32), mats.gold);
    g.add(bore);
    g.add(new THREE.Mesh(lathe([[0, outer - 1.6], [0.55, outer - 1.6], [0.55, outer - 0.75], [0, outer - 0.75]], 20), mats.gold));
    // İç taraf: altıgen flanş, gövde, sıkma yüksüğü ve koaksiyel kablo
    const flange = holedPrism(hexPoints(af), 0.5, 2, mats.gold, 0.2);
    flange.position.z = -t - 2;
    g.add(flange);
    g.add(new THREE.Mesh(lathe([[0, -t - 6.5], [3.0, -t - 6.5], [3.0, -t - 2], [0, -t - 2]], 32), mats.gold));
    g.add(new THREE.Mesh(lathe([[0, -t - 10], [1.7, -t - 10], [1.7, -t - 6.5], [0, -t - 6.5]], 24), mats.gold));
    const cableL = Math.max(2, (pd.inner || 12) - 10);
    g.add(new THREE.Mesh(lathe([[0, -t - 10 - cableL], [0.65, -t - 10 - cableL], [0.65, -t - 10], [0, -t - 10]], 16), mats.cable));
    return g;
  }
  if (v.kind === 'gland' || v.kind === 'vent') {
    const d = pd.size && /^M\d+/.test(pd.size) ? Number(pd.size.slice(1)) : 12;
    const af = pd.af || d * 1.2;
    const P = 1.5;
    const mat = v.kind === 'vent' ? mats.plasticGray : mats.plasticDark;
    const outer = pd.outer || d;
    // Dış: altıgen gövde + (rakorda) kubbeli sıkma başlığı / (basınç elemanında) yuvarlak kapak
    const hexH = Math.min(4, outer * 0.3);
    const body = holedPrism(hexPoints(af), d * 0.35, hexH, mat, 0.3);
    g.add(body);
    if (v.kind === 'gland') {
      const R = (af * HEX_E_VIS) / 2 * 0.98;
      const rc = Math.max(1.2, (pd.clamp ? pd.clamp[1] : d * 0.5) / 2);
      const z1 = hexH;
      const z2 = outer;
      const pts = [[rc, z1], [R, z1], [R, z1 + (z2 - z1) * 0.55]];
      for (let i = 1; i <= 8; i++) {
        const a = (i / 8) * (Math.PI / 2);
        pts.push([rc + (R - rc) * Math.cos(a), z1 + (z2 - z1) * 0.55 + (z2 - z1) * 0.45 * Math.sin(a)]);
      }
      g.add(new THREE.Mesh(lathe(pts, 48), mat));
      // Sızdırmazlık lastiği (kablo girişi)
      g.add(new THREE.Mesh(lathe([[rc * 0.55, z2 - 2.5], [rc, z2 - 2.5], [rc, z2 - 0.2], [rc * 0.55, z2 - 0.2], [rc * 0.55, z2 - 2.5]], 32), mats.rubber));
    } else {
      const Rc = (pd.eo || af + 3) / 2;
      const z2 = outer;
      g.add(new THREE.Mesh(lathe([[0, hexH], [Rc - 0.8, hexH], [Rc, hexH + 0.8], [Rc, z2 - 0.6], [Rc - 0.6, z2], [0, z2]], 48), mat));
      for (let k = 0; k < 6; k++) {
        const slot = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, (z2 - hexH) * 0.45), mats.rubber);
        const a = (k / 6) * TAU;
        slot.position.set(Math.cos(a) * (Rc - 0.25), Math.sin(a) * (Rc - 0.25), hexH + (z2 - hexH) * 0.4);
        slot.rotation.z = a + Math.PI / 2;
        g.add(slot);
      }
    }
    // İç: metrik diş + kontra somun
    const inner = pd.inner || 7;
    g.add(threadedRod(d, P, -t - inner + 0.5, 0, mat));
    const nutH = Math.min(inner - 1, Math.max(3, d * 0.28));
    const nut = holedPrism(hexPoints(af), d / 2 + 0.02, nutH, mat, 0.3);
    nut.position.z = -t - nutH;
    g.add(nut);
    return g;
  }
  // Özel delik: dışta somun (varsa) + delik çapında gövde
  const r = Math.max(0.5, (pd.holeD || 6) / 2 - 0.15);
  const outer = pd.outer || 8;
  const inner = pd.inner || 8;
  g.add(new THREE.Mesh(lathe([[0, -t - inner], [r, -t - inner], [r, outer], [0, outer]], 36), mats.finishes.stainless.body));
  if (pd.af) {
    const nut = holedPrism(hexPoints(pd.af), r + 0.02, Math.min(3, outer * 0.4), mats.finishes.stainless.body, 0.2);
    g.add(nut);
  }
  return g;
}
