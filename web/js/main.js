/*
 * Ikra Enclosure Engine — uygulama kabuğu:
 * STEP yükle → (Web Worker'da OpenCascade) oku → analiz et → tasarım arayüzü (design-ui.js) →
 * inceleme → katı model → son inceleme → çıktılar.
 * Bu dosya: uygulama çubuğu, aşama çubuğu, menüler, tema, bildirimler (durum çubuğu / bildirim / hata bandı),
 * onay pencereleri, klavye modeli, dosya girişi, proje kaydet/aç, kart analizi özeti ve otomatik test kancası.
 */
import { Viewer } from './viewer.js';
import { analyzeAssembly } from './analysis.js';
import { createDesignUI } from './design-ui.js';

const APP_VERSION = '0.22.0 (V2.1)';

const LARGE_FILE_MB = 50;

const $ = (sel) => document.querySelector(sel);
const num = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('tr-TR');
const fmt = (v) => num.format(v);

const STAGE_TEXT = {
  engine: '3B motoru hazırlanıyor… (ilk açılışta CAD çekirdeği indirilir, tek seferlik)',
  parse: 'STEP okunuyor ve üçgen ağa çevriliyor…',
};

let worker = null;
let requestSeq = 0;
let pending = null;
let current = null;
let selectedPart = null;
let projectApplied = false; // yüklenen karta (varsa) proje ayarları uygulandı

const typingTarget = (el) => !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName || ''));
const dialogOpen = () => !!document.querySelector('dialog[open]');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Bildirimler: durum çubuğu (ilerleme), bildirim (başarı/geri al), hata bandı (engellemeyen) ---------- */

const ui = {
  appVersion: APP_VERSION,

  /** Durum çubuğundaki ilerleme iletisi (engellemez); null kapatır */
  progress(text) {
    const el = $('#sb-msg');
    el.innerHTML = text ? `<span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span>` : '';
  },

  /** Kısa bildirim (role=status, kibar); isteğe bağlı eylem düğmesiyle (ör. "Geri al") */
  toast(text, { action = null, onAction = null, timeout = 6500 } = {}) {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span class="toast-text"></span>${action ? `<button type="button" class="btn sm">${esc(action)}</button>` : ''}` +
      '<button type="button" class="icon-btn" aria-label="Bildirimi kapat"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
    t.querySelector('.toast-text').textContent = text;
    let timer = null;
    const close = () => { clearTimeout(timer); t.remove(); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(close, timeout); };
    if (action) t.querySelector('.btn').addEventListener('click', () => { close(); onAction?.(); });
    t.querySelector('.icon-btn').addEventListener('click', close);
    // Üzerindeyken ya da odaktayken kapanmaz (okuma ve eylem için zaman)
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', arm);
    t.addEventListener('focusin', () => clearTimeout(timer));
    t.addEventListener('focusout', arm);
    box.appendChild(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    arm();
    return close;
  },

  /** Ekran okuyucu duyurusu (görünmez, kibar) */
  announce(text) {
    const el = $('#announcer');
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 60);
  },

  /** Hata bandı (role=alert): görüntüleyicinin üstünde, modeli kapatmaz; eylem düğmeleri isteğe bağlı */
  alert(text, { actions = [] } = {}) {
    const box = $('#alert');
    $('#alert-text').textContent = text;
    const acts = $('#alert-actions');
    acts.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn sm';
      b.textContent = a.label;
      b.addEventListener('click', () => { ui.clearAlert(); a.onClick?.(); });
      acts.appendChild(b);
    }
    box.classList.remove('hidden');
  },
  clearAlert() { $('#alert').classList.add('hidden'); },

  /** Onay penceresi: buttons [{ id, label, primary, danger }] → seçilen id (Esc/Vazgeç: null) */
  confirm({ title, html = '', buttons = [{ id: 'cancel', label: 'Vazgeç' }, { id: 'ok', label: 'Tamam', primary: true }] }) {
    const dlg = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-body').innerHTML = html;
    const acts = $('#confirm-actions');
    acts.innerHTML = '';
    return new Promise((resolve) => {
      let answer = null;
      for (const b of buttons) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`;
        el.textContent = b.label;
        el.addEventListener('click', () => { answer = b.id === 'cancel' ? null : b.id; dlg.close(); });
        acts.appendChild(el);
      }
      dlg.addEventListener('close', () => resolve(answer), { once: true });
      dlg.showModal();
      // Güvenli varsayılan: ilk (vazgeç) düğmesi odakta
      acts.querySelector('button')?.focus();
    });
  },

  selectStage: (id, opts) => selectStage(id, opts),
  setStageStatus: (id, status, sr) => setStageStatus(id, status, sr),
  openReview: (opts) => openReview(opts),
  closeReview: () => closeReview(),
  isDrawer: () => window.matchMedia('(max-width: 1199px)').matches,
};

$('#alert-close').addEventListener('click', () => ui.clearAlert());

/* ---------- Görüntüleyici ---------- */

const viewer = new Viewer($('#viewer'), {
  onPick: (id) => { viewer.clearFocus(); selectPart(id, { scroll: true }); },
  cubeContainer: $('#viewcube'),
});
$('#app-version').textContent = `v${APP_VERSION}`;
$('#foot-version').textContent = `Sürüm ${APP_VERSION}`;
$('#help-version').textContent = `Sürüm ${APP_VERSION}`;
// Görünüme tıklanınca klavye odağı görünüme geçer (tek tuş kısayolları yalnızca burada çalışır)
$('#viewer').addEventListener('pointerdown', () => $('#viewer').focus({ preventScroll: true }));

