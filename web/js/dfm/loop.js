/*
 * Tasarım → inceleme → düzeltme → yeniden inceleme döngüsü (öner-ve-düzelt, propose-and-revise).
 *
 * 1) Üret: kural dosyası varsayılanları + kullanıcının yazdığı (kilitli) değerlerle computeDesign().
 * 2) İncele: kontroller katalog kurallarına bağlı bulgulara (Finding) çevrilir.
 * 3) Düzelt: güvenli düzeltmeler (sayısal, otomatik anahtar, kilitsiz, değeri yalnızca ARTIRAN, 0,05 mm'ye
 *    yuvarlanmış) uygulanır; her geçişte anahtar başına en fazla bir düzeltme (en büyük artış, eşitlikte kural
 *    önceliği). Bağımlı parametreler aynı geçişte birlikte değiştirilmez (et kalınlığı değişirse diğerleri sonraki
 *    geçişe kalır).
 * 4) Kabul: geçiş yalnızca puan (1e6·hata + 1e3·uyarı + otomatik düzeltmesi kalan bilgi sayısı) kesin olarak
 *    düşerse kabul edilir; toplu geçiş düşürmezse en fazla 3 aday tek tek denenir. Reddedilen (kural, anahtar,
 *    değer) üçlüleri yasaklanır (tabu); parametre durumu tekrar ederse salınım kabul edilir.
 * Bitiş: converged | max-iter | oscillation | stalled | needs-user. Rastgelelik ve saat yoktur: aynı girdi aynı sonucu verir.
 *
 * Kaynaklar (araştırma notları): Gil & Melz propose-and-revise; ESLint çok geçişli düzeltme ve döngüsel düzeltme
 * tespiti; min-conflicts sözlük sıralı puan; veri akışı analizinde monoton, sınırlı adımlarla sabit noktaya yakınsama.
 */
import { computeDesign } from '../design.js';
import { RULES } from './catalog.js';
import { AUTO_PARAM_KEYS, findingsFromChecks, summarize, toFinding } from './review.js';

export const AUTO_KEYS = AUTO_PARAM_KEYS;

// Bağımlılık sırası: et kalınlığı tabanı, kapağı, köşe radyüsünü, conta kanalını ve vida boylarını etkiler
const ORDER = ['wall', 'cornerRadius', 'pcbClearance', 'topClearance', 'standoffHeight'];
const DOWNSTREAM = {
  wall: ['cornerRadius', 'pcbClearance', 'topClearance', 'standoffHeight'],
  cornerRadius: ['pcbClearance'],
  pcbClearance: [],
  topClearance: ['standoffHeight'],
  standoffHeight: [],
};
// Otomatik düzeltmenin aşamayacağı üst sınırlar (mm): bunun üstü kullanıcı kararıdır
const BOUNDS = { wall: 12, pcbClearance: 10, topClearance: 60, standoffHeight: 60, cornerRadius: 30 };
const STEP = 0.05;
const LEVEL_RANK = { error: 0, warn: 1, info: 2, ok: 3 };
const PARAM_LABEL = {
  wall: 'Et kalınlığı', pcbClearance: 'PCB–duvar boşluğu', topClearance: 'Bileşen üstü boşluk',
  standoffHeight: 'PCB altı yükseklik', cornerRadius: 'İç köşe radyüsü',
};

const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const f = (v) => nf.format(Math.round(v * 100) / 100);
const r2 = (v) => Math.round(v * 100) / 100;
/** Yukarı 0,05 mm'ye yuvarla (monoton artış) */
const quant = (v) => r2(Math.ceil(v / STEP - 1e-6) * STEP);

/** Saf kural varsayılanları (eski defaultParams'ın gizli döngüsünden önceki değerler) */
export function baseParams(analysis, rules) {
  const below = analysis && analysis.maxBelow ? analysis.maxBelow.value : 0;
  return {
    wall: rules.default_wall,
    pcbClearance: rules.pcb_clearance_xy,
    topClearance: rules.component_clearance_z,
    standoffHeight: r2(Math.max(rules.min_standoff_height, below + rules.under_board_clearance)),
    cornerRadius: rules.corner_radius_min,
  };
}

