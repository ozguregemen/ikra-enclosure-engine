/*
 * Teknik resim (M4).
 * CAD işçisinin gizli çizgi kaldırmalı (HLR) izdüşümlerinden A4 yatay SVG paftaları üretir
 * (gövde + kapak) ve isteğe bağlı olarak PDF'e çevirir (jsPDF + svg2pdf.js, Türkçe için DejaVu Sans).
 * Koordinatlar gövdenin dış köşesine (0, 0, 0) göredir; tüm ölçüler mm.
 */

import { matchPreferred as matchPref } from './bom.js';

const JSPDF_URL ='https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';
const SVG2PDF_URL = 'https://cdn.jsdelivr.net/npm/svg2pdf.js@2.9.0/dist/svg2pdf.umd.min.js';
const FONT_REG_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf';
const FONT_BOLD_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf';
const FONT = 'DejaVu Sans';
// Önizlemede DejaVu kurulu değilse benzer bir sans-serif'e düşer; PDF'te gömülü DejaVu kullanılır
const FONT_STACK = `'DejaVu Sans', 'Segoe UI', Arial, Helvetica, sans-serif`;

const W = 297;
const H = 210;
const SCALES = [2, 1, 0.5, 0.2, 0.1];
const scaleText = (s) => (s >= 1 ? `${s}:1` : `1:${Math.round(1 / s)}`);
const nf1 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const d1 = (v) => nf1.format(Math.round(v * 10) / 10);
const d2 = (v) => nf2.format(Math.round(v * 100) / 100);
const r3 = (v) => Math.round(v * 1000) / 1000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STROKE_VISIBLE = 0.35;
const STROKE_THIN = 0.18;

/* ---------- SVG yol ayrıştırma ve dönüştürme ---------- */

const ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function parsePath(d) {
  const tokens = d.match(/[MLHVCSQTAZmlhvcsqtaz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const segs = [];
  let cmd = null;
  let buf = [];
  for (const t of tokens) {
    if (/[a-z]/i.test(t)) {
      cmd = t.toUpperCase();
      buf = [];
      if (cmd === 'Z') segs.push({ c: 'Z', a: [] });
      continue;
    }
    if (!cmd || cmd === 'Z') continue;
    buf.push(Number(t));
    if (buf.length === ARGC[cmd]) {
      segs.push({ c: cmd, a: buf });
      buf = [];
      if (cmd === 'M') cmd = 'L'; // M'den sonraki örtük koordinatlar çizgidir
    }
  }
  return segs;
}

function segsBox(list, box) {
  for (const segs of list) {
    for (const { c, a } of segs) {
      if (c === 'Z' || c === 'H' || c === 'V') continue;
      const x = a[a.length - 2];
      const y = a[a.length - 1];
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
  }
  return box;
}

function mapSegs(segs, tf) {
  const X = (x) => r3(tf.ox + tf.s * (x - tf.x0));
  const Y = (y) => r3(tf.oy + tf.s * (y - tf.y0));
  return segs.map(({ c, a }) => {
    switch (c) {
      case 'M': case 'L': case 'T': return `${c}${X(a[0])} ${Y(a[1])}`;
      case 'H': return `H${X(a[0])}`;
      case 'V': return `V${Y(a[0])}`;
      case 'C': return `C${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])} ${X(a[4])} ${Y(a[5])}`;
      case 'S': case 'Q': return `${c}${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])}`;
      case 'A': return `A${r3(a[0] * tf.s)} ${r3(a[1] * tf.s)} ${a[2]} ${a[3]} ${a[4]} ${X(a[5])} ${Y(a[6])}`;
      default: return 'Z';
    }
  }).join('');
}

/* ---------- Görünüşler ---------- */

// Dünya noktası → görünüşün 2B SVG koordinatı (y aşağı). cad-worker'daki kameralarla aynı.
const VIEW_UV = {
  top: (p) => [p[0], -p[1]],
  bottom: (p) => [p[0], p[1]],
  front: (p) => [p[0], -p[2]],
  back: (p) => [-p[0], -p[2]],
  right: (p) => [p[1], -p[2]],
  left: (p) => [-p[1], -p[2]],
  // cad-worker iso kamerası: yön (1, −1, 1), kağıtta sağ (1, 1, 0)/√2, yukarı (−1, 1, 2)/√6
  iso: (p) => [(p[0] + p[1]) / Math.SQRT2, -(-p[0] + p[1] + 2 * p[2]) / Math.sqrt(6)],
};
const VIEW_LABEL = {
  top: 'ÜST GÖRÜNÜŞ', bottom: 'ALT GÖRÜNÜŞ', front: 'ÖN GÖRÜNÜŞ (−Y)',
  back: 'ARKA GÖRÜNÜŞ (+Y)', right: 'SAĞ GÖRÜNÜŞ (+X)', left: 'SOL GÖRÜNÜŞ (−X)',
};
const SIDE_VIEW = { '-Y': 'front', '+Y': 'back', '+X': 'right', '-X': 'left' };

function prepView(key, proj) {
  const vis = proj.visible.map(parsePath);
  const hid = proj.hidden.map(parsePath);
  const box = segsBox(vis.concat(hid), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  return { key, vis, hid, box, w: box.x1 - box.x0, h: box.y1 - box.y0 };
}

/** Görünüşü (ox, oy) sol üst köşesine s ölçeğiyle yerleştirir; dünya→kağıt dönüşümünü döndürür. */
function placeView(out, view, ox, oy, s, label) {
  const tf = { s, ox, oy, x0: view.box.x0, y0: view.box.y0 };
  for (const segs of view.hid) {
    out.push(`<path d="${mapSegs(segs, tf)}" fill="none" stroke="#000" stroke-width="${STROKE_THIN}" stroke-dasharray="1.2 0.8"/>`);
  }
  for (const segs of view.vis) {
    out.push(`<path d="${mapSegs(segs, tf)}" fill="none" stroke="#000" stroke-width="${STROKE_VISIBLE}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  out.push(text(ox, oy - 3, label, 2.6, { bold: true }));
  const toPaper = (p) => {
    const [u, v] = VIEW_UV[view.key](p);
    return [tf.ox + s * (u - tf.x0), tf.oy + s * (v - tf.y0)];
  };
  return { toPaper, x0: ox, y0: oy, x1: ox + s * view.w, y1: oy + s * view.h };
}

/* ---------- Çizim yardımcıları ---------- */

function text(x, y, str, size = 2.5, { bold = false, anchor = 'start', rotate = 0 } = {}) {
  const tr = rotate ? ` transform="rotate(${rotate} ${r3(x)} ${r3(y)})"` : '';
  return `<text x="${r3(x)}" y="${r3(y)}" font-family="${FONT_STACK}" font-size="${size}" font-weight="${bold ? 'bold' : 'normal'}" text-anchor="${anchor}"${tr}>${esc(str)}</text>`;
}
const line = (x1, y1, x2, y2, w = STROKE_THIN) =>
  `<line x1="${r3(x1)}" y1="${r3(y1)}" x2="${r3(x2)}" y2="${r3(y2)}" stroke="#000" stroke-width="${w}"/>`;

function arrow(x, y, dx, dy) {
  const L = 2.2;
  const Wd = 0.6;
  const n = Math.hypot(dx, dy) || 1;
  const ux = dx / n, uy = dy / n;
  const bx = x - ux * L, by = y - uy * L;
  return `<path d="M${r3(x)} ${r3(y)}L${r3(bx - uy * Wd)} ${r3(by + ux * Wd)}L${r3(bx + uy * Wd)} ${r3(by - ux * Wd)}Z" fill="#000"/>`;
}

/** Yatay ölçü: x1..x2 arası, ölçü çizgisi y'de; ext: uzatma çizgilerinin başladığı y */
function dimH(out, x1, x2, y, extFrom, value) {
  out.push(line(x1, extFrom, x1, y + (y > extFrom ? 1 : -1)), line(x2, extFrom, x2, y + (y > extFrom ? 1 : -1)));
  out.push(line(x1, y, x2, y), arrow(x1, y, -1, 0), arrow(x2, y, 1, 0));
  out.push(text((x1 + x2) / 2, y - 0.8, d1(value), 2.5, { anchor: 'middle' }));
}

/** Düşey ölçü: y1..y2 arası, ölçü çizgisi x'te */
function dimV(out, y1, y2, x, extFrom, value) {
  out.push(line(extFrom, y1, x + (x > extFrom ? 1 : -1), y1), line(extFrom, y2, x + (x > extFrom ? 1 : -1), y2));
  out.push(line(x, y1, x, y2), arrow(x, y1, 0, -1), arrow(x, y2, 0, 1));
  out.push(text(x - 0.8, (y1 + y2) / 2, d1(value), 2.5, { anchor: 'middle', rotate: -90 }));
}

function balloon(out, x, y, tx, ty, label) {
  out.push(line(x, y, tx, ty));
  out.push(`<circle cx="${r3(x)}" cy="${r3(y)}" r="0.45" fill="#000"/>`);
  out.push(`<circle cx="${r3(tx)}" cy="${r3(ty)}" r="2.4" fill="#fff" stroke="#000" stroke-width="${STROKE_THIN}"/>`);
  out.push(text(tx, ty + 0.85, label, 2.2, { anchor: 'middle', bold: true }));
}

function centerMark(out, x, y, r) {
  const e = r + 1.2;
  out.push(`<path d="M${r3(x - e)} ${r3(y)}H${r3(x + e)}M${r3(x)} ${r3(y - e)}V${r3(y + e)}" stroke="#000" stroke-width="0.13" stroke-dasharray="2 0.6 0.4 0.6"/>`);
}

/** Basit tablo: cols [{label, w, align}], rows: string[][] */
function table(out, x, y, title, cols, rows) {
  const rh = 4.2;
  const totalW = cols.reduce((a, c) => a + c.w, 0);
  out.push(text(x, y - 1.2, title, 2.6, { bold: true }));
  out.push(`<rect x="${r3(x)}" y="${r3(y)}" width="${r3(totalW)}" height="${r3(rh * (rows.length + 1))}" fill="none" stroke="#000" stroke-width="${STROKE_THIN}"/>`);
  out.push(`<rect x="${r3(x)}" y="${r3(y)}" width="${r3(totalW)}" height="${rh}" fill="#eef1f4"/>`);
  let cx = x;
  cols.forEach((c, i) => {
    if (i) out.push(line(cx, y, cx, y + rh * (rows.length + 1)));
    out.push(text(cx + 1, y + rh - 1.2, c.label, 2.1, { bold: true }));
    rows.forEach((row, j) => out.push(text(cx + 1, y + rh * (j + 2) - 1.2, row[i], 2.1)));
    cx += c.w;
  });
  for (let j = 1; j <= rows.length; j++) out.push(line(x, y + rh * j, x + totalW, y + rh * j));
  return y + rh * (rows.length + 1);
}

/** Satır kaydırmalı numaralı notlar; dönüş: son y */
function notes(out, x, y, width, title, items, size = 2.2) {
  out.push(text(x, y, title, 2.6, { bold: true }));
  let yy = y + 4;
  const maxChars = Math.floor(width / (size * 0.56));
  items.forEach((item, i) => {
    const words = `${i + 1}. ${item}`.split(' ');
    let cur = '';
    const lines = [];
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (next.length > maxChars && cur) { lines.push(cur); cur = `   ${w}`; } else cur = next;
    }
    if (cur) lines.push(cur);
    for (const l of lines) { out.push(text(x, yy, l, size)); yy += size * 1.35; }
  });
  return yy;
}

/** Notları antede taşmadan sığdır: gerekirse yazı boyunu küçültür (2,2 → 1,6) */
function fitNotes(out, x, y, width, title, items, yMax = 168) {
  const lineCount = (size) => {
    const maxChars = Math.floor(width / (size * 0.56));
    return items.reduce((sum, item, i) => sum + Math.max(1, Math.ceil((`${i + 1}. ${item}`.length * 1.08) / maxChars)), 0);
  };
  const size = [2.2, 2.0, 1.85, 1.7, 1.6].find((s) => y + 4 + lineCount(s) * s * 1.35 <= yMax) || 1.6;
  return notes(out, x, y, width, title, items, size);
}

function titleBlock(out, info, part, sheetNo, sheetCount, scale) {
  const x = 167, y = 172, w = 120, h = 28;
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="#000" stroke-width="${STROKE_VISIBLE}"/>`);
  out.push(line(x, y + 8, x + w, y + 8), line(x, y + 15, x + w, y + 15), line(x, y + 22, x + w, y + 22));
  out.push(line(x + 70, y, x + 70, y + 22));
  out.push(text(x + 2, y + 5.6, 'IKRA ENCLOSURE ENGINE', 3.2, { bold: true }));
  out.push(text(x + 72, y + 3.2, 'PARÇA', 1.8), text(x + 72, y + 6.9, part, 3, { bold: true }));
  out.push(text(x + 2, y + 10.6, 'PROJE', 1.8), text(x + 2, y + 14, info.project, 2.5));
  out.push(text(x + 72, y + 10.6, 'MALZEME', 1.8), text(x + 72, y + 14, info.material, 2.5));
  out.push(text(x + 2, y + 17.6, 'ÜRETİM YÖNTEMİ', 1.8), text(x + 2, y + 21, info.process, 2.5));
  out.push(text(x + 72, y + 17.6, 'KORUMA', 1.8), text(x + 72, y + 21, info.ip, 2.5));
  const cells = [['ÖLÇEK', scaleText(scale)], ['BİRİM', 'mm'], ['TARİH', info.date], ['PAFTA', `${sheetNo} / ${sheetCount}`]];
  const cw = w / cells.length;
  cells.forEach(([k, v], i) => {
    if (i) out.push(line(x + cw * i, y + 22, x + cw * i, y + h));
    out.push(text(x + cw * i + 1.5, y + 24.4, k, 1.6), text(x + cw * i + 1.5, y + 27.2, v, 2.3, { bold: true }));
  });
  out.push(text(x + w, y - 1.2, `Ikra ${info.version} · koordinatlar gövde dış köşesine (0,0,0) göre`, 1.7, { anchor: 'end' }));
}

function sheetSvg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>` +
    `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="#000" stroke-width="0.5"/>` +
    body.join('') + '</svg>';
}

function chooseScale(fits) {
  for (const s of SCALES) if (fits(s)) return s;
  return SCALES[SCALES.length - 1];
}

/* ---------- Paftalar ---------- */

function toleranceNotes(rules, d = null) {
  const pp = rules.process_params || {};
  const t = d?.tolerance;
  const treated = !!d?.geometry?.treat;
  const gen = t ? `±${d2(t.general)} mm (+±${d2(t.per_100mm)} mm / 100 mm)` : null;
  const fitTxt = t ? `Kapak geçmesi ${{ press: 'sıkı', normal: 'normal', loose: 'bol' }[t.fitSel.lid]} (dil boşluğu ${d2(t.lidGap)} mm/kenar); geçiş delikleri ISO 273 ${{ press: 'ince', normal: 'orta', loose: 'kaba' }[t.fitSel.screw]} seri.` : null;
  if (rules.process === 'fdm') {
    return [
      `Genel tolerans ${gen || '±0,2 mm'} (FDM, ${rules.label}, Ø${d1(pp.nozzle_diameter)} nozul, ${d1(pp.layer_height)} mm katman).`,
      ...(t && t.hole_comp ? [`Delikler baskıda küçük çıkacağı için modelde +${d2(t.hole_comp)} mm telafili çizilmiştir; ölçüler modeldeki değerlerdir.`] : []),
      ...(fitTxt ? [fitTxt] : []),
    ];
  }
  if (rules.process === 'cnc') {
    // Kenar işlemli modelde kenar/köşe notları edgeNotes()'tan gelir (model neyse not o)
    if (treated) return [`Genel toleranslar ISO 2768-m; ${rules.label} için ${gen || '±0,1 mm'}.`, ...(fitTxt ? [fitTxt] : [])];
    return [
      `Genel toleranslar ISO 2768-m; ${rules.label} için ${gen || '±0,1 mm'}. Keskin kenarları 0,3×45° kır.`,
      `İç köşe radyüsleri takıma göre R${d1(pp.tool_diameter / 2 + 0.1)}.`,
      ...(fitTxt ? [fitTxt] : []),
    ];
  }
  if (treated) return ['Genel toleranslar ISO 20457 TG6.', `Çekme payı %${d1(rules.shrink_factor * 100)} kalıpta uygulanır.`];
  return [
    'Genel toleranslar ISO 20457 TG6.',
    `Kalıp çıkma açısı ≥ ${d1(rules.draft_angle_min)}° (resimde gösterilmemiştir). Çekme payı %${d1(rules.shrink_factor * 100)} kalıpta uygulanır.`,
  ];
}

/**
 * Kenar / çıkma açısı notları: geometry.treat (politika) ve treatReport (katı modelde gerçekten uygulanan) üzerinden.
 * Yalnızca modelde olan işlem yazılır; uygulanamayanlar ayrıca belirtilir. treat yoksa boş (eski notlar geçerli).
 */
function edgeNotes(d, part) {
  const T = d?.geometry?.treat;
  const P = T?.[part];
  if (!P) return [];
  const rep = (d.treatReport || []).filter((e) => e.part === part);
  const has = rep.length > 0;
  // Uygulanan ölçü (rapor yoksa politika değeri)
  const got = (key, fallback = 0) => {
    const e = rep.find((x) => x.key === key);
    if (!e) return has ? 0 : fallback;
    return e.applied > 0 ? e.applied : 0;
  };
  const n = [];
  const geo = d.geometry;
  const cnc = P.process === 'cnc';
  const fdm = P.process === 'fdm';
  const inj = P.process === 'injection';
  if (part === 'base') {
    if (inj) {
      const dr = got('draft.outer', P.draftDeg);
      const dp = got('draft.pocket', P.draftDeg);
      if (dr > 0 && dp > 0) {
        n.push(`Kalıp çıkma açısı ${d1(dr)}° modelde uygulanmıştır (çekme +Z): dış ve iç duvar paralel açılı, cep taban seviyesinde anma ölçüsünde; ayırma çizgisi ağız dış kenarında, keskin. Dış hat ağızda her yanda +${d2(T.rim.grow)} mm.`);
      } else n.push(`Kalıp çıkma açısı ≥ ${d1(P.draftDeg)}° gerekir; modelde uygulanamadı (işlem raporu).`);
      const ri = got('floor', P.floorFillet);
      const ro = got('outer.bottom', P.outerBottomFillet);
      if (ri > 0 || ro > 0) n.push(`İç taban köşesi R${d2(ri)}${ro > 0 ? `, dış alt kenar R${d2(ro)} (iç radyüs + et, aynı merkez)` : ''}.`);
      const sr = got('standoff.root', P.bossRootFillet);
      if ((geo.standoffs || []).some((s) => s.integral !== false) && sr > 0) n.push(`Boss'lar: dış yüz ${d1(P.bossDraftDeg)}° açılı, kök R${d2(sr)}, uçta ${d1(P.bossTipChamfer)}×45° pah.`);
      if ((geo.ears || []).length || (geo.cutouts || []).some((c) => c.z1 <= geo.cavTop)) n.push('Kulaklar ve kapalı yan pencereler kalıpta yan maça ister; bunlarda çıkma açısı uygulanmamıştır.');
    } else if (cnc) {
      const b = got('outer.bottom', P.outerEdgeBreak);
      const parts = [];
      if (b > 0) parts.push('taban çevresi');
      if (got('rim.out', P.rimOuterBreak) > 0) parts.push('ağız dış kenarı');
      if (got('cutout.break', P.cutoutBreak) > 0) parts.push('port açıklıkları dış kenarı');
      if (got('ear.bottom', P.outerEdgeBreak) > 0) parts.push('kulaklar');
      n.push(`Belirtilmeyen kenarlar ISO 13715 −${d1(P.outerEdgeBreak)} (çapaksız, kırma ≤ ${d1(P.outerEdgeBreak)} mm)${parts.length ? `; modelde ${d1(P.outerEdgeBreak)}×45° pah: ${parts.join(', ')}` : ''}.`);
    } else if (fdm) {
      const bc = got('bed', P.bedChamfer);
      if (bc > 0) n.push(`Tabla kenarları ${d1(bc)}×45° pah (fil ayağı payı; tabla kenarında radyüs yok)${(geo.ears || []).length && got('ear.bottom', P.bedChamfer) > 0 ? '; kulak alt kenarları dahil' : ''}.`);
      const ff = got('floor', P.floorFillet);
      if (ff > 0) n.push(`Taban–duvar iç köşesi R${d2(ff)} (yukarı bakan oluk, desteksiz).`);
    }
    const li = got('rim.in', P.rimLeadIn);
    if (li > 0) n.push(`Ağız iç kenarında ${d1(li)}×45° giriş pahı (kapak dili için).`);
    if (cnc) {
      const pp = d.params || {};
      const radii = [`cep köşeleri R${d1(pp.rIn ?? geo.cavity.r)}`];
      const cr = got('corner.concave', 0);
      const pr = got('pad.concave', 0);
      if (cr > 0) radii.push(`köşe boss'u–duvar birleşimi R${d2(cr)}`);
      if (pr > 0) radii.push(`kart desteği–duvar birleşimi R${d2(pr)}`);
      if (got('ear.concave', 0) > 0) radii.push(`kulak–duvar birleşimi R${d2(got('ear.concave', 0))}`);
      if ((geo.cutouts || []).length) radii.push(`port köşeleri R${d1(Math.max(...geo.cutouts.map((c) => c.r)))}`);
      n.push(`İç dikey köşeler: ${radii.join(', ')}; taban–duvar iç köşesi keskin (düz parmak freze).`);
    }
    if (!inj && got('standoff.root', P.bossRootFillet) > 0) n.push(`Standoff kökleri R${d2(got('standoff.root', P.bossRootFillet))}${got('standoff.tip', P.bossTipChamfer) > 0 ? `, uçları ${d1(P.bossTipChamfer)}×45° pah` : ''}.`);
    else if (cnc && got('standoff.tip', P.bossTipChamfer) > 0) n.push(`Standoff uçları ${d1(P.bossTipChamfer)}×45° pah.`);
    const tap = (T.holes?.standoffs || []).concat(T.holes?.corners || []).filter((h) => h.entry && (h.method === 'tapped' || h.method === 'helicoil'));
    if (tap.length && (got('entry.standoff', 1) > 0 || got('entry.corner', 1) > 0)) n.push('Kılavuz çekilecek delikler 90° havşalı (Ø = diş dış çapı + 0,2), NASA JSC-67701 §9.6a.');
    const st = (T.holes?.standoffs || []).concat(T.holes?.corners || []).filter((h) => h.entry && h.method === 'self_tap');
    if (st.length && (got('entry.standoff', 1) > 0 || got('entry.corner', 1) > 0)) n.push('Sac vidası ön deliklerinin girişi Ø1,05·d boşaltmalı 45° pah (EJOT DELTA PT).');
    if (d.fasteningMethod === 'insert' && P.holeEntry.insert === 0) n.push('İnsert delikleri düz, girişte pah yok (insert üreticisi ölçüsü).');
    if (P.grooveBottomR > 0 && geo.groove) {
      const gb = got('groove.bottom', P.grooveBottomR);
      n.push(`Conta kanalı dip radyüsü R${d2(gb)}${got('groove.break', P.grooveEdgeBreak) > 0 ? `, üst kenarları ${d2(P.grooveEdgeBreak)} mm kırık` : ''} (Parker ORD 5700).`);
    }
    if (T.clip && geo.din) {
      const lr = (d.treatReport || []).find((e) => e.part === 'clip' && e.key === 'latch.root');
      const v = lr ? lr.applied : T.clip.latchRootR;
      const cbE = (d.treatReport || []).find((e) => e.part === 'clip' && e.key === 'bed');
      const cb = cbE ? cbE.applied : T.clip.bedChamfer;
      if (v > 0) n.push(`DIN klipsi: kilit dili kökü R${d2(v)} (≥ 0,5·t), yarık uçları yuvarlak${cb > 0 ? `; üst yüz (tabla) kenarları ${d2(cb)}×45° pah` : ''}.`);
    }
  } else if (part === 'lid') {
    if (inj) {
      const dr = got('draft.plate', P.draftDeg);
      n.push(dr > 0
        ? `Kalıp çıkma açısı ${d1(dr)}° (çekme −Z); ayırma çizgisi kapak alt dış kenarında, keskin; alt dış hat gövde ağız hattıyla aynı.`
        : `Kalıp çıkma açısı ≥ ${d1(P.draftDeg)}° gerekir; modelde uygulanamadı (işlem raporu).`);
      const tf = got('outer.top', P.outerTopFillet);
      if (tf > 0) n.push(`Üst dış kenar R${d2(tf)} (kozmetik).`);
      if (got('lip.draft', P.lipDraftDeg) > 0) n.push(`Kapak dili: ${d1(P.lipDraftDeg)}° çıkma açısı, kök R${d2(got('lip.root', P.lipRootFillet))}, uçta ${d1(got('lip.tip', P.lipTipChamfer))}×45° giriş pahı.`);
      if (got('tube.root', P.tubeRootFillet) > 0) n.push(`Vida boruları: ${d1(P.bossDraftDeg)}° açılı, kök R${d2(got('tube.root', P.tubeRootFillet))}, uçta pah.`);
    } else {
      if (fdm && got('bed', P.bedChamfer) > 0) n.push(`Dış yüz tablada: üst dış kenar ${d1(got('bed', P.bedChamfer))}×45° pah (tabla kenarında radyüs yok).`);
      if (cnc) {
        const both = got('outer.top', P.outerEdgeBreak) > 0 && got('outer.bottom', P.outerEdgeBreak) > 0;
        n.push(`Belirtilmeyen kenarlar ISO 13715 −${d1(P.outerEdgeBreak)}${both ? `; üst ve alt dış kenarlar modelde ${d1(P.outerEdgeBreak)}×45° pah` : ''}.`);
      }
      const lt = got('lip.tip', P.lipTipChamfer);
      if (lt > 0) n.push(`Kapak dili ucunda ${d1(lt)}×45° giriş pahı${got('lip.root', P.lipRootFillet) > 0 ? `, kökte R${d2(got('lip.root', P.lipRootFillet))}` : ''}.`);
      if (got('tube.root', P.tubeRootFillet) > 0) n.push(`Vida borusu kökleri R${d2(got('tube.root', P.tubeRootFillet))}.`);
      if (cnc && got('entry.tube', 1) > 0 && (T.holes?.lidTubes || []).some((h) => h.entry)) n.push(`Geçiş delikleri girişte ${d1(P.holeEntry.clearance)}×45° kırık.`);
    }
  }
  const failed = rep.filter((e) => !e.ok && e.kind !== 'boolean' && e.applied === 0 && !/yan maça/.test(e.note || '')).map((e) => e.feature);
  if (failed.length) n.push(`Modelde uygulanamayan işlemler (elle tamamlanmalı): ${[...new Set(failed)].slice(0, 4).join(', ')}.`);
  return n;
}

const METHOD_NOTE = { insert: 'ısıl insert', tapped: 'kılavuz', self_tap: 'sac vidası ön deliği', helicoil: 'Helicoil (STI)', nut: 'geçiş + somun cebi', standoff: 'aralayıcı geçiş deliği' };

function baseSheet(ctx) {
  const { views, design: d, rules } = ctx;
  const g = d.geometry;
  const datum = [g.center[0] - g.outer.L / 2, g.center[1] - g.outer.W / 2, g.z0];
  const panelItems = d.panel?.items || [];
  const wallPanel = panelItems.filter((it) => SIDE_VIEW[it.face] && Number.isFinite(it.x));
  const portSides = new Set([...d.ports.filter((p) => p.enabled).map((p) => p.side), ...wallPanel.map((it) => it.face)]);
  const elevKeys = ['front', 'right', ...(portSides.has('+Y') ? ['back'] : []), ...(portSides.has('-X') ? ['left'] : [])];
  const elevs = elevKeys.map((k) => prepView(k, views.base[k]));
  const top = prepView('top', views.base.top);

  // Yerleşim: 1. sıra ön + sağ; 2. sıra üst görünüş (ön ile X hizalı) ve yanında varsa arka/sol alt alta
  const region = { x: 22, y: 22, w: 168, h: 172 };
  const gap = 14;
  const [front, right, ...extras] = elevs;
  const extrasH = (sc) => extras.reduce((a, v) => a + sc * v.h, 0) + gap * Math.max(extras.length - 1, 0);
  const extrasW = (sc) => extras.reduce((a, v) => Math.max(a, sc * v.w), 0);
  const s = chooseScale((sc) => {
    const row1W = sc * front.w + gap + sc * right.w;
    const row2W = sc * top.w + gap + extrasW(sc);
    const height = sc * front.h + gap + Math.max(sc * top.h + 14, extrasH(sc));
    return Math.max(row1W, row2W) <= region.w && height <= region.h;
  });

  const out = [];
  const placed = {};
  placed.front = placeView(out, front, region.x, region.y, s, VIEW_LABEL.front);
  placed.right = placeView(out, right, region.x + s * front.w + gap, region.y, s, VIEW_LABEL.right);
  const topY = region.y + s * front.h + gap;
  placed.top = placeView(out, top, region.x, topY, s, `${VIEW_LABEL.top} (kapaksız)`);
  let ey = topY;
  for (const v of extras) {
    placed[v.key] = placeView(out, v, region.x + s * top.w + gap, ey, s, VIEW_LABEL[v.key]);
    ey += s * v.h + gap;
  }

  // Genel ölçüler
  const pt = placed.top;
  // Kulaklar varsa üst görünüş kutusu taban izidir (kulaklar dahil)
  const fpL = d.mount?.footprint?.L ?? d.outer.L;
  const fpW = d.mount?.footprint?.W ?? d.outer.W;
  dimH(out, pt.x0, pt.x1, pt.y1 + 7, pt.y1, fpL);
  dimV(out, pt.y0, pt.y1, pt.x1 + 7, pt.x1, fpW);
  const pf = placed.front;
  dimV(out, pf.y0, pf.y1, pf.x0 - 7, pf.x0, g.cavTop - g.z0);

  // Delikler (standoff) — üst görünüşte balon + merkez işareti
  const holeRows = [];
  d.standoffs.forEach((st, i) => {
    const [px, py] = pt.toPaper([st.x, st.y, 0]);
    centerMark(out, px, py, (st.holeD / 2) * s);
    const tx = px + (px < (pt.x0 + pt.x1) / 2 ? 6 : -6);
    balloon(out, px, py, tx, py - 5, `H${i + 1}`);
    holeRows.push([`H${i + 1}`, d2(st.x - datum[0]), d2(st.y - datum[1]), `Ø${d2(st.holeD)}`, d2(st.depth), `${st.screw} ${METHOD_NOTE[d.fasteningMethod] || ''}`]);
  });
  (d.geometry.cornerBosses || []).forEach((c, i) => {
    const [px, py] = pt.toPaper([c.x, c.y, 0]);
    centerMark(out, px, py, (c.holeD / 2) * s);
    balloon(out, px, py, px + (px < (pt.x0 + pt.x1) / 2 ? 6 : -6), py - 5, `C${i + 1}`);
    holeRows.push([`C${i + 1}`, d2(c.x - datum[0]), d2(c.y - datum[1]), `Ø${d2(c.holeD)}`, d2(c.depth), `köşe boss Ø${d1(c.od)}`]);
  });

  // Montaj delikleri (kulak / taban) — üst görünüşte merkez işareti + balon
  (d.mount?.holes || []).forEach((mh, i) => {
    const [px, py] = pt.toPaper([mh.x, mh.y, 0]);
    centerMark(out, px, py, (mh.d / 2) * s);
    balloon(out, px, py, px + (px < (pt.x0 + pt.x1) / 2 ? -6 : 6), py + 6, `M${i + 1}`);
    holeRows.push([`M${i + 1}`, d2(mh.x - datum[0]), d2(mh.y - datum[1]), `Ø${d2(mh.d)}${mh.slot ? `×${d1(mh.d + mh.slot)}` : ''}`, 'boydan', mh.kind === 'ear' ? 'montaj kulağı' : mh.kind === 'din' ? 'DIN klipsi (M3)' : 'taban montajı']);
  });

  // Port açıklıkları — ilgili görünüşte balon
  const portRows = [];
  d.ports.filter((p) => p.enabled).forEach((p, i) => {
    const vk = SIDE_VIEW[p.side];
    const zTop = Math.min(p.zHi, g.cavTop);
    const mid = (p.a0 + p.a1) / 2;
    const world = p.axis === 0 ? [p.dir > 0 ? 1e3 : -1e3, mid, (p.zLo + zTop) / 2] : [mid, p.dir > 0 ? 1e3 : -1e3, (p.zLo + zTop) / 2];
    if (placed[vk]) {
      const [px, py] = placed[vk].toPaper(world);
      balloon(out, px, py, px + 6, placed[vk].y1 + 5, `P${i + 1}`);
    }
    const along0 = p.a0 - datum[p.along];
    portRows.push([`P${i + 1}`, p.side, `${p.along === 0 ? 'X' : 'Y'} ${d1(along0)}`, d1(p.zLo - g.z0), `${d1(p.openWidth)} × ${d1(p.openHeight)}`,
      p.style === 'notch' ? 'Çentik' : `Pencere${p.r > 0.01 ? ` R${d1(p.r)}` : ''}`]);
  });

  // Panel elemanları (Toolbox Paket D) — ilgili duvar görünüşünde merkez işareti + balon
  const panelRows = [];
  wallPanel.forEach((it, i) => {
    const vk = SIDE_VIEW[it.face];
    const label = `E${i + 1}`;
    if (placed[vk]) {
      const [px, py] = placed[vk].toPaper([it.x, it.y, it.z]);
      centerMark(out, px, py, (it.hole.d / 2) * s);
      balloon(out, px, py, px + 7, py - 7, label);
    }
    const along = it.face[1] === 'X' ? 1 : 0;
    panelRows.push([label, it.face, `${along === 0 ? 'X' : 'Y'} ${d1((along === 0 ? it.x : it.y) - datum[along])}`, d1(it.z - g.z0),
      it.hole.shape === 'D' ? `D Ø${d1(it.hole.d)}×${d1(it.hole.flat)}` : `Ø${d1(it.hole.d)}`,
      `${it.title}${it.spot ? ` · ${it.spot.side === 'inner' ? 'iç' : 'dış'} lamba Ø${d1(it.spot.d)}×${d1(it.spot.depth)}` : ''}`]);
  });

  // Sağ sütun: tablolar ve notlar
  const colX = 194;
  let y = 24;
  if (holeRows.length) {
    y = table(out, colX, y, 'DELİK TABLOSU', [
      { label: 'No', w: 8 }, { label: 'X', w: 12 }, { label: 'Y', w: 12 }, { label: 'Çap', w: 12 }, { label: 'Derinlik', w: 14 }, { label: 'Not', w: 34 },
    ], holeRows) + 8;
  }
  if (portRows.length) {
    y = table(out, colX, y, 'AÇIKLIK TABLOSU', [
      { label: 'No', w: 8 }, { label: 'Duvar', w: 10 }, { label: 'Konum', w: 15 }, { label: 'Z', w: 10 }, { label: 'G × Y', w: 22 }, { label: 'Tip', w: 27 },
    ], portRows) + 8;
  }
  if (panelRows.length) {
    y = table(out, colX, y, 'PANEL DELİKLERİ', [
      { label: 'No', w: 8 }, { label: 'Duvar', w: 10 }, { label: 'Konum', w: 15 }, { label: 'Z', w: 10 }, { label: 'Delik', w: 20 }, { label: 'Parça', w: 29 },
    ], panelRows) + 8;
  }
  const n = [
    ...toleranceNotes(rules, d),
    ...edgeNotes(d, 'base'),
    `Et kalınlığı ${d1(d.params.wall)} mm, taban ${d1(d.params.floor)} mm, iç köşe R${d1(d.params.rIn)}, dış köşe R${d1(d.params.rOut)}.`,
    `Açıklık konumu duvar boyunca sıfır noktasından, Z gövde altından ölçülür; açıklıklar konnektör + ${d1(rules.cutout_clearance_xy)} mm boşlukla.`,
  ];
  if (d.edgeHold?.active && d.edgeHold.pads) n.push(`Kart kenarı tutucu: ${d.edgeHold.pads} alt destek kartı kenarından ${d1(d.edgeHold.info?.overlap ?? 2)} mm içeri taşır; kapakta ${d.edgeHold.pressers} baskı dili kartı üstten sıkıştırır.`);
  if (d.mount?.info) n.push(`Montaj delikleri (M): ${d.mount.holes.length} × Ø${d2(d.mount.info.d)}, aralık ${d.mount.info.spacing.filter((v) => v > 0.05).map(d1).join(' × ')} mm${d.mount.footprint ? `; kulaklarla taban izi ${d1(d.mount.footprint.L)} × ${d1(d.mount.footprint.W)} mm` : ''}.`);
  if (d.mount?.din && d.mount.info) {
    const mi = d.mount.info;
    n.push(`DIN ray klipsi (EN 60715 TS35, ayrı parça ${d1(mi.clipL)} × ${d1(mi.clipW)} mm, ray ${mi.axis === 0 ? 'X' : 'Y'} yönünde): kutuya içeriden 2 × M3×${mi.len}; esnek kilit dilleri ${mi.latchSide} tarafında. Klips STL/STEP ayrı indirilir.`);
  }
  if (panelRows.length) n.push('Panel delikleri (E): merkez konumu duvar boyunca sıfır noktasından, Z gövde altından; D-deliklerde düzlük üstte. Lamba, parçanın panel kalınlığı sınırı için yerel et inceltmedir.');
  if (d.sealing) {
    const sg = d.sealing.groove;
    n.push(`Conta kanalı ${d2(sg.width)} × ${d2(sg.depth)} mm, duvar üstünde orta eksende; Ø${d1(d.sealing.cord_d)} kordon (%${Math.round(d.sealing.squeeze * 100)} sıkışma), ${d.sealing.label}.`);
  }
  if (rules.process === 'fdm') n.push('Baskı yönü: gövde ağzı yukarı; destek gerekmez.');
  const ins0 = d.standoffs[0]?.insert;
  if (d.fasteningMethod === 'insert') n.push(`İnsertler${ins0 ? ` (${ins0.id})` : ''} havya ile dik bastırılır; yüzeyle aynı hizada bitmeli.`);
  if (d.fasteningMethod === 'helicoil' && ins0) n.push(`Helicoil yuvaları: Ø${d2(ins0.drill)} matkap, ${d.standoffs[0].screw} STI kılavuz, girişte 90° havşa Ø${d2(ins0.csk)}; burç yüzeyden 0,25–0,5·P içeride, tang kırılır.`);
  if (d.fasteningMethod === 'nut' && ins0) n.push(ins0.shape === 'hex' ? `Somun cepleri tabandan: ${ins0.code} ${d.standoffs[0].screw} için altıgen cep (SW + boşluk); somun vidayla yukarı çekilir.` : `Kare somun yuvaları standoff yanında, kavite tarafına açık (${ins0.code} ${d.standoffs[0].screw}).`);
  if (d.fasteningMethod === 'standoff' && ins0) n.push(`Hazır aralayıcılar ${d.standoffs[0].screw} × ${d2(ins0.L)} SW ${d2(ins0.sw)} tabandaki geçiş deliklerine ${ins0.ends === 'ff' ? 'alttan vidayla' : 'altta somunla'} bağlanır.`);
  y = fitNotes(out, colX, y, 91, 'NOTLAR', n);
  if (d.bom.length && y < 158) notes(out, colX, y + 3, 91, 'BAĞLANTI ELEMANLARI', d.bom, 2.0);

  titleBlock(out, ctx.info, 'GÖVDE', 1, ctx.sheetCount || 2, s);
  return { title: 'Gövde', svg: sheetSvg(out), scale: s };
}

function lidSheet(ctx) {
  const { views, design: d } = ctx;
  // Kapak ayrı malzemeden olabilir: kurallar, tolerans notları ve antet kapak malzemesine göre
  const rules = ctx.lidRules || ctx.rules;
  const dl = d.lidTolerance ? { ...d, tolerance: d.lidTolerance } : d;
  const g = d.geometry;
  const datum = [g.center[0] - g.outer.L / 2, g.center[1] - g.outer.W / 2, g.z0];
  const front = prepView('front', views.lid.front);
  const top = prepView('top', views.lid.top);
  const bottom = prepView('bottom', views.lid.bottom);

  const region = { x: 24, y: 22, w: 160, h: 172 };
  const gap = 14;
  const s = chooseScale((sc) => sc * (top.w + bottom.w) + gap <= region.w && sc * front.h + gap + sc * top.h + 14 <= region.h);

  const out = [];
  const pf = placeView(out, front, region.x, region.y, s, VIEW_LABEL.front);
  const rowY = region.y + s * front.h + gap;
  const pt = placeView(out, top, region.x, rowY, s, VIEW_LABEL.top);
  const pb = placeView(out, bottom, region.x + s * top.w + gap, rowY, s, `${VIEW_LABEL.bottom} (iç yüz)`);

  dimH(out, pt.x0, pt.x1, pt.y1 + 7, pt.y1, d.outer.L);
  dimV(out, pt.y0, pt.y1, pt.x0 - 7, pt.x0, d.outer.W);
  dimV(out, pf.y0, pf.y1, pf.x0 - 7, pf.x0, front.h);

  const rows = [];
  d.lidTubes.forEach((t, i) => {
    const [px, py] = pt.toPaper([t.x, t.y, 0]);
    centerMark(out, px, py, (t.holeD / 2) * s);
    balloon(out, px, py, px + (px < (pt.x0 + pt.x1) / 2 ? 6 : -6), py - 5, `K${i + 1}`);
    rows.push([`K${i + 1}`, d2(t.x - datum[0]), d2(t.y - datum[1]), `Ø${d2(t.holeD)}`,
      t.countersink ? `havşa Ø${d2(t.countersink.dTop)}` : 'boydan boya',
      t.countersink ? `90° · boru Ø${d1(t.od)}` : t.counterbore ? `oyuk Ø${d1(t.counterbore.d)}×${d1(t.counterbore.depth)}` : `boru Ø${d1(t.od)}`]);
  });
  (d.geometry.lidHoles || []).forEach((hh, i) => {
    const [px, py] = pt.toPaper([hh.x, hh.y, 0]);
    centerMark(out, px, py, (hh.holeD / 2) * s);
    balloon(out, px, py, px + (px < (pt.x0 + pt.x1) / 2 ? 6 : -6), py - 5, `C${i + 1}`);
    rows.push([`C${i + 1}`, d2(hh.x - datum[0]), d2(hh.y - datum[1]), `Ø${d2(hh.holeD)}`,
      hh.countersink ? `havşa Ø${d2(hh.countersink.dTop)}` : hh.counterbore ? `oyuk Ø${d1(hh.counterbore.d)}` : 'boydan boya',
      `köşe vidası${hh.pad ? ` · yastık ${d1(hh.pad.h)}` : ''}`]);
  });

  // Panel elemanları kapakta (rakor, basınç elemanı, özel delik) ve ışık boruları
  let ei = 0;
  for (const it of d.panel?.items || []) {
    if (it.face !== 'lid') continue;
    const pts = it.kind === 'lightpipe' ? (it.positions || []).map((q) => ({ x: q.x, y: q.y, note: `${it.title}, L ${d1(q.L)}` }))
      : Number.isFinite(it.x) ? [{ x: it.x, y: it.y, note: `${it.title}${it.spot ? ` · iç lamba Ø${d1(it.spot.d)}×${d1(it.spot.depth)}` : ''}` }] : [];
    for (const q of pts) {
      const label = `${it.kind === 'lightpipe' ? 'L' : 'E'}${++ei}`;
      const [px, py] = pt.toPaper([q.x, q.y, 0]);
      centerMark(out, px, py, (it.hole.d / 2) * s);
      balloon(out, px, py, px + (px < (pt.x0 + pt.x1) / 2 ? 6 : -6), py + 5, label);
      rows.push([label, d2(q.x - datum[0]), d2(q.y - datum[1]),
        it.hole.shape === 'D' ? `D Ø${d1(it.hole.d)}` : `Ø${d2(it.hole.d)}`, it.hole.shape === 'D' ? `düzlük ${d1(it.hole.flat)}` : 'boydan boya', q.note]);
    }
  }

  let y = 24;
  if (rows.length) {
    y = table(out, 194, y, 'DELİK TABLOSU (KAPAK)', [
      { label: 'No', w: 8 }, { label: 'X', w: 12 }, { label: 'Y', w: 12 }, { label: 'Çap', w: 12 }, { label: 'Tip', w: 20 }, { label: 'Not', w: 28 },
    ], rows) + 8;
  }
  const n = [
    ...toleranceNotes(rules, dl),
    ...edgeNotes(d, 'lid'),
    `Kapak kalınlığı ${d1(d.params.lidT)} mm. Konumlandırma dili ${d1(d.params.lipT)} mm, gövdeye ${d2(d.params.fit)} mm boşlukla oturur.`,
    'Delik koordinatları gövde ile aynı sıfır noktasına göredir.',
  ];
  const sunk = d.lidTubes.some((t) => t.countersink);
  if (sunk) n.push('Havşalar 90°; vida başı kapak üst yüzüyle aynı hizada kalır.');
  if (d.sealing) {
    n.push(`Kapağın alt yüzü conta yüzeyidir: düz ve çiziksiz olmalı. ${sunk ? 'Havşalara sıvı sızdırmazlık.' : 'Vida başlarına sızdırmazlık pulu.'}`);
  }
  if (rules.process === 'fdm') n.push('Baskı yönü: kapağın dış yüzü tablaya; borular ve dil yukarı.');
  fitNotes(out, 194, y, 91, 'NOTLAR', n);

  titleBlock(out, { ...ctx.info, material: ctx.info.lidMaterial || ctx.info.material, process: ctx.info.lidProcess || ctx.info.process }, 'KAPAK', 2, ctx.sheetCount || 2, s);
  return { title: 'Kapak', svg: sheetSvg(out), scale: s };
}

/**
 * Montaj paftası: patlatılmış izometrik görünüş, balonlar ve parça listesi.
 * Poz numaraları BOM CSV ile aynıdır: 1 gövde, 2 kapak, (varsa) DIN klipsi, sonra bağlantı ve panel elemanları.
 */
function assemblySheet(ctx) {
  const { views, design: d } = ctx;
  const iso = prepView('iso', views.assembly.iso);
  const g = d.geometry;
  const e = ctx.explode || 0;
  const region = { x: 16, y: 24, w: 168, h: 168 };
  const margin = 12;
  const s = chooseScale((sc) => sc * iso.w + 2 * margin <= region.w && sc * iso.h + 2 * margin <= region.h);
  const out = [];
  const ox = region.x + (region.w - s * iso.w) / 2;
  const oy = region.y + (region.h - s * iso.h) / 2;
  // Başlık balon halkasının dışında (sol üst köşe), görünüş etiketsiz
  const pv = placeView(out, iso, ox, oy, s, '');
  out.push(text(region.x, region.y - 4, 'MONTAJ (PATLATILMIŞ İZOMETRİK)', 2.6, { bold: true }));

  // Satırlar: gövde, kapak, parçalar (yalnızca çizimde konumu olanlara balon)
  const [cx, cy] = g.center;
  const rows = [
    { name: 'Gövde', qty: 1, std: '', material: ctx.info.material, at: [cx, cy - g.outer.W / 2, g.z0 + (g.cavTop - g.z0) * 0.45], lid: false },
    { name: 'Kapak', qty: 1, std: '', material: ctx.info.material, at: [cx + g.outer.L * 0.3, cy, g.zTop], lid: true },
    ...(g.din ? [{ name: 'DIN ray klipsi', qty: 1, std: 'EN 60715 TS35', material: ctx.info.material, at: [cx, cy, g.z0 - g.din.tp - 2], clip: true }] : []),
    ...(d.parts || []).map((p) => ({
      name: p.name, qty: p.qty, std: [p.standard, p.size + (p.length ? '×' + d1(p.length) : '')].filter(Boolean).join(' '),
      material: p.material, at: p.at, lid: p.part === 'lid', clip: p.part === 'clip', part: p,
    })),
  ];
  const clipDrop = Math.max(15, e * 0.9); // cad-worker explodedAssembly ile aynı

  // Balon yerleşimi: noktadan görünüş merkezinden dışa doğru, görünüş kutusunun 8 mm dışındaki dikdörtgen üzerine;
  // çakışan balonlar dikdörtgen çevresi boyunca kaydırılır
  const bx0 = pv.x0 - 8, by0 = pv.y0 - 8, bx1 = pv.x1 + 8, by1 = pv.y1 + 8;
  const bw = bx1 - bx0, bh = by1 - by0, per = 2 * (bw + bh);
  const fromS = (t) => {
    let u = ((t % per) + per) % per;
    if (u < bw) return [bx0 + u, by0];
    u -= bw; if (u < bh) return [bx1, by0 + u];
    u -= bh; if (u < bw) return [bx1 - u, by1];
    u -= bw; return [bx0, by1 - u];
  };
  const toS = ([x, y]) => {
    if (Math.abs(y - by0) < 1e-6) return x - bx0;
    if (Math.abs(x - bx1) < 1e-6) return bw + (y - by0);
    if (Math.abs(y - by1) < 1e-6) return bw + bh + (bx1 - x);
    return 2 * bw + bh + (by1 - y);
  };
  const mx = (pv.x0 + pv.x1) / 2, my = (pv.y0 + pv.y1) / 2;
  const placed = [];
  const marks = [];
  rows.forEach((r, i) => {
    if (!r.at) return;
    const [px, py] = pv.toPaper([r.at[0], r.at[1], r.at[2] + (r.lid ? e : r.clip ? -clipDrop : 0)]);
    let dx = px - mx, dy = py - my;
    if (Math.hypot(dx, dy) < 1e-6) dx = 1;
    const k = 1 / Math.max(Math.abs(dx) / (bw / 2), Math.abs(dy) / (bh / 2));
    marks.push({ i, px, py, sPos: toS([mx + dx * k, my + dy * k]) });
  });
  marks.sort((a, b) => a.sPos - b.sPos);
  for (const m of marks) {
    let t = m.sPos;
    for (let guard = 0; guard < 80 && placed.some((q) => Math.hypot(q[0] - fromS(t)[0], q[1] - fromS(t)[1]) < 5.6); guard++) t += 2;
    const [tx, ty] = fromS(t);
    placed.push([tx, ty]);
    balloon(out, m.px, m.py, tx, ty, String(m.i + 1));
  }

  // Parça listesi (sağ sütun)
  const pref = ctx.preferred || [];
  const hasPref = pref.length > 0;
  const clip = (str, w) => { const max = Math.floor(w / 1.12); const t = String(str ?? ''); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
  const cols = hasPref
    ? [{ label: 'Poz', w: 7 }, { label: 'Adet', w: 7 }, { label: 'Tanım', w: 31 }, { label: 'Standart / ölçü', w: 25 }, { label: 'Stok kodu', w: 23 }]
    : [{ label: 'Poz', w: 7 }, { label: 'Adet', w: 7 }, { label: 'Tanım', w: 36 }, { label: 'Standart / ölçü', w: 26 }, { label: 'Malzeme', w: 17 }];
  const tRows = rows.map((r, i) => {
    const last = hasPref ? (r.part ? (matchPref(r.part, pref)?.stock || '—') : '') : r.material || '';
    return [String(i + 1), String(r.qty), clip(r.name, cols[2].w), clip(r.std, cols[3].w), clip(last, cols[4].w)];
  });
  let y = table(out, 194, 24, 'PARÇA LİSTESİ', cols, tRows) + 8;
  const tq = (d.bom || []).find((l) => l.startsWith('Sıkma torku'));
  const n = [
    'Patlatılmış görünüş: kapak ve kapak elemanları ' + d1(e) + ' mm yukarı kaydırılmıştır.',
    'Bağlantı elemanları basitleştirilmiş gösterilir (diş ve tahrik izi yok); ölçüler standart tablolardandır.',
  ];
  if (tq) n.push(tq);
  if (y < 150) notes(out, 194, y, 91, 'NOTLAR', n);
  titleBlock(out, ctx.info, 'MONTAJ', 3, ctx.sheetCount || 3, s);
  return { title: 'Montaj', svg: sheetSvg(out), scale: s };
}

export function buildSheets(ctx) {
  const withAsm = !!ctx.views.assembly?.iso;
  ctx.sheetCount = withAsm ? 3 : 2;
  return [baseSheet(ctx), lidSheet(ctx), ...(withAsm ? [assemblySheet(ctx)] : [])];
}

/* ---------- PDF ---------- */

let libsPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Yüklenemedi: ${src}`));
    document.head.appendChild(el);
  });
}

async function fetchBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font indirilemedi (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function loadPdfLibs() {
  if (!libsPromise) {
    libsPromise = (async () => {
      if (!window.jspdf) await loadScript(JSPDF_URL);
      if (!window.svg2pdf) await loadScript(SVG2PDF_URL);
      const [reg, bold] = await Promise.all([fetchBase64(FONT_REG_URL), fetchBase64(FONT_BOLD_URL)]);
      return { reg, bold };
    })();
    libsPromise.catch(() => { libsPromise = null; });
  }
  return libsPromise;
}

export async function exportPdf(sheets, fileName, { download = true } = {}) {
  const fonts = await loadPdfLibs();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  doc.addFileToVFS('DejaVuSans.ttf', fonts.reg);
  doc.addFont('DejaVuSans.ttf', FONT, 'normal');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', fonts.bold);
  doc.addFont('DejaVuSans-Bold.ttf', FONT, 'bold');
  doc.setFont(FONT, 'normal');
  doc.setProperties({ title: fileName.replace(/\.pdf$/i, ''), creator: 'Ikra Enclosure Engine' });

  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:297mm;height:210mm;';
  document.body.appendChild(holder);
  try {
    for (let i = 0; i < sheets.length; i++) {
      if (i) doc.addPage('a4', 'landscape');
      holder.innerHTML = sheets[i].svg;
      const el = holder.querySelector('svg');
      await window.svg2pdf.svg2pdf(el, doc, { x: 0, y: 0, width: W, height: H });
    }
  } finally {
    holder.remove();
  }
  if (!download) return doc.output('blob');
  doc.save(fileName);
  return null;
}
