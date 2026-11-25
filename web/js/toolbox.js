/*
 * Toolbox (SolidWorks Toolbox benzeri): standart bağlantı elemanı kütüphanesi.
 * ISO › Cıvata ve vidalar › gruplar (yıldız, düz, imbus, torx, sac vidası) › tipler.
 * Kullanıcı tip, boyut ve boy seçer; her boyun bu kartta nasıl tutunduğu (uygun / kısa / standoff uyarlanır)
 * canlı hesapla gösterilir. Hesap design.js'te; bu modül pencereyi ve vida önizleme çizimini yönetir.
 */
import {
  libraryTypes, screwTable, driveText, designation, isTapping, resolveScrewMaterial, resolveWasherMaterial, washerSizeFor, torqueLimitText,
} from './design.js';
import { headProfile, headTop, driveOutline, driveSection } from './screw-shapes.js';

const NUM = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const n = (v) => NUM.format(v);
const sizeLabel = (size) => size.replace('.', ',');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const DRIVE_LABEL = {
  cross: 'Yıldız (Phillips, H)',
  slot: 'Düz (tornavida)',
  hex: 'İç altıgen (imbus)',
  torx: 'Torx (iç yıldız)',
};

/* ---------- Küçük baş simgesi (ağaç ve bağlantı kartı) ---------- */

export function headIcon(head) {
  const body = {
    pan: '<path d="M4 11h20v-1.6c0-3-3.2-5.4-10-5.4S4 6.4 4 9.4z"/>',
    cheese: '<path d="M6.5 11h15V5.2c0-.9-.7-1.6-1.6-1.6h-11.8c-.9 0-1.6.7-1.6 1.6z"/>',
    socket: '<path d="M6 11h16V4.6L21 3.6H7L6 4.6z"/>',
    button: '<path d="M4 11h20v-.8C24 7 19.6 5 14 5S4 7 4 10.2z"/>',
    countersunk: '<path d="M3 3.6h22L17.5 11h-7z"/>',
  }[head] || '';
  return `<svg class="head-icon" viewBox="0 0 28 26" aria-hidden="true">${body}` +
    '<path d="M10.5 11h7v11.4l-1 1.2h-5l-1-1.2z"/>' +
    '<path class="hi-thread" d="M10.5 15h7M10.5 18h7M10.5 21h7"/></svg>';
}

/* ---------- Ölçülü vida önizleme çizimi (yan görünüş + üstten) ---------- */

/**
 * type: toolbox tipi, sz: boyut kaydı { dk, dk_actual?, k, P, drive, A?, m? }, size: boyut adı, d: anma çapı,
 * L: boy (havşada başı kapsar). Teknik resim alışkanlığı: diş dibi ince sürekli çizgi, tahrik izi gizli çizgi,
 * eksen noktalı çizgi, ölçü çizgileri ok uçlu. Model koordinatı: y yukarı, 0 = oturma yüzü (havşada üst yüz), uç −L.
 */
export function screwFigure(type, sz, size, d, L, washer = null) {
  const VW = 320;
  const VH = 270;
  const shape = { head: type.head, dk: sz.dk, dkActual: sz.dk_actual, k: sz.k, d, driveKind: type.drive_kind, drive: sz.drive, A: sz.A, m: sz.m };
  const sunk = type.head === 'countersunk';
  const k = sz.k;
  const P = sz.P || 0.5;
  const dkShown = sz.dk_actual || sz.dk;
  const r = dkShown / 2;
  const maxTop = headTop(shape);
  const totalH = L + maxTop;
  const areaW = 106;
  const areaH = 196;
  const wD = washer && !sunk ? washer.d2 : 0;
  const s = Math.min(areaH / totalH, areaW / Math.max(sz.dk, wD), 22);
  const cx = 112;
  const top = 34 + (areaH - totalH * s) / 2;
  const X = (x) => cx + x * s;
  const Y = (y) => top + (maxTop - y) * s;
  const out = [];
  const pts = (arr) => arr.map(([x, y]) => `${X(x).toFixed(2)},${Y(y).toFixed(2)}`).join(' ');

  // Baş: döndürme profilinin sağ yarısı + aynası
  const right = headProfile(shape).filter(([x]) => x > 1e-9);
  const head = right.concat(right.slice().reverse().map(([x, y]) => [-x, y]));
  // Gövde: ST sac vidasında sivri uç (form C), metrikte pah
  const tapping = isTapping(type);
  const c = tapping ? Math.min(1.6 * P, 0.7 * d) : Math.min(0.75 * P, d * 0.2);
  const tipR = tapping ? 0.18 * d : d / 2 - c;
  const shankTop = sunk ? -k : 0;
  const shank = [[-d / 2, shankTop], [d / 2, shankTop], [d / 2, -L + c], [tipR, -L], [-tipR, -L], [-d / 2, -L + c]];
  out.push(`<polygon class="tf-part" points="${pts(shank)}"/>`);
  out.push(`<polygon class="tf-part" points="${pts(head)}"/>`);
  // Baş altı pulu (kesit): oturma yüzünün hemen altında, deliğin iki yanında
  if (washer && !sunk) {
    const r1 = washer.d1 / 2;
    const r2 = washer.d2 / 2;
    out.push(`<polygon class="tf-washer" points="${pts([[-r2, 0], [-r1, 0], [-r1, -washer.s], [-r2, -washer.s]])}"/>`);
    out.push(`<polygon class="tf-washer" points="${pts([[r1, 0], [r2, 0], [r2, -washer.s], [r1, -washer.s]])}"/>`);
  }
  // Diş dibi (ince sürekli çizgi)
  const rm = d / 2 - (tapping ? 0.33 : 0.6134) * P;
  const y0 = shankTop - (sunk ? 0.2 : 0.4);
  const y1 = -L + c * (tapping ? 0.9 : 0.6);
  out.push(`<path class="tf-thin" d="M${X(-rm)} ${Y(y0)}V${Y(y1)}M${X(rm)} ${Y(y0)}V${Y(y1)}"/>`);
  // Tahrik izi (gizli çizgi)
  const sec = driveSection(shape);
  if (sec.length) out.push(`<polyline class="tf-thin tf-hid" points="${pts(sec)}"/>`);
  // Eksen
  out.push(`<line class="tf-center" x1="${cx}" y1="${Y(maxTop) - 8}" x2="${cx}" y2="${Y(-L) + 8}"/>`);

  // Ölçüler
  const dimH = (x1, x2, y, label, from) => {
    out.push(`<path class="tf-ext" d="M${x1} ${from[0]}V${y + (y < from[0] ? -3 : 3)}M${x2} ${from[1]}V${y + (y < from[1] ? -3 : 3)}"/>`);
    arrowLine(out, x1, y, x2, y);
    out.push(`<text class="tf-txt" x="${(x1 + x2) / 2}" y="${y < from[0] ? y - 5 : y + 13}" text-anchor="middle">${esc(label)}</text>`);
  };
  const dimV = (y1, y2, x, label, from, side) => {
    out.push(`<path class="tf-ext" d="M${from[0]} ${y1}H${x + (x < from[0] ? -3 : 3)}M${from[1]} ${y2}H${x + (x < from[1] ? -3 : 3)}"/>`);
    arrowLine(out, x, y1, x, y2);
    const tx = side === 'left' ? x - 6 : x + 6;
    out.push(`<text class="tf-txt" x="${tx}" y="${(y1 + y2) / 2 + 4}" text-anchor="${side === 'left' ? 'end' : 'start'}">${esc(label)}</text>`);
  };
  const widestY = sunk ? Y(0) : type.head === 'socket' || type.head === 'cheese' ? Y(k / 2) : Y(0.12 * k);
  dimH(X(-r), X(r), Y(maxTop) - 14, `Ø${n(dkShown)}`, [widestY, widestY]);
  dimV(Y(maxTop), Y(sunk ? -k : 0), X(r) + 16, `k ${n(k)}`, [X(sunk ? r : 0.6 * r), X(sunk ? d / 2 : r)], 'right');
  dimV(Y(0), Y(-L), X(-Math.max(r, wD / 2)) - 18, `L ${n(L)}`, [X(-r), X(-d / 2)], 'left');
  dimH(X(-d / 2), X(d / 2), Y(-L) + 16, sizeLabel(size), [Y(-L + c), Y(-L + c)]);

  // Üstten görünüş
  const tcx = 268;
  const tcy = 92;
  const s2 = Math.min(s, 32 / r);
  out.push(`<circle class="tf-part" cx="${tcx}" cy="${tcy}" r="${r * s2}"/>`);
  if (sunk && sz.dk_actual) out.push(`<circle class="tf-thin" cx="${tcx}" cy="${tcy}" r="${(d / 2) * s2}" stroke-dasharray="3 2"/>`);
  for (const poly of driveOutline(shape)) {
    out.push(`<polygon class="tf-recess" points="${poly.map(([x, y]) => `${(tcx + x * s2).toFixed(2)},${(tcy - y * s2).toFixed(2)}`).join(' ')}"/>`);
  }
  out.push(`<text class="tf-cap" x="${tcx}" y="${tcy + r * s2 + 16}" text-anchor="middle">Üstten</text>`);
  out.push(`<text class="tf-cap" x="${tcx}" y="${tcy + r * s2 + 30}" text-anchor="middle">${esc(driveText(type, sz))}</text>`);
  out.push('<text class="tf-cap" x="8" y="14">Yan görünüş</text>');

  return `<svg class="tb-figure-svg" viewBox="0 0 ${VW} ${VH}" role="img" aria-label="${esc(type.code)} vida ölçü çizimi">${out.join('')}</svg>`;
}