/* ---------- Aşama çubuğu (dikey sekmeler: dolaşan sekme sırası, ok tuşları, Home/End) ---------- */

const STAGES = ['kart', 'req', 'design', 'loop', 'solid', 'final', 'output'];
const stageTabs = () => [...document.querySelectorAll('#rail [role="tab"]')];

function selectStage(id, { focus = false } = {}) {
  if (!STAGES.includes(id) || !current) return;
  for (const t of stageTabs()) {
    const on = t.dataset.stage === id;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  for (const s of STAGES) $(`#panel-${s}`).classList.toggle('hidden', s !== id);
  renderRailCaption();
  $('#side').scrollTop = 0;
  if (window.matchMedia('(max-width: 767px)').matches && focus) $('#side').scrollIntoView({ block: 'start' });
  if (focus) $(`#panel-${id}`).focus({ preventScroll: true });
}
function setStageStatus(id, status, sr = '') {
  const t = $(`#rail [data-stage="${id}"]`);
  if (!t) return;
  t.dataset.status = status;
  const n = STAGES.indexOf(id) + 1;
  const glyph = {
    done: '<svg viewBox="0 0 20 20"><path d="m5.5 10.2 3 3 6-6.2"/></svg>',
    warn: '<svg viewBox="0 0 20 20"><path d="M10 5v6M10 14.5h.01"/></svg>',
    error: '<svg viewBox="0 0 20 20"><path d="M6.5 6.5l7 7M13.5 6.5l-7 7"/></svg>',
  }[status];
  t.querySelector('.stage-ico').innerHTML = glyph || `<span class="stage-num">${n}</span>`;
  t.querySelector('.stage-sr').textContent = sr ? `, ${sr}` : '';
  if (t.getAttribute('aria-selected') === 'true') renderRailCaption();
}
/** Dar ekran: aşama adları görsel olarak gizli; seçili aşamanın sırası, adı ve durumu rayın altında yazılır */
function renderRailCaption() {
  const cap = $('#rail-caption');
  const t = stageTabs().find((x) => x.getAttribute('aria-selected') === 'true');
  if (!cap || !t) return;
  const n = STAGES.indexOf(t.dataset.stage) + 1;
  const label = t.querySelector('.stage-label')?.textContent || '';
  const sr = (t.querySelector('.stage-sr')?.textContent || '').replace(/^,\s*/, '');
  cap.innerHTML = `<span class="muted">Aşama ${n}/${STAGES.length} · </span><b>${esc(label)}</b>${sr ? `<span class="muted"> · ${esc(sr)}</span>` : ''}`;
}
$('#rail').addEventListener('click', (e) => {
  const t = e.target.closest('[role="tab"]');
  if (t && !t.disabled) selectStage(t.dataset.stage);
});
$('#rail').addEventListener('keydown', (e) => {
  const tabs = stageTabs().filter((t) => !t.disabled);
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const map = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  let j;
  if (e.key in map) j = (i + map[e.key] + tabs.length) % tabs.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = tabs.length - 1;
  else return;
  e.preventDefault();
  tabs[j].focus();
  selectStage(tabs[j].dataset.stage);
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b && !b.closest('#pipeline')) selectStage(b.dataset.goto, { focus: true });
});

/* ---------- İnceleme paneli: geniş ekranda sabit, < 1200 px çekmece ---------- */

const review = $('#review');
const narrowMq = window.matchMedia('(max-width: 767px)');
// < 768 px çekmece tüm ekranı kaplar: açıkken arkadaki bölgeler etkisizleştirilir (odak görünmeyen öğeye kaçmaz)
const BEHIND_DRAWER = ['.skip-link', '.appbar', '#workspace > .rail', '#side', '#viewer-wrap', '#statusbar'];
function syncDrawerModal() {
  const modal = review.classList.contains('open') && narrowMq.matches;
  if (modal) { review.setAttribute('role', 'dialog'); review.setAttribute('aria-modal', 'true'); } else { review.removeAttribute('role'); review.removeAttribute('aria-modal'); }
  for (const sel of BEHIND_DRAWER) {
    document.querySelectorAll(sel).forEach((el) => { el.inert = modal; });
  }
}
function openReview({ focus = true } = {}) {
  if (!ui.isDrawer()) { if (focus) $('#review-title').focus(); return; }
  review.classList.add('open');
  $('#review-toggle').setAttribute('aria-expanded', 'true');
  syncDrawerModal();
  if (focus) setTimeout(() => $('#review-title').focus(), 30);
}
function closeReview({ returnFocus = false } = {}) {
  review.classList.remove('open');
  $('#review-toggle').setAttribute('aria-expanded', 'false');
  syncDrawerModal();
  if (returnFocus) $('#review-toggle').focus();
}
narrowMq.addEventListener('change', syncDrawerModal);
$('#review-toggle').addEventListener('click', () => (review.classList.contains('open') ? closeReview() : openReview()));
$('#review-close').addEventListener('click', () => closeReview({ returnFocus: true }));
review.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.isDrawer() && review.classList.contains('open') && !dialogOpen()) { e.preventDefault(); closeReview({ returnFocus: true }); }
});
window.matchMedia('(max-width: 1199px)').addEventListener('change', (m) => { if (!m.matches) closeReview(); });
// "Tasarım incelemesine geç" bağlantısı: dar ekranda inceleme kapalı çekmecededir (görünmez); bağlantı çekmeceyi açar
document.querySelectorAll('a.skip-link[href="#review"]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  openReview({ focus: true });
}));