function scoreOf(findings) {
  let s = 0;
  for (const fd of findings) {
    if (fd.waived) continue;
    if (fd.level === 'error') s += 1e6;
    else if (fd.level === 'warn') s += 1e3;
    else if (fd.level === 'info' && fd.fixAuto) s += 1;
  }
  return s;
}

const hashParams = (p) => AUTO_KEYS.map((k) => (Number.isFinite(Number(p[k])) ? r2(Number(p[k])) : String(p[k]))).join('|');

function evaluate(analysis, rules, params, options, locks, waivers) {
  const design = computeDesign(analysis, rules, params, options);
  const findings = findingsFromChecks(design, { params, locks, waivers });
  return { design, findings, score: scoreOf(findings), params };
}

/** Uygulanabilir otomatik düzeltme adayları */
function candidates(findings, params, locks, tabu) {
  const out = [];
  for (const fd of findings) {
    if (fd.waived || !fd.fix || fd.fix.auto === false) continue;
    const key = fd.fix.key;
    if (!AUTO_KEYS.includes(key) || locks.has(key)) continue;
    if (typeof fd.fix.value !== 'number' || !Number.isFinite(fd.fix.value)) continue;
    const from = Number(params[key]);
    if (!Number.isFinite(from)) continue;
    const to = quant(fd.fix.value);
    if (!(to > from + 1e-9) || to > BOUNDS[key] + 1e-9) continue;
    const tabuKey = `${fd.rule}|${key}|${to}`;
    if (tabu.has(tabuKey)) continue;
    out.push({ finding: fd, key, from, to, rule: fd.rule, priority: RULES[fd.rule]?.priority ?? 100, rank: LEVEL_RANK[fd.level] ?? 3, tabuKey });
  }
  return out;
}

/** Anahtar başına tek aday: en büyük artış; eşitlikte düşük öncelik numarası, sonra daha ağır önem */
function bestPerKey(cands) {
  const m = new Map();
  for (const c of cands) {
    const cur = m.get(c.key);
    if (!cur || c.to > cur.to + 1e-9 ||
      (Math.abs(c.to - cur.to) <= 1e-9 && (c.priority < cur.priority || (c.priority === cur.priority && c.rank < cur.rank)))) m.set(c.key, c);
  }
  return m;
}

const bySeverity = (a, b) => a.rank - b.rank || a.priority - b.priority || ORDER.indexOf(a.key) - ORDER.indexOf(b.key);

function changeText(c) {
  const title = RULES[c.rule]?.title || c.rule || '';
  return `${PARAM_LABEL[c.key] || c.key} ${f(c.from)} → ${f(c.to)} mm (${title}).`;
}

/* ---------- Önbellek: son ~8 sonuç ---------- */
const MEMO_MAX = 8;
const memo = new Map();
const objIds = new WeakMap();
let nextObjId = 1;
const idOf = (o) => {
  if (!o || (typeof o !== 'object' && typeof o !== 'function')) return String(o);
  let v = objIds.get(o);
  if (!v) { v = nextObjId++; objIds.set(o, v); }
  return v;
};
const listKey = (arr) => (Array.isArray(arr) ? arr.map(idOf).join(',') : idOf(arr));
const optKeyCache = new WeakMap();

