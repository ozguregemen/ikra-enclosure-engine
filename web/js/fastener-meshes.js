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
const COARSE_P = { M2: 0.4, 'M2.5': 0.45, M3: 0.5, M4: 0.7 };
export const pitchFor = (size, d) => COARSE_P[size] ?? Math.max(0.35, 0.15 * d);

/** Paylaşılan PBR malzemeler; envMap verilirse metal yansıması gerçekçi görünür */
export function createFastenerMaterials(envMap = null) {
  const common = envMap ? { envMap, envMapIntensity: 1.0 } : {};
  return {
    steel: new THREE.MeshStandardMaterial({ color: 0xd3d7dc, metalness: 1.0, roughness: 0.3, ...common }),
    steelDark: new THREE.MeshStandardMaterial({ color: 0x8e959c, metalness: 1.0, roughness: 0.45, side: THREE.DoubleSide, ...common }),
    brass: new THREE.MeshStandardMaterial({ color: 0xd9ad55, metalness: 1.0, roughness: 0.32, ...common }),
    brassInner: new THREE.MeshStandardMaterial({ color: 0xb08a3c, metalness: 1.0, roughness: 0.4, side: THREE.BackSide, ...common }),
    wire: new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 1.0, roughness: 0.25, ...common }),
  };
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

/* ---------- Vida ---------- */

/**
 * s: { head, headD, headDActual, headH, d, length, P, tapping, driveKind, drive, driveA, driveM }
 * Dönen grup oturma yüzü z=0 olacak şekilde; çağıran (x, y, z) konumuna taşır.
 */
export function buildScrew(s, mats) {
  const group = new THREE.Group();
  const k = s.headH;
  const sunk = s.head === 'countersunk';
  const shape = { head: s.head, dk: s.headD, dkActual: s.headDActual, k, d: s.d, driveKind: s.driveKind, drive: s.drive, A: s.driveA, m: s.driveM };

  // Baş: profilin dış kısmı (merkez diski hariç) + tahrik izi delikli üst yüz
  const prof = headProfile(shape);
  const outer = prof.slice(1, -1);
  outer.unshift([s.d / 2 * 0.98, prof[0][1]]);
  const flatR = outer[outer.length - 1][0];
  const topZ = headTop(shape);
  if (s.head === 'socket') {
    // ISO 4762 başı: yan yüzde düz tırtıl (≈0,5 mm adım), alt halka ve üst pah döndürme profili
    const r = s.headD / 2;
    const ch = outer[2][1]; // pahın başladığı yükseklik
    const N = Math.max(18, Math.round((Math.PI * s.headD) / 0.5));
    const kd = Math.min(0.08, 0.015 * s.headD);
    group.add(new THREE.Mesh(lathe(outer.slice(0, 2), 48), mats.steel));
    group.add(new THREE.Mesh(revolvedGrid(0, ch, 2, N * 4, (t) => {
      const w = frac((N * t) / TAU);
      return r - kd * 2 * Math.abs(w - 0.5);
    }), mats.steel));
    group.add(new THREE.Mesh(lathe(outer.slice(2), 48), mats.steel));
  } else {
    group.add(new THREE.Mesh(lathe(outer, 48), mats.steel));
  }

  let outline = (driveOutline(shape)[0] || []).map(([x, y]) => [x, y]);
  if (outline.length) {
    const maxR = Math.max(...outline.map(([x, y]) => Math.hypot(x, y)));
    if (maxR > 0.9 * flatR) outline = outline.map(([x, y]) => [(x * 0.9 * flatR) / maxR, (y * 0.9 * flatR) / maxR]);
  }
  const face = new THREE.Shape();
  face.absarc(0, 0, flatR, 0, TAU, false);
  if (outline.length) face.holes.push(new THREE.Path(outline.map(([x, y]) => new THREE.Vector2(x, y))));
  const faceGeom = new THREE.ShapeGeometry(face, 48);
  faceGeom.translate(0, 0, topZ);
  group.add(new THREE.Mesh(faceGeom, mats.steel));

  if (outline.length) {
    const kind = s.driveKind;
    const maxR = Math.max(...outline.map(([x, y]) => Math.hypot(x, y)));
    const depth = kind === 'cross' ? 0.55 * k : kind === 'slot' ? 0.5 * k : (s.head === 'button' ? 0.55 : 0.5) * k;
    const bottomScale = kind === 'cross' ? 0.3 : kind === 'slot' ? 1 : 0.94;
    const cone = kind === 'slot' ? 0 : kind === 'cross' ? 0.35 * maxR : maxR * 0.94 * Math.tan((31 * Math.PI) / 180);
    const rec = recessGeometry(outline, Math.min(depth, 0.85 * (sunk ? k : k)), bottomScale, cone);
    rec.translate(0, 0, topZ);
    group.add(new THREE.Mesh(rec, mats.steelDark));
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
  group.add(new THREE.Mesh(shaft, mats.steel));
  // Uç kapağı
  const cap = new THREE.CircleGeometry(rTip * 1.02, 24);
  cap.rotateX(Math.PI);
  cap.translate(0, 0, zTip);
  group.add(new THREE.Mesh(cap, mats.steel));
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
