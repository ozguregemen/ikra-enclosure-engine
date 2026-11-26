/*
 * Tasarım incelemesi: computeDesign() kontrollerini ve katı model işlem raporunu, kural kataloğuna
 * bağlı "bulgu" (Finding) kayıtlarına çevirir. Saf fonksiyonlardır; DOM'a ya da CAD çekirdeğine bağımlı değildir.
 * Girdi nesneleri (tasarım, işlem raporu, muafiyetler) hiçbir zaman değiştirilmez.
 *
 * Finding = { id, rule, level, cat, part, title, text, measured, limit, op, unit, why, source, conf,
 *             fix, fixAuto, focus, waived, autoFixed }
 *   id       kararlı parmak izi: kural + odak parça + rakamları atılmış metin (yeniden üretimde aynı kalır;
 *            muafiyetler bu kimliğe bağlanır)
 *   fixAuto  düzeltme döngünün kendiliğinden uygulayacağı türden mi (sayısal, otomatik anahtar, kilitsiz, artırır)
 *   waived   { reason, date } — kullanıcı muafiyeti; gerekçesi en az 3 karakter olmalı, yoksa yok sayılır;
 *            sayımlarda ayrı tutulur
 */
import { RULES } from './catalog.js';

/** Döngünün kendiliğinden değiştirebildiği sayısal parametreler (yalnızca artırarak) */
export const AUTO_PARAM_KEYS = ['wall', 'pcbClearance', 'topClearance', 'standoffHeight', 'cornerRadius'];

/** Muafiyet gerekçesinin boşluksuz en az uzunluğu (D10: gerekçesiz muafiyet yok sayılır) */
export const WAIVER_REASON_MIN = 3;

const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const f = (v) => nf.format(Math.round(v * 100) / 100);

/** FNV-1a 32 bit, onaltılık */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Bulgu parmak izi: kural + odak parça + rakamları (ve ondalık ayırıcılarını) atılmış metin */
export function fingerprint(rule, focus, text) {
  const t = String(text || '').replace(/\d+(?:[.,]\d+)*/g, '#');
  return `${rule || 'NA'}-${hash32(`${rule}|${focus?.partId ?? ''}|${t}`)}`;
}

const lockSet = (locks) => (locks instanceof Set ? locks : new Set(Array.isArray(locks) ? locks : []));

/** Düzeltme otomatik mi: sayısal + otomatik anahtar + auto !== false (+ verilirse: kilitsiz ve değeri artırıyor) */
export function isAutoFix(fix, params = null, locks = null) {
  if (!fix || fix.auto === false || !AUTO_PARAM_KEYS.includes(fix.key)) return false;
  if (typeof fix.value !== 'number' || !Number.isFinite(fix.value)) return false;
  if (locks && lockSet(locks).has(fix.key)) return false;
  if (params && Number.isFinite(params[fix.key]) && !(fix.value > params[fix.key] + 1e-9)) return false;
  return true;
}

/** Muafiyet geçerli mi: nesne ve boşluksuz en az WAIVER_REASON_MIN karakterlik gerekçe */
export function validWaiver(w) {
  if (!w || typeof w !== 'object') return false;
  return String(w.reason ?? '').replace(/\s+/g, '').length >= WAIVER_REASON_MIN;
}

function defaultPart(c, cat) {
  if (c.part) return c.part;
  if (cat === 'kapak') return 'lid';
  if (cat === 'genel' || cat === 'rf' || cat === 'geometri') return 'all';
  return 'base';
}

/** Bulgunun derin kopyası (önbellek ve çağıran birbirini bozmasın) */
export function cloneFinding(fd) {
  return {
    ...fd,
    fix: fd.fix ? { ...fd.fix } : null,
    focus: fd.focus ? { ...fd.focus } : null,
    waived: fd.waived ? { ...fd.waived } : null,
    source: Array.isArray(fd.source) ? fd.source.map((s) => ({ ...s })) : [],
    limit: Array.isArray(fd.limit) ? [...fd.limit] : fd.limit,
  };
}

