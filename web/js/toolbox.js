/*
 * Toolbox (SolidWorks Toolbox benzeri): standart bağlantı elemanı kütüphanesi.
 * Şimdilik ISO › Cıvata ve vidalar › 3 tip. Kullanıcı tip, boyut ve boy seçer; her boyun bu kartta
 * nasıl tutunduğu (uygun / kısa / standoff uyarlanır) canlı hesapla gösterilir.
 * Hesap design.js'te; bu modül yalnızca pencereyi ve vida önizleme çizimini yönetir.
 */

const NUM = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const n = (v) => NUM.format(v);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const parseDrive = (s) => (s && /^[\d,.]+$/.test(s) ? Number(String(s).replace(',', '.')) : null);

/** SolidWorks Toolbox tarzı tanım: "ISO 7045 - M3 × 12 - H" */
export function designation(type, size, L) {
  return `${type.code} - ${size} × ${L ?? '…'}${type.recess ? ' - ' + type.recess : ''}`;
}

/* ---------- Küçük baş simgesi (ağaç ve bağlantı kartı) ---------- */

export function headIcon(head) {
  const body = {
    pan: '<path d="M4 11h20v-1.6c0-3-3.2-5.4-10-5.4S4 6.4 4 9.4z"/>',
    socket: '<path d="M6 11h16V4.6L21 3.6H7L6 4.6z"/>',
    countersunk: '<path d="M3 3.6h22L17.5 11h-7z"/>',
  }[head] || '';
  const shankTop = head === 'countersunk' ? 11 : 11;
  return `<svg class="head-icon" viewBox="0 0 28 26" aria-hidden="true">${body}` +
    `<path d="M10.5 ${shankTop}h7v11.4l-1 1.2h-5l-1-1.2z"/>` +
    `<path class="hi-thread" d="M10.5 15h7M10.5 18h7M10.5 21h7"/></svg>`;
}

/* ---------- Ölçülü vida önizleme çizimi (yan görünüş + üstten) ---------- */

/**
 * type: toolbox tipi, sz: { dk, k, P, drive_size }, d: anma çapı, L: boy (havşada başı kapsar).
 * Çizim kuralları teknik resim alışkanlığına göre: diş dibi ince sürekli çizgi, tahrik izi gizli çizgi,
 * eksen noktalı çizgi, ölçü çizgileri ok uçlu.
 */