/* ---------- Menüler (örnek kart, tema): menü düğmesi deseni ---------- */

function setupMenu(btn, pop) {
  const items = () => [...pop.querySelectorAll('[role^="menuitem"]')];
  const open = (focusIdx = 0) => {
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const it = items();
    it[Math.max(0, Math.min(it.length - 1, focusIdx < 0 ? it.length - 1 : focusIdx))]?.focus();
  };
  const close = (refocus = true) => {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(0); }
    if (e.key === 'ArrowUp') { e.preventDefault(); open(-1); }
  });
  pop.addEventListener('keydown', (e) => {
    const it = items();
    const i = it.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); it[(i + 1) % it.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); it[(i - 1 + it.length) % it.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); it[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); it[it.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
  });
  pop.addEventListener('click', (e) => { if (e.target.closest('[role^="menuitem"]')) close(); });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close(false); });
  return { open, close };
}

/* ---------- Tema: sistem / açık / koyu (bu tarayıcıda hatırlanır) ---------- */

const THEME_KEY = 'ikra.theme';
const THEME_LABEL = { system: 'Sistem ayarı', light: 'Açık', dark: 'Koyu' };
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem(THEME_KEY, t); } catch { /* depolama kapalı */ }
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeSet === t)));
  $('#theme-btn').setAttribute('aria-label', `Tema: ${THEME_LABEL[t] || THEME_LABEL.system}`);
  $('#theme-btn').title = `Tema: ${THEME_LABEL[t] || THEME_LABEL.system}`;
  viewer.refreshTheme();
}
setupMenu($('#theme-btn'), $('#theme-menu'));
$('#theme-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-set]');
  if (b) applyTheme(b.dataset.themeSet);
});
(() => {
  let t = 'system';
  try { t = localStorage.getItem(THEME_KEY) || 'system'; } catch { /* yok */ }
  applyTheme(t);
})();

/* ---------- Radyo grupları: rol, dolaşan sekme sırası ve ok tuşları (dinamik içerik dahil) ---------- */

function normalizeRadios() {
  document.querySelectorAll('.chip[aria-checked]:not([role])').forEach((el) => el.setAttribute('role', 'radio'));
  document.querySelectorAll('[role="radio"]').forEach((r) => {
    const g = r.parentElement;
    if (g && !r.closest('[role="radiogroup"]') && !g.hasAttribute('role')) g.setAttribute('role', 'radiogroup');
  });
  document.querySelectorAll('[role="radiogroup"]').forEach((g) => {
    const radios = [...g.querySelectorAll('[role="radio"]')].filter((r) => r.closest('[role="radiogroup"]') === g);
    if (!radios.length) return;
    const enabled = radios.filter((r) => !r.disabled);
    const checked = enabled.find((r) => r.getAttribute('aria-checked') === 'true') || enabled[0];
    for (const r of radios) {
      const ti = r === checked ? '0' : '-1';
      if (r.getAttribute('tabindex') !== ti) r.setAttribute('tabindex', ti);
    }
  });
}
let radioQueued = false;
new MutationObserver(() => {
  if (radioQueued) return;
  radioQueued = true;
  queueMicrotask(() => { radioQueued = false; normalizeRadios(); });
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked', 'disabled'] });
normalizeRadios();

/** Yeniden çizimden sonra eşdeğer öğeyi bul (kimlik: id ya da kapsayan kimlik + data-* öznitelikleri) */
function identityOf(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const attrs = [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('');
  if (!attrs) return null;
  const host = el.parentElement?.closest('[id]');
  return `${host ? `#${CSS.escape(host.id)} ` : ''}${el.tagName.toLowerCase()}${attrs}`;
}
/** Etkinleştirilen öğe yeniden çizilip kaybolursa odak eşdeğerine döner (klavye kullanıcısı yerini kaybetmez) */
let focusToken = 0;
function keepFocusAfter(el) {
  const sel = identityOf(el);
  const token = ++focusToken; // yeni etkinleştirme eskilerin geri yüklemesini iptal eder
  if (!sel) return;
  const restore = () => {
    if (token !== focusToken) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const n = document.querySelector(sel);
    if (n && n.offsetParent !== null) n.focus({ preventScroll: true });
  };
  for (const ms of [0, 150, 450, 1000]) setTimeout(restore, ms);
}
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('button, [role="radio"], [role="tab"], input, select, summary');
  if (el) keepFocusAfter(el);
}, true);
document.addEventListener('change', (e) => keepFocusAfter(e.target), true);

document.addEventListener('keydown', (e) => {
  const r = e.target.closest?.('[role="radio"]');
  if (!r) return;
  const g = r.closest('[role="radiogroup"]');
  if (!g) return;
  const map = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const radios = [...g.querySelectorAll('[role="radio"]')].filter((x) => x.closest('[role="radiogroup"]') === g && !x.disabled && x.offsetParent !== null);
  const i = radios.indexOf(r);
  let j;
  if (e.key in map) j = (i + map[e.key] + radios.length) % radios.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = radios.length - 1;
  else if (e.key === ' ' || e.key === 'Enter') return; // düğmenin kendi etkinleştirmesi
  else return;
  e.preventDefault();
  const next = radios[j];
  if (!next || next === r) return;
  next.focus();
  next.click();
});

/* ---------- Açılır bölümler: başlık içinde düğme (WAI-ARIA APG "disclosure") ----------
 * <h3><button data-disclosure aria-expanded aria-controls="gövde">…</button></h3> + <div id="gövde" hidden>.
 * Başlık düzeyi başlıkla gezinmede görünür kalır; Enter / Boşluk düğmenin kendi davranışıdır.
 * Durum değişince düğmeden "ikra:disclosure" olayı kabarcıklanır ({ open, key }); inceleme paneli bunu saklar.
 */
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('button[data-disclosure]');
  if (!b || b.disabled) return;
  const open = b.getAttribute('aria-expanded') !== 'true';
  b.setAttribute('aria-expanded', String(open));
  const panel = document.getElementById(b.getAttribute('aria-controls') || '');
  if (panel) panel.hidden = !open;
  b.dispatchEvent(new CustomEvent('ikra:disclosure', { bubbles: true, detail: { open, key: b.dataset.openKey || null } }));
});

