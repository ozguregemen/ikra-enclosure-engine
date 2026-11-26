/*
 * Tasarım → inceleme → düzeltme → yeniden inceleme döngüsü (öner-ve-düzelt, propose-and-revise).
 *
 * 1) Üret: kural dosyası varsayılanları + kullanıcının yazdığı (kilitli) değerlerle computeDesign().
 * 2) İncele: kontroller katalog kurallarına bağlı bulgulara (Finding) çevrilir.
 * 3) Düzelt: güvenli düzeltmeler (sayısal, otomatik anahtar, kilitsiz, değeri yalnızca ARTIRAN, 0,05 mm'ye yukarı
 *    yuvarlanmış, BOUNDS üst sınırının altında) uygulanır. Toplu geçişte anahtar başına en fazla bir düzeltme (en büyük
 *    artış, eşitlikte kural önceliği); bağımlı parametreler aynı geçişte birlikte değiştirilmez (DOWNSTREAM: et kalınlığı
 *    değişirse diğerleri, üst boşluk değişirse PCB altı yükseklik sonraki geçişe kalır).
 * 4) Kabul: geçiş yalnızca puan (1e6·hata + 1e3·uyarı + otomatik düzeltmesi kalan bilgi sayısı) kesin olarak düşerse
 *    kabul edilir. Toplu geçiş düşürmezse adaylar tek tek denenir (önem, öncelik, parametre sırası, büyükten küçüğe hedef;
 *    aynı anahtarın başka kurallardan gelen küçük hedefleri de aday). Reddedilen (kural, anahtar, hedef) üçlüleri
 *    yasaklanır (tabu) ve döngü kalan adaylarla sürer.
 * 5) Bedavacı ayıklama: kabul edilen toplu geçişte kendi bulgusu iyileşmeyen ve çıkarıldığında puanı bozmayan
 *    üye geri alınır (tabu, 'no-effect').
 * Bitiş: converged (açık hata/uyarıda uygulanmamış düzeltme yok) | needs-user (açık hata/uyarının düzeltmesi
 *   kilitli, yalnızca öneri, sayısal değil, sınır üstü ya da daha önce reddedilmiş) | stalled (son geçişte tüm
 *   otomatik adaylar reddedildi ve açık bulgu kaldı) | oscillation | max-iter.
 * Rastgelelik ve saat yoktur: aynı girdi aynı sonucu verir. Döngü tasarım nesnesini değiştirmez; dönen sonuç
 * önbellekten derin kopyadır.
 *
 * Kaynaklar (araştırma notları): Gil & Melz propose-and-revise; ESLint çok geçişli düzeltme ve döngüsel düzeltme
 * tespiti; min-conflicts sözlük sıralı puan; tabu araması; veri akışı analizinde monoton, sınırlı adımlarla sabit noktaya yakınsama.
 */
import { computeDesign } from '../design.js';
import { RULES } from './catalog.js';
import { AUTO_PARAM_KEYS, findingsFromChecks, summarize, toFinding, cloneFinding } from './review.js';

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
/** Otomatik düzeltmenin aşamayacağı üst sınırlar (mm): bunun üstü kullanıcı kararıdır */
export const LOOP_BOUNDS = Object.freeze({ wall: 12, pcbClearance: 10, topClearance: 60, standoffHeight: 60, cornerRadius: 30 });
const BOUNDS = LOOP_BOUNDS;
const STEP = 0.05;
const MAX_SINGLES = 6; // reddedilen toplu geçişten sonra bir geçişte tek tek denenecek en fazla hesap
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
const tabuKeyOf = (rule, key, to) => `${rule}|${key}|${to}`;

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

/** Uygulanabilir otomatik düzeltme adayları (aynı anahtarın tüm kurallardan gelen hedefleri) */
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
    const tabuKey = tabuKeyOf(fd.rule, key, to);
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

const strCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Tek tek deneme sırası: önem, katalog önceliği, parametre sırası, büyük hedef önce, kural kimliği (tam belirlenimci) */
const bySeverity = (a, b) => a.rank - b.rank || a.priority - b.priority || ORDER.indexOf(a.key) - ORDER.indexOf(b.key) ||
  b.to - a.to || strCmp(String(a.rule), String(b.rule));

function changeText(c) {
  const title = RULES[c.rule]?.title || c.rule || '';
  return `${PARAM_LABEL[c.key] || c.key} ${f(c.from)} → ${f(c.to)} mm (${title}).`;
}

