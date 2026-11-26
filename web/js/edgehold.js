/*
 * Kart kenarı tutucu: montaj deliği olmayan (ya da ek tutma istenen) kartlar için kenardan tutma.
 * - Alt destek: tabana ve yan duvara bağlı blok; kartı kenar bandından (≈2 mm) alttan taşır.
 * - Üst baskı: kapaktan inen dil; kapak kapanınca kartı kenar bandından üstten sıkıştırır.
 * Yanal konum kavite duvarlarıyla (PCB–duvar boşluğu kadar). Yerler, kenar bandında altında / üstünde bileşen
 * olmayan noktalar arasından köşelere yayılacak şekilde (en uzak nokta seçimi) otomatik bulunur.
 * computeDesign() içinden çağrılır; yalnızca sayı üretir.
 */

const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const f = (v) => nf.format(Math.round(v * 100) / 100);
const GAP = 0.3; // mm: tutucu ile bileşen arası en az boşluk
const LEN = 4; // mm: tutucu boyu (kenar boyunca)
const LEN_MIN = 3;
const OVERLAPS = [2, 1.5, 1.2]; // mm: kartın kenarından içeri bindirme (önce geniş)
const COUNT = 4;

const hit = (a, b, g = GAP) => a.min[0] < b.max[0] + g && a.max[0] > b.min[0] - g &&
  a.min[1] < b.max[1] + g && a.max[1] > b.min[1] - g && a.min[2] < b.max[2] + g && a.max[2] > b.min[2] - g;
const cyl = (x, y, d, z0, z1) => ({ min: [x - d / 2, y - d / 2, z0], max: [x + d / 2, y + d / 2, z1] });

/**
 * ctx: { mode: 'auto'|'on'|'off', hasHoles, b (board: box, top, bottom), cav, floorTop, cavTop, rIn, fit, clr,
 *        obstacles (bileşen kutuları {box,name}), standoffs, cornerBosses, cornerReach (köşe boss'u–duvar radyüsünün kavite
 *        köşesinden duvar boyunca uzandığı mesafe, mm), lidTubes, lidHoles, floorHoles, lidItems, rules }
 * Dönüş: { active, pads: [{min,max,edge}], pressers: [{min,max,edge}], checks, info }
 */