/* ---------- Görünüm ve kısayollar ---------- */

$('#view-home').addEventListener('click', () => viewer.setView('iso'));
$('#view-fit').addEventListener('click', () => viewer.fit());
const helpDialog = $('#help-dialog');
$('#help-btn').addEventListener('click', () => helpDialog.showModal());
$('#help-close').addEventListener('click', () => helpDialog.close());

// Tek tuş kısayolları yalnızca 3B görünüm odaktayken (WCAG 2.1.4); yazı alanında asla
const KEY_VIEWS = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom' };
$('#viewer-wrap').addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || typingTarget(e.target) || dialogOpen()) return;
  if (!e.target.closest('#viewer')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') viewer.fit();
  else if (k === 'h') viewer.setView('iso');
  else if (k === 'g') $('#guides-btn').click();
  else if (k === 't') $('#toolbox-btn').click();
  else if (KEY_VIEWS[k]) viewer.setView(KEY_VIEWS[k]);
  else if (e.key === 'Escape') { viewer.clearFocus(); selectPart(null); }
  else return;
  e.preventDefault();
});

// Ctrl kısayolları: kaydet, aç, geri al, yinele (pencere açıkken ya da yazarken geri al/yinele çalışmaz)
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); if (!dialogOpen()) openSaveDialog(); return; }
  if (k === 'o') { e.preventDefault(); if (!dialogOpen()) $('#file-input').click(); return; }
  if (typingTarget(e.target) || dialogOpen()) return;
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); designUI.undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); designUI.redo(); }
});

const designUI = createDesignUI({ viewer, ui });

function showError(text) {
  pending = null;
  ui.progress(null);
  $('#viewer-progress').classList.add('hidden');
  ui.alert(text);
  setControlsBusy(false);
}

function setControlsBusy(busy) {
  document.querySelectorAll('[data-action="sample"]').forEach((b) => { b.disabled = busy; });
  $('#sample-btn').disabled = busy;
}

/* ---------- STEP okuma (Web Worker) ---------- */

function getWorker() {
  if (worker) return worker;
  worker = new Worker('js/step-worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    worker = null;
    showError('3B motoru yüklenemedi. İnternet bağlantısı kontrol edilip yeniden denenmeli (motor jsDelivr CDN üzerinden gelir).');
  };
  return worker;
}

function loadBuffer(buffer, fileName, sizeBytes, project = null) {
  const id = ++requestSeq;
  // İşçiye aktarılan tampon boşalır: projeye gömmek ve kimlik (SHA-256) için kopya tutulur
  const bytes = buffer.slice(0);
  pending = { id, fileName, sizeBytes, t0: performance.now(), bytes, project };
  setControlsBusy(true);
  ui.clearAlert();
  ui.progress(STAGE_TEXT.engine);
  $('#viewer-progress').classList.remove('hidden');
  getWorker().postMessage({ id, buffer }, [buffer]);
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (!pending || msg.id !== pending.id) return;
  if (msg.type === 'progress') {
    let text = STAGE_TEXT[msg.stage] || '';
    if (msg.stage === 'parse' && pending.sizeBytes > LARGE_FILE_MB * 1024 * 1024) text += ' Büyük dosya, biraz sürebilir.';
    ui.progress(text);
    return;
  }
  if (msg.type === 'error') { showError(msg.message); return; }
  if (msg.type === 'result') {
    ui.progress('Kart analiz ediliyor…');
    setTimeout(() => finishLoad(msg), 30);
  }
}

function setProjectTitle(name) {
  $('#project-name').textContent = name || '';
  $('#project-title').textContent = name || current?.fileName || 'Kart yüklenmedi';
  document.title = `${name || current?.fileName || 'Ikra'} · Ikra Enclosure Engine`;
}