/** Adayın kendi bulgusu yeni değerlendirmede iyileşti mi: aynı kural + odak parçada bulgu yok ya da daha hafif seviyede */
function findingImproved(c, ev) {
  const fd = c.finding;
  const pid = fd.focus?.partId ?? null;
  const now = ev.findings.filter((x) => x.rule === fd.rule && (x.focus?.partId ?? null) === pid && !x.waived);
  if (!now.length) return true;
  const worst = Math.min(...now.map((x) => LEVEL_RANK[x.level] ?? 3));
  return worst > (LEVEL_RANK[fd.level] ?? 3);
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

/**
 * Tasarımın sığ kopyası: çağıranın üst düzey alanlara, geometry'ye ve checks'e yazdıkları
 * (ör. d.geometry.treat, d.treatReport) önbellekteki sonucu bozmaz. Tasarım salt okunur kabul edilir.
 */
function cloneDesign(d) {
  if (!d || typeof d !== 'object') return d;
  return {
    ...d,
    geometry: d.geometry && typeof d.geometry === 'object' ? { ...d.geometry } : d.geometry,
    checks: Array.isArray(d.checks) ? d.checks.map((c) => ({ ...c, fix: c.fix ? { ...c.fix } : c.fix })) : d.checks,
    params: d.params && typeof d.params === 'object' ? { ...d.params } : d.params,
  };
}

function cloneResult(r) {
  return {
    ...r,
    design: cloneDesign(r.design),
    params: { ...r.params },
    locks: [...r.locks],
    findings: r.findings.map(cloneFinding),
    changes: r.changes.map((c) => ({ ...c })),
    rejected: r.rejected.map((c) => ({ ...c, introduced: [...(c.introduced || [])] })),
    counts: { ...r.counts },
  };
}

/**
 * input = { userParams: { anahtar: değer } (yalnızca kullanıcının yazdıkları = kilitli), waivers: { bulguId: { reason, date } },
 *           maxIter: 8, compute?: (analysis, rules, params, options) => design (test için; varsayılan computeDesign) }
 * Dönüş (LoopResult) = { design, params, findings, changes: [{ iter, rule, title, key, from, to, level, text }],
 *   rejected: [{ iter, rule, key, from, to, why: 'no-gain'|'oscillation'|'no-effect', introduced: [yeni hata/uyarı kuralları] }],
 *   status: 'ready'|'advisories'|'blocked', stop: 'converged'|'max-iter'|'oscillation'|'stalled'|'needs-user',
 *   iterations (inceleme turu: ilk inceleme + kabul edilen her düzeltme geçişi), evaluations (computeDesign çağrısı), counts, locks }
 */
export function runDesignLoop(analysis, rules, input = {}, options = {}) {
  const compute = typeof input.compute === 'function' ? input.compute : computeDesign;
  const userParams = {};
  for (const [k, v] of Object.entries(input.userParams || {})) if (AUTO_KEYS.includes(k)) userParams[k] = v;
  const waivers = input.waivers || {};
  const maxIter = Number.isFinite(input.maxIter) ? input.maxIter : 8;
  const memoKey = `${rules.id}#${idOf(rules)}|${idOf(analysis)}|${idOf(compute)}|${JSON.stringify(userParams)}|${JSON.stringify(waivers)}|${maxIter}|${optionsKey(options)}`;
  const hit = memo.get(memoKey);
  if (hit) {
    memo.delete(memoKey);
    memo.set(memoKey, hit); // en son kullanılan sona
    return cloneResult(hit);
  }

  const locks = new Set(Object.keys(userParams));
  const evaluate = (prm) => {
    const design = compute(analysis, rules, prm, options);
    const findings = findingsFromChecks(design, { params: prm, locks, waivers });
    return { design, findings, score: scoreOf(findings), params: prm };
  };
  let params = { ...baseParams(analysis, rules), ...userParams };
  let cur = evaluate(params);
  let evaluations = 1;
  let iterations = 1;
  const changes = [];
  const rejected = [];
  const tabu = new Set();
  const seen = new Set([hashParams(params)]);
  let stop = null;
  let accepted = 0; // kabul edilen düzeltme geçişi
  let passes = 0; // denenen geçiş (kabul + ret)
  const maxPasses = 3 * maxIter;
  let lastFailed = null; // son geçiş reddedildiyse { osc }

  const tryApply = (list) => {
    const next = { ...params };
    for (const c of list) next[c.key] = c.to;
    const h = hashParams(next);
    if (seen.has(h)) return { osc: true };
    evaluations++;
    return { ev: evaluate(next), h };
  };

  for (;;) {
    const cands = candidates(cur.findings, params, locks, tabu);
    if (!cands.length) break;
    if (accepted >= maxIter || passes >= maxPasses) { stop = 'max-iter'; break; }
    passes++;
    const iter = accepted + 1;
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
    // Reddedilen düzeltme: hangi yeni hata/uyarıyı doğurduğu kaydedilir (kural çatışmasını kullanıcıya göstermek için)
    const reject = (c, ev, why) => {
      if (tabu.has(c.tabuKey)) return;
      const ids = new Set(cur.findings.map((fd) => fd.id));
      const introduced = ev ? [...new Set(ev.findings.filter((fd) => !fd.waived && (fd.level === 'error' || fd.level === 'warn') && !ids.has(fd.id)).map((fd) => fd.rule))] : [];
      rejected.push({ iter, rule: c.rule, key: c.key, from: c.from, to: c.to, why, introduced });
      tabu.add(c.tabuKey);
    };
    let acc = null;
    let osc = false;
    const tb = tryApply(batch);
    if (tb.osc) { osc = true; if (batch.length === 1) reject(batch[0], null, 'oscillation'); }
    else if (tb.ev.score < cur.score) acc = { list: batch, ...tb };
    else if (batch.length === 1) reject(batch[0], tb.ev, 'no-gain');
    if (!acc) {
      // Toplu geçiş puanı düşürmedi: tüm adaylar (aynı anahtarın küçük hedefleri dahil) tek tek, aynı (anahtar, hedef) bir kez hesaplanır
      const singles = [...cands].sort(bySeverity).filter((c) => !tabu.has(c.tabuKey));
      const byTarget = new Map();
      let n = 0;
      for (const c of singles) {
        const sig = `${c.key}|${c.to}`;
        let t1 = byTarget.get(sig);
        if (!t1) {
          if (n >= MAX_SINGLES) break;
          t1 = tryApply([c]);
          byTarget.set(sig, t1);
          if (!t1.osc) n++;
        }
        if (t1.osc) { osc = true; reject(c, null, 'oscillation'); continue; }
        if (t1.ev.score < cur.score) { acc = { list: [c], ...t1 }; break; }
        reject(c, t1.ev, 'no-gain');
      }
    }
    if (!acc) { lastFailed = { osc }; continue; }
    // Bedavacı ayıklama: kendi bulgusu iyileşmeyen üye çıkarıldığında puan bozulmuyorsa geri alınır
    if (acc.list.length > 1) {
      for (const c of [...acc.list].sort(bySeverity).reverse()) {
        if (acc.list.length <= 1) break;
        if (findingImproved(c, acc.ev)) continue;
        const without = acc.list.filter((x) => x !== c);
        const t = tryApply(without);
        if (!t.osc && t.ev.score <= acc.ev.score) {
          rejected.push({ iter, rule: c.rule, key: c.key, from: c.from, to: c.to, why: 'no-effect', introduced: [] });
          tabu.add(c.tabuKey);
          acc = { list: without, ...t };
        }
      }
    }
    for (const c of acc.list) {
      changes.push({ iter, rule: c.rule, title: RULES[c.rule]?.title || c.rule, key: c.key, from: c.from, to: c.to, level: c.finding.level, text: changeText(c) });
    }
    params = acc.ev.params;
    cur = acc.ev;
    seen.add(acc.h);
    iterations++;
    accepted++;
    lastFailed = null;
  }

  if (!stop) {
    // Otomatik aday kalmadı: açık hata/uyarıda uygulanmamış bir düzeltme (kilitli anahtar, yalnızca öneri, sayısal
    // olmayan, sınır üstü ya da reddedilmiş) varsa kullanıcı kararı; son geçiş reddedildiyse takıldı
    const open = cur.findings.filter((fd) => !fd.waived && (fd.level === 'error' || fd.level === 'warn'));
    const unapplied = open.filter((fd) => fd.fix);
    const isTabu = (fd) => AUTO_KEYS.includes(fd.fix.key) && typeof fd.fix.value === 'number' && tabu.has(tabuKeyOf(fd.rule, fd.fix.key, quant(fd.fix.value)));
    if (!unapplied.length) stop = 'converged';
    else if (lastFailed && unapplied.some(isTabu)) stop = lastFailed.osc ? 'oscillation' : 'stalled';
    else stop = 'needs-user';
  }

  // Otomatik düzeltilen kurallar: yalnızca artık geçen ('ok') bulgular işaretlenir; kuralın açık ya da geçen bulgusu
  // kalmadıysa düzeltme kaydı 'ok' bulgu olarak eklenir
  const findings = cur.findings.map(cloneFinding);
  const fixedRules = [...new Set(changes.map((c) => c.rule))];
  for (const rule of fixedRules) {
    const same = findings.filter((fd) => fd.rule === rule && !fd.waived);
    const passing = same.filter((fd) => fd.level === 'ok');
    const failing = same.filter((fd) => fd.level === 'error' || fd.level === 'warn');
    for (const fd of passing) fd.autoFixed = true;
    if (!passing.length && !failing.length) {
      const all = changes.filter((c) => c.rule === rule).map((c) => c.text.replace(/ \(.*\)\.$/, '')).join('; ');
      const rec = toFinding({ level: 'ok', rule, text: `Otomatik düzeltildi: ${all}.`, cat: RULES[rule]?.cat || 'genel', autoFixed: true });
      rec.autoFixed = true;
      findings.push(rec);
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
