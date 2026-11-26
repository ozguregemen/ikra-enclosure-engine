/*
 * DFM geometri politikası: kenar işlemleri, kalıp çıkma açısı (draft), giriş pahları.
 *
 * treatmentFor(design, rules, lidRules) SAF bir fonksiyondur: yalnızca computeDesign() çıktısını ve kural
 * dosyalarını okur, cad-worker.js'in katı modele uygulayacağı ölçüleri (mm, °) döndürür. 0 = işlem yok.
 * Gövde rules.process'e, kapak lidRules.process'e (farklı malzemeli kapak), DIN klipsi rules.process'e göre işlenir.
 *
 * Parça yönleri (her kenar kararı buna dayanır):
 *   FDM-58  gövde tabanı tablada, kapak dış yüzü tablada, DIN klipsi üst yüzü tablada basılır.
 *   IM-38   enjeksiyonda ayırma çizgisi ağız kenarında, keskin kenarda; gövde +Z, kapak −Z yönünde kalıptan çıkar.
 *
 * Kullanıcıya giden metinlerde ve işlem raporunda yalnızca kural kataloğu kimlikleri (dfm/catalog.js, GEO-*, INJ-*)
 * kullanılır. Sabitlerin yanındaki FDM-xx / IM-xx / CNC-xx kimlikleri araştırma notlarındaki kaynak kurallarıdır
 * (yalnızca kod açıklaması). Kaynakta sayı olmayan değerler "tasarım tercihi" olarak işaretlidir.
 */

/*
 * Katalog kuralı ← araştırma kuralları (yalnız belge; kaynak başlık ve bağlantıları tek yerde, dfm/catalog.js'te):
 *   GEO-EDGE-BED       FDM-08/09/10/58        GEO-EDGE-BREAK     CNC-32/33/34/35
 *   GEO-FILLET-INNER   IM-07, IM-24, FDM-53/55/56, CNC-03
 *   GEO-FILLET-OUTER   IM-08, IM-38           GEO-LEADIN         FDM-47, IM-39
 *   GEO-HOLE-ENTRY     CNC-26, IM-28, IM-30, FDM-27
 *   GEO-BOSS           IM-21, IM-28, FDM-41   GEO-DOGBONE        CNC-03, CNC-09
 *   GEO-GROOVE         ENC-SEAL-02            GEO-CORNER-CONCAVE IM-07, CNC-03, FDM-12
 *   INJ-DRAFT          IM-10/11/12/16, IM-24, IM-38             INJ-SIDE-ACTION    IM-36
 */

/* ---------- Süreçten bağımsız sabitler ---------- */

// FDM-08/09/10: tablaya değen kenarlara 45° pah (radyüs değil). İlk katman taşması ≈ 0,2 mm (Ø0,4 nozul, Prusa);
// pah bacağı en az bu kadar olmalı. 0,5 mm tasarım seçimidir (kaynakta ölçü yok, düşük güven) — FDM-10 VERIFY.
const FDM_BED_CHAMFER = 0.5;
// FDM-47: birbirine geçen kenarlara giriş pahı (ağız iç kenarı, kapak dili ucu). Kaynakta ölçü yok: 0,3 mm ≈ 0,75 × nozul.
const FDM_LEAD_IN = 0.3;
// FDM-56 (Hubs): düz tabanlarda keskin iç köşe yerine radyüs (kaynak ölçü vermez); FDM-14 (Stratasys) yalnız
// R_dış = R_iç + t ilişkisini verir. Taban–duvar iç köşesi yukarı bakan oluk olduğu için desteksiz basılır.
// 0,5–1 mm aralığı TASARIM TERCİHİDİR; üst sınır cep köşe radyüsü − 0,05.
const FDM_FLOOR_FILLET_MIN = 0.5;
const FDM_FLOOR_FILLET_MAX = 1.0;
// FDM-41: ince direk/boss köklerine radyüs. Ölçü kaynakta yok: 0,5 mm tasarım tercihi.
const FDM_ROOT_FILLET = 0.5;
// FDM-12: dikey iç köşeler nozul çapı kadar yuvarlak basılır; en az nozul çapı ya da 0,5 mm.
const FDM_CONCAVE_MIN = 0.5;
// FDM-53/55 (Bayer/Covestro; Hubs): geçme dili kökü R ≥ 0,5·t, hiçbir zaman 0,38 mm'den küçük değil.
const SNAP_ROOT_FACTOR = 0.5;
const SNAP_ROOT_MIN = 0.38;

// CNC-32/33/35, CNC-34: belirtilmeyen dış kenarlar 0,13–0,51 mm kırılır; varsayılan 0,3×45° pah (ISO 13715 '−0,3').
const CNC_EDGE_BREAK = 0.3;
// CNC-03 (Xometry/Ensinger): iç dikey köşe ≈ 1,3 × takım yarıçapı (takım yarıçapına eşit köşe titreşim yapar).
const CNC_CORNER_FACTOR = 1.3;
// CNC-26 (NASA JSC-67701 §9.6a): kılavuz çekilecek her delik 80–120° havşalanır (kaynak çap vermez).
// Modelde 90°; üst çap = diş dış çapı + 0,2 mm TASARIM TERCİHİDİR.
const TAP_CSK_OVER_MAJOR = 0.2;