/** Seçeneklerin kısa anahtarı: küçük alanlar JSON, büyük kütüphaneler (toolbox) nesne kimliğiyle */
function optionsKey(o) {
  if (!o) return '';
  const cached = optKeyCache.get(o);
  if (cached) return cached;
  const small = {
    lidMode: o.lidMode, cornerAxis: o.cornerAxis, cornerSpec: o.cornerSpec,
    selectedHoles: o.selectedHoles ? [...o.selectedHoles].sort((a, b) => a - b) : null,
    portOverrides: o.portOverrides ? [...o.portOverrides.entries()] : null,
    sealing: o.sealing ? (o.sealing.id ?? idOf(o.sealing)) : null,
    screwSpec: o.screwSpec, insertSpec: o.insertSpec, panelParts: o.panelParts, fits: o.fits, tolerance: o.tolerance,
    lidRules: o.lidRules ? `${o.lidRules.id}#${idOf(o.lidRules)}` : null, lidTolerance: o.lidTolerance,
    mount: o.mount, edgeHold: o.edgeHold, encloseOverrides: o.encloseOverrides ? [...o.encloseOverrides.entries()] : null,
  };
  const tb = o.toolbox || {};
  const big = [idOf(o.fasteners), ...['types', 'inserts', 'washers', 'nuts', 'standoffs', 'panel', 'materials'].map((k) => listKey(tb[k])), idOf(tb.model)].join('|');
  const key = `${JSON.stringify(small)}|${big}`;
  optKeyCache.set(o, key);
  return key;
}

function cloneResult(r) {
  return { ...r, params: { ...r.params }, locks: [...r.locks], changes: r.changes.map((c) => ({ ...c })), rejected: r.rejected.map((c) => ({ ...c })), counts: { ...r.counts } };
}

/**
 * input = { userParams: { anahtar: değer } (yalnızca kullanıcının yazdıkları = kilitli), waivers: { bulguId: { reason, date } }, maxIter: 8 }
 * Dönüş (LoopResult) = { design, params, findings, changes: [{ iter, rule, title, key, from, to, text }],
 *   rejected: [{ iter, rule, key, from, to, why: 'no-gain'|'oscillation', introduced: [yeni hata/uyarı kuralları] }],
 *   status: 'ready'|'advisories'|'blocked', stop: 'converged'|'max-iter'|'oscillation'|'stalled'|'needs-user',
 *   iterations (inceleme turu: ilk inceleme + kabul edilen her düzeltme geçişi), evaluations (computeDesign çağrısı), counts, locks }
 */
