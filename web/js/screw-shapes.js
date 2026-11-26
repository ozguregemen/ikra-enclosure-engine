/*
 * Vida başı ve tahrik izi geometrisi (saf fonksiyonlar). 3B önizleme (viewer.js, döndürme profili + düz iz)
 * ve Toolbox ölçü çizimi (toolbox.js, SVG) aynı şekilleri kullanır.
 * Koordinatlar mm. Profil: [yarıçap, yükseklik]; yükseklik 0 = oturma yüzü (havşada üst yüz, baş aşağıda).
 */

/**
 * Bombeli havşa başın (ISO 7047, ISO 7051) bombesi: havşanın üst kenarından (ra, 0) tepeye (0, f) küre kapağı.
 * Yarıçap kenardan ve tepeden geçecek biçimde hesaplanır (ISO rf ≈ bu değer; M3: 5,75 / rf 6). Bombesizse null.
 */
export function raisedDome(s) {
  if (s.head !== 'countersunk' || !(s.f > 0)) return null;
  const ra = Math.min(s.dk / 2, (s.dkActual || s.dk) / 2);
  const R = (ra * ra + s.f * s.f) / (2 * s.f);
  const yc = s.f - R;
  return { ra, f: s.f, R, yc, at: (x) => yc + Math.sqrt(Math.max(0, R * R - x * x)) };
}

/** Baş için döndürme profili. s: { head, dk, k, d, dkActual, f? (bombe), v? (DIN 7985 silindir yüksekliği) } */
export function headProfile(s) {
  const r = s.dk / 2;
  const k = s.k;
  switch (s.head) {
    case 'countersunk': {
      // 90° koni; gerçek baş çapı teorik çaptan küçükse üstte kısa silindirik kenar kalır
      const ra = Math.min(r, (s.dkActual || s.dk) / 2);
      const yCone = -k + (ra - s.d / 2);
      const base = [[0, -k], [s.d / 2, -k], [ra, Math.min(0, yCone)], [ra, 0]];
      const dome = raisedDome(s);
      if (!dome) return [...base, [0, 0]];
      // Bombeli havşa: oturma düzleminden (havşa üst kenarı) tepeye f yüksekliğinde küre kapağı
      const a0 = Math.asin(Math.min(1, ra / dome.R));
      for (let i = 1; i <= 8; i++) {
        const a = a0 * (1 - i / 8);
        base.push([dome.R * Math.sin(a), dome.yc + dome.R * Math.cos(a)]);
      }
      base[base.length - 1] = [0, dome.f];
      return base;
    }
    case 'socket': {
      const ch = Math.min(0.12 * k, 0.3);
      return [[0, 0], [r, 0], [r, k - ch], [r - ch, k], [0, k]];
    }
    case 'cheese': {
      // Silindir baş, üst kenarı yuvarlatılmış, tepe hafif bombe
      const e = 0.18 * k;
      const pts = [[0, 0], [r, 0], [r, k - e]];
      for (let i = 1; i <= 4; i++) {
        const a = (i / 4) * (Math.PI / 2);
        pts.push([r - e + e * Math.cos(a), k - e + e * Math.sin(a)]);
      }
      pts.push([0, k]);
      return pts;
    }
    case 'button': {
      // Mercimek baş: alçak kenar, basık kubbe, düz tepe
      const rt = 0.42 * r;
      const pts = [[0, 0], [r, 0], [r, 0.1 * k]];
      for (let i = 1; i <= 8; i++) {
        const a = (i / 8) * (Math.PI / 2);
        pts.push([rt + (r - rt) * Math.cos(a), 0.1 * k + 0.9 * k * Math.sin(a)]);
      }
      pts.push([0, k]);
      return pts;
    }
    default: {
      if (s.v > 0 && s.v < k) {
        // Yuvarlak silindir baş (DIN 7985): v yüksekliğinde silindir, üstü dk boyunca küre kapağı (tepe k)
        const h = k - s.v;
        const R = (r * r + h * h) / (2 * h);
        const yc = k - R;
        const a0 = Math.asin(Math.min(1, r / R));
        const pts = [[0, 0], [r, 0], [r, s.v]];
        for (let i = 1; i <= 8; i++) {
          const a = a0 * (1 - i / 8);
          pts.push([R * Math.sin(a), yc + R * Math.cos(a)]);
        }
        pts[pts.length - 1] = [0, k];
        return pts;
      }
      // Bombe (pan) baş: düşük kenar, yuvarlatılmış omuz, düz tepe
      const pts = [[0, 0], [r, 0], [r, 0.35 * k]];
      for (let i = 1; i <= 6; i++) {
        const a = (i / 6) * (Math.PI / 2);
        pts.push([0.55 * r + 0.45 * r * Math.cos(a), 0.35 * k + 0.65 * k * Math.sin(a)]);
      }
      pts.push([0, k]);
      return pts;
    }
  }
}