// IM-07 (DuPont/Ticona): iç köşe r_i = 0,5·t, gerilme taşıyan yerde ≥ 0,5 mm, hiçbir yerde < 0,13 mm.
const IM_INNER_R_FACTOR = 0.5;
const IM_INNER_R_MIN = 0.5;
// IM-28 (Avient): boss dış çıkma açısı 1°, kök radyüsü 0,25·t, üstte 45° giriş pahı (ölçü kaynakta yok: 0,3 mm).
const IM_BOSS_DRAFT = 1;
const IM_BOSS_ROOT_FACTOR = 0.25;
const IM_BOSS_TIP = 0.3;
// IM-24/IM-39 (Bonenberger; DuPont): kapak dili de çıkıntı gibi: kök radyüsü 0,25–0,5·T, çıkma açısı ≥ 2°, giriş pahı.
const IM_LIP_DRAFT = 2;
const IM_LIP_ROOT_FACTOR = 0.25;
// IM-30 (Böllhoff/EJOT DELTA PT): diş açan vida ön deliği girişinde Ø1,05·d boşaltma (kaynakta düz havşa/oyuk, derinlik yok).
// Modelde 90° havşa, üst çap 1,05·d: havşa biçimi TASARIM TERCİHİ (IM-28 45° giriş pahıyla birleştirilir).
const SELF_TAP_RELIEF = 1.05;
// IM-38: kozmetik kenar ayırma çizgisinden uzakta tutulur; kapak üst dış kenarı radyüslü (≤ 1 mm tasarım tercihi).
const IM_LID_TOP_FILLET_MAX = 1.0;
// Kulak kökü dış duvara bu kadar gömülür (cad-worker kulak geometrisi); alt dış kenar işlemi bunu aşamaz.
export const EAR_EMBED = 0.8;
const DEG = Math.PI / 180;
// Rakam yuvarlama: gereksiz küsurlar raporu kirletmesin
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * IM-11 (Protolabs) gerekli çıkma açısı tablosu: derinlik (mm) → [[et kalınlığı (mm), derece], ...].
 * Tabloda olmayan ince et / derin cep birleşimleri ve 50,8 mm'den derin cepler için IM-12: 3°.
 */
const PL_DRAFT = [
  [6.35, [[1.0, 0.5]]],
  [12.7, [[1.0, 1], [1.5, 0.5]]],
  [19.05, [[1.0, 2], [1.5, 1], [2.0, 0.5]]],
  [25.4, [[1.5, 2], [2.0, 1], [2.5, 0.5]]],
  [38.1, [[2.0, 2], [2.5, 1]]],
  [50.8, [[2.5, 2]]],
];
const IM_DEEP_DRAFT = 3; // IM-12: 50–101 mm derinlikte 3° (ya da ≥ 3 mm et)

/** Protolabs tablosundan gereken açı (derece) */
export function protolabsDraft(depth, wall) {
  const row = PL_DRAFT.find(([d]) => depth <= d + 1e-9);
  if (!row) return IM_DEEP_DRAFT;
  const fits = row[1].filter(([t]) => wall >= t - 1e-9);
  return fits.length ? fits[fits.length - 1][1] : IM_DEEP_DRAFT;
}

/**
 * Enjeksiyon çıkma açısı — inceleme (design.js INJ-DRAFT) ve katı model (cad-worker) için TEK kaynak.
 * max(kural en azı, Protolabs derinlik×et tablosu, 25,4 mm derinlik başına ~1° (Protolabs), 1° varsayılan — ABS/PC/PC-ABS, IM-10);
 * 50,8 mm'den derin ceplerde 3° (IM-12). 0,5°'ye yukarı yuvarlanır.
 * @param depth dış duvarın kalıp derinliği (ağız – taban altı), mm
 * @param wall et kalınlığı, mm
 */
export function injectionDraft(depth, wall, ruleMin) {
  const perInch = depth > 50.8 + 1e-9 ? IM_DEEP_DRAFT : Math.ceil((depth / 25.4) * 2 - 1e-9) / 2;
  const v = Math.max(ruleMin || 0, protolabsDraft(depth, wall), perInch, 1);
  return Math.ceil(v * 2 - 1e-9) / 2;
}

/** Vida boyutu adından diş dış çapı: 'M3' → 3, 'M2.5' → 2,5, 'ST2.9' → 2,9 */
export function majorDiameter(size) {
  const m = /([0-9]+(?:[.,][0-9]+)?)/.exec(String(size || ''));
  return m ? Number(m[1].replace(',', '.')) : null;
}

/**
 * Enjeksiyon kapağında vida borusu çıkma açısı: boru kapak plakasının altından tubeLen kadar iner, kalıp derinliği
 * lidT + tubeLen'dir (design.js kapak INJ-DRAFT limits.tube ile aynı formül, tek kaynak). En az IM-28 boss açısı (1°).
 */
export function lidTubeDraft(lidT, tubeLen, ruleMin) {
  return Math.max(IM_BOSS_DRAFT, injectionDraft(lidT + Math.max(0, tubeLen || 0), lidT, ruleMin));
}

/** Standart parmak freze çapları (mm): takım önerileri bunlardan birine aşağı yuvarlanır */
export const STD_CUTTERS = [1, 1.5, 2, 2.5, 3, 4, 5, 6];
/** d mm'yi aşmayan en büyük standart freze çapı (yoksa null) */
export const stdCutterAtMost = (d) => [...STD_CUTTERS].reverse().find((c) => c <= d + 1e-9) ?? null;