export function planEdgeHold(ctx) {
  const mode = ctx.mode || 'auto';
  const active = mode === 'on' || (mode === 'auto' && !ctx.hasHoles);
  const out = { active, pads: [], pressers: [], checks: [], info: null };
  if (!active) return out;
  // Kontrol kaydı: { level, text, fix, rule, measured?, limit?, op?, unit? } — rule: dfm/catalog.js kimliği (EDGE-*)
  const add = (level, text, fix = null, rule = 'EDGE-SUPPORT', meta = null) => out.checks.push({ level, text, fix, rule, ...(meta || {}) });
  const { b, cav, floorTop, cavTop, rIn, fit } = ctx;
  const pb = b.box;

  // Engeller: kartın altındaki (destek için) ve üstündeki (baskı için) her şey
  const below = [];
  const above = [];
  for (const o of ctx.obstacles || []) {
    if (o.box.min[2] < b.bottom - 0.01) below.push(o);
    if (o.box.max[2] > b.top + 0.01) above.push(o);
  }
  for (const s of ctx.standoffs || []) below.push({ box: cyl(s.x, s.y, s.insert?.kind === 'standoff' ? s.insert.sw * 1.155 : s.od, s.z0, b.bottom), name: 'standoff' });
  for (const c of ctx.cornerBosses || []) {
    // Boss + duvar köşesi + boss–duvar içbükey radyüsü (GEO-CORNER-CONCAVE): radyüs duvar boyunca kavite köşesinden
    // cornerReach kadar uzanır (design.js; kapak dili ucuyla aynı bağıntı). Kutu köşeden iki duvar boyunca bu kadar büyür.
    const [wx, wy] = c.wall;
    const mx = Math.sign(c.x - wx) || 1;
    const my = Math.sign(c.y - wy) || 1;
    const ex = Math.max(Math.abs(c.x - wx) + c.od / 2, ctx.cornerReach || 0);
    const ey = Math.max(Math.abs(c.y - wy) + c.od / 2, ctx.cornerReach || 0);
    const bx = { min: [Math.min(wx, wx + mx * ex), Math.min(wy, wy + my * ey), c.z0], max: [Math.max(wx, wx + mx * ex), Math.max(wy, wy + my * ey), c.z1] };
    below.push({ box: bx, name: 'köşe boss' });
    above.push({ box: bx, name: 'köşe boss' });
  }
  for (const h of ctx.floorHoles || []) below.push({ box: cyl(h.x, h.y, h.d + 6, floorTop, b.bottom), name: 'taban montaj vidası' });
  for (const t of ctx.lidTubes || []) above.push({ box: cyl(t.x, t.y, t.od, t.z0, cavTop), name: 'kapak borusu' });
  for (const h of ctx.lidHoles || []) if (h.pad) above.push({ box: cyl(h.x, h.y, h.pad.od, cavTop - h.pad.h, cavTop), name: 'köşe vidası yastığı' });
  for (const it of ctx.lidItems || []) above.push(it);

  // Aday yerler: dört kenar boyunca 1 mm adımla
  const cands = { pad: [], presser: [] };
  const edges = [['-X', 0, -1], ['+X', 0, 1], ['-Y', 1, -1], ['+Y', 1, 1]];
  for (const [edge, axis, dir] of edges) {
    const along = 1 - axis;
    const pcbEdge = dir < 0 ? pb.min[axis] : pb.max[axis];
    const wallIn = dir < 0 ? cav.min[axis] : cav.max[axis];
    const lo = Math.max(pb.min[along], cav.min[along] + rIn) + LEN / 2 + 0.3;
    const hi = Math.min(pb.max[along], cav.max[along] - rIn) - LEN / 2 - 0.3;
    for (let a = lo; a <= hi + 1e-9; a += 1) {
      for (const kind of ['pad', 'presser']) {
        for (const ov of OVERLAPS) {
          const inner = pcbEdge - dir * ov; // kartın içine bindirme
          const outerEdge = kind === 'pad' ? wallIn + dir * 0.3 : wallIn - dir * fit; // destek duvara gömülür, baskı duvara değmez
          const min = [0, 0, 0];
          const max = [0, 0, 0];
          min[axis] = Math.min(inner, outerEdge); max[axis] = Math.max(inner, outerEdge);
          min[along] = a - LEN / 2; max[along] = a + LEN / 2;
          if (kind === 'pad') { min[2] = floorTop - 0.3; max[2] = b.bottom; } else { min[2] = b.top; max[2] = cavTop + 0.3; }
          const box = { min, max };
          const list = kind === 'pad' ? below : above;
          if (list.some((o) => hit(box, o.box))) continue;
          cands[kind].push({ edge, axis, dir, a, ov, box, p: [kind === 'pad' ? 0 : 0, 0], c: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] });
          break;
        }
      }
    }
  }

  // En uzak nokta seçimi: önce kavite köşesine en yakın aday, sonra seçilenlerden en uzak olan
  const pick = (list) => {
    if (!list.length) return [];
    const chosen = [];
    const corner = [cav.min[0], cav.min[1]];
    chosen.push(list.reduce((m, c) => (Math.hypot(c.c[0] - corner[0], c.c[1] - corner[1]) < Math.hypot(m.c[0] - corner[0], m.c[1] - corner[1]) ? c : m)));
    while (chosen.length < COUNT) {
      let best = null;
      let bestD = 0;
      for (const c of list) {
        const d = Math.min(...chosen.map((q) => Math.hypot(q.c[0] - c.c[0], q.c[1] - c.c[1])));
        if (d > bestD) { bestD = d; best = c; }
      }
      if (!best || bestD < LEN + 2) break;
      chosen.push(best);
    }
    return chosen;
  };
  const pads = pick(cands.pad);
  const pressers = pick(cands.presser);
  out.pads = pads.map((c) => ({ min: c.box.min, max: c.box.max, edge: c.edge }));
  out.pressers = pressers.map((c) => ({ min: c.box.min, max: c.box.max, edge: c.edge }));

  // Destekler kartı en az üç noktadan ve geniş bir alana yayılarak taşımalı
  const spread = (list) => {
    if (list.length < 3) return 0;
    const xs = list.map((c) => c.c[0]);
    const ys = list.map((c) => c.c[1]);
    return ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / ((pb.max[0] - pb.min[0]) * (pb.max[1] - pb.min[1]));
  };
  const why = ctx.hasHoles ? '' : 'Kartta montaj deliği yok: ';
  out.info = { pads: pads.length, pressers: pressers.length, clr: ctx.clr, overlap: pads[0]?.ov ?? pressers[0]?.ov ?? null };
  if (pads.length < 3) {
    add('error', `${why}kartı kenarından alttan taşıyacak yer bulunamadı (${pads.length} destek; en az 3 gerekir). Kartın kenar bandının (≈2 mm) altında bileşen/pin var; PCB altı yükseklik ya da kart–duvar boşluğu değiştirilmeli ya da kart pin başlıklarından dişi soket/aralayıcıyla tutulmalı.`,
      null, 'EDGE-SUPPORT', { measured: pads.length, limit: 3, op: '>=', unit: 'adet' });
  } else {
    const sp = spread(pads);
    add(sp < 0.25 ? 'warn' : 'ok', `${why}kart ${pads.length} alt destekle kenarından taşınıyor (tabana ve duvara bağlı, kart kenarından ${f(pads[0].ov)} mm içeri)${sp < 0.25 ? '; destekler bir bölgede toplanmış, kart eğilebilir' : ''}.`,
      null, 'EDGE-SUPPORT', { measured: Math.round(sp * 100) / 100, limit: 0.25, op: '>=', unit: '' });
  }
  if (!pressers.length) {
    add('warn', 'Kartı üstten tutacak kapak baskısı için kenarda boş yer yok: kart desteklere oturur ama kapak kapanınca sıkışmaz. Desteklere çift taraflı köpük bant ya da kartın üstüne yumuşak ped önerilir.', null, 'EDGE-PRESSER');
  } else {
    add(pressers.length < 3 ? 'info' : 'ok', `${pressers.length} kapak baskısı kartı kenarından üstten sıkıştırır (kapak kapanınca temas; titreşimli ortamda baskı altına 0,5–1 mm silikon/EVA ped önerilir).`, null, 'EDGE-PRESSER',
      { measured: pressers.length, limit: 3, op: '>=', unit: 'adet', part: 'lid' });
  }
  add('info', `Kart yanal olarak kavite duvarlarıyla konumlanır (her yanda ${f(ctx.clr)} mm boşluk); daha sıkı konum için PCB–duvar boşluğu azaltılabilir.`, null, 'EDGE-LATERAL');
  if (ctx.rules?.process === 'cnc') add('info', 'CNC: alt destekler cep tabanında duvara bağlı adacıklar olarak işlenir; baskı dilleri kapağın iç yüzünden.', null, 'EDGE-CNC');
  return out;
}
