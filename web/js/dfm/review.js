/*
 * Tasarım incelemesi: computeDesign() kontrollerini ve katı model işlem raporunu, kural kataloğuna
 * bağlı "bulgu" (Finding) kayıtlarına çevirir. Saf fonksiyonlardır; DOM'a ya da CAD çekirdeğine bağımlı değildir.
 * Girdi nesneleri (tasarım, işlem raporu, muafiyetler) hiçbir zaman değiştirilmez.
 *
 * Finding = { id, rule, level, cat, part, title, text, measured, limit, op, unit, why, source, conf,
 *             fix, fixAuto, focus, waived, autoFixed, limits?, fixes? }
 *   limits   yalnız yüzey başına sınırı olan kurallarda (ör. kapak INJ-DRAFT: { plate, lip, tube }, °)
 *   fixes    birden çok düzeltme yolu olan bulgularda: [fix, ...seçenekler] (ör. Helicoil ya da daha küçük freze,
 *            { key: 'toolDiameter', value, label, auto: false }); fixes[0] her zaman fix ile aynıdır
 *   id       kararlı parmak izi: kural + odak parça + rakamları atılmış metin (yeniden üretimde aynı kalır;
 *            muafiyetler bu kimliğe bağlanır)
 *   fixAuto  düzeltme döngünün kendiliğinden uygulayacağı türden mi (sayısal, otomatik anahtar, kilitsiz, artırır)
 *   waived   { reason, date } — kullanıcı muafiyeti; gerekçesi en az 3 karakter olmalı, yoksa yok sayılır;
 *            sayımlarda ayrı tutulur
 */
import { RULES } from './catalog.js';
import { stdCutterAtMost } from '../treat.js';

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
    ...(Array.isArray(fd.fixes) ? { fixes: fd.fixes.map((x) => ({ ...x })) } : {}),
    focus: fd.focus ? { ...fd.focus } : null,
    waived: fd.waived ? { ...fd.waived } : null,
    source: Array.isArray(fd.source) ? fd.source.map((s) => ({ ...s })) : [],
    limit: Array.isArray(fd.limit) ? [...fd.limit] : fd.limit,
    ...(fd.limits && typeof fd.limits === 'object' ? { limits: { ...fd.limits } } : {}),
  };
}

/**
 * Tek kontrol/bulgu kaydını Finding'e çevir (girdi kaydı değiştirilmez).
 * opts.phase === 'post': katı model sonrası bulgu; parmak izi ayrı önekle alınır, ön incelemeyle aynı kimliği hiç almaz
 * (birleştirmede yeniden adlandırma gerekmez, muafiyet kimliği sabit kalır).
 */