export function runDesignLoop(analysis, rules, input = {}, options = {}) {
  const userParams = {};
  for (const [k, v] of Object.entries(input.userParams || {})) if (AUTO_KEYS.includes(k)) userParams[k] = v;
  const waivers = input.waivers || {};
  const maxIter = Number.isFinite(input.maxIter) ? input.maxIter : 8;
  const memoKey = `${rules.id}#${idOf(rules)}|${idOf(analysis)}|${JSON.stringify(userParams)}|${JSON.stringify(waivers)}|${maxIter}|${optionsKey(options)}`;
  const hit = memo.get(memoKey);
  if (hit) {
    memo.delete(memoKey);
    memo.set(memoKey, hit); // en son kullanılan sona
    return cloneResult(hit);
  }

  const locks = new Set(Object.keys(userParams));
  let params = { ...baseParams(analysis, rules), ...userParams };
  let cur = evaluate(analysis, rules, params, options, locks, waivers);
  let evaluations = 1;
  let iterations = 1;
  const changes = [];
  const rejected = [];
  const tabu = new Set();
  const seen = new Set([hashParams(params)]);
  let stop = null;

  for (let iter = 1; iter <= maxIter; iter++) {
    const cands = candidates(cur.findings, params, locks, tabu);
    if (!cands.length) break;
    const best = bestPerKey(cands);
    // Toplu geçiş: bağımlılık sırasıyla; aynı geçişte değişen bir anahtarın akış aşağısındakiler sonraki geçişe kalır
    const batch = [];
    const blocked = new Set();
    for (const k of ORDER) {
      const c = best.get(k);
      if (!c || blocked.has(k)) continue;
      batch.push(c);
      for (const d of DOWNSTREAM[k]) blocked.add(d);
    }
    const tryApply = (list) => {
      const next = { ...params };
      for (const c of list) next[c.key] = c.to;
      const h = hashParams(next);
      if (seen.has(h)) return { osc: true };
      evaluations++;
      return { ev: evaluate(analysis, rules, next, options, locks, waivers), h };
    };
    let accepted = null;
    let oscillated = false;
    // Reddedilen düzeltme: hangi yeni hata/uyarıyı doğurduğu kaydedilir (kural çatışmasını kullanıcıya göstermek için)
    const reject = (c, ev, why) => {
      const ids = new Set(cur.findings.map((fd) => fd.id));
      const introduced = ev ? [...new Set(ev.findings.filter((fd) => !fd.waived && (fd.level === 'error' || fd.level === 'warn') && !ids.has(fd.id)).map((fd) => fd.rule))] : [];
      rejected.push({ iter, rule: c.rule, key: c.key, from: c.from, to: c.to, why, introduced });
      tabu.add(c.tabuKey);
    };
    const tb = tryApply(batch);
    if (tb.osc) oscillated = true;
    else if (tb.ev.score < cur.score) accepted = { list: batch, ...tb };
    else if (batch.length === 1) reject(batch[0], tb.ev, 'no-gain');
    if (!accepted) {
      // Toplu geçiş puanı düşürmedi: en fazla 3 aday tek tek (önce hata, sonra öncelik)
      const singles = [...best.values()].sort(bySeverity).filter((c) => !(batch.length === 1 && c === batch[0])).slice(0, 3);
      for (const c of singles) {
        const t1 = tryApply([c]);
        if (t1.osc) { oscillated = true; reject(c, null, 'oscillation'); continue; }
        if (t1.ev.score < cur.score) { accepted = { list: [c], ...t1 }; break; }
        reject(c, t1.ev, 'no-gain');
      }
    }
    if (!accepted) {
      for (const c of batch) tabu.add(c.tabuKey);
      stop = oscillated ? 'oscillation' : 'stalled';
      break;
    }
    for (const c of accepted.list) {
      changes.push({ iter, rule: c.rule, title: RULES[c.rule]?.title || c.rule, key: c.key, from: c.from, to: c.to, level: c.finding.level, text: changeText(c) });
    }
    params = accepted.ev.params;
    cur = accepted.ev;
    seen.add(accepted.h);
    iterations++;
    if (iter === maxIter && candidates(cur.findings, params, locks, tabu).length) stop = 'max-iter';
  }

  if (!stop) {
    // Otomatik aday kalmadı: açık hata/uyarılarda kullanıcı düzeltmesi (sayısal olmayan, kilitli anahtar ya da yalnızca öneri) varsa
    const open = cur.findings.filter((fd) => !fd.waived && (fd.level === 'error' || fd.level === 'warn'));
    stop = open.some((fd) => fd.fix && !fd.fixAuto) ? 'needs-user' : 'converged';
  }

  // Otomatik düzeltilen kurallar: son bulgular işaretlenir; bulgu kaybolduysa düzeltme kaydı 'ok' bulgu olarak eklenir
  const findings = cur.findings.map((fd) => ({ ...fd }));
  const fixedRules = new Map();
  for (const ch of changes) fixedRules.set(ch.rule, ch);
  for (const [rule, ch] of fixedRules) {
    const same = findings.filter((fd) => fd.rule === rule);
    if (same.length) for (const fd of same) fd.autoFixed = true;
    else {
      const all = changes.filter((c) => c.rule === rule).map((c) => c.text.replace(/ \(.*\)\.$/, '')).join('; ');
      const rec = toFinding({ level: 'ok', rule, text: `Otomatik düzeltildi: ${all}.`, cat: RULES[rule]?.cat || 'genel', autoFixed: true });
      rec.autoFixed = true;
      findings.push(rec);
      void ch;
    }
  }
  const sum = summarize(findings);
  const result = {
    design: cur.design, params: { ...params }, findings, changes, rejected, status: sum.status, stop,
    iterations, evaluations, counts: sum.counts, locks: [...locks],
  };
  memo.set(memoKey, result);
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return cloneResult(result);
}
