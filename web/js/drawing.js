/*
 * Teknik resim.
 * CAD işçisinin gizli çizgi kaldırmalı (HLR) izdüşümlerinden A4 yatay SVG paftaları üretir
 * (gövde + kapak + montaj; ctx.review verilirse DFM İnceleme Raporu paftaları) ve isteğe bağlı olarak
 * PDF'e çevirir (jsPDF + svg2pdf.js, Türkçe için DejaVu Sans).
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

function titleBlock(out, info, part, sheetNo, sheetCount, scale, caption = null) {
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
  const cells = [['ÖLÇEK', scale ? scaleText(scale) : '—'], ['BİRİM', 'mm'], ['TARİH', info.date], ['PAFTA', `${sheetNo} / ${sheetCount}`]];
  const cw = w / cells.length;
  cells.forEach(([k, v], i) => {
    if (i) out.push(line(x + cw * i, y + 22, x + cw * i, y + h));
    out.push(text(x + cw * i + 1.5, y + 24.4, k, 1.6), text(x + cw * i + 1.5, y + 27.2, v, 2.3, { bold: true }));
  });
  out.push(text(x + w, y - 1.2, caption ?? `Ikra ${info.version} · koordinatlar gövde dış köşesine (0,0,0) göre`, 1.7, { anchor: 'end' }));
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

function toleranceNotes(rules, d = null, part = 'base') {
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
    // Tasarımın geçerli freze çapı (kullanıcı seçimi ya da kural dosyası; eski tasarımda alan yoksa kural dosyası)
    const gTool = Number(part === 'lid' ? d?.geometry?.lidToolDiameter : d?.geometry?.toolDiameter);
    const tool = Number.isFinite(gTool) && gTool > 0 ? gTool : pp.tool_diameter || 3;
    const rWin = Math.ceil((1.3 * tool) / 2 / 0.05 - 1e-6) * 0.05; // treat.js cncCutoutR ile aynı
    return [
      `Genel toleranslar ISO 2768-m; ${rules.label} için ${gen || '±0,1 mm'}. Keskin kenarları 0,3×45° kır.`,
      part === 'lid'
        ? `İç köşeler Ø${d1(tool)} takıma göre R${d2(rWin)} (1,3 × takım yarıçapı).`
        : `İç köşeler Ø${d1(tool)} takıma göre: kavite R${d2(d?.params?.rIn ?? rWin)}, port açıklıkları R${d2(rWin)} (1,3 × takım yarıçapı; dar açıklıkta açıklığa sığan en büyük radyüs).`,
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
 * Yalnızca modelde olan işlem yazılır (ölçüler uygulanan değerdir); uygulanamayanlar ayrıca belirtilir.
 * treat yoksa boş (eski notlar geçerli). treatReport sözleşme A: ok/limited/applied, aynı anahtarın farklı sonuçları
 * "<anahtar>.limited" / "<anahtar>.failed" satırlarındadır.
 */
