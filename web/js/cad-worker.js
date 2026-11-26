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
import { bossRoot, bottomEdge, EAR_EMBED, nutDogboneR, nutMaxTool, NUT_RELIEF_MIN } from './treat.js';

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

/**
 * Kapaktan kaviteye inen öğeyi (vida borusu, köşe vidası yastığı) gövde duvarından kapak boşluğu kadar içeride kırpan
 * prizma. c: design.js clip = { L, W, r, cx, cy } (kavite − 2 × kapak boşluğu, köşe r − boşluk); z0..z1 öğeyi kapsar.
 */
function insetClip(c, z0, z1) {
  if (c.r > 0.05) return roundedSlab(c.L, c.W, c.r, c.cx, c.cy, z0, z1 - z0);
  return makeBox([c.cx - c.L / 2, c.cy - c.W / 2, z0], [c.cx + c.L / 2, c.cy + c.W / 2, z1]);
}
/** Kırpma (varsa): öğe ∩ prizma; öğenin kendi z aralığından 1 mm taşan prizmayla */
const clipTo = (s, c, z0, z1) => (c ? s.intersect(insetClip(c, Math.min(z0, z1) - 1, Math.max(z0, z1) + 1)) : s);
/**
 * Enjeksiyon kapağında kırpma yüzü de kalıptan çıkmalı: kırpma sınırı kökte (zRoot, kapak plakası altı) kavite − kapak
 * boşluğu, uca doğru boru çıkma açısıyla içeri kayar (düzleşen yüz borunun açısıyla; boşluk hiçbir yükseklikte azalmaz).
 */
function clipToDrafted(s, c, zTip, zRoot, deg) {
  if (!c) return s;
  const ta = tanD(deg);
  if (!(ta > 0)) return clipTo(s, c, zTip, zRoot);
  const at = (z) => { const k = (z - zRoot) * ta; return { L: c.L + 2 * k, W: c.W + 2 * k, r: Math.max(c.r + k, 0.05), z }; };
  return s.intersect(taperSlab([at(Math.min(zTip, zRoot) - 1), at(Math.max(zTip, zRoot) + 1.5)], c.cx, c.cy));
}

/** İşlemsiz (eski) üretim: üç parça ayrı fonksiyonlarda, böylece işlemli üretimde yalnız düşen parça yeniden kurulur */
function buildEnclosure(g) {
  return { base: legacyBase(g), lid: legacyLid(g), clip: g.din ? buildClip(g.din) : null };
}

function legacyBase(g) {
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
  return base;
}