/*
 * Cep derinliği / freze çapı hata sınırı (CNC-POCKET-DEPTH). CNC-06 (Hubs; Fictiv DFM Feedback Glossary): parmak freze
 * tipik olarak 3–4 × D keser (kural dosyası max_depth_ratio, uyarı), uzatılmış takımla en fazla 10 × D; üstü işlenemez (hata).
 * CNC-05 (Protolabs, Mastering complex features): pratikteki en küçük parmak freze Ø1 mm, bu frezeyle en fazla 9,52 mm derinlik.
 */
export const CNC_DEPTH_RATIO_MAX = 10;
export const CNC_SMALL_TOOL = 1;
export const CNC_SMALL_TOOL_DEPTH = 9.52;
/** depth mm derinlik toolD çaplı frezeyle işlenebilir mi (hata sınırı; uyarı sınırı kural dosyasında) */
export function cncDepthMachinable(depth, toolD) {
  if (!(toolD > 0) || !(depth >= 0)) return false;
  if (depth / toolD > CNC_DEPTH_RATIO_MAX + 1e-9) return false;
  if (toolD <= CNC_SMALL_TOOL + 1e-9 && depth > CNC_SMALL_TOOL_DEPTH + 1e-9) return false;
  return true;
}
/** depth derinliği işleyebilen (hata sınırını aşmayan) en küçük standart freze (yoksa null) */
export const stdCutterForDepth = (depth) => STD_CUTTERS.find((c) => cncDepthMachinable(depth, c)) ?? null;
/** Kullanıcı freze çapı seçeneğinin geçerli aralığı (mm) */
const TOOL_MIN = 0.5;
const TOOL_MAX = 20;
/**
 * CNC'de geçerli parmak freze çapı (mm): kullanıcı seçimi (options.toolDiameter, geçerli sayıysa) ya da kural dosyasının
 * process_params.tool_diameter değeri. CNC dışı süreçlerde null. design.js, treat.js ve cad-worker aynı değeri kullanır.
 */
export function cncToolDiameter(rules, toolDiameter = null) {
  if (rules?.process !== 'cnc') return null;
  return validToolDiameter(toolDiameter) ?? (rules.process_params?.tool_diameter || 3);
}
/** Kullanıcı freze çapı geçerliyse sayı (mm), değilse (boş, null, aralık dışı) null */
export function validToolDiameter(v) {
  const n = v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= TOOL_MIN - 1e-9 && n <= TOOL_MAX + 1e-9 ? n : null;
}

/** Cep/boss köşe yuvarlatma için: cep köşe radyüsünü geçmeyen (torus bozulmasın) radyüs */
const capBelow = (v, limit) => Math.max(0, Math.min(v, limit - 0.05));
const numTr = (v) => String(r2(v)).replace('.', ',');
const ceil005 = (v) => Math.round(Math.ceil(v / 0.05 - 1e-6) * 0.05 * 100) / 100;

/**
 * CNC iç köşe radyüsü sınırları (design.js CNC-CORNER-TOOL ve parametre ipucu için tek kaynak).
 * rMin: frezenin açabildiği en küçük radyüs = takım yarıçapı + kural dosyasının payı (CNC kural dosyalarında
 * corner_radius_min = Ø3 yarıçapı 1,5 + 0,1 mm); altı hata. rNeed: 1,3 × takım yarıçapı (CNC-03), 0,05 mm'ye yukarı
 * yuvarlı, hiçbir zaman rMin'den küçük değil; altı uyarı. Kullanıcı freze seçmediyse kural dosyasının corner_radius_min
 * değeri taban olarak kalır (kural dosyası o frezeye göre yazılmıştır); seçtiyse sınır seçilen frezeden türetilir.
 */
export function cncCornerLimits(rules, toolDiameter = null) {
  const tool = cncToolDiameter(rules, toolDiameter) || rules?.process_params?.tool_diameter || 3;
  const ruleTool = Number(rules?.process_params?.tool_diameter) || 3;
  const crm = Number(rules?.corner_radius_min) || 0;
  const pad = Math.max(0, r2(crm - ruleTool / 2));
  const user = validToolDiameter(toolDiameter) !== null;
  const rTool = tool / 2;
  const rMin = r2(user ? rTool + pad : Math.max(crm, rTool));
  const rNeed = Math.max(rMin, ceil005(CNC_CORNER_FACTOR * rTool));
  return { tool, rTool, rMin, rNeed, pad, user };
}

/** CNC'de yan duvar açıklığı (port penceresi/çentiği) köşe radyüsü: 1,3 × takım yarıçapı (CNC-03), 0,05 mm'ye yukarı yuvarlı */
export const cncCutoutR = (toolD) => ceil005(CNC_CORNER_FACTOR * (toolD || 3) / 2);

/**
 * Dikey iç köşelerde (köşe boss'u–duvar, kart desteği–duvar, kulak–duvar) istenen en küçük plan radyüsü:
 * FDM nozul çapı / 0,5 mm (FDM-12), enjeksiyon r_i = 0,5·t ≥ 0,5 mm (IM-07), CNC 1,3 × takım yarıçapı (CNC-03).
 * design.js (kapak dili ucu konumu) ve cad-worker aynı değeri kullansın diye dışa açıktır.
 * toolD: CNC'de geçerli freze çapı (cncToolDiameter); verilmezse kural dosyasındaki çap.
 */
