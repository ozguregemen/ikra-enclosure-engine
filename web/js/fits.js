/*
 * Tolerans ve geçme modeli (malzeme + süreç).
 * Kural dosyasındaki "tolerance" bloğu:
 *   general     ± genel ölçü toleransı (küçük ölçüler, mm)
 *   per_100mm   her 100 mm boy için ek ± (FDM: çekme/kalibrasyon, CNC plastik: ısıl genleşme ve nem)
 *   hole_comp   FDM: dikey delikler küçük çıkar; modeldeki delik çapına eklenen telafi (CNC/enjeksiyon: 0)
 *   fits        çapsal (iki yan toplam) boşluk, mm — press: sıkı (negatif = sıkılık), normal: kayar, loose: bol
 * Kullanıcı kendi yazıcısı/atölyesi için bu değerleri ezebilir (options.tolerance).
 * Kural dosyasının lid_fit_clearance değeri (her yan, mm), malzeme varsayılanlarıyla normal kapak geçmesindeki en küçük dil
 * boşluğudur. Model boşluğuyla arasındaki fark malzeme payı olarak her düzeltmeye eklenir (lidGap); kullanıcı payı
 * options.tolerance.lid_min ile ezebilir (0 = pay yok).
 */

export const FIT_CLASSES = [
  { id: 'press', label: 'Sıkı', hint: 'çakma / sürtünmeyle tutar' },
  { id: 'normal', label: 'Normal', hint: 'elle takılır, boşluksuz' },
  { id: 'loose', label: 'Bol', hint: 'kolay takılır, boşluklu' },
];

// ISO 273 geçiş delikleri: ince / orta / kaba seri
export const ISO273 = {
  M2: [2.2, 2.4, 2.6], 'M2.5': [2.7, 2.9, 3.1], M3: [3.2, 3.4, 3.6], M4: [4.3, 4.5, 4.8], M5: [5.3, 5.5, 5.8], M6: [6.4, 6.6, 7.0],
};
const CLASS_INDEX = { press: 0, normal: 1, loose: 2 };
export const SCREW_HOLE_LABEL = { press: 'İnce (ISO 273 f)', normal: 'Orta (ISO 273 m)', loose: 'Kaba (ISO 273 c)' };

// Kural dosyasında tolerans bloğu yoksa süreç varsayılanı
const PROCESS_DEFAULT = {
  fdm: { general: 0.2, per_100mm: 0.3, hole_comp: 0.15, lid_extra: 0.1, fits: { press: -0.05, normal: 0.15, loose: 0.4 } },
  cnc: { general: 0.1, per_100mm: 0.1, hole_comp: 0, lid_extra: 0.02, fits: { press: -0.02, normal: 0.05, loose: 0.15 } },
  injection: { general: 0.15, per_100mm: 0.2, hole_comp: 0, lid_extra: 0.03, fits: { press: -0.05, normal: 0.1, loose: 0.25 } },
};

const r2 = (v) => Math.round(v * 100) / 100;

/** Etkin tolerans: kural dosyası (ya da süreç varsayılanı) + kullanıcı düzeltmesi */
export function toleranceOf(rules, override = null) {
  const base = rules.tolerance || PROCESS_DEFAULT[rules.process] || PROCESS_DEFAULT.cnc;
  const o = override || {};
  const pick = (k) => (Number.isFinite(o[k]) ? o[k] : base[k]);
  const fits = { ...base.fits };
  for (const k of ['press', 'normal', 'loose']) if (Number.isFinite(o[k])) fits[k] = o[k];
  return {
    general: pick('general'), per_100mm: pick('per_100mm'), hole_comp: pick('hole_comp'), fits,
    lid_extra: Number.isFinite(o.lid_extra) ? o.lid_extra : base.lid_extra ?? 0,
    // Kural dosyasındaki kapak dili boşluğu (lid_fit_clearance, her yan): malzeme varsayılanlarıyla normal geçmedeki en küçük boşluk.
    // lid_ref: bu değerin karşılaştırıldığı malzeme varsayılanları; kullanıcı düzeltmesinden bağımsızdır, böylece malzeme payı
    // (lidGap) sabit kalır ve her düzeltme boşluğu aynı yönde değiştirir
    lid_min: Number.isFinite(o.lid_min) ? o.lid_min : Number.isFinite(rules.lid_fit_clearance) ? rules.lid_fit_clearance : null,
    lid_ref: { normal: base.fits.normal, lid_extra: base.lid_extra ?? 0, per_100mm: base.per_100mm },
    overridden: Object.keys(o).some((k) => Number.isFinite(o[k])),
    source: base.source || '',
  };
}

