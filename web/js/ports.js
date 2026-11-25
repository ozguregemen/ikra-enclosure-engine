/*
 * Port (konnektör açıklığı) tespiti (M3).
 * Bileşen kutuları yerine üçgen ağları duvar düzleminde kesilir: yalnızca duvarın
 * ötesine geçen kısmın kesiti alınır. Böylece ör. kartın altına inen pinler veya
 * bir modülün duvara uzak gövdeleri açıklığı büyütmez.
 * Saf fonksiyonlardır.
 */

const AX = ['X', 'Y', 'Z'];
export const NEAR_GAP = 1.0; // mm: duvara bu kadar yakın (değmeyen) gövdeler kenara dayalı sayılır
const NEAR_FACE_DEPTH = 0.6; // mm: kenara dayalı gövdede duvara bakan ön yüz kalınlığı

// Dışarıdan erişim gerektiren bileşen ipuçları (ad içinde)
const CONNECTOR_SUBSTR = /(usb|rj-?45|rj-?11|ethernet|jack|conn|jst|terminal|sma|bnc|hdmi|barrel|dc_?jack|type-?c|micro_?b|molex|phoenix|xt-?30|xt-?60|sim|micro_?sd|sd_?card|d-?sub|db9|m12|button|switch|sw_push|tact)/i;
export const isConnectorName = (name) => CONNECTOR_SUBSTR.test(String(name || ''));

function emptyBox() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}
const isEmpty = (b) => !(b.min[0] <= b.max[0]);
function expand(b, x, y, z) {
  if (x < b.min[0]) b.min[0] = x; if (x > b.max[0]) b.max[0] = x;
  if (y < b.min[1]) b.min[1] = y; if (y > b.max[1]) b.max[1] = y;
  if (z < b.min[2]) b.min[2] = z; if (z > b.max[2]) b.max[2] = z;
}

/**
 * Ağın, axis eksenindeki plane düzleminin ötesinde (dir=+1: büyük taraf, -1: küçük taraf)
 * kalan kısmının sınır kutusu. Düzlemi kesen üçgen kenarlarının kesişim noktaları da dahil.
 */
export function sectionBeyond(mesh, axis, plane, dir) {
  const P = mesh.position;
  const I = mesh.index;
  const box = emptyBox();
  const inside = (v) => (dir > 0 ? v >= plane : v <= plane);
  for (let t = 0; t < I.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const p = I[t + e] * 3;
      const q = I[t + ((e + 1) % 3)] * 3;
      const vp = P[p + axis];
      const vq = P[q + axis];
      const ip = inside(vp);
      if (ip) expand(box, P[p], P[p + 1], P[p + 2]);
      if (ip !== inside(vq) && vq !== vp) {
        const s = (plane - vp) / (vq - vp);
        expand(box, P[p] + s * (P[q] - P[p]), P[p + 1] + s * (P[q + 1] - P[p + 1]), P[p + 2] + s * (P[q + 2] - P[p + 2]));
      }
    }
  }
  return box;
}

/**
 * analysis: analyzeAssembly çıktısı (meshes ve meshBoxes dahil)
 * cav: { min:[x,y], max:[x,y] } iç cep sınırı; zRange: [alt, üst] duvarın yükseklik aralığı
 * Dönüş: bileşen × kenar başına port adayları
 */
export function detectPorts(analysis, cav, zRange) {
  const sides = [
    { side: '+X', axis: 0, along: 1, plane: cav.max[0], dir: 1 },
    { side: '-X', axis: 0, along: 1, plane: cav.min[0], dir: -1 },
    { side: '+Y', axis: 1, along: 0, plane: cav.max[1], dir: 1 },
    { side: '-Y', axis: 1, along: 0, plane: cav.min[1], dir: -1 },
  ];
  const map = new Map();
  for (const part of analysis.parts) {
    if (part.isBoard) continue;
    for (const mi of part.meshIdx) {
      const b = analysis.meshBoxes[mi];
      if (b.max[2] <= zRange[0] || b.min[2] >= zRange[1]) continue;
      for (const s of sides) {
        const front = s.dir > 0 ? b.max[s.axis] : b.min[s.axis];
        const gap = s.dir > 0 ? s.plane - front : front - s.plane; // < 0: duvara giriyor
        if (gap > NEAR_GAP) continue;
        const crossing = gap < 0;
        const sec = crossing
          ? sectionBeyond(analysis.meshes[mi], s.axis, s.plane, s.dir)
          : sectionBeyond(analysis.meshes[mi], s.axis, front - s.dir * NEAR_FACE_DEPTH, s.dir);
        if (isEmpty(sec)) continue;
        const key = `${part.id}|${s.side}`;
        if (!map.has(key)) {
          map.set(key, {
            key, partId: part.id, name: part.name, side: s.side, axis: s.axis, along: s.along, dir: s.dir,
            cross: null, near: null, connectorLike: isConnectorName(part.name),
          });
        }
        const pt = map.get(key);
        const slot = crossing ? 'cross' : 'near';
        if (!pt[slot]) pt[slot] = { front, a0: Infinity, a1: -Infinity, z0: Infinity, z1: -Infinity };
        const acc = pt[slot];
        acc.front = s.dir > 0 ? Math.max(acc.front, front) : Math.min(acc.front, front);
        acc.a0 = Math.min(acc.a0, sec.min[s.along]);
        acc.a1 = Math.max(acc.a1, sec.max[s.along]);
        acc.z0 = Math.min(acc.z0, sec.min[2]);
        acc.z1 = Math.max(acc.z1, sec.max[2]);
        // Not: ad kontrolü yalnızca bileşen adıyla yapılır; ham gövde adları üst montaj adını
        // da içerir (ör. "...Ethernet_Carrier_Board_i/...") ve yanlış eşleşmeye yol açar.
      }
    }
  }
  // Duvardan geçen gövde varsa açıklık yalnızca onlara göre; yoksa duvara dayalı ön yüze göre
  return [...map.values()].map((p) => {
    const r = p.cross || p.near;
    return {
      key: p.key, partId: p.partId, name: p.name, side: p.side, axis: p.axis, along: p.along, dir: p.dir,
      axisName: AX[p.axis], connectorLike: p.connectorLike, crossing: !!p.cross,
      front: r.front, a0: r.a0, a1: r.a1, z0: r.z0, z1: r.z1,
      width: r.a1 - r.a0, height: r.z1 - r.z0,
    };
  });
}