function finishLoad(msg) {
  const job = pending;
  pending = null;
  try {
    const analysis = analyzeAssembly(msg.root, msg.meshes);
    selectedPart = null;
    viewer.setModel(msg.meshes, analysis);
    current = {
      fileName: job.fileName,
      sizeBytes: job.sizeBytes,
      seconds: (performance.now() - job.t0) / 1000,
      analysis,
      bytes: job.bytes,
      sha256: null,
    };
    const loaded = current;
    const hashReady = sha256Hex(job.bytes).then((h) => { loaded.sha256 = h; return h; }).catch(() => null);
    $('#empty-hint').classList.add('hidden');
    $('#start-panel').classList.add('hidden');
    $('#work').classList.remove('hidden');
    stageTabs().forEach((t) => { t.disabled = false; });
    renderSummary(current);
    renderParts(current);
    selectStage('kart');
    setStageStatus('kart', analysis.warnings.some((w) => w.level === 'warn') ? 'warn' : analysis.board ? 'done' : 'error',
      analysis.board ? 'kart bulundu' : 'kart bulunamadı');
    ui.progress(null);
    $('#viewer-progress').classList.add('hidden');
    const proj = job.project || pendingProject;
    projectApplied = false;
    setProjectTitle(proj?.name || '');
    designUI.setAnalysis(current, { deferBuild: !!proj })
      .then(async () => {
        $('#save-btn').disabled = false;
        // Proje dosyasıyla açıldıysa ya da bekleyen bir proje bu kartı bekliyorsa ayarları uygula
        if (!proj) { projectApplied = true; ui.announce(`Kart yüklendi: ${job.fileName}. Tasarım otomatik üretilip inceleniyor.`); return; }
        pendingProject = null;
        const h = await hashReady;
        const mismatch = proj.step?.sha256 && h && proj.step.sha256 !== h;
        const warnings = await designUI.importState(proj.design);
        projectApplied = true;
        if (mismatch) warnings.unshift(`Yüklenen STEP projedekinden farklı (${proj.step.fileName}); delik ve port seçimleri uyuşmayabilir.`);
        setProjectTitle(proj.name || '');
        selectStage('design');
        if (warnings.length) ui.alert(`Proje açıldı: ${proj.name || job.fileName}. ${warnings.join(' ')}`);
        else ui.toast(`Proje açıldı: ${proj.name || job.fileName}.`);
      })
      .catch((err) => {
        console.error(err);
        ui.alert('Tasarım paneli açılamadı: ' + err.message);
      });
  } catch (err) {
    console.error(err);
    showError('Model analiz edilemedi: ' + err.message);
    return;
  }
  setControlsBusy(false);
}

/* ---------- Dosya girişi ---------- */

/** Kaydedilmemiş tasarım varsa dosya değiştirmeden önce sor */
async function confirmReplace(what) {
  if (!current || !designUI.isDirty()) return true;
  const ans = await ui.confirm({
    title: 'Kaydedilmemiş değişiklikler var',
    html: `<p>Mevcut tasarımda kaydedilmemiş değişiklikler var. ${esc(what)} açılırsa bu değişiklikler kaybolur.</p>`,
    buttons: [{ id: 'cancel', label: 'Vazgeç' }, { id: 'save', label: 'Önce kaydet' }, { id: 'open', label: 'Kaydetmeden aç', primary: true, danger: true }],
  });
  if (ans === 'save') { openSaveDialog(); return false; }
  return ans === 'open';
}

async function handleFile(file) {
  if (!file) return;
  if (!(await confirmReplace(`"${file.name}"`))) return;
  if (/\.(json|ikra)$/i.test(file.name)) { openProject(file); return; }
  if (!/\.(step|stp)$/i.test(file.name)) {
    showError(`"${file.name}" bir STEP ya da Ikra proje dosyası değil. .step / .stp ya da .ikra.json dosyası seçilmeli.`);
    return;
  }
  file.arrayBuffer()
    .then((buf) => loadBuffer(buf, file.name, file.size))
    .catch(() => showError('Dosya okunamadı.'));
}

$('#file-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  handleFile(f);
});
const pickFile = () => $('#file-input').click();
$('#open-step-btn').addEventListener('click', pickFile);
$('#open-btn').addEventListener('click', pickFile);
$('#replace-btn').addEventListener('click', pickFile);
$('#dropzone').addEventListener('click', pickFile);

// Örnek kartlar: tools/make-sample-step.ps1 ile üretilen basitleştirilmiş modeller (kutu biçimli bileşenler).
// Kart dış ölçüsü, montaj delikleri ve konnektör konumları üreticinin mekanik çizimlerinden; bkz. README.
const SAMPLES = [
  { id: 'ornek-kart', label: 'Örnek kart', sub: '60 × 40 · USB-C, SMA, LED' },
  { id: 'arduino-uno-r3', label: 'Arduino UNO R3', sub: '68,6 × 53,3 · USB-B, DC jak' },
  { id: 'raspberry-pi-4b', label: 'Raspberry Pi 4 B', sub: '85 × 56 · USB, RJ45, HDMI' },
  { id: 'esp32-devkitc', label: 'ESP32-DevKitC', sub: 'modül + pin başlıkları' },
  { id: 'nucleo-64', label: 'STM32 Nucleo-64', sub: 'ST-LINK, Arduino başlıkları' },
];
const sampleById = (id) => SAMPLES.find((s) => s.id === id) || SAMPLES[0];

async function loadSample(id = 'ornek-kart', { ask = true } = {}) {
  const s = sampleById(id);
  if (ask && !(await confirmReplace(`"${s.label}" örneği`))) return;
  setControlsBusy(true);
  ui.progress(`${s.label} indiriliyor…`);
  try {
    const res = await fetch(`samples/${s.id}.step`);
    if (!res.ok) throw new Error(res.status);
    const buf = await res.arrayBuffer();
    loadBuffer(buf, `${s.id}.step`, buf.byteLength);
  } catch {
    showError(`${s.label} örnek dosyası indirilemedi.`);
  }
}
$('#sample-grid').innerHTML = SAMPLES.map((s) =>
  `<button type="button" class="sample-btn" data-action="sample" data-sample="${s.id}"><b>${esc(s.label)}</b><span>${esc(s.sub)}</span></button>`).join('');
