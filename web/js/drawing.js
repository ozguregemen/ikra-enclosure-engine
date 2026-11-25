/*
 * Teknik resim (M4).
 * CAD işçisinin gizli çizgi kaldırmalı (HLR) izdüşümlerinden A4 yatay SVG paftaları üretir
 * (gövde + kapak) ve isteğe bağlı olarak PDF'e çevirir (jsPDF + svg2pdf.js, Türkçe için DejaVu Sans).
 * Koordinatlar gövdenin dış köşesine (0, 0, 0) göredir; tüm ölçüler mm.
 */

const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';
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

function toleranceNotes(rules) {
  const pp = rules.process_params || {};
  if (rules.process === 'fdm') {
    return [`Genel tolerans ±0,2 mm (FDM, Ø${d1(pp.nozzle_diameter)} nozul, ${d1(pp.layer_height)} mm katman).`];
  }
  if (rules.process === 'cnc') {
    return ['Genel toleranslar ISO 2768-m. Keskin kenarları 0,3×45° kır.', `İç köşe radyüsleri takıma göre R${d1(pp.tool_diameter / 2 + 0.1)}.`];
  }
  return [
    'Genel toleranslar ISO 20457 TG6.',
    `Kalıp çıkma açısı ≥ ${d1(rules.draft_angle_min)}° (resimde gösterilmemiştir). Çekme payı %${d1(rules.shrink_factor * 100)} kalıpta uygulanır.`,
  ];
}

const METHOD_NOTE = { insert: 'ısıl insert', tapped: 'kılavuz', self_tap: 'sac vidası ön deliği', helicoil: 'Helicoil (STI)' };

function baseSheet(ctx) {
  const { views, design: d, rules } = ctx;
  const g = d.geometry;
  const datum = [g.center[0] - g.outer.L / 2, g.center[1] - g.outer.W / 2, g.z0];
  const portSides = new Set(d.ports.filter((p) => p.enabled).map((p) => p.side));
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
  dimH(out, pt.x0, pt.x1, pt.y1 + 7, pt.y1, d.outer.L);
  dimV(out, pt.y0, pt.y1, pt.x1 + 7, pt.x1, d.outer.W);
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
  const n = [
    ...toleranceNotes(rules),
    `Et kalınlığı ${d1(d.params.wall)} mm, taban ${d1(d.params.floor)} mm, iç köşe R${d1(d.params.rIn)}, dış köşe R${d1(d.params.rOut)}.`,
    `Açıklık konumu duvar boyunca sıfır noktasından, Z gövde altından ölçülür; açıklıklar konnektör + ${d1(rules.cutout_clearance_xy)} mm boşlukla.`,
  ];
  if (d.sealing) {
    const sg = d.sealing.groove;
    n.push(`Conta kanalı ${d2(sg.width)} × ${d2(sg.depth)} mm, duvar üstünde orta eksende; Ø${d1(d.sealing.cord_d)} kordon (%${Math.round(d.sealing.squeeze * 100)} sıkışma), ${d.sealing.label}.`);
  }
  if (rules.process === 'fdm') n.push('Baskı yönü: gövde ağzı yukarı; destek gerekmez.');
  const ins0 = d.standoffs[0]?.insert;
  if (d.fasteningMethod === 'insert') n.push(`İnsertler${ins0 ? ` (${ins0.id})` : ''} havya ile dik bastırılır; yüzeyle aynı hizada bitmeli.`);
  if (d.fasteningMethod === 'helicoil' && ins0) n.push(`Helicoil yuvaları: Ø${d2(ins0.drill)} matkap, ${d.standoffs[0].screw} STI kılavuz, girişte 90° havşa Ø${d2(ins0.csk)}; burç yüzeyden 0,25–0,5·P içeride, tang kırılır.`);
  y = notes(out, colX, y, 91, 'NOTLAR', n);
  if (d.bom.length && y < 158) notes(out, colX, y + 3, 91, 'BAĞLANTI ELEMANLARI', d.bom, 2.0);

  titleBlock(out, ctx.info, 'GÖVDE', 1, 2, s);
  return { title: 'Gövde', svg: sheetSvg(out), scale: s };
}

function lidSheet(ctx) {
  const { views, design: d, rules } = ctx;
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
      t.countersink ? `90° · boru Ø${d1(t.od)}` : `boru Ø${d1(t.od)}`]);
  });

  let y = 24;
  if (rows.length) {
    y = table(out, 194, y, 'DELİK TABLOSU (KAPAK)', [
      { label: 'No', w: 8 }, { label: 'X', w: 12 }, { label: 'Y', w: 12 }, { label: 'Çap', w: 12 }, { label: 'Tip', w: 20 }, { label: 'Not', w: 28 },
    ], rows) + 8;
  }
  const n = [
    ...toleranceNotes(rules),
    `Kapak kalınlığı ${d1(d.params.lidT)} mm. Konumlandırma dili ${d1(d.params.lipT)} mm, gövdeye ${d2(d.params.fit)} mm boşlukla oturur.`,
    'Delik koordinatları gövde ile aynı sıfır noktasına göredir.',
  ];
  const sunk = d.lidTubes.some((t) => t.countersink);
  if (sunk) n.push('Havşalar 90°; vida başı kapak üst yüzüyle aynı hizada kalır.');
  if (d.sealing) {
    n.push(`Kapağın alt yüzü conta yüzeyidir: düz ve çiziksiz olmalı. ${sunk ? 'Havşalara sıvı sızdırmazlık.' : 'Vida başlarına sızdırmazlık pulu.'}`);
  }
  if (rules.process === 'fdm') n.push('Baskı yönü: kapağın dış yüzü tablaya; borular ve dil yukarı.');
  notes(out, 194, y, 91, 'NOTLAR', n);

  titleBlock(out, ctx.info, 'KAPAK', 2, 2, s);
  return { title: 'Kapak', svg: sheetSvg(out), scale: s };
}

export function buildSheets(ctx) {
  return [baseSheet(ctx), lidSheet(ctx)];
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