/** Baş tepesinin oturma yüzüne göre yüksekliği (bombeli havşada bombe yüksekliği f) */
export const headTop = (s) => (s.head === 'countersunk' ? (s.f > 0 ? s.f : 0) : s.k);

/** Yıldız iz çapı: Pozidriv (Z) için mZ, yoksa m; ikisi de yoksa null (çizimler 0,54·dk alır) */
export const recessM = (sz, recess) => (recess === 'Z' ? (sz?.mZ ?? sz?.m ?? null) : (sz?.m ?? null));

/**
 * Üstten tahrik izi (merkez 0,0): kapalı çokgenler listesi.
 * s: { head, dk, dkActual, driveKind, drive (PH no. / yarık n / imbus s / T no.), A (torx), m (yıldız iz çapı), recess ('H' | 'Z') }
 * Pozidriv (Z): yıldızın yanında, kollar arasında 45°'de dört ince çentik (ilk çokgen yine yıldızdır).
 */
export function driveOutline(s) {
  const dk = s.dkActual || s.dk;
  switch (s.driveKind) {
    case 'cross': {
      const L = (s.m || 0.54 * dk) / 2;
      const w = 0.11 * (s.m || 0.54 * dk);
      const cross = [[-L, -w], [-w, -w], [-w, -L], [w, -L], [w, -w], [L, -w], [L, w], [w, w], [w, L], [-w, L], [-w, w], [-L, w]];
      if (s.recess !== 'Z') return [cross];
      // Pozidriv imi: köşeden (w√2) dışa doğru, kol boyunun ~%75'ine kadar 45° çentikler
      const r0 = w * Math.SQRT2 + 0.15 * w;
      const r1 = 0.78 * L;
      const t = 0.14 * w;
      const ticks = [1, 3, 5, 7].map((q) => {
        const a = (q * Math.PI) / 4;
        const [c, sn] = [Math.cos(a), Math.sin(a)];
        const [nx, ny] = [-sn * t, c * t];
        return [[r0 * c - nx, r0 * sn - ny], [r1 * c - nx, r1 * sn - ny], [r1 * c + nx, r1 * sn + ny], [r0 * c + nx, r0 * sn + ny]];
      });
      return [cross, ...ticks];
    }
    case 'slot': {
      const L = (s.head === 'pan' || s.head === 'button' ? 0.6 : 0.95) * dk / 2;
      const w = (s.drive || 0.15 * dk) / 2;
      return [[[-L, -w], [L, -w], [L, w], [-L, w]]];
    }
    case 'hex': {
      const R = (s.drive || 0.45 * dk) / Math.sqrt(3);
      const pts = [];
      for (let i = 0; i < 6; i++) pts.push([R * Math.cos((Math.PI / 3) * i), R * Math.sin((Math.PI / 3) * i)]);
      return [pts];
    }
    case 'torx': {
      const Ro = (s.A || 0.5 * dk) / 2;
      const Ri = 0.72 * Ro;
      const pts = [];
      for (let i = 0; i < 72; i++) {
        const t = (i / 72) * Math.PI * 2;
        const lobe = Math.pow((1 + Math.cos(6 * t)) / 2, 1.4);
        const rr = Ri + (Ro - Ri) * lobe;
        pts.push([rr * Math.cos(t), rr * Math.sin(t)]);
      }
      return [pts];
    }
    default:
      return [];
  }
}

/** Yan görünüşte tahrik izinin gizli çizgisi (oturma yüzü koordinatında, y yukarı): kapalı olmayan çoklu çizgi */
export function driveSection(s) {
  const top = headTop(s);
  const k = s.k;
  const dk = s.dkActual || s.dk;
  switch (s.driveKind) {
    case 'cross': {
      const m = (s.m || 0.54 * dk) / 2;
      return [[-m, top], [0, top - 0.62 * k], [m, top]];
    }
    case 'slot': {
      const w = (s.drive || 0.15 * dk) / 2;
      const t = 0.5 * k;
      return [[-w, top], [-w, top - t], [w, top - t], [w, top]];
    }
    case 'hex':
    case 'torx': {
      const w = s.driveKind === 'hex' ? (s.drive || 0.45 * dk) / 2 : (s.A || 0.5 * dk) / 2;
      const t = (s.head === 'countersunk' ? 0.6 : s.head === 'button' ? 0.62 : 0.55) * k;
      const cone = w * Math.tan((31 * Math.PI) / 180);
      return [[-w, top], [-w, top - t], [0, top - t - cone], [w, top - t], [w, top]];
    }
    default:
      return [];
  }
}