/** Tek kontrol/bulgu kaydını Finding'e çevir (girdi kaydı değiştirilmez) */
export function toFinding(c, opts = {}) {
  const info = c.rule && RULES[c.rule] ? RULES[c.rule] : null;
  const cat = c.cat || info?.cat || 'genel';
  const fix = c.fix ? { ...c.fix } : null;
  const finding = {
    id: fingerprint(c.rule, c.focus, c.text),
    rule: c.rule || null,
    level: c.level,
    cat,
    part: defaultPart(c, cat),
    title: info ? info.title : String(c.text || '').split(/[.:;]/)[0],
    text: c.text,
    measured: c.measured ?? null,
    limit: Array.isArray(c.limit) ? [...c.limit] : c.limit ?? null,
    op: c.op ?? null,
    unit: c.unit ?? null,
    why: info ? info.why : '',
    source: info ? info.source.map((s) => ({ ...s })) : [],
    conf: info ? info.conf : 'low',
    fix,
    fixAuto: isAutoFix(fix, opts.params || null, opts.locks || null),
    focus: c.focus ? { ...c.focus } : null,
    waived: null,
    autoFixed: !!c.autoFixed,
  };
  if (!info) finding.uncatalogued = true;
  return finding;
}

/** Kimlik çakışmasında (aynı kural + parça + metin) sıra numarası eklenir; geçerli muafiyetler işlenir */
function finalize(list, waivers) {
  const seen = new Map();
  for (const fd of list) {
    const n = seen.get(fd.id) || 0;
    seen.set(fd.id, n + 1);
    if (n) fd.id = `${fd.id}-${n + 1}`;
    const w = waivers && Object.prototype.hasOwnProperty.call(waivers, fd.id) ? waivers[fd.id] : null;
    if (fd.level !== 'ok' && validWaiver(w)) fd.waived = { reason: String(w.reason).trim(), date: w.date || null };
  }
  return list;
}

/**
 * computeDesign() sonucundaki kontrollerden bulgular.
 * opts: { params (otomatik düzeltme yönü için), locks (Set|dizi), waivers ({ id: {reason,date} }) }
 */
export function findingsFromChecks(design, opts = {}) {
  if (!design) return [];
  const list = [];
  if (design.error) {
    list.push(toFinding({ level: 'error', text: design.error, rule: 'GEN-INPUT', cat: 'genel' }, opts));
  }
  for (const c of design.checks || []) list.push(toFinding(c, opts));
  return finalize(list, opts.waivers);
}

/* ---------- Katı model sonrası inceleme (işlem raporu sözleşmesi, sürüm 2) ---------- */

const PART_TEXT = { base: 'Gövde', lid: 'Kapak', clip: 'DIN klipsi' };
/** Gerçek kenar işlemleri (özet satırında sayılır) ve Türkçe adları */
const KIND_TEXT = {
  fillet: 'radyüs', chamfer: 'pah', draft: 'kalıp çıkma açısı', countersink: 'havşa', dogbone: 'köşe boşaltması (dogbone)',
  leadin: 'giriş pahı', loft: 'eğimli yüzey',
};
/** Yalnızca bilgi satırları: işlem sayılmaz, uyarı üretmez (sürüm 1 adları geriye uyum için) */
const INFO_KINDS = new Set(['info', 'sharp', 'embed', 'offset']);
const DRAFT_KEYS = { 'draft.outer': 'dış duvar', 'draft.pocket': 'cep (iç duvar)' };
const DEFAULT_UNIT = { draft: '°', boolean: 'adet', build: 'adet' };

const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** Değer + birim: "0,5 mm", "1,5°", "3 adet" */
const withUnit = (v, unit) => (unit === '°' ? `${f(v)}°` : `${f(v)} ${unit || 'mm'}`);

/** Ön incelemedeki (computeDesign) INJ-DRAFT sınırı: en az gereken çıkma açısı (°) */
export function draftLimitOf(design) {
  const c = (design?.checks || []).find((x) => x && x.rule === 'INJ-DRAFT' && x.part !== 'lid' && Number.isFinite(Number(x.limit)));
  return c ? Number(c.limit) : null;
}

/**
 * Katı model sonrası inceleme: işçinin işlem raporu (treatReport, sözleşme A sürüm 2) bulgulara çevrilir.
 * Satır: { part, key, feature, kind, size, applied, unit, ok, limited, count, rule, note, dv? }
 *   kind 'info'                 → yok sayılır (ayırma çizgisi, ofset, gömme, kaydırma, pencere notları)
 *   kind 'build', ok:false      → GEO-BUILD hata (parça işlemsiz yapıya düştü)
 *   kind 'boolean'              → öğe sayıları karşılaştırılır; ok:false → GEO-BUILD hata, limited → bilgi
 *   ok:true, limited:false      → tam ölçüde uygulandı (özet 'ok' satırında sayılır)
 *   ok:true, limited:true       → bilgi: "istenen X yerine Y uygulandı (neden)"
 *   ok:false                    → uyarı: "uygulanamadı" (yüzey/kenar düz bırakıldı)
 * rule: katalogda varsa satırın kuralı, yoksa GEO-TREAT. Enjeksiyonda INJ-DRAFT yalnızca gövdenin draft.outer ve
 * draft.pocket satırlarıyla (size > 0) ve ön incelemedeki sınırla (opts.draftLimit ya da design.checks) değerlendirilir.
 * opts: { params, locks, waivers, draftLimit }
 */
