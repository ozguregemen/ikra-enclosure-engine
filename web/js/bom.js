/*
 * Malzeme listesi (BOM) çıktısı ve şirket tercihli parça listesi.
 * - parts: computeDesign() çıktısındaki yapılandırılmış satırlar
 * - Tercihli liste: kullanıcının içe aktardığı CSV (standart; boyut; boy; malzeme; stok kodu; açıklama).
 *   Yalnızca bu tarayıcıda saklanır (localStorage); dosyalar hiçbir sunucuya gönderilmez.
 */

const STORE_KEY = 'ikra.preferredParts.v1';
const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2, useGrouping: false });

const norm = (v) => String(v ?? '').trim().toLocaleLowerCase('tr').replace(/\s+/g, ' ').replace(',', '.');
const normStd = (v) => norm(v).replace(/^(din en iso|en iso|iso)\s*/, 'iso ').replace(/\s*-\s*1$/, '');
const normLen = (v) => {
  const s = norm(v);
  if (!s) return '';
  const n = Number(s);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : s;
};

export function loadPreferred() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return Array.isArray(data?.items) ? data : { items: [], name: '', date: '' };
  } catch {
    return { items: [], name: '', date: '' };
  }
}

export function savePreferred(data) {
  try {
    if (!data || !data.items.length) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** CSV satırını ayır (tırnaklı alanlar desteklenir) */
function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const HEADERS = {
  standard: ['standart', 'standard', 'norm', 'standart/kod', 'kod'],
  size: ['boyut', 'size', 'ölçü', 'olcu', 'diş', 'dis'],
  length: ['boy', 'boy (mm)', 'length', 'uzunluk', 'l'],
  material: ['malzeme', 'material', 'kaplama'],
  stock: ['stok kodu', 'stok_kodu', 'stok', 'stock', 'stock code', 'parça no', 'parca no', 'part number', 'malzeme kodu', 'sap'],
  note: ['açıklama', 'aciklama', 'tanım', 'tanim', 'description', 'not'],
};

/**
 * Tercihli parça CSV'si → { items: [{ standard, size, length, material, stock, note }], skipped }
 * İlk satır başlık olmalı (Türkçe veya İngilizce); ayraç ; , ya da sekme.
 */
export function parsePreferredCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('Dosya boş.');
  const first = lines[0];
  const sep = [';', '\t', ','].map((s) => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const head = splitCsvLine(first, sep).map((h) => norm(h));
  const col = {};
  for (const [key, names] of Object.entries(HEADERS)) {
    const i = head.findIndex((h) => names.includes(h));
    if (i >= 0) col[key] = i;
  }
  if (col.standard === undefined || col.stock === undefined) {
    throw new Error('Başlık satırında en az "standart" ve "stok kodu" sütunları olmalı.');
  }
  const items = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line, sep);
    const get = (k) => (col[k] === undefined ? '' : c[col[k]] || '');
    const it = { standard: get('standard'), size: get('size'), length: get('length'), material: get('material'), stock: get('stock'), note: get('note') };
    if (!it.standard || !it.stock) { skipped++; continue; }
    items.push(it);
  }
  return { items, skipped };
}

/** Parça satırı ile tercihli kayıt eşleşir mi? Kayıttaki boş alan "hepsi" demektir. Dönüş: eşleşen alan sayısı ya da -1 */
function score(entry, p) {
  if (normStd(entry.standard) !== normStd(p.standard || p.name)) return -1;
  let n = 1;
  if (entry.size) { if (norm(entry.size) !== norm(p.size)) return -1; n++; }
  if (entry.length) { if (normLen(entry.length) !== normLen(p.length)) return -1; n++; }
  if (entry.material) { if (norm(entry.material) !== norm(p.material)) return -1; n++; }
  return n;
}

/** En özel (en çok alanı tutan) tercihli kayıt ya da null */
export function matchPreferred(p, items) {
  let best = null;
  let bestN = 0;
  for (const e of items || []) {
    const s = score(e, p);
    if (s > bestN) { best = e; bestN = s; }
  }
  return best;
}

/** Toolbox işaretleri: bu standart (ve boyut / boy) tercihli listede var mı? */
export function preferredHas(items, standard, size = null, length = null) {
  return (items || []).some((e) => normStd(e.standard) === normStd(standard) &&
    (size === null || !e.size || norm(e.size) === norm(size)) &&
    (length === null || !e.length || normLen(e.length) === normLen(length)));
}

const csvCell = (v) => {
  const s = typeof v === 'number' ? nf.format(v) : String(v ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvText = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';

/** Malzeme listesi CSV'si (Excel için ; ayraç, ondalık virgül, UTF-8 BOM) */
export function bomCsv(parts, preferred, info = {}) {
  const items = preferred?.items || [];
  const rows = [['Poz', 'Adet', 'Tanım', 'Standart', 'Boyut', 'Boy (mm)', 'Malzeme', 'Özellik', 'Konum', 'Stok kodu', 'Tercihli']];
  // Poz numaraları teknik resimdeki montaj paftasıyla aynı: önce gövde ve kapak (üretilen parçalar)
  let pos = 0;
  for (const b of info.bodies || []) rows.push([++pos, 1, b.name, '', '', '', b.material || '', b.spec || '', '', '', '']);
  for (const p of parts) {
    const m = matchPreferred(p, items);
    rows.push([++pos, p.qty, p.name, p.standard, p.size, p.length ?? '', p.material, p.spec, p.where, m ? m.stock : '', items.length ? (m ? 'evet' : 'hayır') : '']);
  }
  if (info.project) rows.push([], ['Proje', info.project], ['Malzeme / süreç', info.material || ''], ['Tarih', info.date || ''], ['Kaynak', info.version || 'Ikra Enclosure Engine']);
  return csvText(rows);
}

/** Tercihli liste şablonu: bu tasarımın parçaları, stok kodu boş (doldurulup geri yüklenir) */
export function preferredTemplateCsv(parts, preferred) {
  const items = preferred?.items || [];
  const rows = [['Standart', 'Boyut', 'Boy', 'Malzeme', 'Stok kodu', 'Açıklama']];
  for (const e of items) rows.push([e.standard, e.size, e.length, e.material, e.stock, e.note]);
  const seen = new Set(items.map((e) => [normStd(e.standard), norm(e.size), normLen(e.length), norm(e.material)].join('|')));
  for (const p of parts) {
    const std = p.standard || p.name;
    const key = [normStd(std), norm(p.size), normLen(p.length), norm(p.material)].join('|');
    if (seen.has(key) || matchPreferred(p, items)) continue;
    seen.add(key);
    rows.push([std, p.size, p.length ?? '', p.material, '', p.name]);
  }
  return csvText(rows);
}