$('#sample-menu').innerHTML = SAMPLES.map((s) =>
  `<button type="button" role="menuitem" class="menu-item" data-action="sample" data-sample="${s.id}" tabindex="-1">${esc(s.label)}<span>${esc(s.sub)}</span></button>`).join('');
setupMenu($('#sample-btn'), $('#sample-menu'));
document.querySelectorAll('[data-action="sample"]').forEach((b) => b.addEventListener('click', () => loadSample(b.dataset.sample || 'ornek-kart')));

// Pencerenin her yerine sürükle-bırak
let dragDepth = 0;
const overlay = $('#drop-overlay');
const dropzone = $('#dropzone');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  overlay.classList.remove('hidden');
  dropzone.classList.add('drag');
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) { overlay.classList.add('hidden'); dropzone.classList.remove('drag'); }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.add('hidden');
  dropzone.classList.remove('drag');
  handleFile(e.dataTransfer.files[0]);
});
// Kaydedilmemiş tasarımla sayfadan çıkılırken tarayıcı sorar
window.addEventListener('beforeunload', (e) => {
  if (current && designUI.isDirty() && !new URLSearchParams(location.search).get('selftest')) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- Proje kaydet / aç (.ikra.json) ---------- */

const PROJECT_FORMAT = 'ikra-project';
let pendingProject = null; // STEP'i gömülü olmayan, kartı bekleyen proje

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function bufToBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBuf(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}
const stemOf = (name) => String(name || 'ikra').replace(/\.(step|stp)$/i, '');

const saveDialog = $('#save-dialog');
function openSaveDialog() {
  if (!current || !designUI.hasDesign()) { ui.toast('Önce bir kart yüklenmeli.'); return; }
  $('#save-name').value = $('#project-name').textContent || stemOf(current.fileName);
  $('#save-step-size').textContent = `${(current.sizeBytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  saveDialog.showModal();
  $('#save-name').select();
}

async function saveProject() {
  const name = ($('#save-name').value || '').trim() || stemOf(current.fileName);
  const embed = $('#save-embed').checked;
  const design = designUI.exportState();
  if (!design) return;
  const hash = current.sha256 || (current.bytes ? await sha256Hex(current.bytes) : null);
  const project = {
    format: PROJECT_FORMAT,
    version: 1,
    app: APP_VERSION,
    name,
    saved: new Date().toISOString(),
    step: { fileName: current.fileName, size: current.sizeBytes, sha256: hash, ...(embed && current.bytes ? { data: bufToBase64(current.bytes) } : {}) },
    design,
  };
  const blob = new Blob([JSON.stringify(project, null, embed ? 0 : 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.ikra.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  setProjectTitle(name);
  saveDialog.close();
  designUI.markSaved();
  ui.toast(`Proje kaydedildi: ${a.download}${embed ? ' (STEP içinde)' : ' (STEP ayrı tutulmalı)'}.`);
}

async function openProject(file) {
  let proj;
  try {
    proj = JSON.parse(await file.text());
  } catch {
    showError(`"${file.name}" okunamadı: geçerli bir proje dosyası değil.`);
    return;
  }
  if (proj?.format !== PROJECT_FORMAT || !proj.design) {
    showError(`"${file.name}" bir Ikra proje dosyası değil.`);
    return;
  }
  if (proj.step?.data) {
    try {
      const buf = base64ToBuf(proj.step.data);
      loadBuffer(buf, proj.step.fileName || `${proj.name || 'proje'}.step`, buf.byteLength, proj);
    } catch {
      showError('Projedeki STEP verisi bozuk.');
    }
    return;
  }
  // STEP gömülü değil: yüklü kart aynıysa hemen uygula, değilse kartı bekle
  if (current && proj.step?.sha256 && current.sha256 === proj.step.sha256) {
    const warnings = await designUI.importState(proj.design);
    setProjectTitle(proj.name || '');
    selectStage('design');
    if (warnings.length) ui.alert(`Proje açıldı: ${proj.name}. ${warnings.join(' ')}`);
    else ui.toast(`Proje açıldı: ${proj.name}.`);
    return;
  }
  pendingProject = proj;
  ui.toast(`Proje "${proj.name || file.name}" hazır: kartın STEP dosyası (${proj.step?.fileName || 'aynı kart'}) yüklenince ayarlar otomatik uygulanır.`, { timeout: 12000, action: 'STEP seç', onAction: pickFile });
}

$('#save-btn').addEventListener('click', openSaveDialog);
$('#save-cancel').addEventListener('click', () => saveDialog.close());
$('#save-ok').addEventListener('click', (e) => { e.preventDefault(); saveProject().catch((err) => ui.alert('Proje kaydedilemedi: ' + err.message)); });

/* ---------- Görünüm araç çubuğu ---------- */

$('#guides-btn').addEventListener('click', (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  e.currentTarget.setAttribute('aria-pressed', String(on));
  viewer.setGuidesVisible(on);
});

/* ---------- Kart analizi özeti ---------- */

const mmv = (v) => `${fmt(v)} mm`;

function renderSummary({ fileName, sizeBytes, seconds, analysis: a }) {
  const el = $('#summary-panel');
  const sizeMb = sizeBytes / (1024 * 1024);
  $('#file-name').textContent = fileName;
  $('#file-name').title = fileName;
  $('#file-meta').textContent = `${sizeMb < 1 ? int.format(Math.round(sizeBytes / 1024)) + ' KB' : fmt(sizeMb) + ' MB'} · ${fmt(seconds)} sn'de okundu · ${a.partCount} parça`;

  const rows = [];
  if (a.board) {
    const b = a.board;
    rows.push(['PCB ölçüsü (sınır kutusu)', `${fmt(b.length)} × ${fmt(b.width)} × ${fmt(b.thickness)} mm`, `${b.axes.u} × ${b.axes.v} × kalınlık (${b.axes.n}) · tespit: ${b.detectedBy.join(' + ')} · "${b.name}"`]);
    rows.push(['Üst yüzeyden en yüksek', mmv(a.maxAbove.value), a.maxAbove.name || 'üstte bileşen yok']);
    rows.push(['Alt yüzeyden taşan', mmv(a.maxBelow.value), a.maxBelow.name || 'altta taşan yok']);
    rows.push(['Bileşen zarfı', `${fmt(a.envelope.length)} × ${fmt(a.envelope.width)} × ${fmt(a.envelope.height)} mm`,
      'Kart ve tüm bileşenler, taşan konnektörler dahil; duvar boşlukları ve et kalınlığı Tasarım aşamasında eklenir.']);
    rows.push(['Bileşen', `${int.format(a.partCount - 1)}`, `üst ${a.counts.top} · alt ${a.counts.bottom}`]);
    rows.push(['Kenarda / taşan', `${a.counts.edge} / ${a.counts.overhang}`, 'port açıklığı adayı']);
    const mount = (a.holes || []).filter((h) => h.mount);
    const sizes = [...new Set(mount.map((h) => 'Ø' + fmt(h.d)))].join(', ');
    const pinHoles = (a.holes || []).length - mount.length;
    rows.push(['Kart montaj deliği', `${mount.length}`, mount.length ? `${sizes}${pinHoles ? ` · ayrıca ${pinHoles} pin deliği` : ''}` : 'kart gövdesinde bulunamadı']);
  } else {
    const s = a.assemblySize;
    rows.push(['Montaj ölçüsü (sınır kutusu)', `${fmt(s[0])} × ${fmt(s[1])} × ${fmt(s[2])} mm`, 'X × Y × Z']);
    rows.push(['Parça', int.format(a.partCount), `${int.format(a.triangleCount)} üçgen`]);
  }
  let html = `<table class="spec-table"><caption class="vh">PCB analizi</caption>${rows.map(([k, v, sub]) =>
    `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</td></tr>`).join('')}</table>`;

  const notes = [...a.warnings];
  if (a.board) {
    notes.push({ level: 'info', text: `Kenar eşiği ${fmt(a.options.edgeMargin)} mm. Kenarda ya da kart dışına taşan bileşenler port açıklığı adayıdır (Tasarım › Port açıklıkları).` });
    notes.push({ level: 'info', text: 'Kart sınırı gerçek kontur değil, sınır kutusu olarak alındı; dikdörtgen olmayan kartlarda fark olabilir.' });
  }
  if (notes.length) {
    html += '<ul class="notes">' + notes.map((n) => `<li class="note ${n.level === 'warn' ? 'warn' : ''}">${n.level === 'warn' ? '<span class="vh">Uyarı: </span>' : ''}${esc(n.text)}</li>`).join('') + '</ul>';
  }
  el.innerHTML = '<h3 class="panel-title">PCB analizi</h3>' + html;
  el.classList.remove('hidden');
}
$('#report-btn').addEventListener('click', downloadReport);

/* ---------- Bileşen tablosu (satırlar klavyeyle seçilebilir) ---------- */

const SIDE_TEXT = { top: 'üst', bottom: 'alt', board: 'PCB' };

function edgeText(p) {
  if (!p.edges.length) return '';
  const parts = p.edges.map((e) => (e.kind === 'overhang' ? `${e.side} taşma ${fmt(e.value)} mm` : `${e.side} kenarda`));
  return `<span class="pill edge" aria-hidden="true">${esc(p.edges.map((e) => e.side).join(' '))}</span><span class="vh">${esc(parts.join(', '))}</span>`;
}

function renderParts({ analysis: a }) {
  const body = $('#parts-body');
  const rows = [...a.parts].sort((x, y) => {
    if (x.isBoard !== y.isBoard) return x.isBoard ? -1 : 1;
    return y.height - x.height;
  });
  body.innerHTML = rows.map((p) => {
    const side = p.side ? `<span class="pill ${p.isBoard ? 'board' : ''}">${SIDE_TEXT[p.side]}</span>` : '';
    const height = p.isBoard ? fmt(a.board.thickness) : (p.side ? fmt(p.height) : '–');
    const title = p.isBoard ? 'Kart kalınlığı' : `Üste ${fmt(p.above)} mm, alta ${fmt(p.below)} mm`;
    return `<tr data-id="${p.id}" tabindex="-1" aria-selected="false"><td class="name" title="${esc(p.name)}">${esc(p.name)}</td>` +
      `<td>${side}</td><td class="num" title="${esc(title)}">${height}</td><td>${edgeText(p)}</td></tr>`;
  }).join('');
  const first = body.querySelector('tr');
  if (first) first.tabIndex = 0;
  $('#parts-count').textContent = `${int.format(a.partCount)} parça`;
  $('#parts-panel').classList.remove('hidden');
}
// Satır: fareyle üzerine gelince ya da klavyeyle odaklanınca vurgulanır; tıklama, Enter ya da Boşluk seçer; ↑↓ satırlar arasında gezer
const partsBody = $('#parts-body');
partsBody.addEventListener('mouseover', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) viewer.highlight(Number(tr.dataset.id)); });
partsBody.addEventListener('mouseleave', () => viewer.highlight(selectedPart));
partsBody.addEventListener('focusin', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  partsBody.querySelectorAll('tr[tabindex="0"]').forEach((r) => { if (r !== tr) r.tabIndex = -1; });
  tr.tabIndex = 0;
  viewer.highlight(Number(tr.dataset.id));
});
partsBody.addEventListener('focusout', (e) => { if (!partsBody.contains(e.relatedTarget)) viewer.highlight(selectedPart); });
partsBody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = Number(tr.dataset.id);
  selectPart(selectedPart === id ? null : id);
});
partsBody.addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const id = Number(tr.dataset.id); selectPart(selectedPart === id ? null : id); return; }
  const next = e.key === 'ArrowDown' ? tr.nextElementSibling : e.key === 'ArrowUp' ? tr.previousElementSibling : null;
  if (next) { e.preventDefault(); next.focus(); }
});