export function reviewBuild(design, treatReport, opts = {}) {
  const out = [];
  if (!design) return out;
  const process = String(design.rulesId || '').split('/')[0] || null;
  const list = Array.isArray(treatReport) ? treatReport.filter((t) => t && typeof t === 'object') : null;
  const ruleOf = (t, fallback) => (t.rule && Object.prototype.hasOwnProperty.call(RULES, t.rule) ? t.rule : fallback);
  const catOf = (rule) => RULES[rule]?.cat || 'geometri';
  let okRows = 0;
  let okInstances = 0;
  for (const t of list || []) {
    const kind = String(t.kind || '');
    if (INFO_KINDS.has(kind)) continue;
    const part = PART_TEXT[t.part] ? t.part : 'all';
    const who = PART_TEXT[t.part] || 'Parça';
    const feature = String(t.feature || 'özellik');
    const note = t.note ? ` (${t.note})` : '';
    const size = numOrNull(t.size);
    const applied = numOrNull(t.applied);
    const unit = t.unit || DEFAULT_UNIT[kind] || 'mm';
    if (kind === 'build') {
      if (t.ok === false) {
        out.push({ level: 'error', rule: 'GEO-BUILD', cat: 'geometri', part,
          text: `${who}: kenar işlemli katı model kurulamadı, işlemsiz yapıya düşüldü${note}; bu parçada radyüs, pah ve çıkma açıları yok, model incelemedeki varsayımla örtüşmez.` });
      }
      continue;
    }
    if (kind === 'boolean') {
      const req = size ?? 0;
      const done = applied ?? 0;
      if (t.ok === false) {
        const miss = Math.max(1, Math.round(req - done));
        out.push({ level: 'error', rule: 'GEO-BUILD', cat: 'geometri', part, measured: done, limit: req, op: '>=', unit: 'adet',
          text: `${who}: ${feature}: ${f(req)} öğeden ${f(miss)} tanesi katı modelde oluşturulamadı${note}; üretilen model tasarımdan farklı.` });
      } else if (t.limited) {
        const rule = ruleOf(t, 'GEO-TREAT');
        out.push({ level: 'info', rule, cat: catOf(rule), part, measured: done, limit: req, op: '>=', unit: 'adet',
          text: `${who}: ${feature}: ${f(req)} öğenin bir kısmı kenar işlemi olmadan (düz geometriyle) oluşturuldu${note}.` });
      }
      continue; // Boole satırları kenar işlemi sayılmaz
    }
    // Kenar işlemi: pah, radyüs, çıkma açısı, havşa, dogbone, giriş pahı (bilinmeyen tür de işlem sayılır)
    const kt = KIND_TEXT[kind] || 'kenar işlemi';
    const rule = ruleOf(t, 'GEO-TREAT');
    // Sürüm 1 raporu: ok:false ama uygulanan > 0 → sınırlandırılmış uygulama
    const legacyLimited = t.limited === undefined && t.ok === false && applied !== null && applied > 1e-9;
    const limited = legacyLimited || (t.ok !== false && (t.limited === true || (size !== null && applied !== null && applied < size - 1e-6)));
    const fullOk = t.ok !== false && !limited;
    if (fullOk) { okRows++; okInstances += Number.isFinite(Number(t.count)) && Number(t.count) > 0 ? Number(t.count) : 1; }
    // Enjeksiyonda gövde dış/cep çıkma açısı INJ-DRAFT toplu değerlendirmesinde
    if (process === 'injection' && t.part === 'base' && DRAFT_KEYS[t.key]) continue;
    if (fullOk) continue;
    if (limited) {
      out.push({ level: 'info', rule, cat: catOf(rule), part, measured: applied ?? 0, limit: size, op: '>=', unit,
        text: `${who}: ${feature}: istenen ${size !== null ? withUnit(size, unit) + ' ' : ''}${kt} yerine ${withUnit(applied ?? 0, unit)} uygulandı${note}.` });
    } else {
      out.push({ level: 'warn', rule, cat: catOf(rule), part, measured: applied ?? 0, limit: size, op: '>=', unit,
        text: `${who}: ${feature}: istenen ${size !== null ? withUnit(size, unit) + ' ' : ''}${kt} uygulanamadı${note}; bu yüzey/kenar düz bırakıldı.` });
    }
  }
  if (okRows) {
    out.push({ level: 'ok', rule: 'GEO-TREAT', cat: 'geometri', part: 'all', measured: okRows, unit: 'adet',
      text: `${okRows} kenar işlemi katı modelde tam ölçüsüyle uygulandı${okInstances > okRows ? ` (${okInstances} kenar/öğe)` : ''}.` });
  }
  if (process === 'injection') {
    const lim = Number.isFinite(Number(opts.draftLimit)) && opts.draftLimit !== null ? Number(opts.draftLimit) : draftLimitOf(design);
    const limit = lim ?? 0;
    const rows = (list || []).filter((t) => t.part === 'base' && DRAFT_KEYS[t.key] && numOrNull(t.size) > 0);
    const base = { rule: 'INJ-DRAFT', cat: 'surec', part: 'base', op: '>=', unit: '°', limit };
    if (!list) {
      out.push({ ...base, level: 'warn', measured: 0,
        text: 'Kalıp çıkma açısı katı modelde doğrulanamadı (işlem raporu yok): yan duvarlar 0° kabul edilir; parça kalıptan zor çıkar ya da çizilir.' });
    } else if (!rows.length) {
      out.push({ ...base, level: 'warn', measured: 0,
        text: `Kalıp çıkma açısı katı modelde uygulanmadı: gövde yan duvarları 0°${limit ? `, en az ${f(limit)}° gerekir` : ''}; parça kalıptan zor çıkar ya da çizilir.` });
    } else {
      const got = (t) => (t.ok === false ? 0 : numOrNull(t.applied) ?? 0);
      const minA = Math.min(...rows.map(got));
      const desc = rows.map((t) => `${DRAFT_KEYS[t.key]} ${f(got(t))}°`).join(', ');
      const bad = rows.filter((t) => t.ok === false || got(t) < limit - 1e-6);
      if (!bad.length) {
        out.push({ ...base, level: 'ok', measured: minA, text: `Kalıp çıkma açısı katı modelde uygulandı: ${desc} (en az ${f(limit)}°).` });
      } else {
        const why = bad.map((t) => t.note).filter(Boolean)[0];
        out.push({ ...base, level: 'warn', measured: minA,
          text: `Kalıp çıkma açısı katı modelde yetersiz: ${desc}; en az ${f(limit)}° gerekir${why ? ` (${why})` : ''}. Parça kalıba yapışır ya da çizilir.` });
      }
    }
  }
  return finalize(out.map((c) => toFinding(c, opts)), opts.waivers);
}