function edgeNotes(d, part) {
  const T = d?.geometry?.treat;
  const P = T?.[part];
  if (!P) return [];
  const rep = (d.treatReport || []).filter((e) => e.part === part);
  const has = rep.length > 0;
  const fam = (key) => rep.filter((x) => x.key === key || x.key === `${key}.limited` || x.key === `${key}.failed`);
  // Uygulanan ölçü aralığı [en küçük, en büyük] (yalnız uygulananlar); rapor yoksa politika değeri
  const span = (key, fallback = 0) => {
    if (!has) return fallback > 0 ? [fallback, fallback] : null;
    const es = fam(key).filter((e) => e.ok && e.applied > 0);
    return es.length ? [Math.min(...es.map((e) => e.applied)), Math.max(...es.map((e) => e.applied))] : null;
  };
  const got = (key, fallback = 0) => span(key, fallback)?.[0] || 0;
  const rng = (s, fmt = d2) => (s[1] - s[0] > 0.005 ? `${fmt(s[0])}–${fmt(s[1])}` : fmt(s[0]));
  const limitedOf = (key) => fam(key).find((e) => e.ok && e.limited);
  // Radyüs istenip çekirdek kuramadığında 45° pah uygulanmış olabilir (satır türü 'chamfer'): ölçü buna göre yazılır
  const asChamfer = (key) => has && fam(key).some((e) => e.ok && e.applied > 0 && e.kind === 'chamfer');
  const rad = (key, v) => (asChamfer(key) ? `${d2(v)}×45° pah` : `R${d2(v)}`);
  const n = [];
  const geo = d.geometry;
  const cnc = P.process === 'cnc';
  const fdm = P.process === 'fdm';
  const inj = P.process === 'injection';
  const partName = { base: 'Gövde', lid: 'Kapak' }[part] || 'Parça';
  // Parça işlemsiz (eski yöntemle) kurulduysa kenar notları geçersiz
  if (rep.some((e) => e.kind === 'build' && !e.ok)) {
    return [`${partName} kenar işlemleri ve çıkma açısı olmadan kurulmuştur (işlemli model kurulamadı); belirtilmeyen kenarlar keskindir, ayrıntı DFM incelemesinde.`];
  }
  const holes = T.holes || {};
  const holeList = (holes.standoffs || []).concat(holes.corners || []);
  if (part === 'base') {
    const intStandoffs = (geo.standoffs || []).filter((s) => s.integral !== false);
    if (inj) {
      const dr = got('draft.outer', P.draftDeg);
      const dp = got('draft.pocket', P.draftDeg);
      if (dr > 0 && dp > 0) {
        n.push(`Kalıp çıkma açısı ${d1(dr)}° modelde uygulanmıştır (çekme +Z): dış ve iç duvar paralel açılı, cep taban seviyesinde anma ölçüsünde; ayırma çizgisi ağız dış kenarında, keskin. Dış hat ağızda her yanda +${d2(T.rim.grow)} mm.`);
      } else n.push(`Kalıp çıkma açısı en az ${d1(P.draftDeg)}° olmalı; modelde uygulanamadı (ayrıntı DFM incelemesinde).`);
      const ri = got('floor', P.floorFillet);
      const ro = got('outer.bottom', P.outerBottomFillet);
      const roLim = limitedOf('outer.bottom');
      if (ri > 0 || ro > 0) {
        const roTxt = roLim ? `(r_o = r_i + t için R${d2(roLim.size)} gerekirdi; ${roLim.note || 'sınırlandı'})` : '(iç radyüs + et, aynı merkezden)';
        n.push(`İç taban köşesi ${ri > 0 ? rad('floor', ri) : 'keskin'}${ro > 0 ? `, dış alt kenar ${rad('outer.bottom', ro)} ${roTxt}` : ''}.`);
      }
      const sr = span('standoff.root', P.bossRootFillet);
      const stp = span('standoff.tip', P.bossTipChamfer);
      if (intStandoffs.length && sr) n.push(`Boss'lar: dış yüz ${d1(P.bossDraftDeg)}° açılı, kök R${rng(sr)}${stp ? `, uçta ${rng(stp)}×45° pah` : ''}.`);
      // Yalnız modelde bulunan çıkıntılar/pencereler (G8)
      const hasEars = (geo.ears || []).length > 0;
      const hasWin = (geo.cutouts || []).some((c) => c.z1 <= geo.cavTop);
      if (hasEars || hasWin) {
        const what = [hasEars ? 'montaj kulakları' : '', hasWin ? 'kapalı yan pencereler' : ''].filter(Boolean).join(' ve ');
        n.push(`${what[0].toLocaleUpperCase('tr')}${what.slice(1)} kalıpta yan maça (ya da kademeli ayırma çizgisi) ister; bunlarda çıkma açısı uygulanmamıştır.`);
      }
    } else if (cnc) {
      const parts = [];
      if (got('outer.bottom', P.outerEdgeBreak) > 0) parts.push('taban çevresi');
      if (got('rim.out', P.rimOuterBreak) > 0) parts.push('ağız dış kenarı');
      if (got('cutout.break', P.cutoutBreak) > 0) parts.push('port açıklıkları dış kenarı');
      if ((geo.ears || []).length && got('ear.bottom', P.outerEdgeBreak) > 0) parts.push('kulaklar');
      n.push(`Belirtilmeyen kenarlar ISO 13715 −${d1(P.outerEdgeBreak)} (çapaksız, kırma ≤ ${d1(P.outerEdgeBreak)} mm)${parts.length ? `; modelde ${d1(P.outerEdgeBreak)}×45° pah: ${parts.join(', ')}` : ''}.`);
    } else if (fdm) {
      const bc = got('bed', P.bedChamfer);
      if (bc > 0) n.push(`Tabla kenarları ${d1(bc)}×45° pah (ilk katman taşması için, ölçü tasarım tercihi; tabla kenarında radyüs yok)${(geo.ears || []).length && got('ear.bottom', P.bedChamfer) > 0 ? '; kulak alt kenarları dahil' : ''}.`);
      const ff = got('floor', P.floorFillet);
      if (ff > 0) n.push(`Taban–duvar iç köşesi ${rad('floor', ff)} (yukarı bakan oluk, desteksiz basılır).`);
    }
    const li = got('rim.in', P.rimLeadIn);
    if (li > 0) n.push(`Ağız iç kenarında ${d1(li)}×45° giriş pahı (kapak dili için).`);
    if (cnc) {
      const pp = d.params || {};
      const tool = P.toolD || 3;
      const radii = [`cep köşeleri R${d2(pp.rIn ?? geo.cavity.r)}`];
      const cr = got('corner.concave', 0);
      const pr = got('pad.concave', 0);
      const er = got('ear.concave', 0);
      // Takım yarıçapının altındaki iç köşe radyüsü işlenemez: freze o köşede R(takım/2) bırakır
      const toolLeft = (v) => (v < tool / 2 - 1e-3 ? `Ø${d1(tool)} freze R${d2(tool / 2)} bırakır` : '');
      if (cr > 0) radii.push(`köşe boss'u–duvar birleşimi R${d2(cr)}${toolLeft(cr) ? ` (${toolLeft(cr)}; kapak dili ucuyla çakışma kontrol edilmeli)` : ''}`);
      if (pr > 0) radii.push(`kart desteği–duvar birleşimi R${d2(pr)}${toolLeft(pr) ? ` (${toolLeft(pr)}; destek ucuna kadar yuvarlanır)` : ''}`);
      if (er > 0) radii.push(`kulak–duvar birleşimi R${d2(er)}${toolLeft(er) ? ` (${toolLeft(er)})` : ''}`);
      if ((geo.cutouts || []).length) {
        // Dar açıklıkta radyüs açıklığa sığan en büyük değerdir (design.js): aralık yazılır
        const cr = [Math.min(...geo.cutouts.map((c) => c.r)), Math.max(...geo.cutouts.map((c) => c.r))];
        radii.push(`port köşeleri R${rng(cr)}${cr[1] - cr[0] > 0.005 ? ' (dar açıklıkta açıklığa sığan en büyük radyüs)' : ''}`);
      }
      n.push(`İç dikey köşeler Ø${d1(tool)} frezeye göre: ${radii.join(', ')}; taban–duvar iç köşesi keskin (düz parmak freze).`);
      const nut = span('nut.dogbone', 0);
      if (nut) {
        const lim = limitedOf('nut.dogbone');
        n.push(`Altıgen somun cepleri köşe boşaltmalı (R${rng(nut)})${lim ? `; Ø${d2(Math.floor(2 * nut[0] * 20) / 20)} mm veya daha küçük freze gerekir` : ''}.`);
      }
    }
    if (!inj && intStandoffs.length) {
      const sr = span('standoff.root', P.bossRootFillet);
      const stp = span('standoff.tip', P.bossTipChamfer);
      if (sr) n.push(`Standoff kökleri R${rng(sr)}${stp ? `, uçları ${rng(stp)}×45° pah` : ''}.`);
      else if (stp) n.push(`Standoff uçları ${rng(stp)}×45° pah.`);
    }
    const entryDone = span('entry.standoff') || span('entry.corner');
    const tap = holeList.filter((h) => h.entry && (h.method === 'tapped' || h.method === 'helicoil'));
    if (tap.length && entryDone) n.push('Kılavuz çekilecek delik girişleri havşalı: NASA JSC-67701 §9.6a 80–120° ister; modelde 90°, üst çap = diş dış çapı + 0,2 mm (tasarım tercihi).');
    const selfTap = holeList.filter((h) => h.entry && h.method === 'self_tap');
    if (selfTap.length && entryDone) n.push('Diş açan vida ön deliklerinin girişinde 90° havşa, üst çap Ø1,05·d (EJOT DELTA PT boşaltma çapı; havşa biçimi tasarım tercihi).');
    const clrHoles = holeList.some((h) => h.entry && h.method === 'clearance') ? span('entry.standoff') : null;
    const clrEars = (holes.ears || []).some((h) => h.entry) ? span('entry.ear') : null;
    if (clrHoles || clrEars) {
      const s = [clrHoles, clrEars].filter(Boolean);
      const v = [Math.min(...s.map((x) => x[0])), Math.max(...s.map((x) => x[1]))];
      n.push(`${clrHoles ? `Geçiş delikleri${clrEars ? ' ve kulak delikleri' : ''}` : 'Kulak delikleri'} girişte ${rng(v, d1)}×45° kırık.`);
    }
    const ins = holeList.filter((h) => h.method === 'insert');
    if (ins.length) {
      n.push(P.holeEntry.insert > 0 && ins.some((h) => h.entry) && entryDone
        ? `İnsert delik girişleri ${d1(P.holeEntry.insert)}×45° kırık.`
        : 'İnsert delikleri düz, girişte pah yok (insert üreticisi ölçüsü).');
    }
    if (P.grooveBottomR > 0 && geo.groove) {
      const gb = got('groove.bottom', P.grooveBottomR);
      const gk = got('groove.break', P.grooveEdgeBreak);
      const gbTxt = gb > 0 ? (asChamfer('groove.bottom') ? `dibi ${d2(gb)}×45° pah (radyüs kurulamadı)` : `dip radyüsü R${d2(gb)}`) : 'dibi keskin';
      if (gb > 0 || gk > 0) n.push(`Conta kanalı ${gbTxt}${gk > 0 ? `, üst kenarları ${d2(gk)} mm kırık` : ''} (Parker ORD 5700).`);
    }
    if (T.clip && geo.din) {
      const clipRep = (d.treatReport || []).filter((e) => e.part === 'clip');
      const cf = (key) => clipRep.filter((e) => (e.key === key || e.key.startsWith(`${key}.`)) && e.ok && e.applied > 0).map((e) => e.applied);
      const lr = has ? cf('latch.root') : [T.clip.latchRootR];
      const cb = has ? cf('bed') : [T.clip.bedChamfer];
      if (clipRep.some((e) => e.kind === 'build' && !e.ok)) {
        n.push('DIN klipsi kenar işlemleri olmadan kurulmuştur (işlemli model kurulamadı): kilit dili yarık uçları ve kenarlar keskindir; ayrıntı DFM incelemesinde.');
      } else if (lr.length && lr[0] > 0) n.push(`DIN klipsi: kilit dili kökü R${d2(Math.min(...lr))} (≥ 0,5·t), yarık uçları yuvarlak${cb.length && cb[0] > 0 ? `; üst yüz (tabla) kenarları ${d2(Math.min(...cb))}×45° pah` : ''}.`);
    }
  } else if (part === 'lid') {
    if (inj) {
      const dr = got('draft.plate', P.draftDeg);
      n.push(dr > 0
        ? `Kalıp çıkma açısı ${d1(dr)}° (çekme −Z); ayırma çizgisi kapak alt dış kenarında, keskin; alt dış hat gövde ağız hattıyla aynı.`
        : `Kalıp çıkma açısı en az ${d1(P.draftDeg)}° olmalı; modelde uygulanamadı (ayrıntı DFM incelemesinde).`);
      const tf = got('outer.top', P.outerTopFillet);
      if (tf > 0) n.push(`Üst dış kenar ${rad('outer.top', tf)} (kozmetik).`);
      const ld = span('lip.draft', P.lipDraftDeg);
      if (ld) {
        const ri = span('lip.root', P.lipRootFillet);
        const ro = span('lip.root.out', 0);
        const lt = span('lip.tip', P.lipTipChamfer);
        n.push(`Kapak dili: ${rng(ld, d1)}° çıkma açısı (uç yüzleri dahil)${ri ? `, kök R${rng(ri)}${ro ? ` (dış yüzde R${rng(ro)})` : ''}` : ''}${lt ? `, uçta ${rng(lt)}×45° giriş pahı` : ''}.`);
      }
      const tr = span('tube.root', P.tubeRootFillet);
      const tt = span('tube.tip', P.bossTipChamfer);
      if (tr) n.push(`Vida boruları: ${d1(P.bossDraftDeg)}° açılı, kök R${rng(tr)}${tt ? `, uçta ${rng(tt)}×45° pah` : ''}.`);
    } else {
      if (fdm && got('bed', P.bedChamfer) > 0) n.push(`Dış yüz tablada: üst dış kenar ${d1(got('bed', P.bedChamfer))}×45° pah (tabla kenarında radyüs yok).`);
      if (cnc) {
        const both = got('outer.top', P.outerEdgeBreak) > 0 && got('outer.bottom', P.outerEdgeBreak) > 0;
        n.push(`Belirtilmeyen kenarlar ISO 13715 −${d1(P.outerEdgeBreak)}${both ? `; üst ve alt dış kenarlar modelde ${d1(P.outerEdgeBreak)}×45° pah` : ''}.`);
      }
      const lt = span('lip.tip', P.lipTipChamfer);
      const lr = span('lip.root', P.lipRootFillet);
      if (lt) n.push(`Kapak dili ucunda ${rng(lt)}×45° giriş pahı${lr ? `, kökte R${rng(lr)}` : ''}.`);
      else if (lr) n.push(`Kapak dili kökünde R${rng(lr)}.`);
      const tr = span('tube.root', P.tubeRootFillet);
      const tt = span('tube.tip', P.bossTipChamfer);
      if (tr || tt) n.push(`Vida boruları:${tr ? ` kök R${rng(tr)}` : ''}${tr && tt ? ',' : ''}${tt ? ` uçta ${rng(tt)}×45° pah` : ''}.`);
      const lidEntries = [...(holes.lidTubes || []), ...(holes.lidHoles || [])].some((h) => h.entry);
      if (cnc && lidEntries && (span('entry.tube') || span('entry.lid'))) n.push(`Geçiş delikleri girişte ${d1(P.holeEntry.clearance)}×45° kırık.`);
    }
  }
  const failed = rep.filter((e) => !e.ok && !['boolean', 'build', 'info'].includes(e.kind) && e.rule !== 'INJ-SIDE-ACTION').map((e) => e.feature);
  if (failed.length) n.push(`Modelde uygulanamayan kenar işlemleri: ${[...new Set(failed)].slice(0, 4).join(', ')}${new Set(failed).size > 4 ? ' …' : ''} (ayrıntı DFM incelemesinde).`);
  return n;
}

