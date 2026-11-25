/*
 * Toolbox (SolidWorks Toolbox benzeri): standart bağlantı elemanı kütüphanesi.
 * ISO › Cıvata ve vidalar › gruplar (yıldız, düz, imbus, torx, sac vidası) › tipler.
 * Kullanıcı tip, boyut ve boy seçer; her boyun bu kartta nasıl tutunduğu (uygun / kısa / standoff uyarlanır)
 * canlı hesapla gösterilir. Hesap design.js'te; bu modül pencereyi ve vida önizleme çizimini yönetir.
 */
import { libraryTypes, screwTable, driveText, designation, isTapping } from './design.js';
import { headProfile, headTop, driveOutline, driveSection } from './screw-shapes.js';

const NUM = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const n = (v) => NUM.format(v);
const sizeLabel = (size) => size.replace('.', ',');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const DRIVE_LABEL = {
  cross: 'Yıldız (Phillips, H)',
  slot: 'Düz (tornavida)',
  hex: 'İç altıgen (imbus)',
  torx: 'Torx (iç yıldız)',
};

/* ---------- Küçük baş simgesi (ağaç ve bağlantı kartı) ---------- */

export function headIcon(head) {
  const body = {
    pan: '<path d="M4 11h20v-1.6c0-3-3.2-5.4-10-5.4S4 6.4 4 9.4z"/>',
    cheese: '<path d="M6.5 11h15V5.2c0-.9-.7-1.6-1.6-1.6h-11.8c-.9 0-1.6.7-1.6 1.6z"/>',
    socket: '<path d="M6 11h16V4.6L21 3.6H7L6 4.6z"/>',
    button: '<path d="M4 11h20v-.8C24 7 19.6 5 14 5S4 7 4 10.2z"/>',
    countersunk: '<path d="M3 3.6h22L17.5 11h-7z"/>',
  }[head] || '';
  return `<svg class="head-icon" viewBox="0 0 28 26" aria-hidden="true">${body}` +
    '<path d="M10.5 11h7v11.4l-1 1.2h-5l-1-1.2z"/>' +
    '<path class="hi-thread" d="M10.5 15h7M10.5 18h7M10.5 21h7"/></svg>';
}

/* ---------- Ölçülü vida önizleme çizimi (yan görünüş + üstten) ---------- */

/**
 * type: toolbox tipi, sz: boyut kaydı { dk, dk_actual?, k, P, drive, A?, m? }, size: boyut adı, d: anma çapı,
 * L: boy (havşada başı kapsar). Teknik resim alışkanlığı: diş dibi ince sürekli çizgi, tahrik izi gizli çizgi,
 * eksen noktalı çizgi, ölçü çizgileri ok uçlu. Model koordinatı: y yukarı, 0 = oturma yüzü (havşada üst yüz), uç −L.
 */