export function concaveMinR(rules, wall, toolD = null) {
  const pp = rules?.process_params || {};
  if (rules?.process === 'fdm') return Math.max(FDM_CONCAVE_MIN, pp.nozzle_diameter || 0.4);
  if (rules?.process === 'injection') return Math.max(IM_INNER_R_FACTOR * wall, IM_INNER_R_MIN);
  if (rules?.process === 'cnc') return r2(CNC_CORNER_FACTOR * (cncToolDiameter(rules, toolD) || 3) / 2);
  return 0;
}

/*
 * Altıgen somun cebi köşe boşaltması (CNC, GEO-DOGBONE): her köşedeki boşaltma dairesi kenardan 2/√3·r yer,
 * altıgen kenarı s/√3 → komşu boşaltmalar çakışmasın diye r < s/4 (0,02 mm pay). cad-worker (modellenen r) ve
 * tasarım denetimi (en büyük takım çapı) aynı sınırı kullansın diye dışa açıktır.
 */
const NUT_RELIEF_GAP = 0.02;
/**
 * Modellenen en küçük köşe boşaltması yarıçapı (mm): daha küçük boşaltma dairesi katı modelde güvenle kurulamaz. Takım
 * yarıçapından büyük boşaltma dairesi aynı frezeyle işlenebildiği için küçük frezelerde boşaltma bu ölçüyle modellenir.
 */
export const NUT_RELIEF_MIN = 0.3;
/** Modellenen köşe boşaltması yarıçapı: takım yarıçapı, cebe sığmıyorsa s/4 − 0,02 (mm) */
export function nutDogboneR(s, toolR) {
  return Math.round(Math.min(toolR, s / 4 - NUT_RELIEF_GAP) * 1000) / 1000;
}
/** SW s cebinin köşelerini boşaltabilecek en büyük freze çapı (0,05 mm'ye aşağı yuvarlı) */
export function nutMaxTool(s) {
  return Math.floor(2 * (s / 4 - NUT_RELIEF_GAP) * 20 + 1e-9) / 20;
}

/**
 * Dönel boss / boru kök geometrisi (cad-worker bossSolid profili ve kök izi hesabı için tek kaynak).
 * Kök radyüsü taban düzlemine teğet olmadan 10° önce biter (boolean enine kesişsin). Yerel (r, dz) koordinatları.
 * Dönüş: { ta, rRoot, rf, T1, E, M } — E[0] kökün düzlemdeki izinin yarıçapıdır (rf yoksa rRoot).
 */
export function bossRoot({ h, rTip, draftDeg = 0, rootR = 0 }) {
  const ta = Math.tan((draftDeg || 0) * DEG);
  const al = Math.atan(ta);
  const rRoot = rTip + h * ta;
  const rf = Math.min(rootR, 0.45 * h);
  if (!(rf > 0.02)) return { ta, rRoot, rf: 0, T1: null, E: [rRoot, 0], M: null };
  const sa = Math.sin(al);
  const ca = Math.cos(al);
  const t = (rf * (1 - sa)) / ca;
  const T1 = [rRoot - t * sa, t * ca];
  const F = [T1[0] + rf * ca, T1[1] + rf * sa];
  const d = 10 * DEG;
  const E = [F[0] - rf * Math.sin(d), F[1] - rf * Math.cos(d)];
  const am = (Math.PI + al + 1.5 * Math.PI - d) / 2;
  const M = [F[0] + rf * Math.cos(am), F[1] + rf * Math.sin(am)];
  return { ta, rRoot, rf, T1, E, M };
}

/**
 * Gövde alt dış kenarı işlemi (FDM tabla pahı / CNC çapak kırma / enjeksiyon r_o): istenen ve uygulanabilir ölçü.
 * Taban kalınlığı (pah ≤ 0,45·taban; radyüs ≤ 1,45·taban ya da iç radyüsle aynı merkezli r_i + taban — et
 * köşede de üniform kaldığı için) ve kulak kökü gömmesi (EAR_EMBED − 0,1) sınırlar.
 * Dönüş: { kind, key, feature, rule, want, size, note } ya da null
 */
export function bottomEdge(P, floor, hasEars) {
  const b = P.bedChamfer > 0 ? { kind: 'chamfer', want: P.bedChamfer, key: 'bed', feature: 'dış alt kenar (tabla pahı)', rule: 'GEO-EDGE-BED' }
    : P.outerEdgeBreak > 0 ? { kind: 'chamfer', want: P.outerEdgeBreak, key: 'outer.bottom', feature: 'dış alt kenar (çapak kırma)', rule: 'GEO-EDGE-BREAK' }
      : P.outerBottomFillet > 0 ? { kind: 'fillet', want: P.outerBottomFillet, key: 'outer.bottom', feature: 'dış alt kenar radyüsü (r_o = r_i + t)', rule: 'GEO-FILLET-OUTER' } : null;
  if (!b) return null;
  let size = b.want;
  let note = '';
  if (hasEars && size > EAR_EMBED - 0.1) { size = EAR_EMBED - 0.1; note = `kulak kökü duvara ${numTr(EAR_EMBED)} mm gömülü olduğundan ${numTr(size)} mm ile sınırlandı`; }
  const cap = b.kind === 'fillet' ? Math.max(1.45 * floor, (P.floorFillet || 0) + floor) : 0.45 * floor;
  if (size > cap) { size = cap; note = `taban kalınlığı ${numTr(floor)} mm olduğundan ${numTr(size)} mm ile sınırlandı`; }
  return { ...b, size: Math.floor(size * 1000 + 1e-9) / 1000, note }; // aşağı yuvarlanır: sınır aşılmasın
}