const METHOD_NOTE = { insert: 'ısıl insert', tapped: 'kılavuz', self_tap: 'diş açan vida ön deliği', helicoil: 'Helicoil (STI)', nut: 'geçiş + somun cebi', standoff: 'aralayıcı geçiş deliği' };

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

  // Panel elemanları — ilgili duvar görünüşünde merkez işareti + balon
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
    `Et kalınlığı ${d1(d.params.wall)} mm, taban ${d1(d.params.floor)} mm, iç köşe R${d2(d.params.rIn)}, dış köşe R${d2(d.params.rOut)}.`,
    `Açıklık konumu duvar boyunca sıfır noktasından, Z gövde altından ölçülür; açıklıklar konnektör + ${d1(rules.cutout_clearance_xy)} mm boşlukla (yuvarlak köşelerde de bu boşluk kalacak kadar büyütülmüş).`,
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
  if (d.fasteningMethod === 'insert' && d.standoffs.length) n.push(`İnsertler${ins0 ? ` (${ins0.id})` : ''} havya ile dik bastırılır; yüzeyle aynı hizada bitmeli.`);
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
    ...toleranceNotes(rules, dl, 'lid'),
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
    { name: 'Kapak', qty: 1, std: '', material: ctx.info.lidMaterial || ctx.info.material, at: [cx + g.outer.L * 0.3, cy, g.zTop], lid: true },
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