export function toFinding(c, opts = {}) {
  const info = c.rule && RULES[c.rule] ? RULES[c.rule] : null;
  const cat = c.cat || info?.cat || 'genel';
  const fix = c.fix ? { ...c.fix } : null;
  const finding = {
    id: fingerprint(c.rule, c.focus, opts.phase === 'post' ? `post|${c.text}` : c.text),
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
    ...(c.limits && typeof c.limits === 'object' ? { limits: { ...c.limits } } : {}),
    why: info ? info.why : '',
    source: info ? info.source.map((s) => ({ ...s })) : [],
    conf: info ? info.conf : 'low',
    fix,
    // Seçenekli düzeltmeler (fixes[0] === fix): ör. Helicoil ya da daha küçük freze
    ...(Array.isArray(c.fixes) && c.fixes.length ? { fixes: c.fixes.filter(Boolean).map((x) => ({ ...x })) } : {}),
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

/**
 * Hiçbir bulguyla eşleşmeyen muafiyet kimlikleri (bulgu metni değiştiğinde ya da sorun ortadan kalktığında).
 * Eşleşmeyen muafiyet hiçbir bulguya kendiliğinden aktarılmaz (yeni bir sorunu sessizce örtmesin); arayüz bunları
 * "artık eşleşmiyor" diye gösterebilir.
 */
export function staleWaivers(waivers, findings) {
  if (!waivers || typeof waivers !== 'object') return [];
  const ids = new Set((findings || []).map((fd) => fd && fd.id));
  return Object.keys(waivers).filter((k) => !ids.has(k));
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
/** Gövdenin INJ-DRAFT toplu değerlendirmesine giren satırlar (sözleşme A) */
const DRAFT_KEYS = { 'draft.outer': 'dış duvar', 'draft.pocket': 'cep (iç duvar)' };
/** Kapağın INJ-DRAFT değerlendirmesinde satır adları (kapakta kind 'draft' ve size > 0 olan tüm satırlar değerlendirilir) */
const LID_DRAFT_KEYS = { 'draft.plate': 'plaka yan yüzü', 'lip.draft': 'dil', 'tube.draft': 'vida boruları' };
/** Ön incelemede sınır bulunamazsa: IM-10 (Protolabs) olağan en az çıkma açısı; injectionDraft'ın tabanı da 1° */
export const DRAFT_FALLBACK = 1;
/** Kapak dili en az çıkma açısı (IM-24/IM-39), ön incelemede lipLimit yoksa */
const LIP_DRAFT_MIN = 2;
const DEFAULT_UNIT = { draft: '°', boolean: 'adet', build: 'adet' };

/**
 * Dikey içbükey köşe satırları (plan radyüsü; CNC'de parmak frezenin yan yüzüyle işlenir): köşe boss'u–duvar, kart
 * desteği–duvar, kulak–duvar. Satır anahtarı bunlardan biri ya da rapor gruplamasındaki son ekli biçimi (.limited/.failed).
 * Taban–duvar köşesi, dil kökü gibi yatay kenarlar ve kavitenin kendi köşeleri (ön incelemede CNC-CORNER-TOOL) dahil değildir.
 */
const VERTICAL_CONCAVE_KEYS = ['corner.concave', 'pad.concave', 'ear.concave'];
const isVerticalConcave = (t) => (t.rule === 'GEO-CORNER-CONCAVE' || t.rule === 'GEO-FILLET-INNER') &&
  VERTICAL_CONCAVE_KEYS.some((k) => t.key === k || String(t.key || '').startsWith(`${k}.`));

const r3 = (v) => Math.round(v * 1000) / 1000;
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** Değer + birim: "0,5 mm", "1,5°", "3 adet" */
const withUnit = (v, unit) => (unit === '°' ? `${f(v)}°` : `${f(v)} ${unit || 'mm'}`);

/** Ön incelemedeki (computeDesign) INJ-DRAFT kontrolü: part 'base' (varsayılan) ya da 'lid' */
function draftCheckOf(design, part = 'base') {
  return (design?.checks || []).find((x) => x && x.rule === 'INJ-DRAFT' && (part === 'lid' ? x.part === 'lid' : x.part !== 'lid') &&
    numOrNull(x.limit) !== null) || null;
}

/** Ön incelemedeki INJ-DRAFT sınırı: en az gereken çıkma açısı (°); part 'base' (varsayılan) ya da 'lid' */
export function draftLimitOf(design, part = 'base') {
  const c = draftCheckOf(design, part);
  return c ? Number(c.limit) : null;
}

/**
 * Katı model sonrası inceleme: işçinin işlem raporu (treatReport, sözleşme A sürüm 2) bulgulara çevrilir.
 * Satır: { part, key, feature, kind, size, applied, unit, ok, limited, count, rule, note, dv? }
 *   kind 'info'                 → yok sayılır (ayırma çizgisi, ofset, gömme, kaydırma, pencere notları)
 *   kind 'build', ok:false      → GEO-BUILD hata (parça kenar işlemsiz modele geri döndü)
 *   kind 'boolean'              → öğe sayıları karşılaştırılır; ok:false → GEO-BUILD hata, limited → bilgi
 *   size > 0 ve applied ≤ 0     → ok bayrağı ne olursa olsun uygulanmadı sayılır (uyarı)
 *   ok:true, limited:false      → tam ölçüde uygulandı (özet 'ok' satırında sayılır)
 *   ok:true, limited:true       → bilgi: "istenen X yerine Y uygulandı (neden)" (0 < applied < size)
 *   ok:false                    → uyarı: "uygulanamadı" (yüzey/kenar düz bırakıldı)
 * rule: katalogda varsa satırın kuralı, yoksa GEO-TREAT.
 * INJ-DRAFT: gövde enjeksiyonsa gövdenin draft.outer ve draft.pocket satırları (size > 0) ön incelemedeki sınırla
 * (opts.draftLimit ya da design.checks); kapak enjeksiyonsa kapaktaki tüm çıkma açısı satırları (size > 0) kapağın ön
 * inceleme sınırlarıyla (limits.plate, limits.lip, limits.tube; yoksa limit; opts.lidDraftLimit hepsinin yerine
 * geçer). Sınır bulunamazsa DRAFT_FALLBACK (1°) alınır ve metinde belirtilir; hiçbir zaman 0° değildir.
 * opts: { params, locks, waivers, draftLimit, lidDraftLimit }
 */
export function reviewBuild(design, treatReport, opts = {}) {
  const out = [];
  if (!design) return out;
  const process = String(design.rulesId || '').split('/')[0] || null;
  const lidProcess = design.lidMaterial?.process || process;
  const list = Array.isArray(treatReport) ? treatReport.filter((t) => t && typeof t === 'object') : null;
  const ruleOf = (t, fallback) => (t.rule && Object.prototype.hasOwnProperty.call(RULES, t.rule) ? t.rule : fallback);
  const catOf = (rule) => RULES[rule]?.cat || 'geometri';
  const isBaseDraft = (t) => process === 'injection' && t.part === 'base' && !!DRAFT_KEYS[t.key] && numOrNull(t.size) > 0;
  const isLidDraft = (t) => lidProcess === 'injection' && t.part === 'lid' && String(t.kind || '') === 'draft' && numOrNull(t.size) > 0;
  // CNC parçada geçerli freze çapı: tasarımın değeri (geometry.toolDiameter / lidToolDiameter), yoksa işlem politikası
  // (geometry.treat), yoksa opts.toolDiameter, yoksa kural dosyalarının varsayılanı Ø3
  const g = design.geometry || {};
  const toolOf = (part) => {
    const proc = part === 'lid' ? lidProcess : process;
    if (proc !== 'cnc') return null;
    const v = [part === 'lid' ? g.lidToolDiameter : g.toolDiameter, g.treat?.[part === 'clip' ? 'clip' : part === 'lid' ? 'lid' : 'base']?.toolD,
      opts.toolDiameter, 3].map(numOrNull).find((x) => x !== null && x > 0);
    return v ?? null;
  };
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
          text: `${who}: kenar işlemli katı model kurulamadı${note}; parça kenar işlemsiz modele geri döndü. Bu parçada radyüs, pah ve çıkma açıları yok; model incelemedeki varsayımla örtüşmez.` });
      }
      continue;
    }
    if (kind === 'boolean') {
      const req = size ?? 0;
      const done = applied ?? 0;
      if (t.ok === false) {
        const miss = Math.max(1, Math.round(req - done));
        out.push({ level: 'error', rule: 'GEO-BUILD', cat: 'geometri', part, measured: done, limit: req, op: '>=', unit: 'adet',
          text: `${who}, ${feature}: ${f(req)} öğeden ${f(miss)} tanesi katı modelde oluşturulamadı${note}; üretilen model tasarımdan farklı.` });
      } else if (t.limited) {
        const rule = ruleOf(t, 'GEO-TREAT');
        out.push({ level: 'info', rule, cat: catOf(rule), part, measured: done, limit: req, op: '>=', unit: 'adet',
          text: `${who}, ${feature}: ${f(req)} öğenin bir kısmı kenar işlemi olmadan (düz geometriyle) oluşturuldu${note}.` });
      }
      continue; // Boole satırları kenar işlemi sayılmaz
    }
    // Kenar işlemi: pah, radyüs, çıkma açısı, havşa, dogbone, giriş pahı (bilinmeyen tür de işlem sayılır)
    const kt = KIND_TEXT[kind] || 'kenar işlemi';
    const rule = ruleOf(t, 'GEO-TREAT');
    // İstenen ölçü 0: işlem istenmemiş (ör. 0° pencere yüzü); ne işlem sayılır ne bulgu üretir
    if (size !== null && size <= 1e-9) continue;
    // İstenen ölçü > 0 ama uygulanan 0: ok bayrağından bağımsız olarak uygulanmadı (sözleşme A: limited ⇔ 0 < applied < size)
    const notApplied = size !== null && size > 1e-9 && applied !== null && applied <= 1e-9;
    // Sürüm 1 raporu: ok:false ama uygulanan > 0 → sınırlandırılmış uygulama
    const legacyLimited = !notApplied && t.limited === undefined && t.ok === false && applied !== null && applied > 1e-9;
    const limited = !notApplied && (legacyLimited || (t.ok !== false && (t.limited === true || (size !== null && applied !== null && applied < size - 1e-6))));
    const fullOk = !notApplied && t.ok !== false && !limited;
    // CNC dikey iç köşe: uygulanan radyüs freze yarıçapından küçükse bu köşe o frezeyle işlenemez → uyarı (satır başına
    // tek bulgu, satırın kendi kuralıyla; kavite köşeleri ön incelemedeki CNC-CORNER-TOOL'dadır, burada yinelenmez)
    const tool = isVerticalConcave(t) ? toolOf(t.part) : null;
    const gotR = notApplied || t.ok === false ? 0 : Math.max(0, applied ?? size ?? 0);
    if (tool && gotR < tool / 2 - 1e-6) {
      const cutter = gotR > 0.05 ? stdCutterAtMost(2 * gotR) : null;
      const sug = cutter && cutter < tool - 1e-9 ? cutter : null;
      out.push({ level: 'warn', rule, cat: catOf(rule), part, measured: r3(gotR), limit: r3(tool / 2), op: '>=', unit: 'mm',
        fix: sug ? { key: 'toolDiameter', value: sug, label: `Ø${f(sug)} mm freze seç`, auto: false } : null,
        text: gotR > 0.05
          ? `${who}, ${feature}: uygulanan R${f(gotR)} Ø${f(tool)} frezenin yarıçapından (R${f(tool / 2)}) küçük; bu iç köşe bu frezeyle işlenemez${note}. ${sug ? `Ø${f(sug)} mm ya da daha küçük freze seçilmeli ya da köşeye radyüs için yer açılmalı.` : 'Köşeye radyüs için yer açılmalı.'}`
          : `${who}, ${feature}: iç köşe radyüssüz (keskin) kaldı${note}; döner freze keskin iç köşe işleyemez, Ø${f(tool)} freze burada en az R${f(tool / 2)} bırakır. Köşeye radyüs için yer açılmalı.` });
      continue;
    }
    if (fullOk) { okRows++; okInstances += Number.isFinite(Number(t.count)) && Number(t.count) > 0 ? Number(t.count) : 1; }
    // Enjeksiyonda çıkma açısı satırları INJ-DRAFT değerlendirmesinde (gövde: dış/cep; kapak: tüm çıkma açıları)
    if (isBaseDraft(t) || isLidDraft(t)) continue;
    if (fullOk) continue;
    if (limited) {
      out.push({ level: 'info', rule, cat: catOf(rule), part, measured: applied ?? 0, limit: size, op: '>=', unit,
        text: `${who}, ${feature}: istenen ${size !== null ? withUnit(size, unit) + ' ' : ''}${kt} yerine ${withUnit(applied ?? 0, unit)} uygulandı${note}.` });
    } else {
      out.push({ level: 'warn', rule, cat: catOf(rule), part, measured: applied ?? 0, limit: size, op: '>=', unit,
        text: `${who}, ${feature}: istenen ${size !== null ? withUnit(size, unit) + ' ' : ''}${kt} uygulanamadı${note}; bu yüzey/kenar düz bırakıldı.` });
    }
  }
  if (okRows) {
    out.push({ level: 'ok', rule: 'GEO-TREAT', cat: 'geometri', part: 'all', measured: okRows, unit: 'adet',
      text: `${okRows} kenar işlemi katı modelde tam ölçüsüyle uygulandı${okInstances > okRows ? ` (${okInstances} kenar/öğe)` : ''}.` });
  }
  // Uygulanan açı: uygulanmayan (ok:false ya da applied ≤ 0) satır 0°
  const got = (t) => (t.ok === false ? 0 : Math.max(0, numOrNull(t.applied) ?? 0));
  const FALLBACK_NOTE = `ön incelemede sınır bulunamadı, IM-10 en az değeri ${f(DRAFT_FALLBACK)}° alındı`;
  /** Bir parçanın çıkma açısı satırlarını kendi sınırlarıyla değerlendirir; tek bulgu (ok ya da warn) üretir */
  const draftFinding = ({ part, prefix, surfaces, rows, limitOf, nameOf, mainLimit, fallback, perRow }) => {
    const base = { rule: 'INJ-DRAFT', cat: 'surec', part, op: '>=', unit: '°', limit: mainLimit };
    const fb = fallback ? ` (${FALLBACK_NOTE})` : '';
    if (!list) {
      return { ...base, level: 'warn', measured: 0,
        text: `${prefix} katı modelde doğrulanamadı (işlem raporu yok): ${surfaces} 0° kabul edilir; parça kalıptan zor çıkar ya da çizilir.` };
    }
    if (!rows.length) {
      return { ...base, level: 'warn', measured: 0,
        text: `${prefix} katı modelde uygulanmadı: ${surfaces} 0°, en az ${f(mainLimit)}° gerekir${fb}; parça kalıptan zor çıkar ya da çizilir.` };
    }
    // En dar paylı satır ölçü/sınır olarak raporlanır
    const worst = rows.reduce((w, t) => (got(t) - limitOf(t) < got(w) - limitOf(w) - 1e-9 ? t : w), rows[0]);
    const desc = rows.map((t) => `${nameOf(t)} ${f(got(t))}°${perRow ? ` (en az ${f(limitOf(t))}°)` : ''}`).join(', ');
    const bad = rows.filter((t) => t.ok === false || got(t) < limitOf(t) - 1e-6);
    if (!bad.length) {
      const tail = perRow ? fb : ` (en az ${f(mainLimit)}°${fallback ? `; ${FALLBACK_NOTE}` : ''})`;
      return { ...base, level: 'ok', measured: got(worst), limit: limitOf(worst), text: `${prefix} katı modelde uygulandı: ${desc}${tail}.` };
    }
    const why = bad.map((t) => t.note).filter(Boolean)[0];
    const whyT = why ? ` (${why})` : '';
    return { ...base, level: 'warn', measured: got(worst), limit: limitOf(worst),
      text: perRow
        ? `${prefix} katı modelde yetersiz: ${desc}${whyT}${fb}; ${bad.map(nameOf).join(', ')} için çıkma açısı artırılmalı, aksi hâlde parça kalıba yapışır ya da çizilir.`
        : `${prefix} katı modelde yetersiz: ${desc}; en az ${f(mainLimit)}° gerekir${whyT}${fb}. Parça kalıba yapışır ya da çizilir.` };
  };
  if (process === 'injection') {
    const lim = numOrNull(opts.draftLimit) ?? draftLimitOf(design, 'base');
    const limit = lim ?? DRAFT_FALLBACK;
    out.push(draftFinding({ part: 'base', prefix: 'Kalıp çıkma açısı', surfaces: 'gövde yan duvarları', rows: (list || []).filter(isBaseDraft),
      limitOf: () => limit, nameOf: (t) => DRAFT_KEYS[t.key], mainLimit: limit, fallback: lim === null, perRow: false }));
  }
  if (lidProcess === 'injection') {
    const lc = draftCheckOf(design, 'lid');
    const optL = numOrNull(opts.lidDraftLimit);
    const main = optL ?? numOrNull(lc?.limit);
    const fallback = main === null;
    const featLim = main ?? DRAFT_FALLBACK;
    const plateLim = optL ?? numOrNull(lc?.limits?.plate) ?? DRAFT_FALLBACK; // plaka yan yüzü yalnız kapak kalınlığı kadar derin
    const lipLim = optL ?? numOrNull(lc?.limits?.lip) ?? Math.max(featLim, LIP_DRAFT_MIN);
    const tubeLim = optL ?? numOrNull(lc?.limits?.tube) ?? featLim;
    const limitOf = (t) => (t.key === 'draft.plate' ? plateLim : t.key === 'lip.draft' ? lipLim : t.key === 'tube.draft' ? tubeLim : featLim);
    out.push(draftFinding({ part: 'lid', prefix: 'Kapak kalıp çıkma açısı', surfaces: 'kapak yan yüzleri, dil ve vida boruları',
      rows: (list || []).filter(isLidDraft), limitOf, nameOf: (t) => LID_DRAFT_KEYS[t.key] || String(t.feature || 'yüzey'),
      mainLimit: featLim, fallback, perRow: true }));
  }
  return finalize(out.map((c) => toFinding(c, { ...opts, phase: 'post' })), opts.waivers);
}

/**
 * Döngü bulgularıyla katı model sonrası bulguları birleştirir (girdiler değiştirilmez): yapım sonrası INJ-DRAFT bulgusu
 * olan parçanın (gövde ya da kapak) ön incelemedeki INJ-DRAFT bilgi satırı düşer. Katı model sonrası kimlikler ayrı
 * önekle üretildiğinden çakışma beklenmez; yine de olursa numaralanır. Dönüş: { findings, counts, status }
 */
export function mergeBuildFindings(findings, buildFindings) {
  const post = (buildFindings || []).map(cloneFinding);
  const partKey = (fd) => (fd.part === 'lid' ? 'lid' : 'base');
  const postDraft = new Set(post.filter((fd) => fd.rule === 'INJ-DRAFT').map(partKey));
  const pre = (findings || []).filter((fd) => !(fd.rule === 'INJ-DRAFT' && fd.level === 'info' && postDraft.has(partKey(fd)))).map(cloneFinding);
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