function partPolicy(process, rules, ctx) {
  const { wall, floor, rIn, rOut, lidT, depth } = ctx;
  // CNC: tasarımın geçerli freze çapı (kullanıcı seçimi ya da kural dosyası; geometry.toolDiameter)
  const tool = (process === 'cnc' ? cncToolDiameter(rules, ctx.toolD) : null) || rules.process_params?.tool_diameter || 3;
  const P = {
    process,
    pull: null, // kalıptan çıkma yönü (yalnız enjeksiyon)
    draftDeg: 0,
    bossDraftDeg: 0,
    bedChamfer: 0,
    outerBottomFillet: 0,
    outerEdgeBreak: 0,
    outerTopFillet: 0,
    rimLeadIn: 0,
    rimOuterBreak: 0,
    floorFillet: 0,
    lipTipChamfer: 0,
    lipRootFillet: 0,
    lipDraftDeg: 0,
    bossRootFillet: 0,
    bossTipChamfer: 0,
    tubeRootFillet: 0,
    holeEntry: { insert: 0, tapped: 0, selfTap: 0, clearance: 0 },
    concaveMinR: 0,
    nutDogbone: 0,
    // Enjeksiyon: kart kenarı desteği (gövde) ve kart baskı dili (kapak) çekme yönüne paralel yüzlerinin açısı, °
    padDraftDeg: 0,
    presserDraftDeg: 0,
    cutoutBreak: 0,
    grooveBottomR: 0,
    grooveEdgeBreak: 0,
    latchRootR: 0,
    // Geometri yüzünden istenen değere ulaşılamayan işlemler: { key, feature, kind, want, got, rule, note }.
    // cad-worker aynı anahtarlı işlem satırını istenen (want) ve uygulanan ölçüyle "sınırlı" olarak yazar.
    limited: [],
    // Politika alanı → katalog kuralı (dfm/catalog.js, işlem raporundaki rule alanıyla aynı)
    src: {},
  };
  // %10'a kadar eksik (köşe torusu için bırakılan 0,05 mm pay) sınırlama sayılmaz
  const limitFloor = (want, got, what) => {
    if (got < 0.9 * want - 1e-6) {
      P.limited.push({ key: 'floor', feature: 'taban–duvar iç köşesi', kind: 'fillet', want: r2(want), got: r2(got), rule: 'GEO-FILLET-INNER',
        note: `cep köşe radyüsü R${numTr(rIn)} olduğundan ${got > 0 ? `R${numTr(got)} ile sınırlandı` : 'uygulanamadı'}; ${what} için cep köşe radyüsü en az R${numTr(want + 0.05)} olmalı` });
    }
  };
  if (process === 'fdm') {
    P.bedChamfer = FDM_BED_CHAMFER;
    P.rimLeadIn = Math.min(FDM_LEAD_IN, wall / 4);
    P.lipTipChamfer = FDM_LEAD_IN;
    P.lipRootFillet = FDM_ROOT_FILLET;
    const ff = capBelow(FDM_FLOOR_FILLET_MAX, rIn);
    P.floorFillet = ff >= 0.2 ? r2(ff) : 0;
    limitFloor(FDM_FLOOR_FILLET_MIN, P.floorFillet, `taban–duvar iç köşesi radyüsü (tasarım tercihi ${numTr(FDM_FLOOR_FILLET_MIN)}–${numTr(FDM_FLOOR_FILLET_MAX)} mm)`);
    P.bossRootFillet = FDM_ROOT_FILLET;
    P.tubeRootFillet = FDM_ROOT_FILLET;
    // FDM-27: ısıl insert deliği düz, girişte pah yok. Kılavuz: CNC-26 (diş açılacak her delik havşalanır).
    P.holeEntry = { insert: 0, tapped: TAP_CSK_OVER_MAJOR, selfTap: 0, clearance: 0 };
    P.concaveMinR = concaveMinR(rules, wall);
    P.src = {
      bedChamfer: 'GEO-EDGE-BED', rimLeadIn: 'GEO-LEADIN', lipTipChamfer: 'GEO-LEADIN', floorFillet: 'GEO-FILLET-INNER', lipRootFillet: 'GEO-FILLET-INNER',
      bossRootFillet: 'GEO-BOSS', tubeRootFillet: 'GEO-BOSS', holeEntry: 'GEO-HOLE-ENTRY', concaveMinR: 'GEO-CORNER-CONCAVE', latchRootR: 'GEO-FILLET-INNER',
    };
  } else if (process === 'injection') {
    P.pull = [0, 0, 1];
    P.draftDeg = injectionDraft(depth, wall, rules.draft_angle_min);
    P.bossDraftDeg = Math.max(IM_BOSS_DRAFT, rules.draft_angle_min || 0);
    P.padDraftDeg = P.draftDeg; // kart desteği açılı cep duvarına bağlı: cep ile aynı açı (gövde INJ-DRAFT sınırı)
    const riWant = Math.max(IM_INNER_R_FACTOR * wall, IM_INNER_R_MIN);
    const ri = capBelow(riWant, rIn);
    P.floorFillet = ri >= 0.13 ? r2(ri) : 0;
    limitFloor(riWant, P.floorFillet, 'iç köşe radyüsü r_i = 0,5·t (en az 0,5 mm)');
    // IM-08: dış radyüs = iç radyüs + et (aynı merkezden; et köşede de üniform)
    P.outerBottomFillet = r2(capBelow(P.floorFillet + floor, rOut));
    P.rimLeadIn = Math.min(0.3, wall / 4); // ağız iç kenarı maça tarafında kalır; giriş pahı kalıplanabilir (IM-39)
    P.rimOuterBreak = 0; // IM-38: ayırma çizgisi keskin kenarda
    P.lipTipChamfer = 0.3;
    P.lipRootFillet = r2(IM_LIP_ROOT_FACTOR * lidT);
    P.lipDraftDeg = Math.max(IM_LIP_DRAFT, rules.draft_angle_min || 0);
    P.bossRootFillet = r2(Math.max(IM_BOSS_ROOT_FACTOR * wall, 0.13)); // IM-21: kök radyüsü hiçbir yerde < 0,13 mm
    P.bossTipChamfer = IM_BOSS_TIP;
    P.tubeRootFillet = r2(Math.max(IM_BOSS_ROOT_FACTOR * lidT, 0.13));
    P.outerTopFillet = r2(Math.max(0, Math.min(IM_LID_TOP_FILLET_MAX, lidT - 0.5)));
    P.holeEntry = { insert: 0, tapped: TAP_CSK_OVER_MAJOR, selfTap: SELF_TAP_RELIEF, clearance: 0 };
    P.concaveMinR = concaveMinR(rules, wall);
    P.src = {
      draftDeg: 'INJ-DRAFT', floorFillet: 'GEO-FILLET-INNER', outerBottomFillet: 'GEO-FILLET-OUTER', rimOuterBreak: 'INJ-DRAFT',
      rimLeadIn: 'GEO-LEADIN', lipTipChamfer: 'GEO-LEADIN', lipRootFillet: 'GEO-FILLET-INNER', lipDraftDeg: 'INJ-DRAFT',
      bossRootFillet: 'GEO-BOSS', bossTipChamfer: 'GEO-BOSS', bossDraftDeg: 'GEO-BOSS', tubeRootFillet: 'GEO-BOSS', outerTopFillet: 'GEO-FILLET-OUTER',
      holeEntry: 'GEO-HOLE-ENTRY', concaveMinR: 'GEO-CORNER-CONCAVE', latchRootR: 'GEO-FILLET-INNER',
    };
  } else if (process === 'cnc') {
    P.outerEdgeBreak = CNC_EDGE_BREAK;
    P.rimOuterBreak = CNC_EDGE_BREAK;
    P.rimLeadIn = Math.min(CNC_EDGE_BREAK, wall / 4);
    P.lipTipChamfer = CNC_EDGE_BREAK;
    P.bossTipChamfer = CNC_EDGE_BREAK;
    P.floorFillet = 0; // CNC-09: düz parmak freze; taban radyüsü gerekmedikçe kullanılmaz
    P.holeEntry = { insert: CNC_EDGE_BREAK, tapped: TAP_CSK_OVER_MAJOR, selfTap: SELF_TAP_RELIEF, clearance: CNC_EDGE_BREAK };
    P.concaveMinR = concaveMinR(rules, wall, tool);
    P.toolD = tool;
    // Köşe boşaltması takım yarıçapıyla; çok küçük frezede modelleme en azı (NUT_RELIEF_MIN) — büyük daire de aynı frezeyle işlenir
    P.nutDogbone = r2(Math.max(tool / 2, NUT_RELIEF_MIN));
    P.cutoutBreak = CNC_EDGE_BREAK;
    P.src = {
      outerEdgeBreak: 'GEO-EDGE-BREAK', rimOuterBreak: 'GEO-EDGE-BREAK', rimLeadIn: 'GEO-LEADIN', lipTipChamfer: 'GEO-LEADIN', bossTipChamfer: 'GEO-BOSS',
      cutoutBreak: 'GEO-EDGE-BREAK', holeEntry: 'GEO-HOLE-ENTRY', concaveMinR: 'GEO-CORNER-CONCAVE', nutDogbone: 'GEO-DOGBONE', latchRootR: 'GEO-FILLET-INNER',
    };
  }
  return P;
}

