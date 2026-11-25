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
 * Sabitlerin yanındaki kimlikler araştırma kataloğundaki kurallardır; bağlantılar TREAT_SOURCES'ta.
 */

/** Kural kimliği → kaynak (kenar işlemi notlarında ve işlem raporunda gösterilir) */
export const TREAT_SOURCES = {
  'FDM-08': 'UltiMaker, How to design for FFF (s.13) — https://ultimaker.com/wp-content/uploads/2024/06/How-to-design-for-FFF-1.pdf',
  'FDM-09': 'Hubs, How to design parts for FDM — https://www.hubs.com/knowledge-base/how-design-parts-fdm-3d-printing/',
  'FDM-10': 'Prusa, Elephant foot compensation — https://help.prusa3d.com/article/elephant-foot-compensation_114487',
  'FDM-11': 'Prusa, Modeling with 3D printing in mind — https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135',
  'FDM-12': 'Hubs, How to design parts for FDM — https://www.hubs.com/knowledge-base/how-design-parts-fdm-3d-printing/',
  'FDM-14': 'Stratasys Direct, FDM Design Guide — https://www.stratasys.com/siteassets/sdm/content---website-storage/design-guides/dg_sdm_fdm_0725a.pdf',
  'FDM-27': 'CNC Kitchen, Heat-set insert tips — https://www.cnckitchen.com/blog/tipps-amp-tricks-fr-gewindeeinstze-im-3d-druck-3awey',
  'FDM-41': 'Hubs, How to design parts for FDM — https://www.hubs.com/knowledge-base/how-design-parts-fdm-3d-printing/',
  'FDM-47': 'Prusa, Modeling with 3D printing in mind — https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135',
  'FDM-53': 'Bayer/Covestro, Snap-Fit Joints for Plastics — https://fab.cba.mit.edu/classes/S62.12/people/vernelle.noel/Plastic_Snap_fit_design.pdf',
  'FDM-55': 'Hubs, Snap-fit joints for 3D printing — https://hubs.com/knowledge-base/how-design-snap-fit-joints-3d-printing',
  'FDM-58': 'UltiMaker, How to design for FFF — https://ultimaker.com/wp-content/uploads/2024/06/How-to-design-for-FFF-1.pdf',
  'IM-07': 'DuPont General Design Principles (Module I) / Ticona TDM-1 §8.10 — https://academic.sun.ac.za/mad/catalogs/dfmguidelines/dupontgeneraldesignprinciples.pdf',
  'IM-08': 'Ticona/Celanese TDM-1 §8.10 — https://res.cloudinary.com/engineering-com/image/upload/v1639229518/tips/Designing_With_Plastics_-_Ticona_Brochure_vghwzt.pdf',
  'IM-10': 'Protolabs, Draft angle guidelines — https://protolabs.com/resources/design-tips/improving-part-moldability-with-draft/',
  'IM-11': 'Protolabs, Draft angle guidelines (derinlik × et tablosu) — https://protolabs.com/resources/design-tips/improving-part-moldability-with-draft/',
  'IM-12': 'Protolabs, Designing for Mouldability Vol. 1 — https://www.protolabs.com/media/949709/dfm1-english.pdf',
  'IM-16': 'Ticona/Celanese TDM-1 §8.6 (paralel draft) — https://res.cloudinary.com/engineering-com/image/upload/v1639229518/tips/Designing_With_Plastics_-_Ticona_Brochure_vghwzt.pdf',
  'IM-21': 'Ticona/Celanese TDM-1 §8.7.1 — https://res.cloudinary.com/engineering-com/image/upload/v1639229518/tips/Designing_With_Plastics_-_Ticona_Brochure_vghwzt.pdf',
  'IM-24': 'Bonenberger, The First Snap-Fit Handbook §4.5 — https://s3.amazonaws.com/gc-p/files/128686/The%20First%20Snap-Fit%20Handbook%202E_Bonenberger.pdf',
  'IM-28': 'Avient, ESCR Design Guide (Bosses) — https://avient.com/sites/default/files/2022-08/Environmental Stress Cracking Resistance _ESCR_ Design Guide %281%29.pdf',
  'IM-30': 'Böllhoff/EJOT DELTA PT, self-tapping fasteners — https://media.boellhoff.com/files/pdf13/8705-self-tapping-fasteners-en.pdf',
  'IM-38': 'Fictiv, Enclosure design for injection molding — https://www.fictiv.com/articles/enclosure-design-for-injection-molding',
  'IM-39': 'DuPont General Design Principles, Fig. 10.56 — https://academic.sun.ac.za/mad/catalogs/dfmguidelines/dupontgeneraldesignprinciples.pdf',
  'CNC-03': 'Xometry, Optimizing internal corner radii — https://www.xometry.com/resources/machining/cnc-machining-optimizing-internal-corner-radii/',
  'CNC-09': 'Hubs, How to design parts for CNC machining — https://www.hubs.com/knowledge-base/how-design-parts-cnc-machining/',
  'CNC-26': 'NASA JSC-67701 §9.6a — https://standards.nasa.gov/system/files/tmp/JSC-67701_JSC_Fabrication_Tolerances_and_Practices_Basic_DCN001_Final.pdf',
  'CNC-32': 'NASA JSC-67701 §7.1 — https://standards.nasa.gov/system/files/tmp/JSC-67701_JSC_Fabrication_Tolerances_and_Practices_Basic_DCN001_Final.pdf',
  'CNC-33': 'Protolabs, Fillets vs. chamfers — https://www.protolabs.com/resources/blog/fillets-and-chamfers/',
  'CNC-34': 'ISO 13715:2017 (önizleme) — https://qualityforum.zeiss.com/migration/images/1125_cad718ab03258942de4de01b28242c05.pdf',
  'CNC-35': 'Xometry, Chamfers and fillets cost — https://www.xometry.com/blog/the-machining-costs-you-should-consider-when-designing-with-chamfers-and-fillets',
  'ENC-SEAL-02': 'Parker O-Ring Handbook ORD 5700, Chart 4-3 — https://nfc.arizona.edu/sites/default/files/2022-02/parker_o-ring_handbook.pdf',
};

