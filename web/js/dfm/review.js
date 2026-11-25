/*
 * Tasarım incelemesi: computeDesign() kontrollerini ve katı model işlem raporunu, kural kataloğuna
 * bağlı "bulgu" (Finding) kayıtlarına çevirir. Saf fonksiyonlardır; DOM'a ya da CAD çekirdeğine bağımlı değildir.
 *
 * Finding = { id, rule, level, cat, part, title, text, measured, limit, op, unit, why, source, conf,
 *             fix, fixAuto, focus, waived, autoFixed }
 *   id       kararlı parmak izi: kural + odak parça + rakamları atılmış metin (yeniden üretimde aynı kalır;
 *            muafiyetler bu kimliğe bağlanır)
 *   fixAuto  düzeltme döngünün kendiliğinden uygulayacağı türden mi (sayısal, otomatik anahtar, kilitsiz, artırır)
 *   waived   { reason, date } — kullanıcı muafiyeti; sayımlarda ayrı tutulur
 */
import { RULES } from './catalog.js';

/** Döngünün kendiliğinden değiştirebildiği sayısal parametreler (yalnızca artırarak) */
export const AUTO_PARAM_KEYS = ['wall', 'pcbClearance', 'topClearance', 'standoffHeight', 'cornerRadius'];

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

function defaultPart(c, cat) {
  if (c.part) return c.part;
  if (cat === 'kapak') return 'lid';
  if (cat === 'genel' || cat === 'rf' || cat === 'geometri') return 'all';
  return 'base';
}

/** Tek kontrol/bulgu kaydını Finding'e çevir */
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
    limit: c.limit ?? null,
    op: c.op ?? null,
    unit: c.unit ?? null,
    why: info ? info.why : '',
    source: info ? info.source : [],
    conf: info ? info.conf : 'low',
    fix,
    fixAuto: isAutoFix(fix, opts.params || null, opts.locks || null),
    focus: c.focus || null,
    waived: null,
    autoFixed: !!c.autoFixed,
  };
  if (!info) finding.uncatalogued = true;
  return finding;
}

/** Kimlik çakışmasında (aynı kural + parça + metin) sıra numarası eklenir; muafiyetler işlenir */
function finalize(list, waivers) {
  const seen = new Map();
  for (const fd of list) {
    const n = seen.get(fd.id) || 0;
    seen.set(fd.id, n + 1);
    if (n) fd.id = `${fd.id}-${n + 1}`;
    const w = waivers && waivers[fd.id];
    if (w && fd.level !== 'ok') fd.waived = { reason: String(w.reason || ''), date: w.date || null };
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

const PART_TEXT = { base: 'Gövde', lid: 'Kapak', clip: 'DIN klipsi' };
const KIND_TEXT = { fillet: 'radyüs', chamfer: 'pah', draft: 'kalıp çıkma açısı', loft: 'eğimli yüzey (loft)', boolean: 'Boole işlemi' };

/**
 * Katı model sonrası inceleme: işçinin işlem raporu (treatReport) bulgulara çevrilir.
 * treatReport = [{ part, feature, kind: 'fillet'|'chamfer'|'draft'|'loft'|'boolean', size, ok, applied, note }]
 * - istenen radyüs/pah/draft uygulanamadı (ok=false) → GEO-TREAT uyarı
 * - özelliğin Boole işlemi başarısız → GEO-BUILD hata
 * - enjeksiyonda draft uygulandıysa INJ-DRAFT uygun, uygulanmadı/rapor yoksa INJ-DRAFT uyarı
 */
export function reviewBuild(design, treatReport, opts = {}) {
  const out = [];
  if (!design) return out;
  const process = String(design.rulesId || '').split('/')[0] || null;
  const list = Array.isArray(treatReport) ? treatReport.filter(Boolean) : null;
  if (list) {
    for (const t of list) {
      const who = PART_TEXT[t.part] || 'Parça';
      const unit = t.kind === 'draft' ? '°' : 'mm';
      const size = Number.isFinite(t.size) ? `${f(t.size)} ${unit} ` : '';
      const note = t.note ? ` (${t.note})` : '';
      if (t.kind === 'boolean' && t.ok === false) {
        out.push({ level: 'error', text: `${who}: ${t.feature} katı model öğesi oluşturulamadı${note}; üretilen model tasarımdan farklı.`, rule: 'GEO-BUILD', cat: 'geometri', part: t.part || 'all' });
      } else if (t.ok === false) {
        out.push({ level: 'warn', text: `${who}: ${t.feature} için istenen ${size}${KIND_TEXT[t.kind] || t.kind} uygulanamadı${note}; bu kenarda düz geometri kullanıldı.`,
          rule: 'GEO-TREAT', cat: 'geometri', part: t.part || 'all', measured: Number.isFinite(t.applied) ? t.applied : 0, limit: Number.isFinite(t.size) ? t.size : null, op: '>=', unit });
      } else if (t.ok && Number.isFinite(t.applied) && Number.isFinite(t.size) && t.applied < t.size - 1e-6) {
        out.push({ level: 'info', text: `${who}: ${t.feature} için istenen ${f(t.size)} ${unit} yerine ${f(t.applied)} ${unit} ${KIND_TEXT[t.kind] || t.kind} uygulandı${note}.`,
          rule: 'GEO-TREAT', cat: 'geometri', part: t.part || 'all', measured: t.applied, limit: t.size, op: '>=', unit });
      }
    }
    const okCount = list.filter((t) => t.ok && t.kind !== 'boolean').length;
    if (okCount) out.push({ level: 'ok', text: `${okCount} kenar işlemi (radyüs, pah, kalıp çıkma açısı) katı modelde uygulandı.`, rule: 'GEO-TREAT', cat: 'geometri', part: 'all' });
  }
  if (process === 'injection') {
    const drafts = (list || []).filter((t) => t.kind === 'draft');
    const okD = drafts.filter((t) => t.ok);
    if (okD.length) {
      out.push({ level: 'ok', text: `Kalıp çıkma açısı katı modelde uygulandı: ${okD.slice(0, 3).map((t) => `${(PART_TEXT[t.part] || 'parça').toLocaleLowerCase('tr')} ${t.feature} ${f(t.applied ?? t.size)}°`).join(', ')}.`,
        rule: 'INJ-DRAFT', cat: 'surec', part: 'base', measured: okD[0].applied ?? okD[0].size, unit: '°' });
    } else {
      out.push({ level: 'warn', text: `Kalıp çıkma açısı katı modelde ${list ? (drafts.length ? 'uygulanamadı' : 'uygulanmadı') : 'doğrulanamadı (işlem raporu yok)'}: yan duvarlar 0°; parça kalıptan zor çıkar ya da çizilir.`,
        rule: 'INJ-DRAFT', cat: 'surec', part: 'base', measured: 0, op: '>=', unit: '°' });
    }
  }
  return finalize(out.map((c) => toFinding(c, opts)), opts.waivers);
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