/** Uzunluk L için toplam ± tolerans (genel + boy payı); computeDesign().tolerance.outerTol dış ölçü için verir */
export const tolAt = (tol, L) => r2(tol.general + (tol.per_100mm * L) / 100);

/**
 * Kapak dili ile gövde iç duvarı arasındaki boşluk (her yan). İki baskı/işlenmiş yüzeyin uzun dikdörtgen geçmesi:
 * sınıf boşluğunun yarısı + iki yüzeyin baskı/işleme sapması (lid_extra) + boy payı. Gövde ve kapak aynı malzemeden
 * olduğu için çekme aynı yöne gider; boy payı genel toleransın dörtte biri alınır (per_100mm · L / 400).
 * Kural dosyasında lid_fit_clearance varsa malzeme payı = max(0, lid_fit_clearance − malzeme varsayılanlarıyla normal
 * boşluk) normal ve bol geçmeye eklenir, sıkı geçmeye eklenmez. Varsayılanlarda normal geçme tam lid_fit_clearance, bol geçme
 * bu değer + (bol − normal) farkı kadar olur; kullanıcı bir değeri büyütürse boşluk büyür, küçültürse küçülür (tekdüze).
 */
export function lidGap(tol, cls, L) {
  const gapOf = (fitD, extra, per100) => fitD / 2 + (extra || 0) + ((per100 || 0) * L) / 400;
  let g = gapOf(tol.fits[cls] ?? tol.fits.normal, tol.lid_extra, tol.per_100mm);
  if (Number.isFinite(tol.lid_min) && cls !== 'press') {
    const ref = tol.lid_ref || { normal: tol.fits.normal, lid_extra: tol.lid_extra, per_100mm: tol.per_100mm };
    g += Math.max(0, tol.lid_min - gapOf(ref.normal, ref.lid_extra, ref.per_100mm));
  }
  return r2(Math.max(cls === 'press' ? -0.05 : 0.02, g));
}

/** Vida satırını geçme sınıfı ve delik telafisiyle düzelt (geçiş, kılavuz, ön delik) */
export function adjustScrewRow(row, tol, cls = 'normal') {
  const i = CLASS_INDEX[cls] ?? 1;
  const iso = ISO273[row.size];
  const clr = iso ? iso[i] : row.clearance + [-0.2, 0, 0.3][i];
  const c = tol.hole_comp || 0;
  return {
    ...row,
    clearance_nominal: iso ? iso[i] : row.clearance,
    clearance: r2(clr + c),
    tap_drill: row.tap_drill === null || row.tap_drill === undefined ? row.tap_drill : r2(row.tap_drill + c),
    selftap_pilot: row.selftap_pilot === null || row.selftap_pilot === undefined ? row.selftap_pilot : r2(row.selftap_pilot + c),
  };
}

/** Sıkı geçme deliği (ışık borusu, pim): çubuk Ø + sıkı boşluk + delik telafisi */
export const pressHole = (d, tol) => r2(d + tol.fits.press + (tol.hole_comp || 0));
/** Somun cebi anahtar ağzı: elle oturan (normal) geçme + telafi; en az +0,1 */
export const pocketAf = (s, tol) => r2(s + Math.max(0.1, tol.fits.normal + (tol.hole_comp || 0)));
/** Üretici kesim ölçüsündeki delik (panel elemanı, oyuk): yalnızca FDM telafisi */
export const compHole = (d, tol) => r2(d + (tol.hole_comp || 0));