/**
 * Döngü bulgularıyla katı model sonrası bulguları birleştirir (girdiler değiştirilmez):
 * yapım sonrası gövde INJ-DRAFT bulgusu varsa ön incelemedeki gövde INJ-DRAFT bilgi satırı düşer (kapağınki kalır);
 * kimlik çakışmaları numaralanır. Dönüş: { findings, counts, status }
 */
export function mergeBuildFindings(findings, buildFindings) {
  const post = (buildFindings || []).map(cloneFinding);
  const postDraft = post.some((fd) => fd.rule === 'INJ-DRAFT' && fd.part !== 'lid');
  const pre = (findings || []).filter((fd) => !(postDraft && fd.rule === 'INJ-DRAFT' && fd.level === 'info' && fd.part !== 'lid')).map(cloneFinding);
  const merged = [...pre, ...post];
  const seen = new Map();
  for (const fd of merged) {
    const n = seen.get(fd.id) || 0;
    seen.set(fd.id, n + 1);
    if (n) fd.id = `${fd.id}-b${n + 1}`;
  }
  return { findings: merged, ...summarize(merged) };
}

/** Sayımlar ve durum: hata varsa 'blocked', uyarı varsa 'advisories', yoksa 'ready'. Muaf bulgular ayrı sayılır. */
export function summarize(findings) {
  const counts = { error: 0, warn: 0, info: 0, ok: 0, waived: 0 };
  for (const fd of findings || []) {
    if (fd.waived) counts.waived++;
    else if (fd.level in counts) counts[fd.level]++;
  }
  const status = counts.error ? 'blocked' : counts.warn ? 'advisories' : 'ready';
  return { counts, status };
}