function arrowLine(out, x1, y1, x2, y2) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / (len || 1);
  const uy = (y2 - y1) / (len || 1);
  const a = 6;
  const w = 2.4;
  const head = (x, y, dx, dy) => `<path class="tf-arrow" d="M${x} ${y}L${x - dx * a - dy * w} ${y - dy * a + dx * w}L${x - dx * a + dy * w} ${y - dy * a - dx * w}z"/>`;
  if (len >= 2 * a + 4) {
    out.push(`<line class="tf-dim" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    out.push(head(x2, y2, ux, uy), head(x1, y1, -ux, -uy));
  } else {
    // Dar ölçü: oklar dışarıdan içeri
    out.push(`<line class="tf-dim" x1="${x1 - ux * 12}" y1="${y1 - uy * 12}" x2="${x2 + ux * 12}" y2="${y2 + uy * 12}"/>`);
    out.push(head(x1, y1, ux, uy), head(x2, y2, -ux, -uy));
  }
}

/* ---------- Pul simgesi ve ölçülü çizimi ---------- */

export function washerIcon(kind) {
  if (kind === 'spring') {
    return '<svg class="head-icon" viewBox="0 0 28 26" aria-hidden="true"><path d="M14 4a9 9 0 1 0 8.2 5.3l-3.8 1.7A4.9 4.9 0 1 1 14 8.1z"/></svg>';
  }
  if (kind === 'serrated') {
    let d = '';
    for (let i = 0; i < 9; i++) {
      const a0 = (i / 9) * Math.PI * 2;
      const a1 = a0 + Math.PI / 9;
      d += `${i ? 'L' : 'M'}${(14 + 10 * Math.cos(a0)).toFixed(1)} ${(13 + 10 * Math.sin(a0)).toFixed(1)}L${(14 + 7.5 * Math.cos(a1)).toFixed(1)} ${(13 + 7.5 * Math.sin(a1)).toFixed(1)}`;
    }
    return `<svg class="head-icon" viewBox="0 0 28 26" aria-hidden="true"><path d="${d}z"/><circle cx="14" cy="13" r="3.5" style="fill:var(--surface-2)"/></svg>`;
  }
  return '<svg class="head-icon" viewBox="0 0 28 26" aria-hidden="true"><circle cx="14" cy="13" r="10"/><circle cx="14" cy="13" r="4" style="fill:var(--surface-2)"/></svg>';
}

/** Pul: üstten görünüş (tırtıl / yarık) ve kesit, d1–d2–s ölçüleriyle */
export function washerFigure(w, z) {
  const VW = 320;
  const VH = 270;
  const s = Math.min(110 / z.d2, 18);
  const out = [];
  const cx = 160;
  const cy = 92;
  const r1 = (z.d1 / 2) * s;
  const r2 = (z.d2 / 2) * s;
  if (w.kind === 'serrated') {
    const nT = (z.teeth || 9) * 2;
    const pts = [];
    for (let i = 0; i < nT; i++) {
      const a = (i / nT) * Math.PI * 2;
      const rr = i % 2 ? r2 * 0.8 : r2;
      pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
    }
    out.push(`<polygon class="tf-washer" points="${pts.join(' ')}"/>`);
  } else if (w.kind === 'spring') {
    const gap = 0.18;
    const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
    out.push(`<path class="tf-washer" d="M${p(r2, gap)}A${r2} ${r2} 0 1 1 ${p(r2, -gap)}L${p(r1, -gap)}A${r1} ${r1} 0 1 0 ${p(r1, gap)}z"/>`);
  } else {
    out.push(`<circle class="tf-washer" cx="${cx}" cy="${cy}" r="${r2}"/>`);
  }
  out.push(`<circle class="tf-hole" cx="${cx}" cy="${cy}" r="${r1}"/>`);
  out.push(`<line class="tf-center" x1="${cx - r2 - 8}" y1="${cy}" x2="${cx + r2 + 8}" y2="${cy}"/>`);
  out.push(`<line class="tf-center" x1="${cx}" y1="${cy - r2 - 8}" x2="${cx}" y2="${cy + r2 + 8}"/>`);
  // Kesit (kalınlık abartılı değil, ölçeğe göre; çok inceyse en az 3 px)
  const sy = 205;
  const th = Math.max(3, z.s * s);
  out.push(`<rect class="tf-washer" x="${cx - r2}" y="${sy}" width="${r2 - r1}" height="${th}"/>`);
  out.push(`<rect class="tf-washer" x="${cx + r1}" y="${sy}" width="${r2 - r1}" height="${th}"/>`);
  // Ölçüler
  arrowLine(out, cx - r2, sy - 18, cx + r2, sy - 18);
  out.push(`<path class="tf-ext" d="M${cx - r2} ${sy - 2}V${sy - 21}M${cx + r2} ${sy - 2}V${sy - 21}"/>`);
  out.push(`<text class="tf-txt" x="${cx}" y="${sy - 23}" text-anchor="middle">Ø${n(z.d2)}</text>`);
  arrowLine(out, cx - r1, sy + th + 16, cx + r1, sy + th + 16);
  out.push(`<path class="tf-ext" d="M${cx - r1} ${sy + th + 2}V${sy + th + 19}M${cx + r1} ${sy + th + 2}V${sy + th + 19}"/>`);
  out.push(`<text class="tf-txt" x="${cx}" y="${sy + th + 30}" text-anchor="middle">Ø${n(z.d1)}</text>`);
  out.push(`<text class="tf-txt" x="${cx + r2 + 10}" y="${sy + th / 2 + 4}">s ${n(z.s)}</text>`);
  out.push('<text class="tf-cap" x="8" y="14">Üstten ve kesit</text>');
  return `<svg class="tb-figure-svg" viewBox="0 0 ${VW} ${VH}" role="img" aria-label="${esc(w.code)} pul ölçü çizimi">${out.join('')}</svg>`;
}

/* ---------- Dişli burç simgesi ve kesit çizimi ---------- */

export function insertIcon(kind) {
  if (kind === 'helicoil') {
    return '<svg class="head-icon" viewBox="0 0 28 26" aria-hidden="true"><path class="hi-thread" d="M8 5l12 2.5M8 9l12 2.5M8 13l12 2.5M8 17l12 2.5M8 21l12 2.5"/>' +
      '<path d="M8 4v19M20 4v19" style="fill:none"/></svg>';
  }
  if (kind === 'tapped') {
    return '<svg class="head-icon" viewBox="0 0 28 26" aria-hidden="true"><path d="M4 3h20v20H4z"/><path style="fill:var(--surface)" d="M10 3h8v15h-8z"/>' +
      '<path class="hi-thread" d="M10 6h8M10 9h8M10 12h8M10 15h8"/></svg>';
  }
  return '<svg class="head-icon" viewBox="0 0 28 26" aria-hidden="true"><path d="M6.5 3h15v13h-1.5v7h-12v-7H6.5z"/>' +
    '<path class="hi-thread" d="M6.5 6l2 1.5-2 1.5M6.5 10l2 1.5-2 1.5M21.5 6l-2 1.5 2 1.5M21.5 10l-2 1.5 2 1.5M11 3v20M17 3v20"/></svg>';
}

/**
 * Standoff üst kesiti ve içindeki burç. kind: 'heatset' | 'helicoil' | 'tapped' | 'self_tap'
 * b: { od (boss Ø), holeD, depth, d (vida çapı), P, L (burç boyu), d1, d2 (insert dış/alt çapı), dhc (Helicoil yuva dişi), csk }
 */
export function insertFigure(kind, b) {
  const VW = 320;
  const VH = 270;
  const bossH = b.depth + Math.max(2, 0.4 * b.depth);
  const s = Math.min(150 / b.od, 200 / bossH, 22);
  const cx = 150;
  const top = 38;
  const X = (x) => cx + x * s;
  const Y = (y) => top + y * s; // y: üst yüzden aşağı
  const out = [];
  const pts = (arr) => arr.map(([x, y]) => `${X(x).toFixed(2)},${Y(y).toFixed(2)}`).join(' ');
  const r = b.od / 2;
  const rh = b.holeD / 2;
  // Boss kesiti (sol ve sağ et; delik boş)
  const left = [[-r, 0], [-rh, 0], [-rh, b.depth], [rh, b.depth], [rh, 0], [r, 0], [r, bossH], [-r, bossH]];
  if (b.csk) {
    const c = (b.csk - b.holeD) / 2;
    left.splice(1, 1, [-b.csk / 2, 0], [-rh, c]);
    left.splice(left.length - 4, 1, [rh, c], [b.csk / 2, 0]);
  }
  out.push(`<polygon class="tf-section" points="${pts(left)}"/>`);
  out.push(`<line class="tf-center" x1="${cx}" y1="${Y(0) - 10}" x2="${cx}" y2="${Y(bossH) + 6}"/>`);
  const rd = b.d / 2;
  if (kind === 'heatset') {
    // Tırtıllı pirinç gövde: üst %65 d1, alt d2; içinde metrik diş
    const r1 = b.d1 / 2;
    const r2 = (b.d2 || b.d1 * 0.85) / 2;
    const L = b.L;
    const kn = 0.65 * L;
    const teeth = Math.max(3, Math.round(kn / 0.9));
    const side = (sg) => {
      const p = [[sg * r1, 0]];
      for (let i = 0; i < teeth; i++) {
        const y0 = (i / teeth) * kn;
        p.push([sg * (r1 - 0.18), y0 + kn / teeth / 2], [sg * r1, y0 + kn / teeth]);
      }
      p.push([sg * r2, kn + 0.2], [sg * r2, L]);
      return p;
    };
    const right = side(1);
    const leftSide = side(-1).reverse();
    out.push(`<polygon class="tf-brass" points="${pts([...right, [rd, L], [rd, 0], [-rd, 0], [-rd, L], ...leftSide])}"/>`);
  } else if (kind === 'helicoil') {
    // Tel kesitleri: her adımda iki elmas (sol / sağ), burç yüzeyden 0,25·P içeride
    const P = b.P;
    const r0 = rd - 0.54 * P * 0.5;
    const r1 = b.dhc / 2;
    const n = Math.max(2, Math.floor(b.L / P));
    for (let i = 0; i < n; i++) {
      const y = 0.25 * P + i * P + P / 2;
      for (const sg of [-1, 1]) {
        const dia = [[sg * r0, y], [sg * (r0 + r1) / 2, y - P * 0.42], [sg * r1, y], [sg * (r0 + r1) / 2, y + P * 0.42]];
        out.push(`<polygon class="tf-steel" points="${pts(dia)}"/>`);
      }
    }
  } else {
    // Doğrudan diş / sac vidası: diş dibi çizgileri
    const rm = rh;
    out.push(`<path class="tf-thin" d="M${X(-rd)} ${Y(0.3)}V${Y(b.depth - 0.6)}M${X(rd)} ${Y(0.3)}V${Y(b.depth - 0.6)}"/>`);
    out.push(`<path class="tf-thin tf-hid" d="M${X(-rm)} ${Y(0)}V${Y(b.depth)}M${X(rm)} ${Y(0)}V${Y(b.depth)}"/>`);
  }
  // Ölçüler
  const dimH = (x1, x2, y, label, fromY) => {
    out.push(`<path class="tf-ext" d="M${x1} ${fromY}V${y + (y < fromY ? -3 : 3)}M${x2} ${fromY}V${y + (y < fromY ? -3 : 3)}"/>`);
    arrowLine(out, x1, y, x2, y);
    out.push(`<text class="tf-txt" x="${(x1 + x2) / 2}" y="${y < fromY ? y - 5 : y + 13}" text-anchor="middle">${esc(label)}</text>`);
  };
  const dimV = (y1, y2, x, label, fromX, side) => {
    out.push(`<path class="tf-ext" d="M${fromX} ${y1}H${x + (x < fromX ? -3 : 3)}M${fromX} ${y2}H${x + (x < fromX ? -3 : 3)}"/>`);
    arrowLine(out, x, y1, x, y2);
    out.push(`<text class="tf-txt" x="${side === 'left' ? x - 6 : x + 6}" y="${(y1 + y2) / 2 + 4}" text-anchor="${side === 'left' ? 'end' : 'start'}">${esc(label)}</text>`);
  };
  dimH(X(-rh), X(rh), Y(0) - 16, `Ø${n(b.holeD)}`, Y(0));
  if (b.L) dimV(Y(kind === 'helicoil' ? 0.25 * b.P : 0), Y((kind === 'helicoil' ? 0.25 * b.P : 0) + b.L), X(-r) - 16, `L ${n(b.L)}`, X(-(b.d1 || b.dhc || b.holeD) / 2), 'left');
  dimV(Y(0), Y(b.depth), X(r) + 16, `${n(b.depth)}`, X(rh), 'right');
  dimH(X(-r), X(r), Y(bossH) + 16, `Ø${n(b.od)} boss`, Y(bossH));
  out.push('<text class="tf-cap" x="8" y="14">Standoff kesiti</text>');
  return `<svg class="tb-figure-svg" viewBox="0 0 ${VW} ${VH}" role="img" aria-label="Burç kesit çizimi">${out.join('')}</svg>`;
}

/* ---------- Pencere ---------- */

const METHOD_LABEL = {
  insert: 'ısıyla gömülen insert', helicoil: 'Helicoil', tapped: 'doğrudan kılavuz', self_tap: 'sac vidası ön deliği',
};

/**
 * dialog: <dialog id="toolbox-dialog">; libraries: [vida kütüphanesi, burç kütüphanesi]; fasteners: fasteners.json
 * evaluate(screwSpec, insertSpec) → null (kart yok) ya da { auto, sel, standoffAuto, standoffNow, ruleMethod, helicoilD }
 * onApply(screwSpec, insertSpec): seçim uygulanınca
 */
export function createToolbox({ dialog, libraries, fasteners, materials = [], evaluate, onApply }) {
  const q = (sel) => dialog.querySelector(sel);
  const [screwLib, insertLib] = libraries;
  const types = libraryTypes(screwLib, 'screws');
  const washerTypes = libraryTypes(screwLib, 'washers');
  const washerById = (id) => washerTypes.find((w) => w.id === id) || null;
  const matById = (id) => materials.find((m) => m.id === id) || null;
  const insertTypes = libraryTypes(insertLib);
  const closedGroups = new Set();
  let draft = null;

  const typeById = (id) => types.find((t) => t.id === id) || types[0];
  const insertById = (id) => insertTypes.find((t) => t.id === id) || null;

  function normalize(spec) {
    const t = typeById(spec.type);
    const out = {
      type: t.id, size: spec.size, length: spec.length,
      material: spec.material && (spec.material === 'auto' || (t.materials || []).includes(spec.material)) ? spec.material : 'auto',
      washer: spec.washer || 'none', washerMaterial: spec.washerMaterial || 'match',
    };
    if (out.size !== 'auto' && !t.sizes[out.size]) out.size = 'auto';
    return out;
  }

  function open(screwSpec, insertSpec, view = 'screw') {
    draft = { screw: normalize(screwSpec), insert: { type: 'auto', variant: 'auto', ...insertSpec }, view, washerView: screwSpec.washer && screwSpec.washer !== 'none' ? screwSpec.washer : 'iso7089' };
    render();
    if (!dialog.open) dialog.showModal();
    q('.tb-item[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function renderTree() {
    const screwItem = (t) => `
      <button type="button" class="tb-item" role="treeitem" data-type="${t.id}" aria-selected="${draft.view === 'screw' && t.id === draft.screw.type}" title="${esc(t.name)}">
        ${headIcon(t.head)}<span class="tb-item-text"><span class="tb-code">${esc(t.code)}</span><span class="tb-name">${esc(t.short)}</span></span>
      </button>`;
    const insertItem = (t) => `
      <button type="button" class="tb-item" role="treeitem" data-insert="${t.id}" aria-selected="${draft.view === 'insert' && t.id === draft.insert.type}" title="${esc(t.name)}">
        ${insertIcon(t.kind)}<span class="tb-item-text"><span class="tb-code">${esc(t.code)}</span><span class="tb-name">${esc(t.short)}</span></span>
      </button>`;
    const washerItem = (t) => `
      <button type="button" class="tb-item" role="treeitem" data-washer="${t.id}" aria-selected="${draft.view === 'washer' && t.id === draft.washerView}" title="${esc(t.name)}">
        ${washerIcon(t.kind)}<span class="tb-item-text"><span class="tb-code">${esc(t.code)}</span><span class="tb-name">${esc(t.short)}${draft.screw.washer === t.id ? ' · seçili' : ''}</span></span>
      </button>`;
    const lib = (L, itemFor, count) => `
      <div class="tb-node"><span class="tb-caret" aria-hidden="true"></span><strong>${esc(L.standard)}</strong><span class="tb-count">${count} tip</span></div>
      ${L.categories.map((cat) => cat.soon
        ? `<div class="tb-node lvl1 soon"><span class="tb-caret" aria-hidden="true"></span>${esc(cat.label)}<span class="tb-soon">yakında</span></div>`
        : `<div class="tb-node lvl1"><span class="tb-caret" aria-hidden="true"></span>${esc(cat.label)}</div>
          ${(cat.groups || []).map((g) => `
            <div class="tb-group-node ${closedGroups.has(g.id) ? 'closed' : ''}" role="group">
              <button type="button" class="tb-node lvl2" data-group="${g.id}" aria-expanded="${!closedGroups.has(g.id)}">
                <span class="tb-caret" aria-hidden="true"></span>${esc(g.label)}<span class="tb-count">${g.types.length}</span>
              </button>
              <div class="tb-group-items">${g.types.map(itemFor(cat)).join('')}</div>
            </div>`).join('')}`).join('')}`;
    q('#tb-tree').innerHTML = lib(screwLib, (cat) => (cat.id === 'washers' ? washerItem : screwItem), types.length + washerTypes.length) +
      (insertLib ? lib(insertLib, () => insertItem, insertTypes.length) : '');
  }

  function render() {
    renderTree();
    if (draft.view === 'insert') renderInsert();
    else if (draft.view === 'washer') renderWasher();
    else renderScrew();
  }

  /** Sıkma torku bölümü: önerilen tork ve sınırlayan etkenler */
  function torqueSection(ev) {
    const tq = ev?.sel?.torque;
    const t = tq?.lid || tq?.pcb;
    if (!t) return '';
    const row = (x) => `<tr class="${x.key === t.limit ? 'tq-lim' : ''}"><th>${esc(torqueLimitText(x.key))}</th><td>${n(Math.round(x.T * 100) / 100)} N·m</td></tr>`;
    const other = tq.lid && tq.pcb ? `<p class="muted small">PCB vidaları: ${n(tq.pcb.T)} N·m (${esc(torqueLimitText(tq.pcb.limit))})</p>` : '';
    return `<section class="tb-group">
        <h4>Sıkma torku</h4>
        <div class="tq-value"><strong>${n(t.T)} N·m</strong><span class="muted small"> · ön yük ≈ ${n(Math.round(t.preload))} N</span></div>
        <p class="small">Sınırlayan: <span class="t-accent">${esc(torqueLimitText(t.limit))}</span></p>
        <table class="tb-table tq-table">${t.limits.map(row).join('')}</table>
        ${other}
        <p class="muted small">VDI 2230 yaklaşımı; plastik gövdede ilk parçada deneyle doğrulayın.</p>
      </section>`;
  }

  function renderScrew() {
    const t = typeById(draft.screw.type);
    const table = screwTable(fasteners, t);
    const screwBySize = (size) => table.find((x) => x.size === size) || null;
    const ev = evaluate(draft.screw, draft.insert);
    const info = ev?.auto?.fastenInfo || null;
    const minHole = ev?.auto?.usedHoleMinD ?? null;
    const sizes = Object.keys(t.sizes);
    const fits = (size) => minHole === null || (screwBySize(size)?.min_pcb_hole ?? 99) <= minHole + 1e-6;
    const autoSize = (info && sizes.includes(info.size) ? info.size : null) || [...sizes].reverse().find(fits) || sizes[0];
    const effSize = draft.screw.size === 'auto' ? autoSize : draft.screw.size;
    const sz = t.sizes[effSize] || t.sizes[sizes[0]];
    const screw = screwBySize(effSize);
    // Boy durumları: otomatik boyun hesaplandığı tasarıma göre
    const lid = ev?.auto?.screws?.find((x) => x.lid) || ev?.auto?.screws?.[0] || null;
    const autoL = lid?.length ?? null;
    const lenInfo = sz.lengths.map((L) => {
      if (!info || info.size !== effSize) return { L, status: 'na' };
      const eng = L - info.grip;
      if (eng < info.minEngage - 1e-9) return { L, status: 'short', eng };
      if (eng <= info.available - 0.3 + 1e-9) return { L, status: 'ok', eng };
      const need = Math.ceil((L - info.grip + 0.3 - info.floor + 0.8) * 10) / 10;
      return { L, status: ev.standoffAuto ? 'adapt' : 'long', eng, need };
    });
    if (draft.screw.length !== 'auto' && !sz.lengths.includes(Number(draft.screw.length))) draft.screw.length = 'auto';
    const selL = draft.screw.length === 'auto' ? autoL : Number(draft.screw.length);
    const figL = selL ?? sz.lengths[Math.floor(sz.lengths.length / 2)];

    const mat = resolveScrewMaterial(t, draft.screw.material, materials);
    const sunkHead = t.head === 'countersunk';
    const wt = !sunkHead && draft.screw.washer !== 'none' ? washerById(draft.screw.washer) : null;
    const wz = wt ? wt.sizes[washerSizeFor(effSize)] : null;
    q('#tb-figure').innerHTML = screwFigure(t, sz, effSize, screw ? screw.d : parseFloat(effSize.replace(/^[A-Z]+/, '')), figL, wz);
    q('#tb-designation').textContent = designation(t, effSize, figL) + (mat ? ` - ${mat.tag}` : '');
    const matChips = (t.materials || []).map((id) => {
      const m = matById(id);
      if (!m) return '';
      const on = draft.screw.material === 'auto' ? id === t.materials[0] : draft.screw.material === id;
      return `<button type="button" class="chip" data-mat="${id}" aria-checked="${on}" title="${esc(m.label)}">${esc(m.tag)}</button>`;
    }).join('');
    const wChips = [`<button type="button" class="chip" data-wsel="none" aria-checked="${draft.screw.washer === 'none'}">Yok</button>`]
      .concat(washerTypes.map((w) => {
        const has = !!w.sizes[washerSizeFor(effSize)];
        const dis = sunkHead || !has;
        return `<button type="button" class="chip" data-wsel="${w.id}" aria-checked="${draft.screw.washer === w.id}"${dis ? ` disabled title="${sunkHead ? 'Havşa başta pul kullanılmaz' : `${washerSizeFor(effSize)} boyutu yok`}"` : ''}>${esc(w.code)}</button>`;
      })).join('');
    const wMat = wt ? resolveWasherMaterial(wt, draft.screw.washerMaterial, mat, materials) : null;

    const sizeChips = [`<button type="button" class="chip" data-size="auto" aria-checked="${draft.screw.size === 'auto'}">Otomatik <span class="chip-sub">${esc(autoSize)}</span></button>`]
      .concat(sizes.map((size) => `<button type="button" class="chip ${fits(size) ? '' : 'bad'}" data-size="${esc(size)}" aria-checked="${draft.screw.size === size}"` +
        ` ${fits(size) ? '' : `disabled title="Ø${n(minHole)} PCB deliğinden geçmez"`}>${esc(size)}</button>`)).join('');
    const stLabel = { ok: 'uygun', short: 'kısa', adapt: 'uyarlanır', long: 'uzun', na: '' };
    const lenChips = [`<button type="button" class="chip" data-len="auto" aria-checked="${draft.screw.length === 'auto'}">Otomatik <span class="chip-sub">${autoL ? n(autoL) + ' mm' : '–'}</span></button>`]
      .concat(lenInfo.map((li) => `<button type="button" class="chip len ${li.status}" data-len="${li.L}" aria-checked="${String(draft.screw.length) === String(li.L)}"` +
        ` title="${esc(li.status === 'na' ? '' : `${stLabel[li.status]}${li.eng === undefined ? '' : li.eng <= 0 ? " · standoff'a ulaşmıyor" : ` · ${n(li.eng)} mm tutunur`}${li.need ? ` · PCB altı ${n(li.need)} mm olur` : ''}`)}">${n(li.L)}</button>`)).join('');

    const selInfo = lenInfo.find((li) => li.L === selL);
    let lenNote = '';
    if (!ev) lenNote = 'Kart yüklenince her boyun bu karttaki tutunması gösterilir.';
    else if (selInfo && selInfo.status === 'ok') lenNote = `<span class="t-ok">✓ Uygun:</span> ${n(selInfo.eng)} mm tutunur (en az ${n(info.minEngage)} mm).`;
    else if (selInfo && selInfo.status === 'short') {
      lenNote = selInfo.eng <= 0
        ? `<span class="t-warn">Kısa:</span> standoff'a ulaşmıyor; kapak + kart ${n(info.grip)} mm, en az ${n(info.grip + info.minEngage)} mm boy gerekir.`
        : `<span class="t-warn">Kısa:</span> yalnızca ${n(selInfo.eng)} mm tutunur (en az ${n(info.minEngage)} mm).`;
    } else if (selInfo && selInfo.status === 'adapt') lenNote = `<span class="t-accent">Uyarlanır:</span> PCB altı yükseklik ${n(selInfo.need)} mm olur, muhafaza yükselir.`;
    else if (selInfo && selInfo.status === 'long') lenNote = '<span class="t-warn">Uzun:</span> PCB altı yüksekliği elle girildiği için delik bu vidaya yetmez.';

    const tapping = isTapping(t);
    const method = info?.method || (tapping ? 'self_tap' : 'insert');
    const st0 = ev?.sel?.standoffs?.[0];
    const bodySide = tapping ? (screw ? `ön delik Ø${n(screw.selftap_pilot)} (diş vidayla açılır)` : '–')
      : st0 ? `${METHOD_LABEL[ev.sel.fasteningMethod] || ''}${st0.insert ? ` · ${st0.insert.kind === 'helicoil' ? 'Helicoil ' + st0.insert.id : st0.insert.id}` : ''} · delik Ø${n(st0.holeD)}`
        : METHOD_LABEL[method];
    const sunk = t.head === 'countersunk';
    const rows = [
      ['Standart', `${t.code} · ${t.name}`],
      ['Tahrik', `${DRIVE_LABEL[t.drive_kind] || ''} · ${driveText(t, sz)}`],
      ['Baş', `Ø${n(sz.dk_actual || sz.dk)} × ${n(sz.k)} mm${sunk ? ` · 90° havşa${sz.dk_actual ? ` (teorik Ø${n(sz.dk)})` : ''}` : ''}`],
      ['Diş', tapping ? `${effSize} sac vidası dişi, adım ${n(sz.P)} (ISO 1478)` : `${effSize} × ${n(sz.P)} (kaba)`],
      ['Kapak deliği', screw ? `Ø${n(screw.clearance)}${sunk ? ` + havşa Ø${n(sz.dk + 0.3)}` : ''}` : '–'],
      ['Gövde tarafı', bodySide],
      ['Boy ölçüsü', t.length_includes_head ? 'başı da kapsar (havşa üst yüzünden)' : 'baş altından uca'],
    ];
    q('#tb-props').innerHTML = `
      <section class="tb-group">
        <h4>Boyut</h4>
        <div class="chips">${sizeChips}</div>
        ${minHole !== null ? `<p class="muted small">En küçük montaj deliği Ø${n(minHole)} mm</p>` : ''}
      </section>
      <section class="tb-group">
        <h4>Boy <span class="muted">(mm)</span></h4>
        <div class="chips">${lenChips}</div>
        <p class="small tb-len-note">${lenNote}</p>
        ${ev ? '<div class="tb-legend"><span class="t-ok">uygun</span><span class="t-warn">kısa</span><span class="t-accent">standoff uyarlanır</span></div>' : ''}
      </section>
      <section class="tb-group">
        <h4>Malzeme / kaplama</h4>
        <div class="chips">${matChips}</div>
        ${mat ? `<p class="muted small">${esc(mat.label)}${mat.magnetic ? ' · manyetik' : ' · manyetik değil'}${mat.conductive ? '' : ' · yalıtkan'}</p>` : ''}
      </section>
      <section class="tb-group">
        <h4>Baş altı pulu</h4>
        <div class="chips">${wChips}</div>
        ${wt && wz ? `<p class="muted small">${esc(wt.name)} ${esc(washerSizeFor(effSize))}: Ø${n(wz.d1)}/Ø${n(wz.d2)} × ${n(wz.s)} mm${wMat ? ` · ${esc(wMat.tag)}` : ''}
          ${wt.materials.includes('pa66') ? ` · <button type="button" class="link-btn" data-wmat="${draft.screw.washerMaterial === 'pa66' ? 'match' : 'pa66'}">${draft.screw.washerMaterial === 'pa66' ? 'vidaya uygun malzeme' : 'PA66 yalıtım pulu yap'}</button>` : ''}
          · <button type="button" class="link-btn" data-washer="${wt.id}">ayrıntı →</button></p>`
          : sunkHead ? '<p class="muted small">Havşa başlı vidada baş altı pulu kullanılmaz.</p>' : ''}
      </section>
      ${torqueSection(ev)}
      <section class="tb-group">
        <h4>Özellikler</h4>
        <table class="tb-table">${rows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>
        ${!tapping ? '<button type="button" class="link-btn" data-view="insert">Gövde tarafını (burç) seç →</button>' : ''}
      </section>
      ${fitSection(ev)}`;
  }

  function renderWasher() {
    const w = washerById(draft.washerView) || washerTypes[0];
    const t = typeById(draft.screw.type);
    const ev = evaluate(draft.screw, draft.insert);
    const size = washerSizeFor(ev?.sel?.fastenInfo?.size || (draft.screw.size !== 'auto' ? draft.screw.size : 'M3'));
    const sizes = Object.keys(w.sizes);
    const z = w.sizes[size] || w.sizes[sizes[sizes.length - 1]];
    const shownSize = w.sizes[size] ? size : sizes[sizes.length - 1];
    const mat = resolveWasherMaterial(w, draft.screw.washerMaterial, resolveScrewMaterial(t, draft.screw.material, materials), materials);
    q('#tb-figure').innerHTML = washerFigure(w, z);
    q('#tb-designation').textContent = `${w.code} - ${shownSize.replace(/^M/, '')}${mat ? ' - ' + mat.tag : ''}`;
    const inUse = draft.screw.washer === w.id;
    const sunk = t.head === 'countersunk';
    const rows = [
      ['Standart', `${w.code} · ${w.name}`],
      ['Boyut', `${shownSize}${w.sizes[size] ? '' : ` (vida boyutu ${size} bu seride yok)`}`],
      ['İç çap d1', `Ø${n(z.d1)}`], ['Dış çap d2', `Ø${n(z.d2)}`], ['Kalınlık s', `${n(z.s)} mm`],
      ...(z.teeth ? [['Diş sayısı', `${z.teeth}`]] : []),
      ...(z.b ? [['Kesit genişliği b', `${n(z.b)} mm`]] : []),
      ['Boy hesabı', `vida boyuna +${n(z.s)} mm eklenir`],
    ];
    const notes = {
      flat: w.id === 'iso7093' ? 'Geniş oturma yüzeyi: plastik kapakta baş baskısını düşürür, daha yüksek sıkma torkuna izin verir.'
        : w.id === 'iso7092' ? 'Küçük seri: silindir ve imbus başlar ile dar PCB pedleri için.' : 'Genel amaçlı düz pul.',
      serrated: 'Tırtıllar boya/eloksali delerek topraklama teması sağlar. DIN 6798 geri çekilmiştir; titreşimde kilitleme için güvenilmez.',
      spring: 'DIN 127 geri çekilmiştir; VDI 2230\'a göre gevşemeyi önlemez. Kilit için sıvı vida sabitleyici önerilir.',
    };
    q('#tb-props').innerHTML = `
      <section class="tb-group">
        <h4>Kullanım</h4>
        <div class="chips">
          <button type="button" class="chip" data-wsel="${w.id}" aria-checked="${inUse}"${sunk || !w.sizes[size] ? ' disabled' : ''}>Bu pulu kullan</button>
          <button type="button" class="chip" data-wsel="none" aria-checked="${draft.screw.washer === 'none'}">Pul yok</button>
        </div>
        ${sunk ? '<p class="small"><span class="t-warn">Havşa başlı vida seçili:</span> baş altı pulu kullanılmaz.</p>' : ''}
      </section>
      ${w.materials.includes('pa66') ? `<section class="tb-group">
        <h4>Malzeme</h4>
        <div class="chips">
          <button type="button" class="chip" data-wmat="match" aria-checked="${draft.screw.washerMaterial !== 'pa66'}">Vidaya uygun${mat && draft.screw.washerMaterial !== 'pa66' ? ` <span class="chip-sub">${esc(mat.tag)}</span>` : ''}</button>
          <button type="button" class="chip" data-wmat="pa66" aria-checked="${draft.screw.washerMaterial === 'pa66'}">PA66 yalıtım</button>
        </div>
      </section>` : ''}
      <section class="tb-group">
        <h4>Özellikler</h4>
        <table class="tb-table">${rows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>
        <p class="muted small">${esc(notes[w.kind] || '')}</p>
        <button type="button" class="link-btn" data-view="screw">← Vida seçimine dön</button>
      </section>
      ${torqueSection(ev)}`;
  }

  /** "Bu tasarımda" bölümü: seçimle oluşacak tasarımın özeti ve bağlantı uyarıları */
  function fitSection(ev) {
    const sel = ev?.sel;
    if (!sel || !sel.outer) return '';
    const issues = (sel.checks || []).filter((c) => c.cat === 'baglanti' && (c.level === 'error' || c.level === 'warn')).slice(0, 4);
    const st0 = sel.standoffs?.[0];
    const fi = sel.fastenInfo;
    const rows = [
      ['PCB altı yükseklik', `${n(sel.params.standoffHeight)} mm${Math.abs(sel.params.standoffHeight - ev.standoffNow) > 1e-6 ? ` <span class="muted">(şu an ${n(ev.standoffNow)})</span>` : ''}`],
      ['Muhafaza dış ölçü', `${n(sel.outer.L)} × ${n(sel.outer.W)} × ${n(sel.outer.H)} mm`],
      st0 ? ['Standoff', `Ø${n(st0.od)} · delik Ø${n(st0.holeD)} × ${n(st0.depth)} mm`] : null,
      fi && sel.screws[0] ? ['Vida tutunması', `${n(sel.screws.find((x) => x.lid)?.engagement ?? sel.screws[0].engagement)} mm (en az ${n(fi.minEngage)})`] : null,
      ['Vida sayısı', `${sel.screws.length} (${sel.screws.filter((x) => x.lid).length} kapak + PCB)`],
    ].filter(Boolean);
    return `<section class="tb-group">
        <h4>Bu tasarımda</h4>
        <table class="tb-table">${rows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${b}</td></tr>`).join('')}</table>
        ${issues.length ? `<ul class="notes">${issues.map((c) => `<li class="note ${c.level}"><span>${esc(c.text)}</span></li>`).join('')}</ul>` : '<p class="small"><span class="t-ok">✓</span> Bağlantı kontrollerinde sorun yok.</p>'}
      </section>`;
  }

  function renderInsert() {
    const ev = evaluate(draft.screw, draft.insert);
    const sel = ev?.sel;
    const st0 = sel?.standoffs?.[0] || null;
    const method = sel?.fasteningMethod || null;
    const screwT = typeById(draft.screw.type);
    const tapping = isTapping(screwT);
    const effType = draft.insert.type === 'auto' ? (sel?.insertType ? insertById(sel.insertType.id) : null)
      : draft.insert.type === 'none' ? null : insertById(draft.insert.type);
    const size = sel?.fastenInfo?.size || (draft.screw.size !== 'auto' ? draft.screw.size : 'M3');
    const zs = effType?.sizes[size] || null;
    const screwRow = (fasteners.screws || []).find((x) => x.size === size) || null;

    // Gövde tarafı seçimi
    const ruleLabel = ev ? METHOD_LABEL[ev.ruleMethod] || '' : 'kural dosyası';
    const choice = [
      ['auto', `Otomatik <span class="chip-sub">${esc(ruleLabel)}</span>`],
      ...insertTypes.map((t) => [t.id, esc(t.kind === 'helicoil' ? 'Helicoil' : 'Isıyla gömülen insert')]),
      ['none', 'Doğrudan kılavuz'],
    ].map(([id, label]) => `<button type="button" class="chip" data-itype="${id}" aria-checked="${draft.insert.type === id}">${label}</button>`).join('');

    // Varyant (boy) seçimi ve durumları
    const fi = sel?.fastenInfo || null;
    const helicoilD = ev?.helicoilD || 2;
    let variantChips = '';
    let note = '';
    if (zs) {
      const avail = fi ? fi.available : null;
      const floor = fi ? fi.floor : 0;
      const status = (v) => {
        if (avail === null) return { status: 'na' };
        const req = effType.kind === 'helicoil' ? v.L + 3.5 * zs.P + 0.5 : v.L + 0.5;
        if (req <= avail + 1e-9) return { status: 'ok', req };
        const need = Math.ceil((req - floor + 0.8) * 10) / 10;
        return { status: ev.standoffAuto ? 'adapt' : 'long', req, need };
      };
      const autoV = st0?.insert?.id || null;
      variantChips = [`<button type="button" class="chip" data-variant="auto" aria-checked="${draft.insert.variant === 'auto'}">Otomatik <span class="chip-sub">${esc(autoV ? (effType.kind === 'helicoil' ? autoV.replace('.', ',') : autoV.replace(/^RX-/, '')) : '–')}</span></button>`]
        .concat(zs.variants.map((v) => {
          const s = status(v);
          const rec = effType.kind === 'helicoil' && v.id === `${helicoilD}d`;
          const label = effType.kind === 'helicoil' ? `${v.id.replace('.', ',')} · ${n(v.L)}` : `${n(v.L)}${v.short ? ' kısa' : ''}`;
          const title = s.status === 'ok' ? `uygun · delik ${n(s.req)} mm` : s.status === 'adapt' ? `PCB altı ${n(s.need)} mm olur` : s.status === 'long' ? 'delik derinliği yetmez' : '';
          return `<button type="button" class="chip len ${s.status}${rec ? ' rec' : ''}" data-variant="${esc(v.id)}" aria-checked="${draft.insert.variant === v.id}" title="${esc(title + (rec ? ' · bu malzeme için önerilen' : ''))}">${esc(label)}${rec ? ' ★' : ''}</button>`;
        })).join('');
      if (effType.kind === 'helicoil') note = `★ ${ev ? 'Bu malzeme için' : 'Önerilen'} ${n(helicoilD)}·d. Vida, burcun tamamını kavramalı.`;
    }
    if (draft.insert.variant !== 'auto' && zs && !zs.variants.some((v) => v.id === draft.insert.variant)) draft.insert.variant = 'auto';

    // Ağaçta etkin burcu işaretle (Otomatik seçiliyken kuralın verdiği burç)
    if (effType) {
      const el = q(`[data-insert="${effType.id}"]`);
      if (el) { el.setAttribute('aria-selected', 'true'); el.scrollIntoView({ block: 'nearest' }); }
    }
    // Çizim ve tanım
    const v = zs ? (zs.variants.find((x) => x.id === (draft.insert.variant !== 'auto' ? draft.insert.variant : st0?.insert?.id)) || zs.variants[zs.variants.length - 1]) : null;
    const d = screwRow ? screwRow.d : parseFloat(size.replace(/^[A-Z]+/, '')) || 3;
    const od = st0?.od || (v ? (v.d1 || zs.dhc || d) + 4 : d + 4);
    const kind = tapping ? 'self_tap' : effType ? effType.kind : 'tapped';
    const holeD = kind === 'heatset' && v ? v.hole : kind === 'helicoil' && zs ? zs.drill : st0?.holeD || (screwRow ? screwRow.tap_drill : d * 0.8);
    const depth = st0?.depth || (v ? v.L + (kind === 'helicoil' ? 3.5 * zs.P + 0.5 : 0.5) : 2 * d + 0.5);
    q('#tb-figure').innerHTML = insertFigure(kind, {
      od, holeD, depth, d, P: zs?.P || (screwT.sizes[size]?.P ?? 0.5), L: v ? v.L : null, d1: v?.d1, d2: v?.d2, dhc: zs?.dhc,
      csk: kind === 'helicoil' && zs ? zs.dhc + 0.1 : null,
    });
    q('#tb-designation').textContent = kind === 'heatset' && v ? `ruthex ${v.id}`
      : kind === 'helicoil' && v ? `HELICOIL Plus ${size} × ${v.id.replace('.', ',')} (${n(v.L)}) · DIN 8140`
        : kind === 'self_tap' ? `Sac vidası ön deliği Ø${n(holeD)}` : `${size} kılavuz · matkap Ø${n(holeD)}`;

    let rows;
    if (kind === 'heatset' && v) {
      rows = [['Seri', `${effType.code} · ${effType.material}`], ['Dış çap', `Ø${n(v.d1)} (alt Ø${n(v.d2)})`], ['Boy', `${n(v.L)} mm`],
        ['Delik', `Ø${n(v.hole)} kör delik`], ['En az et', `${n(v.wall)} mm → boss ≥ Ø${n(v.d1 + 2 * v.wall)}`],
        ['Montaj', 'Havya ucu ile dik bastır (baskı sıcaklığı +10 °C), yüzeyle aynı hizada bitir']];
    } else if (kind === 'helicoil' && v) {
      rows = [['Standart', `${effType.standard} · ${effType.code} Free Running`], ['Malzeme', effType.material], ['Boy', `${v.id.replace('.', ',')} = ${n(v.L)} mm`],
        ['Matkap', `Ø${n(zs.drill)}`], ['Kılavuz', `${size} STI (Helicoil), yuva dişi ≥ Ø${n(zs.dhc)}`], ['Havşa', `90° Ø${n(zs.dhc + 0.1)}`],
        ['Montaj', 'Montaj aletiyle 0,25–0,5·P içeri; tang kırıcı ile tang kırılır']];
    } else if (kind === 'self_tap') {
      rows = [['Vida', `${screwT.code} sac vidası`], ['Gövde', `Ø${n(holeD)} ön delik; diş vidayla açılır`]];
    } else {
      rows = [['Diş', `${size} metrik, doğrudan gövdeye`], ['Matkap', `Ø${n(holeD)}`], ['Not', 'Metalde ve sert plastikte uygundur; baskıda ve PTFE\'de aşınır']];
    }
    q('#tb-props').innerHTML = `
      <section class="tb-group">
        <h4>Gövde tarafı</h4>
        <div class="chips">${choice}</div>
        ${tapping ? '<p class="small"><span class="t-warn">Sac vidası seçili:</span> gövdede burç kullanılmaz, vida dişini kendisi açar.</p>'
          : method ? `<p class="muted small">Şu an: ${esc(METHOD_LABEL[method] || '')} · vida boyutu ${esc(size)}</p>` : ''}
      </section>
      ${zs ? `<section class="tb-group">
        <h4>Boy <span class="muted">(mm)</span></h4>
        <div class="chips">${variantChips}</div>
        ${note ? `<p class="small muted">${note}</p>` : ''}
        ${ev ? '<div class="tb-legend"><span class="t-ok">uygun</span><span class="t-accent">standoff uyarlanır</span></div>' : ''}
      </section>` : ''}
      <section class="tb-group">
        <h4>Özellikler</h4>
        <table class="tb-table">${rows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>
        <button type="button" class="link-btn" data-view="screw">← Vida seçimine dön</button>
      </section>
      ${fitSection(ev)}`;
  }

  q('#tb-tree').addEventListener('click', (e) => {
    const grp = e.target.closest('[data-group]');
    if (grp) {
      const id = grp.dataset.group;
      if (closedGroups.has(id)) closedGroups.delete(id); else closedGroups.add(id);
      renderTree();
      return;
    }
    const wsh = e.target.closest('[data-washer]');
    if (wsh) { draft.washerView = wsh.dataset.washer; draft.view = 'washer'; render(); return; }
    const ins = e.target.closest('[data-insert]');
    if (ins) {
      if (draft.insert.type !== ins.dataset.insert) draft.insert = { type: ins.dataset.insert, variant: 'auto' };
      draft.view = 'insert';
      render();
      return;
    }
    const item = e.target.closest('[data-type]');
    if (!item) return;
    if (item.dataset.type === draft.screw.type && draft.view === 'screw') return;
    draft.screw = normalize({ ...draft.screw, type: item.dataset.type });
    draft.view = 'screw';
    render();
  });
  q('#tb-props').addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]');
    if (view) { draft.view = view.dataset.view; render(); return; }
    const wlink = e.target.closest('[data-washer]');
    if (wlink) { draft.washerView = wlink.dataset.washer; draft.view = 'washer'; render(); return; }
    const wmat = e.target.closest('[data-wmat]');
    if (wmat) { draft.screw.washerMaterial = wmat.dataset.wmat; render(); return; }
    const chip = e.target.closest('[data-size],[data-len],[data-itype],[data-variant],[data-mat],[data-wsel]');
    if (!chip || chip.disabled) return;
    if (chip.dataset.size) { draft.screw.size = chip.dataset.size; draft.screw.length = 'auto'; }
    if (chip.dataset.len) draft.screw.length = chip.dataset.len === 'auto' ? 'auto' : Number(chip.dataset.len);
    if (chip.dataset.itype) draft.insert = { type: chip.dataset.itype, variant: 'auto' };
    if (chip.dataset.variant) draft.insert.variant = chip.dataset.variant;
    if (chip.dataset.mat) draft.screw.material = chip.dataset.mat;
    if (chip.dataset.wsel) { draft.screw.washer = chip.dataset.wsel; if (chip.dataset.wsel !== 'none') draft.washerView = chip.dataset.wsel; }
    render();
  });
  q('#tb-apply').addEventListener('click', () => {
    onApply({ ...draft.screw }, { ...draft.insert });
    dialog.close();
  });
  q('#tb-cancel').addEventListener('click', () => dialog.close());

  return { open, types, typeById, insertTypes };
}