/** outline: kapak dış hattı (işlemli gövde açılıysa ağız hattı; yoksa gövde dış hattı) */
function legacyLid(g, outline = g.outer) {
  const [cx, cy] = g.center;
  const up = [0, 0, 1];
  // Kapak: düz plaka + kenarlara konumlandırma dili + PCB'ye inen vida boruları
  let lid = roundedSlab(outline.L, outline.W, outline.r, cx, cy, g.cavTop, g.lidT);
  // Kart kenarı tutucu: kapaktan inen baskı dilleri (kapak kapanınca kartı üstten sıkıştırır)
  for (const pr of g.edgePressers || []) lid = lid.fuse(makeBox(pr.min, pr.max));
  for (const bar of g.lipBars) {
    lid = lid.fuse(makeBox(bar.min, bar.max));
  }
  const tubes = g.lidTubes || [];
  for (const t of tubes) {
    // Gövde duvarına kapak boşluğundan yakın boru duvar tarafında kırpılır (design.js clip)
    lid = lid.fuse(clipTo(makeCylinder(t.od / 2, t.z1 - t.z0 + 0.5, [t.x, t.y, t.z0], up), t.clip, t.z0, t.z1 + 0.5));
  }
  for (const t of tubes) {
    lid = lid.cut(makeCylinder(t.holeD / 2, g.zTop - t.z0 + 1, [t.x, t.y, t.z0 - 0.5], up));
    if (t.countersink) lid = lid.cut(countersinkCone(t, g.zTop));
    if (t.counterbore) lid = lid.cut(makeCylinder(t.counterbore.d / 2, t.counterbore.depth + 0.5, [t.x, t.y, g.zTop - t.counterbore.depth], up));
  }
  // Köşe vidası kapak delikleri: gerekirse kapağın altına boss'a oturan yastık, geçiş deliği, havşa ya da gömme oyuk
  for (const hh of g.lidHoles || []) {
    if (hh.pad) lid = lid.fuse(clipTo(makeCylinder(hh.pad.od / 2, hh.pad.h + 0.3, [hh.x, hh.y, g.cavTop - hh.pad.h], up), hh.pad.clip, g.cavTop - hh.pad.h, g.cavTop + 0.3));
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
  return lid;
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
const RAIL_CHANNEL_HALF = 12.5; // EN 60715 TS35: flanşlar arası kanal 25 mm (mount.js RAIL.channel); geometry.din.channel varsa o
const numTr = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
/** Bağlantı yöntemi → Türkçe ad (işlem raporu ve notlarda İngilizce kimlik görünmesin) */
const METHOD_TR = { insert: 'ısıl insert', tapped: 'kılavuz', helicoil: 'Helicoil', self_tap: 'diş açan vida', clearance: 'geçiş deliği', nut: 'somun', standoff: 'aralayıcı' };
const methodTr = (m) => METHOD_TR[m] || 'delik';

/**
 * Çekirdek hatasını Türkçe kısa nedene çevirir (ham ileti konsola yazılır; işlem raporuna İngilizce metin girmez).
 * Bu dosyanın kendi attığı Türkçe hatalar olduğu gibi kalır.
 */
function errTr(err) {
  const m = err && err.message ? String(err.message) : typeof err === 'number' ? `OCCT #${err}` : String(err ?? '');
  if (/[çğıöşüÇĞİÖŞÜ]/.test(m)) return m;
  if (m) console.warn('[cad-worker]', m);
  if (/no edge/i.test(m)) return 'kenar bulunamadı';
  if (/fillet|chamfer/i.test(m)) return 'çekirdek radyüs/pah işlemini kuramadı';
  if (/loft|sweep|revol|extru/i.test(m)) return 'çekirdek katıyı kuramadı';
  if (/bool|fuse|cut|common|algo/i.test(m)) return 'çekirdek Boole işlemini kuramadı';
  return 'CAD çekirdeği hatası';
}

/*
 * İşlem raporu — sözleşme A (sürüm 2). Her satır:
 *   { part, key, feature, kind, size, applied, unit, ok, limited, count, rule, note, dv? }
 *   ok && !limited → tam ölçüde uygulandı (applied = size); ok && limited → küçültülmüş ölçüde (0 < applied < size);
 *   !ok → hiç uygulanmadı (applied 0, yüz düz bırakıldı). kind 'info' bilgi satırıdır (işlem sayılmaz);
 *   kind 'boolean': size istenen, applied başarılı özellik sayısı, limited: bazıları işlemsiz geometriye düştü;
 *   kind 'build': parça düzeyi durum (ok:false → parça eski, işlemsiz yöntemle kuruldu).
 * Aynı parça + anahtar + sonuç (tam / sınırlı / uygulanamadı) birleştirilir (count). Bir anahtarda farklı sonuçlar
 * varsa ilk sonuç anahtarı korur, diğerleri "<anahtar>.limited" / "<anahtar>.failed" anahtarıyla ayrı satırdır.
 */
const KINDS = ['chamfer', 'fillet', 'draft', 'countersink', 'dogbone', 'leadin', 'boolean', 'build', 'info'];
const unitOf = (kind) => (kind === 'draft' ? '°' : kind === 'boolean' || kind === 'build' ? 'adet' : 'mm');
const isTreatKind = (k) => k !== 'boolean' && k !== 'build' && k !== 'info';

function normEntry(e) {
  const kind = KINDS.includes(e.kind) ? e.kind : 'info';
  const size = r3(Number.isFinite(e.size) ? e.size : 0);
  let applied = Number.isFinite(e.applied) ? r3(e.applied) : null;
  let ok;
  let limited = false;
  if (kind === 'info') { ok = true; applied = applied ?? size; }
  else if (kind === 'boolean') { applied = applied ?? 0; ok = applied >= size; limited = !!e.limited; }
  else if (kind === 'build') { ok = !!e.ok; applied = ok ? size : 0; }
  else {
    applied = e.ok === false ? 0 : applied ?? size;
    if (!(applied > 0)) { ok = false; applied = 0; }
    else if (applied < size) { ok = true; limited = true; }
    else { ok = true; applied = size; }
  }
  const out = { part: e.part, key: e.key, feature: e.feature, kind, size, applied, unit: e.unit || unitOf(kind), ok, limited,
    count: e.count || 1, rule: e.rule || (kind === 'boolean' || kind === 'build' ? 'GEO-BUILD' : 'GEO-TREAT'), note: e.note || '' };
  // dv: işlemin hacim etkisi (mm³; yalnız kenar işlemlerinde ölçülür) — denetimde beklenen değerle karşılaştırmak için
  if (Number.isFinite(e.dv) && ok) out.dv = Math.round(e.dv * 10) / 10;
  return out;
}

function makeReport() {
  let raw = [];
  return {
    add(e) { raw.push(normEntry(e)); },
    /** Belirtilen anahtarlardaki işlemler uygulanmamış sayılır (ör. işlemli kabuk kurulamadı) */
    fail(part, keys, note) {
      for (const r of raw) {
        if (r.part !== part || !keys.includes(r.key) || !isTreatKind(r.kind)) continue;
        Object.assign(r, { ok: false, limited: false, applied: 0, note });
        delete r.dv;
      }
    },
    /** Parça eski yöntemle kurulduysa: işlemler uygulanmadı, bilgi ve Boole satırları geçersiz */
    failPart(part, note) {
      raw = raw.filter((r) => r.part !== part || isTreatKind(r.kind));
      this.fail(part, [...new Set(raw.filter((r) => r.part === part).map((r) => r.key))], note);
    },
    list() {
      const groups = new Map();
      for (const r of raw) {
        const gk = `${r.part}|${r.key}`;
        if (!groups.has(gk)) groups.set(gk, new Map());
        const m = groups.get(gk);
        const st = isTreatKind(r.kind) ? (!r.ok ? 'failed' : r.limited ? 'limited' : 'full') : 'all';
        const p = m.get(st);
        if (!p) { m.set(st, { ...r }); continue; }
        p.count += r.count;
        if (st === 'full') { p.size = Math.min(p.size, r.size); p.applied = p.size; }
        else if (st === 'limited') { p.size = Math.max(p.size, r.size); p.applied = Math.min(p.applied, r.applied); }
        else if (st === 'failed') p.size = Math.max(p.size, r.size);
        else if (r.kind === 'boolean') { p.size = r3(p.size + r.size); p.applied = r3(p.applied + r.applied); p.ok = p.applied >= p.size; p.limited = p.limited || r.limited; }
        else if (r.kind === 'build') p.ok = p.ok && r.ok;
        else { p.size = Math.max(p.size, r.size); p.applied = Math.max(p.applied, r.applied); }
        if (Number.isFinite(r.dv)) p.dv = Math.round(((p.dv || 0) + r.dv) * 10) / 10;
        if (r.note && !p.note.includes(r.note)) p.note = p.note ? `${p.note}; ${r.note}` : r.note;
      }
      const out = [];
      for (const m of groups.values()) {
        let first = true;
        for (const st of ['all', 'full', 'limited', 'failed']) {
          const e = m.get(st);
          if (!e) continue;
          if (!first) e.key = `${e.key}.${st}`;
          first = false;
          out.push(e);
        }
      }
      return out;
    },
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
      note = 'işlem sonrası katı geçersiz';
    } catch (err) {
      note = errTr(err);
      if (note === 'kenar bulunamadı') return { shape, factor: 0, kind, note };
    }
  }
  return { shape, factor: 0, kind, note: note || 'çekirdek işlemi kuramadı' };
}

/**
 * Basamaklı işlemin sonucunu yaz. size: kenara uygulanmak istenen ölçü; want: istenen (politika) ölçü —
 * geometri sınırı yüzünden size < want ise satır "sınırlı" olur (note nedenini söyler). as: rapordaki tür (ör. 'leadin').
 */
function recordLadder(rep, part, key, feature, kind, size, res, { note = '', want = size, rule, as } = {}) {
  const applied = res.factor ? size * res.factor : 0;
  const parts = [note];
  const swapped = res.factor && res.kind !== kind; // radyüs kurulamadı, 45° pah uygulandı: satır türü 'chamfer'
  if (swapped) parts.push(`radyüs yerine ${numTr(applied)} mm pah uygulandı (çekirdek radyüsü kuramadı)`);
  else if (res.factor && res.factor < 1) parts.push(`çekirdek tam ölçüyü kuramadı; ${numTr(applied)} mm'ye küçültüldü`);
  if (!res.factor) parts.push(res.note);
  rep.add({ part, key, feature, kind: swapped ? res.kind : as || kind, size: want, applied, rule, note: parts.filter(Boolean).join('; '), dv: res.factor ? res.dv : undefined });
}

/** Tek kenar zinciri işlemi: kenar seçimi + basamaklı uygulama + kayıt */
function treatEdges(rep, part, key, feature, kind, size, shape, weightOf, opts = {}) {
  if (!(size > 0.02)) {
    if ((opts.want || 0) > 0.02) rep.add({ part, key, feature, kind, size: opts.want, ok: false, rule: opts.rule, note: opts.note || 'yer yok' });
    return shape;
  }
  const res = edgeLadder(shape, kind, size, weightOf);
  recordLadder(rep, part, key, feature, kind, size, res, opts);
  return res.shape;
}

/** İşlemli ilkel üret; hata olursa null (çağıran işlemsiz ilkele düşer) */
function tryMake(fn) {
  try {
    const s = fn();
    return s && s.wrapped && !s.wrapped.IsNull() ? { shape: s, err: '' } : { shape: null, err: 'boş katı' };
  } catch (err) {
    return { shape: null, err: errTr(err) };
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
    if (b.HasErrors()) throw new Error(`toplu Boole işlemi (${op === 'cut' ? 'kesme' : 'ekleme'}) başarısız`);
    b.SimplifyResult(true, true, 1e-3);
    return cast(b.Shape());
  } finally {
    b.delete();
    A.delete();
    T.delete();
  }
}

/**
 * Özellik listesini topluca ekle/çıkar.
 * items: [{ key, feature, shape (işlemli araç ya da null), err, plain: () => Shape | null, treatOnly?, treats: [...] }]
 *   treatOnly: öğe yalnızca bir kenar işlemidir (giriş havşası, port pahı; plain → null): kurulamazsa işlem
 *   "uygulanamadı" yazılır, özellik eksik sayılmaz ve Boole özetine girmez.
 *   treats: [{ key, feature, kind, size (istenen), applied? (uygulanan; yoksa size), rule, unit?, note? }]
 * Toplu Boole işlemi başarısızsa tek tek: önce işlemli, olmazsa işlemsiz araç; o da olmazsa özellik atlanır.
 * Her öğenin işlemleri son duruma göre kaydedilir.
 */
function applyBatch(rep, part, op, shape, items, tag = '') {
  if (!items.length) return shape;
  const sign = op === 'cut' ? -1 : 1;
  const label = (op === 'cut' ? 'kesme' : 'ekleme') + (tag ? ` · ${tag}` : '');
  const bkey = `bool.${op}${tag ? `.${{ yarık: 'slot', delik: 'hole' }[tag] || 'more'}` : ''}`; // anahtar ASCII kalsın
  const tools = items.map((it) => it.shape || null);
  const plainOf = items.map((it) => {
    let memo;
    return () => (memo === undefined ? (memo = tryMake(it.plain)) : memo);
  });
  const optional = items.map((it) => !!it.treatOnly);
  const finish = (used) => {
    items.forEach((it, i) => {
      const done = used[i] === 'treated';
      for (const t of it.treats || []) {
        if (t.kind === 'info' && !done) continue; // işlemsiz geometride bilgi satırı (kaydırma, gömme) geçersiz
        const why = used[i] === 'plain' ? `işlemli özellik kurulamadı, işlemsiz geometri kullanıldı${it.err ? ` (${it.err})` : ''}`
          : optional[i] ? `işlem aracı ${it.err ? `kurulamadı (${it.err})` : 'Boole işleminde başarısız'}` : 'özellik modele eklenemedi';
        rep.add({ part, key: t.key, feature: t.feature, kind: t.kind, size: t.size, applied: done ? t.applied ?? t.size : 0, ok: done ? undefined : false,
          unit: t.unit, rule: t.rule, note: done ? t.note || '' : why });
      }
    });
  };
  // Tek özet satırı: eksik kalan özellikler (adetleriyle) notta; ayrı öğe satırı yazılmaz (bir eksik = bir bulgu)
  const summary = (used, how) => {
    const req = items.filter((_, i) => !optional[i]).length;
    if (!req) return;
    const okN = used.filter((u, i) => !optional[i] && u !== 'none').length;
    const fellBack = used.filter((u, i) => !optional[i] && u === 'plain' && ((items[i].treats || []).length || items[i].err)).length;
    const missing = new Map();
    items.forEach((it, i) => { if (!optional[i] && used[i] === 'none') missing.set(it.feature, (missing.get(it.feature) || 0) + 1); });
    const miss = [...missing].map(([f, n]) => (n > 1 ? `${f} (${n})` : f)).join(', ');
    rep.add({ part, key: bkey, feature: `özellik ${label} (${how})`, kind: 'boolean', size: req, applied: okN, limited: fellBack > 0, rule: 'GEO-BUILD',
      note: [how === 'tek tek' ? 'toplu Boole işlemi başarısız; özellikler tek tek uygulandı' : '', miss ? `modelde eksik: ${miss}` : '',
        fellBack ? `${fellBack} özellik işlemsiz geometriyle` : ''].filter(Boolean).join('; ') });
  };
  // 1) toplu: işlemli araçlar (yoksa işlemsiz)
  const v0 = measureVolume(shape);
  const batch = [];
  const used = [];
  for (let i = 0; i < items.length; i++) {
    let t = tools[i];
    used[i] = t ? 'treated' : 'plain';
    if (!t) t = plainOf[i]().shape;
    if (!t) used[i] = 'none';
    else batch.push(t);
  }
  try {
    if (batch.length) {
      const r = multiBool(op, shape, batch);
      if (validSolid(r, { v0, sign })) {
        summary(used, 'toplu');
        finish(used);
        return r;
      }
    }
  } catch (err) { /* tek tek denenecek */ }
  if (!batch.length) { summary(used, 'toplu'); finish(used); return shape; }
  // 2) tek tek
  let cur = shape;
  for (let i = 0; i < items.length; i++) {
    used[i] = 'none';
    for (const variant of ['treated', 'plain']) {
      const t = variant === 'treated' ? tools[i] : plainOf[i]().shape;
      if (!t) continue;
      try {
        const vc = measureVolume(cur);
        const r = op === 'cut' ? cur.cut(t) : cur.fuse(t);
        if (validSolid(r, { v0: vc, sign })) { cur = r; used[i] = variant; break; }
      } catch (err) { /* sonraki seçenek */ }
    }
  }
  summary(used, 'tek tek');
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
  const gr = bossRoot({ h, rTip, draftDeg, rootR }); // treat.js: kök izi (büyüme) hesabıyla aynı profil
  const ta = gr.ta;
  const Z = (dz) => zRoot + s * dz;
  const P = (r, dz) => [r, Z(dz)];
  const c = bossTip(tipC, h, rTip);
  let pen;
  if (gr.rf > 0.02) {
    pen = draw(P(0, -embed)).lineTo(P(gr.E[0], -embed)).lineTo(P(gr.E[0], gr.E[1])).threePointsArcTo(P(gr.T1[0], gr.T1[1]), P(gr.M[0], gr.M[1]));
  } else {
    pen = draw(P(0, -embed)).lineTo(P(gr.rRoot + embed * ta, -embed));
  }
  if (c > 0.02) pen = pen.lineTo(P(rTip + c * ta, h - c)).lineTo(P(rTip + c * ta - c, h));
  else pen = pen.lineTo(P(rTip, h));
  return pen.lineTo(P(0, h)).close().sketchOnPlane('XZ', [x, y, 0]).revolve([0, 0, 1], { origin: [x, y, 0] });
}
/** bossSolid'in gerçekten uyguladığı uç pahı (boy ve yarıçapın %45'i ile sınırlı) */
const bossTip = (tipC, h, rTip) => Math.min(tipC, 0.45 * h, 0.45 * rTip);

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

/**
 * Kulak–duvar birleşimi plan radyüsü (2B, kulak yerel çerçevesi: u duvardan dışa, v duvar boyunca kulak ortasından).
 * Yuvarlatma dairesi kulak yan yüzüne ve dış hatta teğettir: düz duvara ya da — kulak duvarın düz kısmının ucuna
 * yakınsa — dış köşe radyüsüne (R0, merkezi düz kısmın ucunda, duvardan R0 içeride). Böylece radyüs kökü hiçbir yerde
 * dış hattın dışında kalmaz (çıkıntı yok) ve tam ölçü uygulanabilir. s: −1 / +1 yan, vs: kulak ortasından o yöndeki
 * düz kısmın ucuna uzaklık. Dönüş: { Te (yan yüzde teğet), Tw (dış hatta teğet), M (yay ortası), Ew (Tw'nin duvara
 * gömülü izdüşümü), Es (düz kısmın ucunun gömülü izdüşümü, yalnız köşe radyüsüne teğette), onArc }
 */
function earFillet(hw, rc, s, vs, R0, emb) {
  if (hw + rc <= vs + 1e-9 || !(R0 > emb)) {
    const k = rc * (1 - S2);
    return { Te: [rc, s * hw], Tw: [0, s * (hw + rc)], M: [k, s * (hw + rc - rc * S2)], Ew: [-emb, s * (hw + rc)], Es: null, onArc: false };
  }
  const dv = hw + rc - vs; // 0 < dv ≤ rc (kulak yan yüzü düz kısımda)
  const uc = -R0 + Math.sqrt((R0 + rc) ** 2 - dv ** 2);
  const n = [(uc + R0) / (R0 + rc), dv / (R0 + rc)]; // köşe radyüsü merkezinden yuvarlatma merkezine (s yönünde v)
  const C = [uc, s * (hw + rc)];
  const Tw = [-R0 + R0 * n[0], s * (vs + R0 * n[1])];
  const a = [0, -s];
  const b = [-n[0], -s * n[1]];
  const l = Math.hypot(a[0] + b[0], a[1] + b[1]);
  const M = [C[0] + (rc * (a[0] + b[0])) / l, C[1] + (rc * (a[1] + b[1])) / l];
  const Ew = [Tw[0] - emb * n[0], Tw[1] - s * emb * n[1]];
  return { Te: [uc, s * hw], Tw, M, Ew, Es: [-emb, s * vs], onArc: true };
}

/**
 * Kulak: duvara gömülü dil + yuvarlak uç; duvar birleşiminde plan radyüsü rc (2B).
 * fit: { vs: [eksi yan, artı yan] düz kısım uzaklıkları, R0: dış köşe radyüsü } — yoksa duvar düz kabul edilir.
 */
function earSolid(ear, rc, fit = null) {
  const toW = (u, v) => { const p = [0, 0]; p[ear.axis] = ear.wallOut + ear.dir * u; p[ear.along] = ear.a + v; return p; };
  const hw = ear.w / 2;
  let pen;
  if (rc > 0.02) {
    const F = [-1, 1].map((s, i) => earFillet(hw, rc, s, fit ? fit.vs[i] : Infinity, fit ? fit.R0 : 0, EAR_EMBED));
    const [m, p] = F;
    pen = draw(toW(...m.Ew)).lineTo(toW(...m.Tw)).threePointsArcTo(toW(...m.Te), toW(...m.M))
      .lineTo(toW(ear.e, -hw)).threePointsArcTo(toW(ear.e, hw), toW(ear.e + hw, 0))
      .lineTo(toW(...p.Te)).threePointsArcTo(toW(...p.Tw), toW(...p.M))
      .lineTo(toW(...p.Ew));
    // Kapanış duvar içinde: köşe radyüsüne teğet yanlarda düz kısmın ucundan geçilir (gömme izi duvarın içinde kalsın)
    if (p.Es) pen = pen.lineTo(toW(...p.Es));
    if (m.Es) pen = pen.lineTo(toW(...m.Es));
  } else {
    pen = draw(toW(-EAR_EMBED, -hw)).lineTo(toW(ear.e, -hw)).threePointsArcTo(toW(ear.e, hw), toW(ear.e + hw, 0)).lineTo(toW(-EAR_EMBED, hw));
  }
  return pen.close().sketchOnPlane('XY', ear.z0).extrude(ear.t);
}

/** Kart kenarı alt desteği yerleşimi: duvar yüzü (edgehold.js 0,3 mm gömme), duvardan içe genişlik U, uygulanabilir radyüs */
function padGeom(pd, rc = 0) {
  const axis = pd.edge[1] === 'X' ? 0 : 1;
  const dir = pd.edge[0] === '-' ? -1 : 1;
  const along = 1 - axis;
  const wall = dir < 0 ? pd.min[axis] + 0.3 : pd.max[axis] - 0.3;
  const inner = dir < 0 ? pd.max[axis] : pd.min[axis];
  const U = Math.abs(inner - wall);
  return { axis, dir, along, wall, U, r: Math.min(rc, U - 0.2) };
}

/** Kart kenarı alt desteği: duvar birleşiminde plan radyüsü rc (CNC), duvara gömme payı emb */
function padSolid(pd, rc, emb, draftDeg = 0) {
  const { axis, dir, along, wall, U, r } = padGeom(pd, rc);
  const toW = (u, v) => { const p = [0, 0]; p[axis] = wall - dir * u; p[along] = v; return p; };
  const v0 = pd.min[along];
  const v1 = pd.max[along];
  const k = r * (1 - S2);
  // Enjeksiyon: üç serbest yan yüz çekme yönünde açılı (üstte anma ölçüsü, tabana doğru büyür; duvar tarafı gömülü)
  if (draftDeg > 0 && !(r > 0.05)) {
    const g = (pd.max[2] - pd.min[2]) * tanD(draftDeg);
    const poly = (e) => draw(toW(-emb, v0 - e)).lineTo(toW(U + e, v0 - e)).lineTo(toW(U + e, v1 + e)).lineTo(toW(-emb, v1 + e)).close();
    return poly(g).sketchOnPlane('XY', pd.min[2]).loftWith(poly(0).sketchOnPlane('XY', pd.max[2]), { ruled: true });
  }
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

/** Kart baskı dili (kapak, enjeksiyon): uçta (kart üstü) anma kutusu, kapak plakasına doğru çıkma açısıyla büyür */
function presserSolid(pr, draftDeg) {
  const g = (pr.max[2] - pr.min[2]) * tanD(draftDeg);
  const rect = (e) => draw([pr.min[0] - e, pr.min[1] - e]).lineTo([pr.max[0] + e, pr.min[1] - e]).lineTo([pr.max[0] + e, pr.max[1] + e]).lineTo([pr.min[0] - e, pr.max[1] + e]).close();
  return rect(0).sketchOnPlane('XY', pr.min[2]).loftWith(rect(g).sketchOnPlane('XY', pr.max[2]), { ruled: true });
}

/**
 * Kapak dili uç yüzleri (enjeksiyon): dil boyunca uçlar çekme yönünde açılı. Dil katısı, kökte (cavTop) dil boyunda,
 * uca doğru her uçta (cavTop − z)·tan(açı) kısalan yamuk prizmayla kesişir.
 */
function lipEndsDrafted(lip, bar, g, deg) {
  const alongX = bar.max[0] - bar.min[0] >= bar.max[1] - bar.min[1];
  const a = alongX ? 0 : 1;
  const c = 1 - a;
  const at = (z) => (g.cavTop - z) * tanD(deg);
  const zT = bar.min[2] - 0.5;
  const zR = g.cavTop + 1.5;
  const a0 = bar.min[a];
  const a1 = bar.max[a];
  const q = [[a0 + at(zT), zT], [a1 - at(zT), zT], [a1 - at(zR), zR], [a0 + at(zR), zR]];
  let pen = draw(q[0]);
  for (const p of q.slice(1)) pen = pen.lineTo(p);
  const dr = pen.close();
  const c0 = bar.min[c] - 10;
  const c1 = bar.max[c] + 10;
  const prism = alongX ? dr.sketchOnPlane('XZ', [0, c1, 0]).extrude(c1 - c0) : dr.sketchOnPlane('YZ', [c0, 0, 0]).extrude(c1 - c0);
  return lip.intersect(prism);
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

/**
 * Altıgen somun cebi CNC'de köşe boşaltmalı (takım yarıçapında daire ile köşe boşaltması).
 * Boşaltma her köşede kenardan 2/√3·r yer; altıgen kenarı s/√3 olduğundan r < s/4 olmalı.
 * Altı köşenin hepsi boşaltılmadıysa (eğri sayısı 12 değil) hata atar: çağıran düz altıgene düşer.
 */
function hexPocketDogbone(st, r) {
  const p = st.nutPocket;
  const R = p.s / Math.sqrt(3);
  const pt = (i) => [st.x + R * Math.cos((Math.PI / 3) * i), st.y + R * Math.sin((Math.PI / 3) * i)];
  let pen = draw(pt(0));
  for (let i = 1; i < 6; i++) pen = pen.lineTo(pt(i)).customCorner(r, 'dogbone');
  const dr = pen.closeWithCustomCorner(r, 'dogbone');
  const n = dr.blueprint?.curves?.length;
  if (n !== 12) throw new Error(`köşe boşaltması altı köşenin hepsine sığmadı (${n ?? '?'} eğri)`);
  return dr.sketchOnPlane('XY', p.z0).extrude(p.z1 - p.z0);
}

/** Köşe boşaltması işlenemeyen altıgen somun cebi: köşeler frezenin bıraktığı r yarıçapında yuvarlak (r < s/2) */
function hexPocketRounded(st, r) {
  const p = st.nutPocket;
  const R = p.s / Math.sqrt(3);
  const pt = (i) => [st.x + R * Math.cos((Math.PI / 3) * i), st.y + R * Math.sin((Math.PI / 3) * i)];
  let pen = draw(pt(0));
  for (let i = 1; i < 6; i++) pen = pen.lineTo(pt(i)).customCorner(r);
  const dr = pen.closeWithCustomCorner(r);
  const n = dr.blueprint?.curves?.length;
  if (n !== 12) throw new Error(`köşe radyüsü altı köşenin hepsine sığmadı (${n ?? '?'} eğri)`);
  return dr.sketchOnPlane('XY', p.z0).extrude(p.z1 - p.z0);
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
    tool.__bottomKind = res.kind;
    tool.__bottomNote = res.note;
  }
  return tool;
}

/* ---------- Gövde ---------- */

/** Basamaklı kenar işlemi sonucundan applyBatch işlem satırı (öğe kurulamazsa applyBatch "uygulanamadı" yazar) */
function ladderTreat(key, feature, kind, want, size, res, rule, note = '') {
  const applied = res && res.factor ? size * res.factor : 0;
  const parts = [note];
  const swapped = res && res.factor && res.kind !== kind;
  if (swapped) parts.push(`radyüs yerine ${numTr(applied)} mm pah uygulandı`);
  else if (res && res.factor && res.factor < 1) parts.push(`çekirdek tam ölçüyü kuramadı; ${numTr(applied)} mm'ye küçültüldü`);
  if (res && !res.factor) parts.push(res.note);
  return { key, feature, kind: swapped ? res.kind : kind, size: want, applied, rule, note: parts.filter(Boolean).join('; ') };
}

function buildBaseTreated(g, T, rep, st) {
  const B = T.base;
  const P = 'base';
  const [cx, cy] = g.center;
  const up = [0, 0, 1];
  const floorTop = g.z0 + g.floor;
  const hBase = g.cavTop - g.z0;
  const ta = tanD(B.draftDeg);
  const cav = g.cavity;
  const tool = B.toolD || 3;
  const plainOuter = () => roundedSlab(g.outer.L, g.outer.W, g.outer.r, cx, cy, g.z0, hBase);
  const plainPocket = () => roundedSlab(cav.L, cav.W, cav.r, cx, cy, floorTop, hBase);
  const shellKeys = []; // kabuk işlemsiz kurulursa geçersiz kalan satırlar

  // 1) Dış blok: enjeksiyonda z0'da anma ölçüsü, ağza doğru büyüyen loft (paralel çıkma açısı, IM-16)
  let outer = null;
  let outerDraft = 0;
  if (B.draftDeg > 0) {
    const gT = hBase * ta;
    const m = tryMake(() => taperSlab([
      { L: g.outer.L, W: g.outer.W, r: g.outer.r, z: g.z0 },
      { L: g.outer.L + 2 * gT, W: g.outer.W + 2 * gT, r: g.outer.r + gT, z: g.cavTop },
    ], cx, cy));
    if (m.shape && validSolid(m.shape)) { outer = m.shape; outerDraft = B.draftDeg; }
    rep.add({ part: P, key: 'draft.outer', feature: 'dış duvar çıkma açısı', kind: 'draft', size: B.draftDeg, applied: outer ? B.draftDeg : 0, rule: 'INJ-DRAFT',
      // Büyüme 3 haneye yuvarlanıp 2 haneyle yazılır: teknik resimdeki (treat.rim.grow) değerle aynı
      note: outer ? `taban altında anma ölçüsü, ağızda her yanda +${numTr(r3(gT))} mm` : `açılı dış blok kurulamadı (${m.err || 'işlem sonrası katı geçersiz'})` });
    shellKeys.push('draft.outer');
  }
  if (!outer) outer = plainOuter();
  // Alt dış kenar: FDM tabla pahı / CNC çapak kırma / enjeksiyon r_o = r_i + t (ölçü ve sınırlar treat.js bottomEdge)
  const be = bottomEdge(B, g.floor, (g.ears || []).length > 0);
  if (be) {
    outer = treatEdges(rep, P, be.key, be.feature, be.kind, be.size, outer, (e) => (inZ(edgePts(e), g.z0) ? 1 : null), { want: be.want, note: be.note, rule: be.rule });
    shellKeys.push(be.key);
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
    rep.add({ part: P, key: 'draft.pocket', feature: 'cep (iç duvar) çıkma açısı', kind: 'draft', size: B.draftDeg, applied: pocket ? B.draftDeg : 0, rule: 'INJ-DRAFT',
      note: pocket ? `taban seviyesinde anma ölçüsü, ağızda her yanda +${numTr(r3(pocketGrow))} mm` : `açılı cep kurulamadı (${m.err || 'işlem sonrası katı geçersiz'})` });
    shellKeys.push('draft.pocket');
  }
  if (!pocket) pocket = plainPocket();
  // Taban–duvar iç köşesi: politika cep köşe radyüsüyle sınırladıysa (treat.js limited) istenen ölçü want olarak yazılır
  const floorLim = (B.limited || []).find((l) => l.key === 'floor');
  if (B.floorFillet > 0 || floorLim) {
    pocket = treatEdges(rep, P, 'floor', 'taban–duvar iç köşesi radyüsü', 'fillet', B.floorFillet, pocket, (e) => (inZ(edgePts(e), floorTop) ? 1 : null),
      { want: floorLim ? Math.max(floorLim.want, B.floorFillet) : B.floorFillet, note: floorLim ? floorLim.note : '', rule: 'GEO-FILLET-INNER' });
    shellKeys.push('floor');
  }
  for (const l of (B.limited || []).filter((x) => x.key !== 'floor')) {
    rep.add({ part: P, key: l.key, feature: l.feature, kind: l.kind, size: l.want, applied: l.got, rule: l.rule, note: l.note });
  }

  let base;
  try {
    base = outer.cut(pocket);
    if (!validSolid(base)) throw new Error('işlemli kabuk geçersiz');
  } catch (err) {
    const why = errTr(err);
    rep.fail(P, shellKeys, `işlemli kabuk kurulamadı (${why}); bu yüzeyler işlemsiz`);
    rep.add({ part: P, key: 'core', feature: 'gövde kabuğu (dış blok − cep)', kind: 'boolean', size: 1, applied: 1, limited: true, rule: 'GEO-BUILD',
      note: `işlemli kabuk kurulamadı (${why}); işlemsiz kabuk kullanıldı` });
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
    // Kapak dili dış kök radyüsü gerçekten uygulanan giriş pahına göre boyutlanır (basamaklı küçülme / başarısızlık)
    st.rimLeadIn = res.factor ? (B.rimLeadIn || 0) * res.factor : 0;
    if (B.rimLeadIn > 0) recordLadder(rep, P, 'rim.in', 'ağız iç kenarı giriş pahı', 'chamfer', B.rimLeadIn, res, { rule: 'GEO-LEADIN', as: 'leadin' });
    if (B.rimOuterBreak > 0) recordLadder(rep, P, 'rim.out', 'ağız dış kenarı çapak kırma', 'chamfer', B.rimOuterBreak, res, { rule: 'GEO-EDGE-BREAK' });
  }
  if (B.process === 'injection') {
    rep.add({ part: P, key: 'parting', feature: 'ayırma çizgisi ağız dış kenarında (keskin kenar)', kind: 'info', size: 1, unit: 'adet', rule: 'INJ-DRAFT',
      note: 'ayırma çizgisi keskin kenarda; çıkma açısı bu çizgiden ayrılır' });
  }

  // 4) Eklenen özellikler (tek toplu füzyon)
  const adds = [];
  const standoffs = g.standoffs || [];
  for (const s of standoffs) {
    if (s.integral === false) continue;
    const plain = () => makeCylinder(s.od / 2, s.z1 - s.z0 + 0.5, [s.x, s.y, s.z0 - 0.5], up);
    const h = s.z1 - s.z0;
    const bw = (s.od - s.holeD) / 2;
    const tipC = Math.min(B.bossTipChamfer, 0.4 * bw);
    const tipA = bossTip(tipC, h, s.od / 2);
    const rf = bossRoot({ h, rTip: s.od / 2, draftDeg: B.bossDraftDeg, rootR: B.bossRootFillet }).rf;
    const treats = [];
    if (B.bossRootFillet > 0) {
      treats.push({ key: 'standoff.root', feature: 'standoff kökü radyüsü', kind: 'fillet', size: B.bossRootFillet, applied: rf, rule: 'GEO-BOSS',
        note: rf < B.bossRootFillet - 1e-3 ? `standoff boyu ${numTr(h)} mm olduğundan ${rf > 0 ? `R${numTr(rf)} ile sınırlandı` : 'uygulanmadı'}` : '' });
    }
    if (B.bossTipChamfer > 0) {
      treats.push({ key: 'standoff.tip', feature: 'standoff ucu pahı', kind: 'chamfer', size: B.bossTipChamfer, applied: tipA > 0.02 ? tipA : 0, rule: 'GEO-BOSS',
        note: tipA < B.bossTipChamfer - 1e-3 ? `boss et kalınlığı ${numTr(bw)} mm olduğundan ${tipA > 0.02 ? `${numTr(tipA)} mm ile sınırlandı` : 'pah uygulanmadı'}` : '' });
    }
    if (B.bossDraftDeg > 0) treats.push({ key: 'standoff.draft', feature: 'standoff dış yüzü çıkma açısı', kind: 'draft', size: B.bossDraftDeg, rule: 'GEO-BOSS', note: 'uçta anma çapı, köke doğru büyür' });
    const m = treats.length ? tryMake(() => bossSolid({ x: s.x, y: s.y, zRoot: s.z0, zTip: s.z1, rTip: s.od / 2, draftDeg: B.bossDraftDeg, rootR: B.bossRootFillet, tipC, embed: 0.5 })) : { shape: null, err: '' };
    adds.push({ key: 'standoff', feature: 'standoff', shape: m.shape, err: m.err, plain, treats });
  }
  const injEmbed = (zTopFeature) => (st.pocketGrow ? Math.max(0, zTopFeature - floorTop) * tanD(st.baseDraft) + 0.05 : 0);
  for (const pd of g.edgePads || []) {
    const plain = () => makeBox(pd.min, pd.max);
    const rcWant = B.process === 'cnc' ? B.concaveMinR : 0;
    const emb = 0.3 + injEmbed(pd.max[2]);
    const padDraft = pd.edge && B.padDraftDeg > 0 && st.baseDraft ? B.padDraftDeg : 0;
    const treats = [];
    if (rcWant > 0 && pd.edge) {
      const ra = padGeom(pd, rcWant).r;
      // CNC'de takım yarıçapının altındaki radyüs işlenemez: freze köşede R(takım/2) bırakır (destek ucuna kadar yuvarlanır)
      const toolNote = ra < tool / 2 - 1e-3 ? `; Ø${numTr(tool)} freze bu köşede R${numTr(tool / 2)} altına inemez` : '';
      treats.push({ key: 'pad.concave', feature: 'kart desteği–duvar iç köşesi radyüsü', kind: 'fillet', size: rcWant, applied: ra > 0.05 ? ra : 0, rule: 'GEO-FILLET-INNER',
        note: ra < rcWant - 1e-3 ? `destek genişliği nedeniyle ${ra > 0.05 ? `R${numTr(ra)} ile sınırlandı` : 'uygulanmadı'}${toolNote}` : '' });
    }
    if (emb > 0.3 + 1e-6) treats.push({ key: 'pad.embed', feature: 'kart desteği açılı duvara gömüldü', kind: 'info', size: emb, unit: 'mm', rule: 'INJ-DRAFT', note: 'duvar açısı kadar derine gömüldü' });
    // Enjeksiyon: destek yan yüzleri cep duvarıyla aynı açıda (gövde INJ-DRAFT sınırıyla katı model sonrası doğrulanır)
    if (padDraft > 0) treats.push({ key: 'pad.draft', feature: 'kart desteği yan yüzleri çıkma açısı', kind: 'draft', size: padDraft, rule: 'INJ-DRAFT', note: 'üstte anma ölçüsü, tabana doğru büyür' });
    const m = treats.length && pd.edge ? tryMake(() => padSolid(pd, rcWant, emb, padDraft)) : { shape: null, err: '' };
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
    // İstenen radyüs: tasarım (design.js) verdiyse o, yoksa süreç politikası (treat.js concaveMinR)
    const needGeo = Number.isFinite(c.concaveR) ? c.concaveR : Number.isFinite(g.cornerConcaveR) ? g.cornerConcaveR : null;
    const need = Math.max(needGeo ?? B.concaveMinR, 0.5);
    const tangentAt = (rc) => R + Math.sqrt(Math.max(0, (RbRoot + rc) ** 2 - (R - rc) ** 2));
    let rc = Math.min(need, 0.9 * R);
    const lim = Math.min(clearU, clearV) - 0.3;
    if (tangentAt(rc) > lim) {
      let lo = 0;
      let hi = rc;
      for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (tangentAt(mid) <= lim) lo = mid; else hi = mid; }
      rc = lo;
    }
    if (rc <= 0.05) rc = 0;
    let note = '';
    if (rc < need - 1e-3) {
      const why = rc < Math.min(need, 0.9 * R) - 1e-3 ? 'kapak dili ucu nedeniyle' : "boss yarıçapı nedeniyle";
      note = `${why} ${rc > 0 ? `R${numTr(rc)} ile sınırlandı` : 'birleşim radyüsüne yer yok'}${B.process === 'cnc' ? `; Ø${numTr(tool)} freze bu köşede R${numTr(tool / 2)} altına inemez, kapak dili ucu köşeden uzaklaştırılmalı` : ''}`;
    }
    const treats = [{ key: 'corner.concave', feature: "köşe boss'u–duvar birleşimi (içbükey radyüs)", kind: 'fillet', size: need, applied: rc, rule: 'GEO-CORNER-CONCAVE', note }];
    if (st.pocketGrow && tb > 0) treats.push({ key: 'corner.draft', feature: "köşe boss'u çıkma açısı", kind: 'draft', size: B.bossDraftDeg, rule: 'GEO-BOSS' });
    const e = 0.4;
    const m = rc > 0 ? tryMake(() => {
      if (!st.pocketGrow) return cornerOutline(c, 0, R, rc, e).sketchOnPlane('XY', za).extrude(zb - za);
      const lower = cornerOutline(c, (za - floorTop) * tw, RbRoot, rc, e).sketchOnPlane('XY', za);
      const upper = cornerOutline(c, (zb - floorTop) * tw, R, rc, e).sketchOnPlane('XY', zb);
      return lower.loftWith(upper, { ruled: true });
    }) : { shape: null, err: 'birleşim radyüsüne yer yok' };
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
    // Plan radyüsü kulak yan yüzüne ve dış hatta teğet: düz kısım yetmezse dış köşe radyüsüne teğet bağlanır (earFillet),
    // kök hiçbir yerde dış hattın dışında kalmaz. Kulak yan yüzü düz kısmı aşıyorsa (köşe radyüsüne biniyorsa) radyüs yok.
    const rcWant = Math.max(B.concaveMinR, 0.5);
    const straight = (ear.along === 0 ? g.outer.L : g.outer.W) / 2 - g.outer.r;
    const dA = ear.a - g.center[ear.along];
    const vs = [straight + dA, straight - dA]; // kulak ortasından eksi / artı yöndeki düz kısmın ucuna
    let rc = Math.min(rcWant, ear.e - 0.5);
    let why = rc < rcWant - 1e-3 ? `kulak çıkıntısı nedeniyle R${numTr(rc)} ile sınırlandı` : '';
    if (Math.min(...vs) < ear.w / 2 - 1e-6) {
      rc = 0;
      why = 'kulak yan yüzü duvarın düz kısmını aşıyor (dış köşe radyüsüne biniyor); birleşim radyüsü uygulanmadı';
    }
    if (rc <= 0.05) rc = 0;
    if (rc > 0 && vs.some((v) => ear.w / 2 + rc > v + 1e-9)) why = [why, 'radyüs dış köşe radyüsüne teğet bağlandı'].filter(Boolean).join('; ');
    if (B.process === 'cnc' && rc < tool / 2 - 1e-3) why = [why, `Ø${numTr(tool)} freze bu köşede R${numTr(tool / 2)} altına inemez`].filter(Boolean).join('; ');
    const treats = [{ key: 'ear.concave', feature: 'kulak–duvar birleşimi (plan radyüsü)', kind: 'fillet', size: rcWant, applied: rc, rule: 'GEO-FILLET-INNER', note: why }];
    const bot = B.bedChamfer > 0 ? B.bedChamfer : B.outerEdgeBreak;
    const botSize = Math.min(bot, ear.t / 3);
    const topSize = Math.min(B.outerEdgeBreak, ear.t / 3);
    let botRes = null;
    let topRes = null;
    // Kenar dış hattın dışındaysa işlenir (gömülü kök kenarları hariç; köşe radyüsüne teğet yayda da doğru)
    const outside = (q) => sdfRR(q.m[0], q.m[1], cx, cy, g.outer.L, g.outer.W, g.outer.r) > 0.01;
    const m = tryMake(() => {
      let s = earSolid(ear, rc, { vs, R0: g.outer.r });
      if (bot > 0) { botRes = edgeLadder(s, 'chamfer', botSize, (e) => { const q = edgePts(e); return inZ(q, ear.z0) && outside(q) ? 1 : null; }); s = botRes.shape; }
      if (B.outerEdgeBreak > 0) { topRes = edgeLadder(s, 'chamfer', topSize, (e) => { const q = edgePts(e); return inZ(q, ear.z0 + ear.t) && outside(q) ? 1 : null; }); s = topRes.shape; }
      return s;
    });
    if (bot > 0) {
      treats.push(ladderTreat('ear.bottom', B.bedChamfer > 0 ? 'kulak alt kenarı tabla pahı' : 'kulak alt kenarı çapak kırma', 'chamfer', bot, botSize, botRes,
        B.bedChamfer > 0 ? 'GEO-EDGE-BED' : 'GEO-EDGE-BREAK', botSize < bot - 1e-3 ? `kulak kalınlığı nedeniyle ${numTr(botSize)} mm ile sınırlandı` : ''));
    }
    if (B.outerEdgeBreak > 0) {
      treats.push(ladderTreat('ear.top', 'kulak üst kenarı çapak kırma', 'chamfer', B.outerEdgeBreak, topSize, topRes, 'GEO-EDGE-BREAK',
        topSize < B.outerEdgeBreak - 1e-3 ? `kulak kalınlığı nedeniyle ${numTr(topSize)} mm ile sınırlandı` : ''));
    }
    if (B.process === 'injection') {
      rep.add({ part: P, key: 'ear.draft', feature: 'kulak yüzleri çıkma açısı', kind: 'draft', size: B.draftDeg || 1, ok: false, rule: 'INJ-SIDE-ACTION',
        note: 'kulak çekme yönüne göre ters açıda (üstündeki kalıp çeliği çıkışı engeller): yan maça ya da kademeli ayırma çizgisi gerekir; kulak yüzlerine açı verilmedi' });
    }
    adds.push({ key: 'ear', feature: 'montaj kulağı', shape: m.shape, err: m.err, plain, treats });
  }
  base = applyBatch(rep, P, 'fuse', base, adds);

  // 5) Kesen araçlar (tek toplu kesim)
  const cuts = [];
  const plainTool = (key, feature, fn) => cuts.push({ key, feature, shape: null, plain: fn, treats: [] });
  const entryTool = (key, feature, method, x, y, holeD, en, zTop) => {
    const m = tryMake(() => countersinkCone({ x, y, holeD, countersink: en }, zTop));
    cuts.push({ key, feature: `${feature} girişi`, shape: m.shape, err: m.err, plain: () => null, treatOnly: true,
      treats: [{ key, feature: `${feature} girişi (${methodTr(method)})`, kind: 'countersink', size: en.depth, rule: 'GEO-HOLE-ENTRY', note: `90° havşa, üst çap Ø${numTr(en.dTop)}` }] });
  };
  const hs = T.holes || {};
  standoffs.forEach((s, i) => {
    plainTool('hole.standoff', 'standoff deliği', () => makeCylinder(s.holeD / 2, s.depth + 0.5, [s.x, s.y, s.z1 - s.depth], up));
    if (s.countersink) plainTool('csk.helicoil', 'Helicoil havşası', () => countersinkCone({ x: s.x, y: s.y, holeD: s.holeD, countersink: s.countersink }, s.z1));
    const en = hs.standoffs?.[i]?.entry;
    if (en) entryTool('entry.standoff', 'standoff deliği', hs.standoffs[i].method, s.x, s.y, s.holeD, en, s.z1);
    if (s.nutPocket) {
      const plain = () => nutPocketShape(s);
      if (s.nutPocket.shape === 'hex' && B.nutDogbone > 0) {
        // Köşe boşaltması: r = takım yarıçapı (en az NUT_RELIEF_MIN; büyük daire aynı frezeyle işlenir). r ≤ s/4 − 0,02 olmalı
        // (treat.js). Freze bundan büyükse boşaltma işlenemez: cep köşeleri frezenin bıraktığı R = Ø/2 ile yuvarlak modellenir
        // (tasarım denetimi somunun bu köşelere oturup oturmadığını sınar; CNC-NUT-POCKET-TOOL).
        const sAF = s.nutPocket.s;
        const rLim = nutDogboneR(sAF, Infinity);
        const toolR = (B.toolD || 3) / 2;
        const toolMax = nutMaxTool(sAF);
        if (B.nutDogbone <= rLim + 1e-6 && B.nutDogbone >= NUT_RELIEF_MIN - 1e-6) {
          const r = nutDogboneR(sAF, B.nutDogbone);
          const note = B.nutDogbone > toolR + 1e-3
            ? `Ø${numTr(2 * toolR)} freze; R${numTr(r)} modellenen en küçük köşe boşaltması, aynı frezeyle işlenir` : '';
          const m = tryMake(() => hexPocketDogbone(s, r));
          cuts.push({ key: 'nut', feature: 'altıgen somun cebi', shape: m.shape, err: m.err, plain,
            treats: [{ key: 'nut.dogbone', feature: 'somun cebi köşe boşaltması', kind: 'dogbone', size: B.nutDogbone, applied: r, rule: 'GEO-DOGBONE', note }] });
        } else {
          const rc = Math.max(0, Math.min(toolR, sAF / 2 - 0.05));
          const why = rLim < NUT_RELIEF_MIN
            ? `SW ${numTr(sAF)} altıgen cepte köşe boşaltmasına yer yok (modellenen en küçük boşaltma R${numTr(NUT_RELIEF_MIN)})`
            : `SW ${numTr(sAF)} altıgen cepte Ø${numTr(2 * toolR)} freze köşe boşaltması açamaz (en fazla Ø${numTr(toolMax)} mm)`;
          const m = rc > 0.05 ? tryMake(() => hexPocketRounded(s, rc)) : { shape: null, err: 'köşe radyüsüne yer yok' };
          cuts.push({ key: 'nut', feature: 'altıgen somun cebi', shape: m.shape, err: m.err, plain,
            treats: [{ key: 'nut.corner', feature: 'somun cebi köşeleri (freze yarıçapında yuvarlak)', kind: 'fillet', size: rc, applied: rc, rule: 'GEO-DOGBONE',
              note: `${why}; köşeler frezenin bıraktığı R${numTr(rc)} ile yuvarlak işlendi, somunun oturması ön incelemede sınandı` }] });
        }
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
    if (en) entryTool('entry.corner', "köşe boss'u deliği", hs.corners[i].method, c.x, c.y, c.holeD, en, c.z1);
  });
  // Port açıklıkları: enjeksiyonda dış uç açılı duvar payı kadar uzar, çentik yanları açılı; CNC'de dış kenara pah
  const outerExt = outerGrow + 0.5;
  for (const c of g.cutouts || []) {
    const mid = (c.n0 + c.n1) / 2;
    const dir = mid > g.center[c.axis] ? 1 : -1;
    // Dış duvar düzlemi: tasarım verdiyse o; yoksa design.js'in 1 mm taşırma payından
    const outerPlane = Number.isFinite(c.outerPlane) ? c.outerPlane : dir > 0 ? c.n1 - 1 : c.n0 + 1;
    const ext = outerGrow > 0 ? { ...c, n0: dir < 0 ? c.n0 - outerExt : c.n0, n1: dir > 0 ? c.n1 + outerExt : c.n1 } : c;
    const plain = () => cutoutPrism(ext);
    const isNotch = c.z1 > g.cavTop;
    if (st.baseDraft && isNotch) {
      const m = tryMake(() => notchDrafted(c, tanD(st.baseDraft), ext.n0, ext.n1));
      cuts.push({ key: 'cutout', feature: 'port çentiği', shape: m.shape, err: m.err, plain,
        treats: [{ key: 'cutout.draft', feature: 'port çentiği yan yüz çıkma açısı', kind: 'draft', size: st.baseDraft, rule: 'INJ-DRAFT' }] });
    } else {
      plainTool('cutout', isNotch ? 'port çentiği' : 'port penceresi', plain);
    }
    if (B.process === 'injection' && !isNotch) {
      rep.add({ part: P, key: 'cutout.window', feature: 'yan duvar penceresi (kalıpta yan maça)', kind: 'info', size: 1, unit: 'adet', rule: 'INJ-SIDE-ACTION',
        note: 'kapalı pencere çekme yönüne dik: kalıpta yan maça ister; pencere yüzlerine çekme yönünde açı gerekmez' });
    }
    if (B.cutoutBreak > 0) {
      const m = tryMake(() => cutoutCollar(c, outerPlane, dir, B.cutoutBreak));
      cuts.push({ key: 'cutout.break', feature: 'port açıklığı dış kenarı', shape: m.shape, err: m.err, plain: () => null, treatOnly: true,
        treats: [{ key: 'cutout.break', feature: 'port açıklığı dış kenarı çapak kırma', kind: 'chamfer', size: B.cutoutBreak, rule: 'GEO-EDGE-BREAK' }] });
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
      if (en) entryTool('entry.ear', 'kulak deliği', 'clearance', ear.hx, ear.hy, ear.d, en, ear.z0 + ear.t);
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
    const m = tryMake(() => grooveTool(gr, cx, cy, z, g.cavTop, { ta: ta2, brk: B.grooveEdgeBreak, shift, bottomR: B.grooveBottomR }));
    const treats = [];
    if (B.grooveBottomR > 0) {
      const ap = m.shape ? m.shape.__bottomR || 0 : 0;
      const asCh = ap > 0 && m.shape.__bottomKind === 'chamfer'; // radyüs kurulamadı, 45° pah
      treats.push({ key: 'groove.bottom', feature: 'conta kanalı dip radyüsü', kind: asCh ? 'chamfer' : 'fillet', size: B.grooveBottomR, applied: ap, rule: 'GEO-GROOVE',
        note: ap > 0 ? (asCh ? `radyüs yerine ${numTr(ap)} mm pah uygulandı (çekirdek radyüsü kuramadı)` : ap < B.grooveBottomR - 1e-3 ? 'çekirdek tam ölçüyü kuramadı' : '') : m.shape?.__bottomNote || '' });
    }
    if (B.grooveEdgeBreak > 0) treats.push({ key: 'groove.break', feature: 'conta kanalı üst kenarları kırma', kind: 'chamfer', size: B.grooveEdgeBreak, rule: 'GEO-GROOVE' });
    if (ta2 > 0) treats.push({ key: 'groove.draft', feature: 'conta kanalı yan yüz açısı (Parker 0–5°)', kind: 'draft', size: st.baseDraft, rule: 'GEO-GROOVE' });
    if (shift > 0) treats.push({ key: 'groove.shift', feature: 'conta kanalı orta çizgisi açılı duvarla kaydırıldı', kind: 'info', size: shift, unit: 'mm', rule: 'GEO-GROOVE' });
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
    rep.add({ part: P, key: 'draft.plate', feature: 'kapak yan yüzü çıkma açısı', kind: 'draft', size: L.draftDeg, applied: lid ? L.draftDeg : 0, rule: 'INJ-DRAFT',
      note: lid ? 'ayırma çizgisi kapak alt dış kenarında, gövde ağız hattıyla aynı' : `açılı plaka kurulamadı (${m.err || 'işlem sonrası katı geçersiz'})` });
  }
  if (!lid) lid = plainPlate();
  if (st.rim.L > g.outer.L + 1e-6) {
    rep.add({ part: P, key: 'outline', feature: 'kapak dış hattı gövde ağız hattına eşitlendi', kind: 'info', size: (st.rim.L - g.outer.L) / 2, unit: 'mm', rule: 'INJ-DRAFT',
      note: 'gövdenin açılı dış duvarı ağızda büyüdüğü için her yanda büyütüldü' });
  }
  // Üst dış kenar: FDM tabla pahı (dış yüz tablada) / CNC çapak kırma / enjeksiyon kozmetik radyüs
  const top = L.bedChamfer > 0 ? ['chamfer', L.bedChamfer, 'bed', 'kapak üst dış kenarı tabla pahı', 'GEO-EDGE-BED']
    : L.outerEdgeBreak > 0 ? ['chamfer', L.outerEdgeBreak, 'outer.top', 'kapak üst dış kenarı çapak kırma', 'GEO-EDGE-BREAK']
      : L.outerTopFillet > 0 ? ['fillet', L.outerTopFillet, 'outer.top', 'kapak üst dış kenarı kozmetik radyüs', 'GEO-FILLET-OUTER'] : null;
  if (top) {
    const size = Math.min(top[1], 0.45 * lidT + (top[0] === 'fillet' ? 0.3 * lidT : 0));
    lid = treatEdges(rep, P, top[2], top[3], top[0], size, lid, (e) => (inZ(edgePts(e), g.zTop) ? 1 : null),
      { want: top[1], rule: top[4], note: size < top[1] - 1e-3 ? `kapak kalınlığı ${numTr(lidT)} mm olduğundan ${numTr(size)} mm ile sınırlandı` : '' });
  }
  if (L.outerEdgeBreak > 0) {
    const size = Math.min(L.outerEdgeBreak, 0.3 * lidT);
    lid = treatEdges(rep, P, 'outer.bottom', 'kapak alt dış kenarı çapak kırma', 'chamfer', size, lid, (e) => (inZ(edgePts(e), g.cavTop) ? 1 : null),
      { want: L.outerEdgeBreak, rule: 'GEO-EDGE-BREAK', note: size < L.outerEdgeBreak - 1e-3 ? `kapak kalınlığı ${numTr(lidT)} mm olduğundan ${numTr(size)} mm ile sınırlandı` : '' });
  }
  if (L.process === 'injection') {
    rep.add({ part: P, key: 'parting', feature: 'ayırma çizgisi kapak alt dış kenarında (keskin kenar)', kind: 'info', size: 1, unit: 'adet', rule: 'INJ-DRAFT',
      note: 'ayırma çizgisi keskin kenarda; gövde ağız hattıyla aynı' });
  }

  const adds = [];
  for (const pr of g.edgePressers || []) {
    // Enjeksiyon kapağında kart baskı dili de kalıptan çıkmalı: uçta anma kutusu, plakaya doğru büyür (kapak INJ-DRAFT presser)
    const pDeg = L.presserDraftDeg > 0 ? L.presserDraftDeg : 0;
    if (pDeg > 0) {
      const m = tryMake(() => presserSolid(pr, pDeg));
      adds.push({ key: 'presser', feature: 'kart baskı dili', shape: m.shape, err: m.err, plain: () => makeBox(pr.min, pr.max),
        treats: [{ key: 'presser.draft', feature: 'kart baskı dili yan yüzleri çıkma açısı', kind: 'draft', size: pDeg, rule: 'INJ-DRAFT', note: 'uçta anma ölçüsü, kapağa doğru büyür' }] });
    } else adds.push({ key: 'presser', feature: 'kart baskı dili', shape: null, plain: () => makeBox(pr.min, pr.max), treats: [] });
  }
  // Kapak dili: kesit profili (kök radyüsü, iki yüzde açı, uç pahı), gövde cebi açılıysa dışa kaydırılır
  const fit = T.lipFit ?? 0.2;
  const tB = st.pocketGrow ? tanD(st.baseDraft) : 0;
  for (const bar of g.lipBars || []) {
    const plain = () => makeBox(bar.min, bar.max);
    const depth = bar.max[2] - bar.min[2];
    const lipT = Math.min(bar.max[0] - bar.min[0], bar.max[1] - bar.min[1]);
    let ao = L.lipDraftDeg;
    let ai = L.lipDraftDeg;
    let draftNote = '';
    // Uç kalınlığı kökün %60'ından aşağı inmesin
    const thin = depth * (tanD(ao) + tanD(ai));
    if (thin > 0.4 * lipT) {
      const k = (0.4 * lipT) / thin;
      ao = Math.atan(tanD(ao) * k) / DEG;
      ai = Math.atan(tanD(ai) * k) / DEG;
      draftNote = `dil ucu kökün %60'ından ince kalmasın diye ${numTr(ao)}°'ye düşürüldü (dil ${numTr(lipT)} mm, boy ${numTr(depth)} mm)`;
    }
    const shift = st.pocketGrow - depth * Math.max(0, tB - tanD(ao));
    const gapRoot = fit + depth * Math.max(0, tB - tanD(ao));
    // Kök radyüsü dil boyunun %40'ını ve dil kalınlığını geçmez; dış yüzde gövde ağzındaki boşluk + giriş pahı kadar
    const ri = Math.min(L.lipRootFillet, 0.4 * depth, lipT);
    // Gövde ağzında gerçekten uygulanan giriş pahı (gövde işlemsiz kurulduysa 0; st yoksa eski davranış)
    const leadIn = Number.isFinite(st.rimLeadIn) ? st.rimLeadIn : B.rimLeadIn || 0;
    const ro = Math.max(0, Math.min(ri, gapRoot + leadIn - 0.05));
    const c = Math.min(L.lipTipChamfer, 0.4 * (lipT - depth * (tanD(ao) + tanD(ai))), 0.4 * depth);
    const treats = [];
    if (L.lipRootFillet > 0) {
      treats.push({ key: 'lip.root', feature: 'kapak dili kökü radyüsü (iç yüz)', kind: 'fillet', size: L.lipRootFillet, applied: ri > 0.02 ? ri : 0, rule: 'GEO-FILLET-INNER',
        note: ri < L.lipRootFillet - 1e-3 ? `dil boyu ${numTr(depth)} mm / kalınlığı ${numTr(lipT)} mm olduğundan ${ri > 0.02 ? `R${numTr(ri)} ile sınırlandı` : 'uygulanmadı'}` : '' });
      // Dış yüz kökü gövde ağzındaki boşluk + giriş pahı kadar olabilir. Enjeksiyonda kök radyüsü kaynağa bağlı en az
      // değerdir (IM-24 0,25·T): eksik kalırsa sınırlı yazılır. FDM'de 0,5 mm tasarım tercihi olduğundan istenen ölçü
      // zaten "en çok boşluk kadar"dır.
      const roWant = L.process === 'injection' ? L.lipRootFillet : Math.min(L.lipRootFillet, ro);
      if (roWant > 0.02) {
        treats.push({ key: 'lip.root.out', feature: 'kapak dili kökü radyüsü (dış yüz)', kind: 'fillet', size: roWant, applied: ro > 0.02 ? ro : 0, rule: 'GEO-FILLET-INNER',
          note: ro < roWant - 1e-3 ? `gövde ağzıyla boşluk ${numTr(gapRoot)} mm${leadIn > 0.02 ? ` ve ${numTr(leadIn)} mm giriş pahı` : ' (ağızda giriş pahı yok)'} nedeniyle ${ro > 0.02 ? `R${numTr(ro)} ile sınırlandı` : 'uygulanmadı'}` : '' });
      }
    }
    if (L.lipTipChamfer > 0) {
      treats.push({ key: 'lip.tip', feature: 'kapak dili ucu giriş pahı', kind: 'leadin', size: L.lipTipChamfer, applied: c > 0.02 ? c : 0, rule: 'GEO-LEADIN',
        note: c < L.lipTipChamfer - 1e-3 ? `dil ucu kalınlığı nedeniyle ${c > 0.02 ? `${numTr(c)} mm ile sınırlandı` : 'uygulanmadı'}` : '' });
    }
    if (L.lipDraftDeg > 0) treats.push({ key: 'lip.draft', feature: 'kapak dili çıkma açısı (iki uzun yüz)', kind: 'draft', size: L.lipDraftDeg, applied: ao, rule: 'INJ-DRAFT', note: draftNote });
    // Dil uç yüzleri de çekme yönüne paralel: aynı en az açıyla (IM-24/IM-39) uçlara doğru kısalır
    if (L.lipDraftDeg > 0) treats.push({ key: 'lip.end.draft', feature: 'kapak dili uç yüzleri çıkma açısı', kind: 'draft', size: L.lipDraftDeg, rule: 'INJ-DRAFT', note: 'kökte dil boyu, uca doğru her uçta kısalır' });
    if (shift > 1e-4) treats.push({ key: 'lip.shift', feature: 'kapak dili açılı cebe göre dışa kaydırıldı', kind: 'info', size: shift, unit: 'mm', rule: 'INJ-DRAFT' });
    const m = treats.length ? tryMake(() => {
      const s = lipSolid(bar, g, { soRoot: shift, ao, ai, ri, ro, c, emb: 0.3 });
      return L.lipDraftDeg > 0 ? lipEndsDrafted(s, bar, g, L.lipDraftDeg) : s;
    }) : { shape: null, err: '' };
    adds.push({ key: 'lip', feature: 'kapak dili', shape: m.shape, err: m.err, plain, treats });
  }
  for (const t of g.lidTubes || []) {
    // Gövde duvarına kapak boşluğundan yakın boru (kök büyümesi dahil) duvar tarafında kırpılır (design.js clip)
    const plain = () => clipTo(makeCylinder(t.od / 2, t.z1 - t.z0 + 0.5, [t.x, t.y, t.z0], up), t.clip, t.z0, t.z1 + 0.5);
    const h = Math.abs(t.z1 - t.z0);
    const bw = (t.od - t.holeD) / 2;
    const tipC = Math.min(L.bossTipChamfer, 0.4 * bw);
    const tipA = bossTip(tipC, h, t.od / 2);
    const rf = bossRoot({ h, rTip: t.od / 2, draftDeg: L.bossDraftDeg, rootR: L.tubeRootFillet }).rf;
    const treats = [];
    if (L.tubeRootFillet > 0) {
      treats.push({ key: 'tube.root', feature: 'kapak borusu kökü radyüsü', kind: 'fillet', size: L.tubeRootFillet, applied: rf, rule: 'GEO-BOSS',
        note: rf < L.tubeRootFillet - 1e-3 ? `boru boyu ${numTr(h)} mm olduğundan ${rf > 0 ? `R${numTr(rf)} ile sınırlandı` : 'uygulanmadı'}` : '' });
    }
    if (L.bossTipChamfer > 0) {
      treats.push({ key: 'tube.tip', feature: 'kapak borusu ucu pahı', kind: 'chamfer', size: L.bossTipChamfer, applied: tipA > 0.02 ? tipA : 0, rule: 'GEO-BOSS',
        note: tipA < L.bossTipChamfer - 1e-3 ? `boru et kalınlığı ${numTr(bw)} mm olduğundan ${tipA > 0.02 ? `${numTr(tipA)} mm ile sınırlandı` : 'pah uygulanmadı'}` : '' });
    }
    if (L.bossDraftDeg > 0) treats.push({ key: 'tube.draft', feature: 'kapak borusu çıkma açısı', kind: 'draft', size: L.bossDraftDeg, rule: 'GEO-BOSS', note: 'uçta anma çapı, köke doğru büyür' });
    if (t.clip) {
      // Kırpma derinliği kökte (çıkma açısı + kök radyüsü izi dahil): eksen ile kırpma sınırı arası uzaklığın ötesi
      const dIn = -sdfRR(t.x, t.y, t.clip.cx, t.clip.cy, t.clip.L, t.clip.W, t.clip.r);
      const rTrace = bossRoot({ h, rTip: t.od / 2, draftDeg: L.bossDraftDeg, rootR: L.tubeRootFillet }).E[0];
      const cut = r3(Math.max(0, rTrace - dIn));
      if (cut > 0.005) {
        treats.push({ key: 'tube.trim', feature: 'kapak borusu gövde duvarı tarafında düzleştirildi', kind: 'info', size: cut, unit: 'mm', rule: 'GEO-BOSS',
          note: `kapak takılırken duvara çarpmasın diye gövde duvarıyla kapak boşluğu kadar açıklık bırakıldı${L.bossDraftDeg > 0 ? `; düzleşen yüz borunun çıkma açısıyla (${numTr(L.bossDraftDeg)}°)` : ''}` });
      }
    }
    // Kırpma: enjeksiyon kapağında düzleşen yüz de borunun çıkma açısıyla (kalıptan çıkar)
    const m = treats.length ? tryMake(() => clipToDrafted(bossSolid({ x: t.x, y: t.y, zRoot: t.z1, zTip: t.z0, rTip: t.od / 2, draftDeg: L.bossDraftDeg, rootR: L.tubeRootFillet, tipC, embed: 0.5 }),
      t.clip, t.z0, t.z1, L.process === 'injection' ? L.bossDraftDeg : 0)) : { shape: null, err: '' };
    adds.push({ key: 'tube', feature: 'kapak borusu', shape: m.shape, err: m.err, plain, treats });
  }
  for (const hh of g.lidHoles || []) {
    if (hh.pad) adds.push({ key: 'lidpad', feature: 'köşe vidası yastığı', shape: null, plain: () => clipTo(makeCylinder(hh.pad.od / 2, hh.pad.h + 0.3, [hh.x, hh.y, g.cavTop - hh.pad.h], up), hh.pad.clip, g.cavTop - hh.pad.h, g.cavTop + 0.3), treats: [] });
  }
  lid = applyBatch(rep, P, 'fuse', lid, adds);

  const cuts = [];
  const plainTool = (key, feature, fn) => cuts.push({ key, feature, shape: null, plain: fn, treats: [] });
  const hs = T.holes || {};
  const entryCut = (key, feature, x, y, holeD, en) => {
    const m = tryMake(() => countersinkCone({ x, y, holeD, countersink: en }, g.zTop));
    cuts.push({ key, feature: `${feature} girişi`, shape: m.shape, err: m.err, plain: () => null, treatOnly: true,
      treats: [{ key, feature: `${feature} girişi çapak kırma (geçiş deliği)`, kind: 'countersink', size: en.depth, rule: 'GEO-HOLE-ENTRY', note: `90° havşa, üst çap Ø${numTr(en.dTop)}` }] });
  };
  (g.lidTubes || []).forEach((t, i) => {
    plainTool('hole.tube', 'kapak vida deliği', () => makeCylinder(t.holeD / 2, g.zTop - t.z0 + 1, [t.x, t.y, t.z0 - 0.5], up));
    if (t.countersink) plainTool('csk.tube', 'havşa', () => countersinkCone(t, g.zTop));
    if (t.counterbore) plainTool('cbore.tube', 'gömme oyuk', () => makeCylinder(t.counterbore.d / 2, t.counterbore.depth + 0.5, [t.x, t.y, g.zTop - t.counterbore.depth], up));
    const en = hs.lidTubes?.[i]?.entry;
    if (en) entryCut('entry.tube', 'kapak vida deliği', t.x, t.y, t.holeD, en);
  });
  (g.lidHoles || []).forEach((hh, i) => {
    const zb = g.cavTop - (hh.pad ? hh.pad.h : 0) - 0.5;
    plainTool('hole.lid', 'köşe vidası deliği', () => makeCylinder(hh.holeD / 2, g.zTop - zb + 0.5, [hh.x, hh.y, zb], up));
    if (hh.countersink) plainTool('csk.lid', 'havşa', () => countersinkCone({ x: hh.x, y: hh.y, holeD: hh.holeD, countersink: hh.countersink }, g.zTop));
    if (hh.counterbore) plainTool('cbore.lid', 'gömme oyuk', () => makeCylinder(hh.counterbore.d / 2, hh.counterbore.depth + 0.5, [hh.x, hh.y, g.zTop - hh.counterbore.depth], up));
    const en = hs.lidHoles?.[i]?.entry;
    if (en) entryCut('entry.lid', 'köşe vidası deliği', hh.x, hh.y, hh.holeD, en);
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
  const topOp = C.bedChamfer > 0 ? [C.bedChamfer, 'bed', 'klips üst yüz kenarı tabla pahı', 'GEO-EDGE-BED']
    : C.outerEdgeBreak > 0 ? [C.outerEdgeBreak, 'outer.top', 'klips üst yüz kenarı çapak kırma', 'GEO-EDGE-BREAK'] : null;
  if (topOp) {
    const size = Math.min(topOp[0], 0.3 * dn.t);
    clip = treatEdges(rep, P, topOp[1], topOp[2], 'chamfer', size, clip, (e) => (inZ(edgePts(e), 0) ? 1 : null),
      { want: topOp[0], rule: topOp[3], note: size < topOp[0] - 1e-3 ? `klips plakası ${numTr(dn.t)} mm olduğundan ${numTr(size)} mm ile sınırlandı` : '' });
  }
  const lc = dn.latchCut;
  const cuts = [{ key: 'latchcut', feature: 'kilit kancası boşluğu', shape: null, plain: () => makeBox([lc.u0, lc.v0, lc.z0], [lc.u1, lc.v1, lc.z1]), treats: [] }];
  const slotW = dn.slots[0] ? dn.slots[0].v1 - dn.slots[0].v0 : 1.5;
  const R = Math.max(C.latchRootR, slotW / 2);
  for (const s of dn.slots) {
    const m = tryMake(() => keyholeSlot(s, R, slotW));
    cuts.push({ key: 'slot', feature: 'kilit dili yarığı', shape: m.shape, err: m.err, plain: () => makeBox([s.u0, s.v0, s.z0], [s.u1, s.v1, s.z1]),
      treats: [{ key: 'latch.root', feature: 'kilit dili kökü (yuvarlak yarık ucu)', kind: 'fillet', size: R, rule: 'GEO-FILLET-INNER',
        note: `R ≥ 0,5·t (t ${numTr(dn.t)} mm)${R > C.latchRootR + 1e-3 ? `; yarık genişliğinin yarısı R${numTr(R)}` : ''}` }] });
  }
  clip = applyBatch(rep, P, 'cut', clip, cuts, 'yarık');
  const adds = [];
  const chHalf = Number.isFinite(dn.channel) ? dn.channel / 2 : RAIL_CHANNEL_HALF;
  for (const b of dn.bosses) {
    const plain = () => makeCylinder(dn.bossD / 2, -dn.tp + 0.5 - dn.bossZ, [b.u, b.v, dn.bossZ], up);
    const h = Math.abs(dn.bossZ + dn.tp);
    const rootR = Math.max(0, Math.min(C.bossRootFillet, chHalf - 0.1 - (Math.abs(b.v) + dn.bossD / 2)));
    const rf = bossRoot({ h, rTip: dn.bossD / 2, rootR }).rf;
    const bw = (dn.bossD - dn.holeD) / 2;
    const tipC = Math.min(C.bossTipChamfer, 0.4 * bw);
    const tipA = bossTip(tipC, h, dn.bossD / 2);
    const treats = [];
    if (C.bossRootFillet > 0) {
      treats.push({ key: 'boss.root', feature: "klips boss'u kökü radyüsü", kind: 'fillet', size: C.bossRootFillet, applied: rf, rule: 'GEO-BOSS',
        note: rf < C.bossRootFillet - 1e-3 ? `ray kanalı (TS35) ve boss boyu nedeniyle ${rf > 0 ? `R${numTr(rf)} ile sınırlandı` : 'uygulanmadı'}` : '' });
    }
    if (C.bossTipChamfer > 0) {
      treats.push({ key: 'boss.tip', feature: "klips boss'u ucu pahı", kind: 'chamfer', size: C.bossTipChamfer, applied: tipA > 0.02 ? tipA : 0, rule: 'GEO-BOSS',
        note: tipA < C.bossTipChamfer - 1e-3 ? `boss et kalınlığı nedeniyle ${tipA > 0.02 ? `${numTr(tipA)} mm ile sınırlandı` : 'pah uygulanmadı'}` : '' });
    }
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
      holes.push({ key: 'entry.clip', feature: 'klips deliği girişi', shape: m.shape, err: m.err, plain: () => null, treatOnly: true,
        treats: [{ key: 'entry.clip', feature: `klips deliği girişi (${methodTr(T.holes.clip.method)})`, kind: 'countersink', size: en.depth, rule: 'GEO-HOLE-ENTRY', note: `90° havşa, üst çap Ø${numTr(en.dTop)}` }] });
    }
  }
  clip = applyBatch(rep, P, 'cut', clip, holes, 'delik');
  if (dn.axis === 1) clip = clip.rotate(90, [0, 0, 0], [0, 0, 1]);
  return clip.translate([dn.center[0], dn.center[1], dn.z0]);
}

/**
 * İşlemli üretim: gövde, kapak, klips + işlem raporu. Bir parçanın işlemli kurulumu beklenmedik hata verirse
 * yalnız o parça eski (işlemsiz) yöntemle kurulur ve raporda 'build' satırıyla belirtilir.
 */
function buildTreated(g) {
  const T = g.treat;
  const rep = makeReport();
  // st: gövdenin gerçekten kurulan ağız ölçüleri (kapak bunlara göre kurulur); rimLeadIn: uygulanan ağız iç pahı
  const st = { rim: { L: g.outer.L, W: g.outer.W, r: g.outer.r }, pocketGrow: 0, baseDraft: 0, rimLeadIn: 0 };
  let base;
  let lid;
  let clip = null;
  try {
    base = buildBaseTreated(g, T, rep, st);
  } catch (err) {
    const why = errTr(err);
    rep.failPart('base', 'işlemli gövde kurulamadı; gövde işlemsiz kuruldu');
    rep.add({ part: 'base', key: 'build', feature: 'gövde katı modeli', kind: 'build', size: 1, ok: false, rule: 'GEO-BUILD',
      note: `işlemli gövde kurulamadı (${why}); gövde kenar işlemleri ve çıkma açısı olmadan kuruldu` });
    st.rim = { L: g.outer.L, W: g.outer.W, r: g.outer.r };
    st.pocketGrow = 0;
    st.baseDraft = 0;
    st.rimLeadIn = 0; // eski yöntemle kurulan gövdenin ağzı keskin: kapak dili kökü buna göre
    base = legacyBase(g);
  }
  try {
    lid = buildLidTreated(g, T, rep, st);
  } catch (err) {
    const why = errTr(err);
    rep.failPart('lid', 'işlemli kapak kurulamadı; kapak işlemsiz kuruldu');
    rep.add({ part: 'lid', key: 'build', feature: 'kapak katı modeli', kind: 'build', size: 1, ok: false, rule: 'GEO-BUILD',
      note: `işlemli kapak kurulamadı (${why}); kapak kenar işlemleri olmadan, gövde ağız hattıyla kuruldu` });
    lid = legacyLid(g, st.rim);
  }
  if (g.din) {
    try {
      clip = T.clip ? buildClipTreated(g.din, T, rep) : buildClip(g.din);
    } catch (err) {
      const why = errTr(err);
      rep.failPart('clip', 'işlemli DIN klipsi kurulamadı; klips işlemsiz kuruldu');
      rep.add({ part: 'clip', key: 'build', feature: 'DIN klipsi katı modeli', kind: 'build', size: 1, ok: false, rule: 'GEO-BUILD',
        note: `işlemli klips kurulamadı (${why}); klips kenar işlemleri olmadan kuruldu` });
      clip = buildClip(g.din);
    }
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