export function screwFigure(type, sz, d, L) {
  const VW = 320;
  const VH = 270;
  const r = sz.dk / 2;
  const k = sz.k;
  const P = sz.P || 0.5;
  const sunk = type.head === 'countersunk';
  const yTop = sunk ? 0 : -k; // model: y aşağı, 0 = oturma yüzü (havşada üst yüz)
  const totalH = L - yTop;
  const areaW = 106;
  const areaH = 196;
  const s = Math.min(areaH / totalH, areaW / sz.dk, 22);
  const cx = 112;
  const top = 34 + (areaH - totalH * s) / 2;
  const X = (x) => cx + x * s;
  const Y = (y) => top + (y - yTop) * s;
  const out = [];
  const pts = (arr) => arr.map(([x, y]) => `${X(x).toFixed(2)},${Y(y).toFixed(2)}`).join(' ');

  // Baş profili
  let head;
  if (sunk) {
    head = [[-r, 0], [r, 0], [d / 2, k], [-d / 2, k]];
  } else if (type.head === 'socket') {
    const ch = Math.min(0.12 * k, 0.3);
    head = [[-r, 0], [-r, -k + ch], [-r + ch, -k], [r - ch, -k], [r, -k + ch], [r, 0]];
  } else {
    const right = [];
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * (Math.PI / 2);
      right.push([0.55 * r + 0.45 * r * Math.cos(a), -(0.35 * k + 0.65 * k * Math.sin(a))]);
    }
    head = [[r, 0], ...right, ...right.slice().reverse().map(([x, y]) => [-x, y]), [-r, 0]];
  }
  // Gövde (uçta pah)
  const c = Math.min(0.75 * P, d * 0.2);
  const shankTop = sunk ? k : 0;
  const shank = [[-d / 2, shankTop], [d / 2, shankTop], [d / 2, L - c], [d / 2 - c, L], [-d / 2 + c, L], [-d / 2, L - c]];

  out.push(`<polygon class="tf-part" points="${pts(shank)}"/>`);
  out.push(`<polygon class="tf-part" points="${pts(head)}"/>`);
  // Diş dibi (ince sürekli çizgi)
  const rm = d / 2 - 0.6134 * P;
  out.push(`<path class="tf-thin" d="M${X(-rm)} ${Y(shankTop + (sunk ? 0.2 : 0.4))}V${Y(L - c * 0.6)}M${X(rm)} ${Y(shankTop + (sunk ? 0.2 : 0.4))}V${Y(L - c * 0.6)}"/>`);
  // Tahrik izi (gizli çizgi)
  const ds = parseDrive(sz.drive_size);
  const recessTop = sunk ? 0 : -k;
  if (type.head === 'pan') {
    const m = 0.54 * sz.dk;
    out.push(`<polyline class="tf-thin tf-hid" points="${pts([[-m / 2, recessTop], [0, recessTop + 0.62 * k], [m / 2, recessTop]])}"/>`);
  } else if (ds) {
    const t = (sunk ? 0.6 : 0.55) * k;
    const cone = (ds / 2) * Math.tan((31 * Math.PI) / 180);
    out.push(`<polyline class="tf-thin tf-hid" points="${pts([[-ds / 2, recessTop], [-ds / 2, recessTop + t], [0, recessTop + t + cone], [ds / 2, recessTop + t], [ds / 2, recessTop]])}"/>`);
  }
  // Eksen
  out.push(`<line class="tf-center" x1="${cx}" y1="${Y(yTop) - 8}" x2="${cx}" y2="${Y(L) + 8}"/>`);

  // Ölçüler
  const dimH = (x1, x2, y, label, from) => {
    // from: ölçülen noktaların y'si (uzatma çizgisi başlangıcı)
    out.push(`<path class="tf-ext" d="M${x1} ${from[0]}V${y + (y < from[0] ? -3 : 3)}M${x2} ${from[1]}V${y + (y < from[1] ? -3 : 3)}"/>`);
    arrowLine(out, x1, y, x2, y);
    out.push(`<text class="tf-txt" x="${(x1 + x2) / 2}" y="${y < from[0] ? y - 5 : y + 13}" text-anchor="middle">${esc(label)}</text>`);
  };
  const dimV = (y1, y2, x, label, from, side) => {
    out.push(`<path class="tf-ext" d="M${from[0]} ${y1}H${x + (x < from[0] ? -3 : 3)}M${from[1]} ${y2}H${x + (x < from[1] ? -3 : 3)}"/>`);
    arrowLine(out, x, y1, x, y2);
    const tx = side === 'left' ? x - 6 : x + 6;
    out.push(`<text class="tf-txt" x="${tx}" y="${(y1 + y2) / 2 + 4}" text-anchor="${side === 'left' ? 'end' : 'start'}">${esc(label)}</text>`);
  };

  const widestY = sunk ? Y(0) : type.head === 'socket' ? Y(-k / 2) : Y(-0.2 * k);
  dimH(X(-r), X(r), Y(yTop) - 14, `Ø${n(sz.dk)}`, [widestY, widestY]);
  const kTop = sunk ? Y(0) : Y(-k);
  const kBot = sunk ? Y(k) : Y(0);
  dimV(kTop, kBot, X(r) + 16, `k ${n(k)}`, [X(sunk ? r : 0.6 * r), X(sunk ? d / 2 : r)], 'right');
  dimV(Y(0), Y(L), X(-r) - 18, `L ${n(L)}`, [X(sunk ? -r : -r), X(-d / 2)], 'left');
  dimH(X(-d / 2), X(d / 2), Y(L) + 16, `${'M' + n(d)}`, [Y(L - c), Y(L - c)]);

  // Üstten görünüş
  const tcx = 268;
  const tcy = 92;
  const s2 = Math.min(s, 32 / r);
  out.push(`<circle class="tf-part" cx="${tcx}" cy="${tcy}" r="${r * s2}"/>`);
  if (sunk || type.head === 'socket') {
    if (ds) {
      const R = (ds / Math.sqrt(3)) * s2;
      const hex = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        hex.push(`${(tcx + R * Math.cos(a)).toFixed(2)},${(tcy + R * Math.sin(a)).toFixed(2)}`);
      }
      out.push(`<polygon class="tf-recess" points="${hex.join(' ')}"/>`);
    }
  } else {
    const m = 0.27 * sz.dk * s2;
    const w = 0.07 * sz.dk * s2;
    out.push(`<path class="tf-recess" d="M${tcx - m} ${tcy - w}H${tcx - w}V${tcy - m}H${tcx + w}V${tcy - w}H${tcx + m}V${tcy + w}H${tcx + w}V${tcy + m}H${tcx - w}V${tcy + w}H${tcx - m}z"/>`);
  }
  out.push(`<text class="tf-cap" x="${tcx}" y="${tcy + r * s2 + 16}" text-anchor="middle">Üstten</text>`);
  out.push(`<text class="tf-cap" x="${tcx}" y="${tcy + r * s2 + 30}" text-anchor="middle">${esc(ds ? `imbus ${sz.drive_size}` : sz.drive_size || '')}</text>`);
  out.push(`<text class="tf-cap" x="8" y="14">Yan görünüş</text>`);

  return `<svg class="tb-figure-svg" viewBox="0 0 ${VW} ${VH}" role="img" aria-label="${esc(type.code)} vida ölçü çizimi">${out.join('')}</svg>`;
}