function selectPart(id, { scroll = false } = {}) {
  selectedPart = id ?? null;
  viewer.highlight(selectedPart);
  document.querySelectorAll('#parts-body tr').forEach((tr) => {
    const on = Number(tr.dataset.id) === selectedPart;
    tr.classList.toggle('sel', on);
    tr.setAttribute('aria-selected', String(on));
    if (on && scroll) tr.scrollIntoView({ block: 'nearest' });
  });
}

/* ---------- Rapor ---------- */

function downloadReport() {
  if (!current) return;
  const a = current.analysis;
  const r3 = (arr) => arr.map((v) => Math.round(v * 1000) / 1000);
  const report = {
    app: 'Ikra Enclosure Engine',
    version: APP_VERSION,
    file: current.fileName,
    createdAt: new Date().toISOString(),
    units: 'mm',
    assemblySize: r3(a.assemblySize),
    board: a.board && { ...a.board, box: { min: r3(a.board.box.min), max: r3(a.board.box.max) } },
    maxAbove: a.maxAbove,
    maxBelow: a.maxBelow,
    envelope: a.envelope && { ...a.envelope, box: { min: r3(a.envelope.box.min), max: r3(a.envelope.box.max) } },
    counts: a.counts,
    holes: (a.holes || []).map((h) => ({ x: h.x, y: h.y, d: h.d, mount: h.mount, occupiedBy: h.occupiedBy })),
    warnings: a.warnings,
    design: designUI.reportSection(),
    parts: a.parts.map((p) => ({
      name: p.name,
      side: p.side,
      height: p.height,
      above: p.above,
      below: p.below,
      edges: p.edges,
      box: { min: r3(p.box.min), max: r3(p.box.max) },
    })),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = current.fileName.replace(/\.(step|stp)$/i, '') + '.ikra-analiz.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Otomatik test kancası (tools/selftest.ps1) ----------
 * index.html?selftest=<örnek-kart-id>&cfg=<JSON tasarım ayarları>&build=0|1
 * Örnek kart yüklenir, ayarlar proje dosyası gibi uygulanır, (build=1 ise) katı model üretilir;
 * sonuç konsola "IKRA-SELFTEST-RESULT <json>" ve ardından "IKRA-SELFTEST-DONE" olarak yazılır.
 */
(() => {
  const q = new URLSearchParams(location.search);
  const sample = q.get('selftest');
  if (!sample) return;
  const wantBuild = q.get('build') !== '0';
  let cfg = {};
  try { cfg = q.get('cfg') ? JSON.parse(q.get('cfg')) : {}; } catch (err) { console.log('IKRA-SELFTEST-ERROR cfg ' + err.message); }
  let done = false;
  const finish = (why) => {
    if (done) return;
    done = true;
    let out;
    try { out = { why, ...designUI.selfTest() }; } catch (err) { out = { why, error: String(err && err.stack || err) }; }
    console.log('IKRA-SELFTEST-RESULT ' + JSON.stringify(out));
    console.log('IKRA-SELFTEST-DONE');
  };
  window.addEventListener('error', (e) => console.log('IKRA-SELFTEST-ERROR ' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => console.log('IKRA-SELFTEST-ERROR ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  // Yalnızca güncel tasarımın katı modeli sonucu bitirir (eskimiş ara oluşturmalar değil)
  document.addEventListener('ikra:built', (e) => { if (!e.detail || e.detail.current !== false) finish('built'); });
  document.addEventListener('ikra:build-error', () => finish('build-error'));
  pendingProject = { name: 'selftest', design: { process: 'fdm', material: 'pla', ...cfg } };
  loadSample(sample, { ask: false });
  // Tasarım hatalıysa (muaf tutulmamış hata) ya da yalnızca hesap isteniyorsa katı model beklenmez.
  // Koşul proje ayarları uygulandıktan sonra bakılır ve 1,5 s sonra yeniden doğrulanır.
  const blockedNow = () => {
    const st = designUI.selfTest();
    const blocked = st.review ? st.review.counts.error > 0 && st.phase === 'invalid'
      : !!(st.report && st.report.checks && st.report.checks.some((c) => c.level === 'error'));
    return blocked && !st.built;
  };
  let waiting = false;
  const poll = setInterval(() => {
    if (done) { clearInterval(poll); return; }
    if (!designUI.hasDesign() || !projectApplied || waiting) return;
    if (!wantBuild || blockedNow()) {
      waiting = true;
      setTimeout(() => {
        waiting = false;
        if (!wantBuild) finish('no-build');
        else if (blockedNow()) finish('design-error');
      }, 1500);
    }
  }, 500);
  setTimeout(() => finish('timeout'), 170000);
})();