export function screwFigure(type, sz, size, d, L) {
  const VW = 320;
  const VH = 270;
  const shape = { head: type.head, dk: sz.dk, dkActual: sz.dk_actual, k: sz.k, d, driveKind: type.drive_kind, drive: sz.drive, A: sz.A, m: sz.m };
  const sunk = type.head === 'countersunk';
  const k = sz.k;
  const P = sz.P || 0.5;
  const dkShown = sz.dk_actual || sz.dk;
  const r = dkShown / 2;
  const maxTop = headTop(shape);
  const totalH = L + maxTop;
  const areaW = 106;
  const areaH = 196;
  const s = Math.min(areaH / totalH, areaW / sz.dk, 22);
  const cx = 112;
  const top = 34 + (areaH - totalH * s) / 2;
  const X = (x) => cx + x * s;
  const Y = (y) => top + (maxTop - y) * s;
  const out = [];
  const pts = (arr) => arr.map(([x, y]) => `${X(x).toFixed(2)},${Y(y).toFixed(2)}`).join(' ');

  // Baş: döndürme profilinin sağ yarısı + aynası
  const right = headProfile(shape).filter(([x]) => x > 1e-9);
  const head = right.concat(right.slice().reverse().map(([x, y]) => [-x, y]));
  // Gövde: ST sac vidasında sivri uç (form C), metrikte pah
  const tapping = isTapping(type);
  const c = tapping ? Math.min(1.6 * P, 0.7 * d) : Math.min(0.75 * P, d * 0.2);
  const tipR = tapping ? 0.18 * d : d / 2 - c;
  const shankTop = sunk ? -k : 0;
  const shank = [[-d / 2, shankTop], [d / 2, shankTop], [d / 2, -L + c], [tipR, -L], [-tipR, -L], [-d / 2, -L + c]];
  out.push(`<polygon class="tf-part" points="${pts(shank)}"/>`);
  out.push(`<polygon class="tf-part" points="${pts(head)}"/>`);
  // Diş dibi (ince sürekli çizgi)
  const rm = d / 2 - (tapping ? 0.33 : 0.6134) * P;
  const y0 = shankTop - (sunk ? 0.2 : 0.4);
  const y1 = -L + c * (tapping ? 0.9 : 0.6);
  out.push(`<path class="tf-thin" d="M${X(-rm)} ${Y(y0)}V${Y(y1)}M${X(rm)} ${Y(y0)}V${Y(y1)}"/>`);
  // Tahrik izi (gizli çizgi)
  const sec = driveSection(shape);
  if (sec.length) out.push(`<polyline class="tf-thin tf-hid" points="${pts(sec)}"/>`);
  // Eksen
  out.push(`<line class="tf-center" x1="${cx}" y1="${Y(maxTop) - 8}" x2="${cx}" y2="${Y(-L) + 8}"/>`);

  // Ölçüler
  const dimH = (x1, x2, y, label, from) => {
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
  const widestY = sunk ? Y(0) : type.head === 'socket' || type.head === 'cheese' ? Y(k / 2) : Y(0.12 * k);
  dimH(X(-r), X(r), Y(maxTop) - 14, `Ø${n(dkShown)}`, [widestY, widestY]);
  dimV(Y(maxTop), Y(sunk ? -k : 0), X(r) + 16, `k ${n(k)}`, [X(sunk ? r : 0.6 * r), X(sunk ? d / 2 : r)], 'right');
  dimV(Y(0), Y(-L), X(-r) - 18, `L ${n(L)}`, [X(-r), X(-d / 2)], 'left');
  dimH(X(-d / 2), X(d / 2), Y(-L) + 16, sizeLabel(size), [Y(-L + c), Y(-L + c)]);

  // Üstten görünüş
  const tcx = 268;
  const tcy = 92;
  const s2 = Math.min(s, 32 / r);
  out.push(`<circle class="tf-part" cx="${tcx}" cy="${tcy}" r="${r * s2}"/>`);
  if (sunk && sz.dk_actual) out.push(`<circle class="tf-thin" cx="${tcx}" cy="${tcy}" r="${(d / 2) * s2}" stroke-dasharray="3 2"/>`);
  for (const poly of driveOutline(shape)) {
    out.push(`<polygon class="tf-recess" points="${poly.map(([x, y]) => `${(tcx + x * s2).toFixed(2)},${(tcy - y * s2).toFixed(2)}`).join(' ')}"/>`);
  }
  out.push(`<text class="tf-cap" x="${tcx}" y="${tcy + r * s2 + 16}" text-anchor="middle">Üstten</text>`);
  out.push(`<text class="tf-cap" x="${tcx}" y="${tcy + r * s2 + 30}" text-anchor="middle">${esc(driveText(type, sz))}</text>`);
  out.push('<text class="tf-cap" x="8" y="14">Yan görünüş</text>');

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
  const types = libraryTypes(library);
  const closedGroups = new Set();
  let draft = null;

  const typeById = (id) => types.find((t) => t.id === id) || types[0];

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
    q('.tb-item[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function renderTree() {
    const item = (t) => `
      <button type="button" class="tb-item" role="treeitem" data-type="${t.id}" aria-selected="${t.id === draft.type}" title="${esc(t.name)}">
        ${headIcon(t.head)}<span class="tb-item-text"><span class="tb-code">${esc(t.code)}</span><span class="tb-name">${esc(t.short)}</span></span>
      </button>`;
    q('#tb-tree').innerHTML = `
      <div class="tb-node"><span class="tb-caret" aria-hidden="true"></span><strong>${esc(library.standard)}</strong><span class="tb-count">${types.length} tip</span></div>
      ${library.categories.map((cat) => cat.soon
        ? `<div class="tb-node lvl1 soon"><span class="tb-caret" aria-hidden="true"></span>${esc(cat.label)}<span class="tb-soon">yakında</span></div>`
        : `<div class="tb-node lvl1"><span class="tb-caret" aria-hidden="true"></span>${esc(cat.label)}</div>
          ${(cat.groups || []).map((g) => `
            <div class="tb-group-node ${closedGroups.has(g.id) ? 'closed' : ''}" role="group">
              <button type="button" class="tb-node lvl2" data-group="${g.id}" aria-expanded="${!closedGroups.has(g.id)}">
                <span class="tb-caret" aria-hidden="true"></span>${esc(g.label)}<span class="tb-count">${g.types.length}</span>
              </button>
              <div class="tb-group-items">${g.types.map(item).join('')}</div>
            </div>`).join('')}`).join('')}`;
  }

  function render() {
    renderTree();
    const t = typeById(draft.type);
    const table = screwTable(fasteners, t);
    const screwBySize = (size) => table.find((x) => x.size === size) || null;
    const ev = evaluate(draft);
    const info = ev?.auto?.fastenInfo || null;
    const minHole = ev?.auto?.usedHoleMinD ?? null;
    const sizes = Object.keys(t.sizes);
    const fits = (size) => minHole === null || (screwBySize(size)?.min_pcb_hole ?? 99) <= minHole + 1e-6;
    const autoSize = (info && sizes.includes(info.size) ? info.size : null) || [...sizes].reverse().find(fits) || sizes[0];
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

    q('#tb-figure').innerHTML = screwFigure(t, sz, effSize, screw ? screw.d : parseFloat(effSize.replace(/^[A-Z]+/, '')), figL);
    q('#tb-designation').textContent = designation(t, effSize, figL);

    const sizeChips = [`<button type="button" class="chip" data-size="auto" aria-checked="${draft.size === 'auto'}">Otomatik <span class="chip-sub">${esc(autoSize)}</span></button>`]
      .concat(sizes.map((size) => `<button type="button" class="chip ${fits(size) ? '' : 'bad'}" data-size="${esc(size)}" aria-checked="${draft.size === size}"` +
        ` ${fits(size) ? '' : `disabled title="Ø${n(minHole)} PCB deliğinden geçmez"`}>${esc(size)}</button>`)).join('');
    const stLabel = { ok: 'uygun', short: 'kısa', adapt: 'uyarlanır', long: 'uzun', na: '' };
    const lenChips = [`<button type="button" class="chip" data-len="auto" aria-checked="${draft.length === 'auto'}">Otomatik <span class="chip-sub">${autoL ? n(autoL) + ' mm' : '–'}</span></button>`]
      .concat(lenInfo.map((li) => `<button type="button" class="chip len ${li.status}" data-len="${li.L}" aria-checked="${String(draft.length) === String(li.L)}"` +
        ` title="${esc(li.status === 'na' ? '' : `${stLabel[li.status]}${li.eng === undefined ? '' : li.eng <= 0 ? " · standoff'a ulaşmıyor" : ` · ${n(li.eng)} mm tutunur`}${li.need ? ` · PCB altı ${n(li.need)} mm olur` : ''}`)}">${n(li.L)}</button>`)).join('');

    const selInfo = lenInfo.find((li) => li.L === selL);
    let lenNote = '';
    if (!ev) lenNote = 'Kart yüklenince her boyun bu karttaki tutunması gösterilir.';
    else if (selInfo && selInfo.status === 'ok') lenNote = `<span class="t-ok">✓ Uygun:</span> ${n(selInfo.eng)} mm tutunur (en az ${n(info.minEngage)} mm).`;
    else if (selInfo && selInfo.status === 'short') {
      lenNote = selInfo.eng <= 0
        ? `<span class="t-warn">Kısa:</span> standoff'a ulaşmıyor; kapak + kart ${n(info.grip)} mm, en az ${n(info.grip + info.minEngage)} mm boy gerekir.`
        : `<span class="t-warn">Kısa:</span> yalnızca ${n(selInfo.eng)} mm tutunur (en az ${n(info.minEngage)} mm).`;
    } else if (selInfo && selInfo.status === 'adapt') lenNote = `<span class="t-accent">Uyarlanır:</span> PCB altı yükseklik ${n(selInfo.need)} mm olur, muhafaza yükselir.`;
    else if (selInfo && selInfo.status === 'long') lenNote = '<span class="t-warn">Uzun:</span> PCB altı yüksekliği elle girildiği için delik bu vidaya yetmez.';

    const tapping = isTapping(t);
    const method = info?.method || (tapping ? 'self_tap' : 'insert');
    const bodySide = !screw ? '–'
      : method === 'insert' ? `insert Ø${n(screw.insert_hole)} × ${n(screw.insert_length)}`
        : method === 'tapped' ? `kılavuz, matkap Ø${n(screw.tap_drill)}`
          : tapping ? `ön delik Ø${n(screw.selftap_pilot)} (diş vidayla açılır)` : `ön delik Ø${n(screw.selftap_pilot)}`;
    const sunk = t.head === 'countersunk';
    const rows = [
      ['Standart', `${t.code} · ${t.name}`],
      ['Tahrik', `${DRIVE_LABEL[t.drive_kind] || ''} · ${driveText(t, sz)}`],
      ['Baş', `Ø${n(sz.dk_actual || sz.dk)} × ${n(sz.k)} mm${sunk ? ` · 90° havşa${sz.dk_actual ? ` (teorik Ø${n(sz.dk)})` : ''}` : ''}`],
      ['Diş', tapping ? `${effSize} sac vidası dişi, adım ${n(sz.P)} (ISO 1478)` : `${effSize} × ${n(sz.P)} (kaba)`],
      ['Kapak deliği', screw ? `Ø${n(screw.clearance)}${sunk ? ` + havşa Ø${n(sz.dk + 0.3)}` : ''}` : '–'],
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
    const grp = e.target.closest('[data-group]');
    if (grp) {
      const id = grp.dataset.group;
      if (closedGroups.has(id)) closedGroups.delete(id); else closedGroups.add(id);
      renderTree();
      return;
    }
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