/** Contanın oluk dibi radyüsü (Parker Chart 4-3, ENC-SEAL-02): W1,78–2,62 → 0,13–0,38; W3,53 → 0,25–0,64; W5,33+ → 0,51–0,89 */
function grooveRadius(cord) {
  if (!(cord > 0)) return 0.2;
  if (cord < 3) return 0.2;
  if (cord < 5) return 0.4;
  return 0.6;
}

/** Bir deliğin giriş işlemi: { dTop } havşa (90°) üst çapı ya da null */
function holeEntryFor(method, d, holeD, he, hasCountersink) {
  if (hasCountersink || !(holeD > 0)) return null;
  let dTop = 0;
  if (method === 'insert') dTop = he.insert > 0 ? holeD + 2 * he.insert : 0;
  else if (method === 'tapped' || method === 'helicoil') dTop = he.tapped > 0 && d ? d + he.tapped : 0;
  else if (method === 'self_tap') dTop = he.selfTap > 0 && d ? he.selfTap * d : 0;
  else dTop = he.clearance > 0 ? holeD + 2 * he.clearance : 0; // geçiş (somun cebi, hazır aralayıcı, kapak, kulak)
  if (!(dTop > holeD + 0.1)) return null;
  return { dTop: r2(dTop), depth: r2((dTop - holeD) / 2) };
}