/* ---------- DFM İnceleme Raporu paftası (ctx.review, sözleşme C) ---------- */

const LEVEL_TR = { error: 'HATA', warn: 'UYARI', info: 'BİLGİ', ok: 'UYGUN' };
const LEVEL_FILL = { error: '#f4d3d3', warn: '#f9e7c0', info: '#dbe6f2', ok: '#d9eddc', waived: '#e4e4e4' };
const STATUS_TR = {
  ready: { head: 'ÜRETİME HAZIR', sub: 'Açık hata ve uyarı yok.', fill: '#d9eddc' },
  advisories: { head: 'UYARILARLA HAZIR', sub: 'Hata yok; açık uyarılar üretim öncesi değerlendirilmeli.', fill: '#f9e7c0' },
  blocked: { head: 'ÜRETİME UYGUN DEĞİL', sub: 'Giderilmesi gereken hata var; tasarım bu hâliyle üretime verilmemeli.', fill: '#f4d3d3' },
};
const STATUS_RANK = { ready: 0, advisories: 1, blocked: 2 };
const STOP_TR = {
  converged: 'otomatik düzeltilebilecek bulgu kalmadı', 'needs-user': 'kalan bulgular kullanıcı kararı gerektiriyor',
  stalled: 'kalan düzeltmeler tasarımı iyileştirmedi', oscillation: 'düzeltmeler önceki bir duruma döndürdü', 'max-iter': 'yineleme sınırına ulaşıldı',
};
const PART_TR = { base: 'Gövde', lid: 'Kapak', clip: 'DIN klipsi', all: 'Genel' };
// design.js PARAM_FIELDS etiketleriyle aynı (yalnızca değişiklik metni yoksa kullanılır)
const PARAM_TR = { wall: 'Et kalınlığı', pcbClearance: 'PCB–duvar boşluğu', topClearance: 'Bileşen üstü boşluk', standoffHeight: 'PCB altı yükseklik', cornerRadius: 'İç köşe radyüsü' };
const OP_TR = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '==': '=', '=': '=' };
const WHY_TR = { 'no-gain': 'tasarımı iyileştirmedi', oscillation: 'önceki bir duruma geri döndürdü' };
const LIABILITY = 'Tasarım niyeti belirtilen kurallarla uyumludur; üretim öncesi üretici onayı gerekir.';
const RV = { x0: 20, x1: 284, yMax: 166, size: 2.0 };