function arrowLine(out, x1, y1, x2, y2) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / (len || 1);
  const uy = (y2 - y1) / (len || 1);
  const a = 6;
  const w = 2.4;
  const head = (x, y, dx, dy) => `<path class="tf-arrow" d="M${x} ${y}L${x - dx * a - dy * w} ${y - dy * a + dx * w}L${x - dx * a + dy * w} ${y - dy * a - dx * w}z"/>`;
  if (len >= 2 * a + 4) {
    out.push(`<line class="tf-dim" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    out.push(head(x2, y2, ux, uy), head(x1, y1, -ux, -uy));
  } else {
    // Dar ölçü: oklar dışarıdan içeri
    out.push(`<line class="tf-dim" x1="${x1 - ux * 12}" y1="${y1 - uy * 12}" x2="${x2 + ux * 12}" y2="${y2 + uy * 12}"/>`);
    out.push(head(x1, y1, ux, uy), head(x2, y2, -ux, -uy));
  }
}

/* ---------- Pencere ---------- */

/**
 * dialog: <dialog id="toolbox-dialog">; library: toolbox JSON; fasteners: fasteners.json
 * evaluate(spec) → null (kart yok) ya da { auto, sel, standoffAuto, standoffNow } (design-ui hesaplar)
 * onApply(spec): seçim uygulanınca
 */
export function createToolbox({ dialog, library, fasteners, evaluate, onApply }) {
  const q = (sel) => dialog.querySelector(sel);
  const types = library.categories.flatMap((c) => c.types);
  let draft = null;

  const typeById = (id) => types.find((t) => t.id === id) || types[0];
  const screwBySize = (size) => fasteners.screws.find((x) => x.size === size) || null;

  function normalize(spec) {
    const t = typeById(spec.type);
    const out = { type: t.id, size: spec.size, length: spec.length };
    if (out.size !== 'auto' && !t.sizes[out.size]) out.size = 'auto';
    return out;
  }

  function open(spec) {
    draft = normalize(spec);
    render();
    if (!dialog.open) dialog.showModal();
  }

  function renderTree() {
    q('#tb-tree').innerHTML = `
      <div class="tb-node open"><span class="tb-caret" aria-hidden="true"></span><strong>${esc(library.standard)}</strong></div>
      ${library.categories.map((cat) => `
        <div class="tb-node lvl1 ${cat.soon ? 'soon' : 'open'}"><span class="tb-caret" aria-hidden="true"></span>${esc(cat.label)}${cat.soon ? '<span class="tb-soon">yakında</span>' : ''}</div>
        ${cat.types.map((t) => `
          <button type="button" class="tb-item" role="treeitem" data-type="${t.id}" aria-selected="${t.id === draft.type}">
            ${headIcon(t.head)}<span class="tb-item-text"><span class="tb-code">${esc(t.code)}</span><span class="tb-name">${esc(t.short)}</span></span>
          </button>`).join('')}`).join('')}`;
  }

  function render() {
    renderTree();
    const t = typeById(draft.type);
    const ev = evaluate(draft);
    const info = ev?.auto?.fastenInfo || null;
    const minHole = ev?.auto?.usedHoleMinD ?? null;
    const sizes = Object.keys(t.sizes);
    const fits = (size) => minHole === null || (screwBySize(size)?.min_pcb_hole ?? 99) <= minHole + 1e-6;
    const autoSize = info?.size || [...sizes].reverse().find(fits) || sizes[0];
    const effSize = draft.size === 'auto' ? autoSize : draft.size;
    const sz = t.sizes[effSize] || t.sizes[sizes[0]];
    const screw = screwBySize(effSize);
    // Boy durumları: otomatik boyun hesaplandığı tasarıma göre
    const lid = ev?.auto?.screws?.find((x) => x.lid) || ev?.auto?.screws?.[0] || null;
    const autoL = lid?.length ?? null;
    const lenInfo = sz.lengths.map((L) => {
      if (!info || info.size !== effSize) return { L, status: 'na' };
      const eng = L - info.grip;
      if (eng < info.minEngage - 1e-9) return { L, status: 'short', eng };
      if (eng <= info.available - 0.3 + 1e-9) return { L, status: 'ok', eng };
      const need = Math.ceil((L - info.grip + 0.3 - info.floor + 0.8) * 10) / 10;
      return { L, status: ev.standoffAuto ? 'adapt' : 'long', eng, need };
    });
    if (draft.length !== 'auto' && !sz.lengths.includes(Number(draft.length))) draft.length = 'auto';
    const selL = draft.length === 'auto' ? autoL : Number(draft.length);
    const figL = selL ?? sz.lengths[Math.floor(sz.lengths.length / 2)];

    q('#tb-figure').innerHTML = screwFigure(t, sz, screw ? screw.d : parseFloat(effSize.slice(1)), figL);
    q('#tb-designation').textContent = designation(t, effSize, figL);

    const sizeChips = [`<button type="button" class="chip" data-size="auto" aria-checked="${draft.size === 'auto'}">Otomatik <span class="chip-sub">${esc(autoSize)}</span></button>`]
      .concat(sizes.map((size) => `<button type="button" class="chip ${fits(size) ? '' : 'bad'}" data-size="${esc(size)}" aria-checked="${draft.size === size}"` +
        ` ${fits(size) ? '' : `disabled title="Ø${n(minHole)} PCB deliğinden geçmez"`}>${esc(size)}</button>`)).join('');
    const stLabel = { ok: 'uygun', short: 'kısa', adapt: 'uyarlanır', long: 'uzun', na: '' };
    const lenChips = [`<button type="button" class="chip" data-len="auto" aria-checked="${draft.length === 'auto'}">Otomatik <span class="chip-sub">${autoL ? autoL + ' mm' : '–'}</span></button>`]
      .concat(lenInfo.map((li) => `<button type="button" class="chip len ${li.status}" data-len="${li.L}" aria-checked="${String(draft.length) === String(li.L)}"` +
        ` title="${esc(li.status === 'na' ? '' : `${stLabel[li.status]}${li.eng === undefined ? '' : li.eng <= 0 ? " · standoff'a ulaşmıyor" : ` · ${n(li.eng)} mm tutunur`}${li.need ? ` · PCB altı ${n(li.need)} mm olur` : ''}`)}">${li.L}</button>`)).join('');

    const selInfo = lenInfo.find((li) => li.L === selL);
    let lenNote = '';
    if (!ev) lenNote = 'Kart yüklenince her boyun bu karttaki tutunması gösterilir.';
    else if (selInfo && selInfo.status === 'ok') lenNote = `<span class="t-ok">✓ Uygun:</span> ${n(selInfo.eng)} mm tutunur (en az ${n(info.minEngage)} mm).`;
    else if (selInfo && selInfo.status === 'short') {
      lenNote = selInfo.eng <= 0
        ? `<span class="t-warn">Kısa:</span> standoff'a ulaşmıyor; kapak + kart ${n(info.grip)} mm, en az ${n(info.grip + info.minEngage)} mm boy gerekir.`
        : `<span class="t-warn">Kısa:</span> yalnızca ${n(selInfo.eng)} mm tutunur (en az ${n(info.minEngage)} mm).`;
    }
    else if (selInfo && selInfo.status === 'adapt') lenNote = `<span class="t-accent">Uyarlanır:</span> PCB altı yükseklik ${n(selInfo.need)} mm olur, muhafaza yükselir.`;
    else if (selInfo && selInfo.status === 'long') lenNote = '<span class="t-warn">Uzun:</span> PCB altı yüksekliği elle girildiği için delik bu vidaya yetmez.';

    const method = info?.method || 'insert';
    const bodySide = !screw ? '–'
      : method === 'insert' ? `insert Ø${n(screw.insert_hole)} × ${n(screw.insert_length)}`
        : method === 'tapped' ? `kılavuz, matkap Ø${n(screw.tap_drill)}` : `sac vidası ön deliği Ø${n(screw.selftap_pilot)}`;
    const rows = [
      ['Standart', `${t.code} · ${t.name}`],
      ['Tahrik', `${t.drive}${sz.drive_size ? ` · ${parseDrive(sz.drive_size) ? sz.drive_size + ' mm' : sz.drive_size}` : ''}`],
      ['Baş', `Ø${n(sz.dk)} × ${n(sz.k)} mm${t.head === 'countersunk' ? ` · ${t.countersink_angle || 90}° havşa` : ''}`],
      ['Diş', `${effSize} × ${n(sz.P)} (kaba)`],
      ['Kapak deliği', screw ? `Ø${n(screw.clearance)}${t.head === 'countersunk' ? ` + havşa Ø${n(sz.dk + 0.3)}` : ''}` : '–'],
      ['Gövde tarafı', bodySide],
      ['Boy ölçüsü', t.length_includes_head ? 'başı da kapsar (havşa üst yüzünden)' : 'baş altından uca'],
    ];
    const sel = ev?.sel;
    const issues = (sel?.checks || []).filter((c) => c.cat === 'baglanti' && (c.level === 'error' || c.level === 'warn')).slice(0, 4);
    const fitRows = sel && sel.outer ? [
      ['PCB altı yükseklik', `${n(sel.params.standoffHeight)} mm${Math.abs(sel.params.standoffHeight - ev.standoffNow) > 1e-6 ? ` <span class="muted">(şu an ${n(ev.standoffNow)})</span>` : ''}`],
      ['Muhafaza dış ölçü', `${n(sel.outer.L)} × ${n(sel.outer.W)} × ${n(sel.outer.H)} mm`],
      ['Vida sayısı', `${sel.screws.length} (${sel.screws.filter((x) => x.lid).length} kapak + PCB)`],
    ] : [];

    q('#tb-props').innerHTML = `
      <section class="tb-group">
        <h4>Boyut</h4>
        <div class="chips">${sizeChips}</div>
        ${minHole !== null ? `<p class="muted small">En küçük montaj deliği Ø${n(minHole)} mm</p>` : ''}
      </section>
      <section class="tb-group">
        <h4>Boy <span class="muted">(mm)</span></h4>
        <div class="chips">${lenChips}</div>
        <p class="small tb-len-note">${lenNote}</p>
        ${ev ? '<div class="tb-legend"><span class="t-ok">uygun</span><span class="t-warn">kısa</span><span class="t-accent">standoff uyarlanır</span></div>' : ''}
      </section>
      <section class="tb-group">
        <h4>Özellikler</h4>
        <table class="tb-table">${rows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>
      </section>
      ${fitRows.length ? `<section class="tb-group">
        <h4>Bu tasarımda</h4>
        <table class="tb-table">${fitRows.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${b}</td></tr>`).join('')}</table>
        ${issues.length ? `<ul class="notes">${issues.map((c) => `<li class="note ${c.level}"><span>${esc(c.text)}</span></li>`).join('')}</ul>` : '<p class="small"><span class="t-ok">✓</span> Bağlantı kontrollerinde sorun yok.</p>'}
      </section>` : ''}`;
  }

  q('#tb-tree').addEventListener('click', (e) => {
    const item = e.target.closest('[data-type]');
    if (!item || item.dataset.type === draft.type) return;
    draft = normalize({ ...draft, type: item.dataset.type });
    render();
  });
  q('#tb-props').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-size],[data-len]');
    if (!chip || chip.disabled) return;
    if (chip.dataset.size) { draft.size = chip.dataset.size; draft.length = 'auto'; }
    if (chip.dataset.len) draft.length = chip.dataset.len === 'auto' ? 'auto' : Number(chip.dataset.len);
    render();
  });
  q('#tb-apply').addEventListener('click', () => {
    onApply({ ...draft });
    dialog.close();
  });
  q('#tb-cancel').addEventListener('click', () => dialog.close());

  return { open, types, typeById };
}