/* ---------- Süreçten bağımsız sabitler ---------- */

// FDM-08/09/10: tablaya değen kenarlara 45° pah (radyüs değil). İlk katman taşması ≈ 0,2 mm (Ø0,4 nozul, Prusa);
// pah bacağı en az bu kadar olmalı. 0,5 mm tasarım seçimidir (kaynakta ölçü yok, düşük güven) — FDM-10 VERIFY.
const FDM_BED_CHAMFER = 0.5;
// FDM-47: birbirine geçen kenarlara giriş pahı (ağız iç kenarı, kapak dili ucu). Kaynakta ölçü yok: 0,3 mm ≈ 0,75 × nozul.
const FDM_LEAD_IN = 0.3;
// FDM-14 (Stratasys, düzeltilmiş): iç birleşimlerde radyüs gerilme yığılmasını azaltır; FDM-56: düz tabanlarda keskin iç köşe yerine radyüs.
// Taban–duvar iç köşesi yukarı bakan oluk olduğu için desteksiz basılır. 0,5–1 mm aralığı, üst sınır cep köşe radyüsü − 0,05.
const FDM_FLOOR_FILLET_MAX = 1.0;
// FDM-41/FDM-14: ince direk/boss köklerine radyüs. Ölçü kaynakta yok: 0,5 mm.
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
// CNC-26 (NASA JSC-67701 §9.6a): kılavuz çekilecek her delik 80–120° havşalanır; 90° havşa Ø = diş dış çapı + 0,2.
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
// IM-30 (Böllhoff/EJOT DELTA PT): sac vidası ön deliği girişinde Ø1,05·d boşaltma; IM-28 45° giriş pahı ile birlikte havşa olarak modellenir.
const SELF_TAP_RELIEF = 1.05;
// IM-38: kozmetik kenar ayırma çizgisinden uzakta tutulur; kapak üst dış kenarı radyüslü (ölçü tasarım seçimi ≤ 1 mm).
const IM_LID_TOP_FILLET_MAX = 1.0;
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

/** Cep/boss köşe yuvarlatma için: cep köşe radyüsünü geçmeyen (torus bozulmasın) radyüs */
const capBelow = (v, limit) => Math.max(0, Math.min(v, limit - 0.05));