/**
 * design: computeDesign() çıktısı (ok olmalı), rules: gövde kuralları, lidRules: kapak kuralları (yoksa gövde).
 * Dönüş: { version: 2, base, lid, clip, rim, pocketGrow, lipFit, holes, growth, rules } — her parça için PartTreat
 * (yukarıdaki alanlar; 0 = yok). growth: işlemlerin anma ölçüsüne göre büyüttüğü izler (tasarım çakışma denetimi için).
 */
export function treatmentFor(design, rules, lidRules = rules) {
  const g = design?.geometry;
  if (!g || !rules) return null;
  const lr = lidRules || rules;
  const p = design.params || {};
  const wall = p.wall ?? g.outer.r - g.cavity.r;
  const floor = p.floor ?? g.floor;
  const lidT = p.lidT ?? g.lidT;
  const rIn = g.cavity.r;
  const rOut = g.outer.r;
  const depthBase = g.cavTop - g.z0; // dış duvarın kalıp derinliği
  // CNC freze çapı: tasarımın geçerli değeri (geometry.toolDiameter / lidToolDiameter; eski tasarımda kural dosyası)
  const toolOf = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const ctxB = { wall, floor, rIn, rOut, lidT, depth: depthBase, toolD: toolOf(g.toolDiameter) };
  const base = partPolicy(rules.process, rules, ctxB);
  // Kapak: plaka yan yüzü + dil + boru boyu en derin özelliktir
  const tubeH = Math.max(0, ...(g.lidTubes || []).map((t) => Math.abs(t.z1 - t.z0)));
  const tubeLen = Math.max(tubeH, ...(g.lipBars || []).map((b) => b.max[2] - b.min[2]));
  const lid = partPolicy(lr.process, lr, { ...ctxB, wall: lidT, depth: lidT + tubeLen, toolD: toolOf(g.lidToolDiameter) ?? (lr.process === rules.process && lr.id === rules.id ? ctxB.toolD : null) });
  if (lid.process === 'injection') {
    lid.pull = [0, 0, -1];
    lid.draftDeg = Math.max(lr.draft_angle_min || 0, 1); // plaka yan yüzü yalnız kapak kalınlığı kadar: 1° (IM-10)
    // Vida boruları plakadan boru boyu kadar aşağı iner: kalıp derinliği lidT + boru boyu (design.js kapak INJ-DRAFT
    // limits.tube ile aynı formül; katı model sonrası kapak INJ-DRAFT bu sınırla doğrulanır)
    if (tubeH > 0) lid.bossDraftDeg = lidTubeDraft(lidT, tubeH, lr.draft_angle_min);
    // Kart baskı dilleri plakadan kartın üstüne iner: boru gibi kendi boyuyla (design.js kapak INJ-DRAFT limits.presser)
    const presserH = Math.max(0, ...(g.edgePressers || []).map((q) => g.cavTop - q.min[2]));
    if (presserH > 0) lid.presserDraftDeg = lidTubeDraft(lidT, presserH, lr.draft_angle_min);
  }
  // Gövdeye özgü olmayan alanlar kapakta kullanılmaz (ve tersi): rapor sade kalsın
  base.lipTipChamfer = 0; base.lipRootFillet = 0; base.lipDraftDeg = 0; base.tubeRootFillet = 0; base.outerTopFillet = 0; base.presserDraftDeg = 0;
  lid.rimLeadIn = 0; lid.floorFillet = 0; lid.outerBottomFillet = 0; lid.rimOuterBreak = 0; lid.nutDogbone = 0; lid.cutoutBreak = 0; lid.padDraftDeg = 0;
  lid.limited = [];
  if (lid.process === 'fdm') lid.bossRootFillet = 0; // kapakta boss yok; boru kökü tubeRootFillet

  // IP conta kanalı (ENC-SEAL-02): dip radyüsü kordon kesitine göre, kenarlar ≈ 0,13 mm kırılır.
  // FDM'de 0,13 mm nozul çözünürlüğünün altında kalır (FDM-01): yalnız dip radyüsü modellenir.
  if (g.groove) {
    const cord = design.sealing?.cord_d;
    base.grooveBottomR = Math.min(grooveRadius(cord), g.groove.width / 2 - 0.05, g.groove.depth / 2);
    base.grooveEdgeBreak = base.process === 'fdm' ? 0 : 0.13;
    base.src.grooveBottomR = 'GEO-GROOVE';
    base.src.grooveEdgeBreak = 'GEO-GROOVE';
  }

  // Ağız seviyesinde gövde dış hattı: kapak dış hattı buna eşit olmalı (enjeksiyonda dış duvar yukarı doğru büyür)
  const tb = Math.tan((base.draftDeg * Math.PI) / 180);
  const grow = depthBase * tb;
  const rim = { L: r2(g.outer.L + 2 * grow), W: r2(g.outer.W + 2 * grow), r: r2(g.outer.r + grow), grow: Math.round(grow * 1000) / 1000 };
  // Cep, taban seviyesinde anma ölçüsünde; ağızda (cavTop) bu kadar büyür. Kapak dili bu kadar dışa kaydırılır.
  const pocketGrow = Math.round((g.cavTop - (g.z0 + floor)) * tb * 1000) / 1000;

  // DIN klipsi: ayrı parça, gövde süreciyle
  let clip = null;
  if (g.din) {
    clip = partPolicy(rules.process, rules, { ...ctxB, depth: 10 });
    clip.pull = null;
    clip.draftDeg = 0; clip.bossDraftDeg = 0; clip.padDraftDeg = 0; clip.presserDraftDeg = 0; // klips enjeksiyonda zaten yan maça ister (mount.js uyarısı): açı uygulanmaz
    clip.floorFillet = 0; clip.rimLeadIn = 0; clip.rimOuterBreak = 0; clip.outerBottomFillet = 0; clip.lipTipChamfer = 0;
    clip.lipRootFillet = 0; clip.lipDraftDeg = 0; clip.tubeRootFillet = 0; clip.outerTopFillet = 0; clip.cutoutBreak = 0;
    clip.limited = [];
    clip.latchRootR = r2(Math.max(SNAP_ROOT_FACTOR * (g.din.t || 2), SNAP_ROOT_MIN));
    if (clip.process === 'injection') { clip.bossRootFillet = Math.max(clip.bossRootFillet, 0.3); clip.bossTipChamfer = 0.3; }
  }

  // Delik giriş işlemleri (delik sırası geometry dizileriyle aynı)
  const method = design.fasteningMethod;
  const holes = {
    standoffs: (design.standoffs || []).map((s, i) => {
      const gs = g.standoffs?.[i] || s;
      const m = method === 'nut' || method === 'standoff' ? 'clearance' : method;
      return { method: m, d: majorDiameter(s.screw), entry: holeEntryFor(m, majorDiameter(s.screw), gs.holeD, base.holeEntry, !!gs.countersink) };
    }),
    corners: (g.cornerBosses || []).map((c) => {
      const m = design.cornerPlan?.method || 'tapped';
      const d = majorDiameter(design.cornerPlan?.size);
      return { method: m, d, entry: holeEntryFor(m, d, c.holeD, base.holeEntry, !!c.countersink) };
    }),
    lidTubes: (g.lidTubes || []).map((t) => ({ method: 'clearance', entry: holeEntryFor('clearance', null, t.holeD, lid.holeEntry, !!(t.countersink || t.counterbore)) })),
    lidHoles: (g.lidHoles || []).map((h) => ({ method: 'clearance', entry: holeEntryFor('clearance', null, h.holeD, lid.holeEntry, !!(h.countersink || h.counterbore)) })),
    ears: (g.ears || []).map((e) => ({ method: 'clearance', entry: e.slot > 0 ? null : holeEntryFor('clearance', null, e.d, base.holeEntry, false) })),
    clip: g.din && clip ? { method: g.din.method, d: 3, entry: holeEntryFor(g.din.method, 3, g.din.holeD, clip.holeEntry, false) } : null,
  };

  // İşlemlerin anma geometrisine göre büyüttüğü izler (tasarım çakışma denetimi için; mm, yarıçap/kenar başına):
  //   standoffRoot / tubeRoot: kök izi yarıçapı − anma yarıçapı (çıkma açısı h·tanα + kök radyüsünün düzlemdeki izi), en büyüğü;
  //   perStandoff / perTube: aynı değer delik sırasıyla; bottomFillet: alt dış kenar işleminin taban düzlemindeki içe girişi.
  const gs = g.standoffs || [];
  const perStandoff = (design.standoffs || []).map((s, i) => {
    const q = gs[i] || s;
    if (q.integral === false || !(q.od > 0) || !(q.z1 > q.z0)) return 0;
    if (!(base.bossRootFillet > 0 || base.bossDraftDeg > 0)) return 0;
    return r2(bossRoot({ h: q.z1 - q.z0, rTip: q.od / 2, draftDeg: base.bossDraftDeg, rootR: base.bossRootFillet }).E[0] - q.od / 2);
  });
  const perTube = (g.lidTubes || []).map((t) => (lid.tubeRootFillet > 0 || lid.bossDraftDeg > 0) && t.od > 0
    ? r2(bossRoot({ h: Math.abs(t.z1 - t.z0), rTip: t.od / 2, draftDeg: lid.bossDraftDeg, rootR: lid.tubeRootFillet }).E[0] - t.od / 2) : 0);
  const be = bottomEdge(base, floor, (g.ears || []).length > 0);
  const growth = {
    standoffRoot: Math.max(0, ...perStandoff),
    tubeRoot: Math.max(0, ...perTube),
    bottomFillet: be ? be.size : 0,
    perStandoff,
    perTube,
  };

  // lipFit: kapak dili–cep boşluğu (dil kök radyüsü gövde ağzına çarpmasın diye sınırlanır)
  return { version: 2, base, lid, clip, rim, pocketGrow, lipFit: p.fit ?? 0.2, holes, growth, rules: { base: rules.id, lid: lr.id } };
}