/** Sözcük kaydırma (DejaVu Sans ortalama harf genişliği ≈ 0,55·boy); sığmayan uzun sözcük (bağlantı) bölünür */
function wrapText(str, width, size, factor = 0.55) {
  const maxChars = Math.max(6, Math.floor(width / (size * factor)));
  const out = [];
  for (const para of String(str ?? '').split('\n')) {
    let cur = '';
    for (let w of para.split(/\s+/).filter(Boolean)) {
      while (w.length > maxChars) {
        if (cur) { out.push(cur); cur = ''; }
        out.push(w.slice(0, maxChars));
        w = w.slice(maxChars);
      }
      const next = cur ? `${cur} ${w}` : w;
      if (next.length > maxChars && cur) { out.push(cur); cur = w; } else cur = next;
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

/** Ölçü birimi eki: derece ve × / % ile başlayan birimler (×D) sayıya bitişik, diğerleri boşlukla */
const unitSuffix = (unit) => (!unit ? '' : unit === '°' || /^[×%]/.test(unit) ? unit : ` ${unit}`);
/** Sayı: arayüzle aynı biçim (eksi işareti U+2212) */
const dm = (v) => d2(v).replace(/^-/, '−');
/** Muafiyet tarihi (waivedAt ya da waived.date, ISO) gerekçenin yanına: " · 26.11.2026" */
const waivedDate = (fd) => {
  const raw = fd.waivedAt || fd.waived?.date;
  const t = raw ? new Date(raw) : null;
  return t && Number.isFinite(t.getTime()) ? ` · ${t.toLocaleDateString('tr-TR')}` : '';
};

function measureText(fd) {
  const u = unitSuffix(fd.unit);
  const m = Number.isFinite(fd.measured) ? `${dm(fd.measured)}${u}` : null;
  const l = Number.isFinite(fd.limit) ? `${OP_TR[fd.op] || ''} ${dm(fd.limit)}${u}`.trim() : null;
  if (m && l) return `${m}\ngerekli ${l}`;
  return m || (l ? `gerekli ${l}` : '—');
}

/** Otomatik düzeltmeyi tetikleyen bulgunun ölçüsü (loop.js changes[]: measured / limit / op / unit; yoksa boş) */
function changeCause(c) {
  if (!Number.isFinite(c?.measured) || !Number.isFinite(c?.limit)) return '';
  const u = unitSuffix(c.unit);
  return `\nNeden: ölçülen ${dm(c.measured)}${u}, gerekli ${`${OP_TR[c.op] || ''} ${dm(c.limit)}${u}`.trim()}.`;
}

/**
 * İnceleme raporunu paftalara yerleştirir (antet hariç). Taşan tablo yeni paftada başlığıyla sürer.
 * Dönüş: { pages: [string[]] }
 */
function layoutReview(ctx) {
  const R = ctx.review || {};
  const findings = Array.isArray(R.findings) ? R.findings : [];
  // Sayılar ve karar listelenen bulgulardan da türetilir: tablo ile karar kutusu hiçbir zaman çelişmez
  // (verilen karar yalnızca ağırlaştırılabilir; muaf olmayan bir hata varsa karar "üretime uygun değil")
  const counts = { error: 0, warn: 0, info: 0, ok: 0, waived: 0, ...(R.counts || {}) };
  if (findings.length) {
    const c = { error: 0, warn: 0, info: 0, ok: 0, waived: 0 };
    for (const fd of findings) { if (fd.waived && fd.level !== 'ok') c.waived++; else if (fd.level in c) c[fd.level]++; }
    for (const k of ['error', 'warn', 'info', 'waived']) counts[k] = c[k];
    if (c.ok > (counts.ok || 0)) counts.ok = c.ok;
  }
  const derived = counts.error > 0 ? 'blocked' : counts.warn > 0 ? 'advisories' : 'ready';
  const given = R.status in STATUS_RANK ? R.status : derived;
  const st = STATUS_TR[STATUS_RANK[derived] > STATUS_RANK[given] ? derived : given];
  const changes = Array.isArray(R.changes) ? R.changes : [];
  const rejected = Array.isArray(R.rejected) ? R.rejected : [];
  const W = RV.x1 - RV.x0;
  const lh = RV.size * 1.32;
  const pages = [];
  let out;
  let y;
  const newPage = (cont) => {
    out = [];
    pages.push(out);
    if (cont) {
      out.push(text(RV.x0, 24, 'DFM İNCELEME RAPORU (devam)', 3.0, { bold: true }));
      y = 31;
    }
  };

  // --- Başlık ve karar ---
  newPage(false);
  out.push(text(RV.x0, 24, 'DFM İNCELEME RAPORU', 3.6, { bold: true }));
  out.push(text(RV.x0, 28.6, 'Tasarım, kaynakları belirtilmiş DFM kurallarına göre incelenmiştir; bu sayfa otomatik düzeltme döngüsünden geçen son tasarımın sonucudur.', 2.0));
  out.push(`<rect x="${RV.x0}" y="32" width="150" height="17" fill="${st.fill}" stroke="#000" stroke-width="${STROKE_VISIBLE}"/>`);
  out.push(text(RV.x0 + 3, 38.2, `KARAR: ${st.head}`, 3.4, { bold: true }));
  out.push(text(RV.x0 + 3, 42.8, st.sub, 2.2));
  const loopTxt = `Döngü: ${Number.isFinite(R.iterations) ? R.iterations : '—'} inceleme turu, ${changes.length} otomatik düzeltme${R.stop ? ` · durma nedeni: ${STOP_TR[R.stop] || R.stop}` : ''}`;
  out.push(text(RV.x0 + 3, 46.8, loopTxt, 1.9));
  const cells = [['Hata', counts.error, LEVEL_FILL.error], ['Uyarı', counts.warn, LEVEL_FILL.warn], ['Bilgi', counts.info, LEVEL_FILL.info], ['Uygun', counts.ok, LEVEL_FILL.ok], ['Muaf', counts.waived, LEVEL_FILL.waived]];
  const cw = (RV.x1 - 176) / cells.length;
  cells.forEach(([k, v, fill], i) => {
    const x = 176 + i * cw;
    out.push(`<rect x="${r3(x)}" y="32" width="${r3(cw)}" height="17" fill="${fill}" stroke="#000" stroke-width="${STROKE_THIN}"/>`);
    out.push(text(x + cw / 2, 36.2, k.toLocaleUpperCase('tr'), 1.9, { anchor: 'middle', bold: true }));
    out.push(text(x + cw / 2, 45.4, String(v ?? 0), 6, { anchor: 'middle', bold: true }));
  });
  // createdAt ISO (UTC) → izleyicinin yerel saati; çözülemezse olduğu gibi
  const at = R.createdAt ? new Date(R.createdAt) : null;
  const when = at && !Number.isNaN(at.getTime())
    ? at.toLocaleString('tr-TR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : R.createdAt ? String(R.createdAt) : ctx.info?.date || '';
  out.push(text(RV.x0, 53.6, `Oluşturma: ${when}${R.appVersion ? ` · uygulama sürümü ${R.appVersion}` : ''} · proje ${ctx.info?.project || ''}`, 1.9));
  y = 60;

  // --- Kaynak numaraları (bulgulardaki kurallar) ---
  const srcList = [];
  const srcIdx = new Map();
  const refsOf = (fd) => (Array.isArray(fd.src) ? fd.src : []).filter((s) => s && (s.title || s.url)).map((s) => {
    const k = `${s.title}|${s.url}`;
    if (!srcIdx.has(k)) { srcList.push(s); srcIdx.set(k, srcList.length); }
    return srcIdx.get(k);
  });

  // --- Tablo yardımcıları ---
  const section = (title, cols, rows, empty) => {
    const head = () => {
      out.push(text(RV.x0, y + 3.2, title, 2.6, { bold: true }));
      y += 5;
      if (!rows.length) return;
      out.push(`<rect x="${RV.x0}" y="${r3(y)}" width="${W}" height="4.6" fill="#eef1f4" stroke="#000" stroke-width="${STROKE_THIN}"/>`);
      let cx = RV.x0;
      for (const c of cols) { out.push(text(cx + 1, y + 3.2, c.label, 1.9, { bold: true })); cx += c.w; }
      y += 4.6;
    };
    const laid = rows.map((row) => {
      const cl = cols.map((c, i) => {
        const v = row.cells[i];
        const parts = typeof v === 'object' && v ? v : { text: v };
        const lines = [];
        if (parts.title) for (const l of wrapText(parts.title, c.w - 2, RV.size, 0.6)) lines.push({ t: l, bold: true });
        for (const l of wrapText(parts.text ?? '', c.w - 2, RV.size)) if (l || !lines.length) lines.push({ t: l, bold: !!parts.bold });
        return lines;
      });
      return { row, cl, h: Math.max(...cl.map((l) => l.length)) * lh + 1.6 };
    });
    if (y + 5 + (rows.length ? 4.6 + laid[0].h : 6) > RV.yMax) newPage(true);
    head();
    if (!rows.length) { out.push(text(RV.x0 + 1, y + 2.6, empty, RV.size)); y += 9; return; }
    for (const L of laid) {
      if (y + L.h > RV.yMax) { newPage(true); head(); }
      if (L.row.fill) out.push(`<rect x="${r3(RV.x0 + (L.row.fillAt || 0))}" y="${r3(y)}" width="${r3(L.row.fillW || W)}" height="${r3(L.h)}" fill="${L.row.fill}"/>`);
      let cx = RV.x0;
      cols.forEach((c, i) => {
        L.cl[i].forEach((l, k) => out.push(text(cx + 1, y + 1 + lh * (k + 1) - 0.55, l.t, RV.size, { bold: l.bold })));
        if (i) out.push(line(cx, y, cx, y + L.h));
        cx += c.w;
      });
      out.push(line(RV.x0, y, RV.x0, y + L.h), line(RV.x1, y, RV.x1, y + L.h), line(RV.x0, y + L.h, RV.x1, y + L.h));
      y += L.h;
    }
    y += 5;
  };

  // --- Otomatik düzeltmeler ---
  section('OTOMATİK DÜZELTMELER', [{ label: 'No', w: 8 }, { label: 'Kural', w: 34 }, { label: 'Parametre', w: 34 }, { label: 'Değişim', w: 30 }, { label: 'Açıklama', w: W - 106 }],
    changes.map((c, i) => ({ cells: [String(i + 1), c.rule || '—', PARAM_TR[c.key] || c.key || '—',
      Number.isFinite(c.from) && Number.isFinite(c.to) ? `${d2(c.from)} → ${d2(c.to)} mm` : '—', { title: c.title || '', text: `${c.text || ''}${changeCause(c)}` }] })),
    'Otomatik düzeltme uygulanmadı.');
  if (rejected.length) {
    section('REDDEDİLEN DÜZELTMELER', [{ label: 'No', w: 8 }, { label: 'Kural', w: 34 }, { label: 'Parametre', w: 34 }, { label: 'Önerilen', w: 30 }, { label: 'Neden', w: W - 106 }],
      rejected.map((c, i) => ({ cells: [String(i + 1), c.rule || '—', PARAM_TR[c.key] || c.key || '—',
        Number.isFinite(c.from) && Number.isFinite(c.to) ? `${d2(c.from)} → ${d2(c.to)} mm` : '—', `Düzeltme denendi, uygulanmadı: ${WHY_TR[c.why] || c.why || ''}.`] })), '');
  }

  // --- Açık bulgular: hata, uyarı, bilgi; sonra muaf tutulanlar ---
  const order = { error: 0, warn: 1, info: 2 };
  const open = findings.filter((fd) => !fd.waived && fd.level in order).sort((a, b) => order[a.level] - order[b.level]);
  const waived = findings.filter((fd) => fd.waived && fd.level !== 'ok');
  const fcols = [{ label: 'No', w: 8 }, { label: 'Seviye', w: 15 }, { label: 'Kural', w: 36 }, { label: 'Parça', w: 16 }, { label: 'Bulgu', w: W - 115 }, { label: 'Ölçülen / sınır', w: 40 }];
  const fRow = (fd, i, isWaived) => {
    const refs = refsOf(fd);
    return {
      fill: LEVEL_FILL[isWaived ? 'waived' : fd.level], fillAt: 8, fillW: 15,
      cells: [String(i + 1), { text: isWaived ? `MUAF (${(LEVEL_TR[fd.level] || '').toLocaleLowerCase('tr')})` : LEVEL_TR[fd.level] || fd.level, bold: true },
        `${fd.rule || '—'}${refs.length ? ` [${refs.join(', ')}]` : ''}`, PART_TR[fd.part] || PART_TR.all,
        { title: fd.title || '', text: `${fd.text || ''}${isWaived && (fd.reason || fd.waived?.reason) ? `\nMuafiyet gerekçesi: ${fd.reason || fd.waived.reason}${waivedDate(fd)}` : ''}` }, measureText(fd)],
    };
  };
  section('AÇIK BULGULAR', fcols, open.map((fd, i) => fRow(fd, i, false)), 'Açık bulgu yok.');
  if (waived.length) section('MUAF TUTULAN BULGULAR', fcols, waived.map((fd, i) => fRow(fd, i, true)), '');
  const okN = counts.ok || 0;
  if (y + 6 > RV.yMax) newPage(true);
  out.push(text(RV.x0, y, `Ayrıca ${okN} kontrol uygun bulundu (ayrıntı uygulamadaki inceleme listesinde).`, RV.size, { bold: true }));
  y += 7;

  // --- Kaynaklar ---
  if (srcList.length) {
    const lines = srcList.flatMap((s, i) => wrapText(`[${i + 1}] ${s.title || ''}${s.url ? ` — ${s.url}` : ''}`, W, 1.8).map((t, k) => (k ? `     ${t}` : t)));
    if (y + 5 + 2 * 1.8 * 1.3 > RV.yMax) newPage(true);
    out.push(text(RV.x0, y + 3.2, 'KAYNAKLAR', 2.6, { bold: true }));
    y += 6;
    for (const t of lines) {
      if (y + 2.4 > RV.yMax) { newPage(true); out.push(text(RV.x0, y + 3.2, 'KAYNAKLAR (devam)', 2.6, { bold: true })); y += 6; }
      out.push(text(RV.x0, y + 1.8, t, 1.8));
      y += 1.8 * 1.3;
    }
  }
  return { pages, hasSources: srcList.length > 0 };
}

/** Yerleşmiş rapor sayfalarına sorumluluk notu ve antet eklenir */
function finishReview(ctx, report, firstNo) {
  const n = report.pages.length;
  return report.pages.map((out, i) => {
    out.push(text(RV.x0, 177, 'SORUMLULUK NOTU', 2.4, { bold: true }));
    wrapText(LIABILITY, 140, 2.2).forEach((l, k) => out.push(text(RV.x0, 181.4 + k * 2.9, l, 2.2)));
    const legend = `HATA: üretim öncesi giderilmeli · UYARI: değerlendirilmeli · BİLGİ: bilgi amaçlı · MUAF: kullanıcı gerekçesiyle kabul edildi.${report.hasSources ? ' Köşeli ayraçtaki numaralar KAYNAKLAR listesine bakar.' : ''}`;
    wrapText(legend, 140, 1.8).forEach((l, k) => out.push(text(RV.x0, 189.4 + k * 2.4, l, 1.8)));
    titleBlock(out, ctx.info, 'DFM İNCELEME', firstNo + i, ctx.sheetCount, null, `Ikra ${ctx.info.version} · DFM inceleme raporu`);
    return { title: n > 1 ? `DFM İnceleme Raporu ${i + 1}/${n}` : 'DFM İnceleme Raporu', svg: sheetSvg(out), scale: 1, kind: 'report' };
  });
}

export function buildSheets(ctx) {
  const withAsm = !!ctx.views.assembly?.iso;
  const drawingCount = withAsm ? 3 : 2;
  // ctx.review yoksa davranış öncekiyle aynı (2 ya da 3 pafta)
  const report = ctx.review ? layoutReview(ctx) : null;
  ctx.sheetCount = drawingCount + (report ? report.pages.length : 0);
  const sheets = [baseSheet(ctx), lidSheet(ctx), ...(withAsm ? [assemblySheet(ctx)] : [])];
  if (report) sheets.push(...finishReview(ctx, report, drawingCount + 1));
  return sheets;
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