function partPolicy(process, rules, ctx) {
  const { wall, floor, rIn, rOut, lidT, depth } = ctx;
  const nozzle = rules.process_params?.nozzle_diameter || 0.4;
  const tool = rules.process_params?.tool_diameter || 3;
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
    cutoutBreak: 0,
    grooveBottomR: 0,
    grooveEdgeBreak: 0,
    latchRootR: 0,
    // Geometri yüzünden kaynak değerine ulaşılamayan işlemler: { key, feature, kind, want, got, note } (işlem raporuna yazılır)
    limited: [],
    src: {},
  };
  // %10'a kadar eksik (köşe torusu için bırakılan 0,05 mm pay) sınırlama sayılmaz
  const limitFloor = (want, got, rule) => {
    if (got < 0.9 * want - 1e-6) {
      P.limited.push({ key: 'floor', feature: 'taban–duvar iç köşesi', kind: 'fillet', want: r2(want), got: r2(got),
        note: `cep köşe radyüsü R${String(r2(rIn)).replace('.', ',')} olduğundan ${got > 0 ? `R${String(r2(got)).replace('.', ',')} ile sınırlandı` : 'uygulanamadı'}; ${rule} için köşe radyüsü en az R${String(r2(want + 0.05)).replace('.', ',')} olmalı` });
    }
  };
  if (process === 'fdm') {
    P.bedChamfer = FDM_BED_CHAMFER;
    P.rimLeadIn = Math.min(FDM_LEAD_IN, wall / 4);
    P.lipTipChamfer = FDM_LEAD_IN;
    P.lipRootFillet = FDM_ROOT_FILLET;
    const ff = capBelow(FDM_FLOOR_FILLET_MAX, rIn);
    P.floorFillet = ff >= 0.2 ? r2(ff) : 0;
    limitFloor(0.5, P.floorFillet, 'FDM-14 (0,5–1 mm)');
    P.bossRootFillet = FDM_ROOT_FILLET;
    P.tubeRootFillet = FDM_ROOT_FILLET;
    // FDM-27: ısıl insert deliği düz, girişte pah yok. Kılavuz: CNC-26 (diş açılacak her delik havşalanır).
    P.holeEntry = { insert: 0, tapped: TAP_CSK_OVER_MAJOR, selfTap: 0, clearance: 0 };
    P.concaveMinR = Math.max(FDM_CONCAVE_MIN, nozzle);
    P.src = {
      bedChamfer: ['FDM-08', 'FDM-09', 'FDM-10', 'FDM-58'], rimLeadIn: ['FDM-47'], lipTipChamfer: ['FDM-47'], floorFillet: ['FDM-14'],
      bossRootFillet: ['FDM-41', 'FDM-14'], holeEntry: ['FDM-27', 'CNC-26'], concaveMinR: ['FDM-12'], latchRootR: ['FDM-53', 'FDM-55'],
    };
  } else if (process === 'injection') {
    P.pull = [0, 0, 1];
    P.draftDeg = injectionDraft(depth, wall, rules.draft_angle_min);
    P.bossDraftDeg = Math.max(IM_BOSS_DRAFT, rules.draft_angle_min || 0);
    const riWant = Math.max(IM_INNER_R_FACTOR * wall, IM_INNER_R_MIN);
    const ri = capBelow(riWant, rIn);
    P.floorFillet = ri >= 0.13 ? r2(ri) : 0;
    limitFloor(riWant, P.floorFillet, 'IM-07 (r_i = 0,5·t, ≥ 0,5 mm)');
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
    P.concaveMinR = Math.max(IM_INNER_R_FACTOR * wall, IM_INNER_R_MIN);
    P.src = {
      draftDeg: ['IM-10', 'IM-11', 'IM-12', 'IM-16'], floorFillet: ['IM-07'], outerBottomFillet: ['IM-08'], rimOuterBreak: ['IM-38'],
      rimLeadIn: ['IM-39'], lipTipChamfer: ['IM-39'], lipRootFillet: ['IM-24'], lipDraftDeg: ['IM-24', 'IM-39'],
      bossRootFillet: ['IM-28', 'IM-21'], bossTipChamfer: ['IM-28'], bossDraftDeg: ['IM-28'], outerTopFillet: ['IM-38'],
      holeEntry: ['IM-28', 'IM-30', 'CNC-26'], concaveMinR: ['IM-07'], latchRootR: ['FDM-53'],
    };
  } else if (process === 'cnc') {
    P.outerEdgeBreak = CNC_EDGE_BREAK;
    P.rimOuterBreak = CNC_EDGE_BREAK;
    P.rimLeadIn = Math.min(CNC_EDGE_BREAK, wall / 4);
    P.lipTipChamfer = CNC_EDGE_BREAK;
    P.bossTipChamfer = CNC_EDGE_BREAK;
    P.floorFillet = 0; // CNC-09: düz parmak freze; taban radyüsü gerekmedikçe kullanılmaz
    P.holeEntry = { insert: CNC_EDGE_BREAK, tapped: TAP_CSK_OVER_MAJOR, selfTap: SELF_TAP_RELIEF, clearance: CNC_EDGE_BREAK };
    P.concaveMinR = r2(CNC_CORNER_FACTOR * tool / 2);
    P.nutDogbone = r2(tool / 2);
    P.cutoutBreak = CNC_EDGE_BREAK;
    P.src = {
      outerEdgeBreak: ['CNC-32', 'CNC-33', 'CNC-34', 'CNC-35'], rimLeadIn: ['CNC-32'], floorFillet: ['CNC-09'],
      holeEntry: ['CNC-26', 'CNC-32'], concaveMinR: ['CNC-03'], latchRootR: ['FDM-53'],
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
 * Dönüş: { version, base, lid, clip, rim, holes } — her parça için PartTreat (yukarıdaki alanlar; 0 = yok).
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
  const ctxB = { wall, floor, rIn, rOut, lidT, depth: depthBase };
  const base = partPolicy(rules.process, rules, ctxB);
  // Kapak: plaka yan yüzü + dil + boru boyu en derin özelliktir
  const tubeLen = Math.max(0, ...(g.lidTubes || []).map((t) => t.z1 - t.z0), ...(g.lipBars || []).map((b) => b.max[2] - b.min[2]));
  const lid = partPolicy(lr.process, lr, { ...ctxB, wall: lidT, depth: lidT + tubeLen });
  if (lid.process === 'injection') {
    lid.pull = [0, 0, -1];
    lid.draftDeg = Math.max(lr.draft_angle_min || 0, 1); // plaka yan yüzü yalnız kapak kalınlığı kadar: 1° (IM-10)
  }
  // Gövdeye özgü olmayan alanlar kapakta kullanılmaz (ve tersi): rapor sade kalsın
  base.lipTipChamfer = 0; base.lipRootFillet = 0; base.lipDraftDeg = 0; base.tubeRootFillet = 0; base.outerTopFillet = 0;
  lid.rimLeadIn = 0; lid.floorFillet = 0; lid.outerBottomFillet = 0; lid.rimOuterBreak = 0; lid.nutDogbone = 0; lid.cutoutBreak = 0;
  lid.limited = [];
  if (lid.process === 'fdm') lid.bossRootFillet = 0; // kapakta boss yok; boru kökü tubeRootFillet

  // IP conta kanalı (ENC-SEAL-02): dip radyüsü kordon kesitine göre, kenarlar ≈ 0,13 mm kırılır.
  // FDM'de 0,13 mm nozul çözünürlüğünün altında kalır (FDM-01): yalnız dip radyüsü modellenir.
  if (g.groove) {
    const cord = design.sealing?.cord_d;
    base.grooveBottomR = Math.min(grooveRadius(cord), g.groove.width / 2 - 0.05, g.groove.depth / 2);
    base.grooveEdgeBreak = base.process === 'fdm' ? 0 : 0.13;
    base.src.groove = ['ENC-SEAL-02'];
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
    clip.draftDeg = 0; clip.bossDraftDeg = 0; // klips enjeksiyonda zaten yan maça ister (mount.js uyarısı): açı uygulanmaz
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

  // lipFit: kapak dili–cep boşluğu (dil kök radyüsü gövde ağzına çarpmasın diye sınırlanır)
  return { version: 1, base, lid, clip, rim, pocketGrow, lipFit: p.fit ?? 0.2, holes, rules: { base: rules.id, lid: lr.id } };
}
