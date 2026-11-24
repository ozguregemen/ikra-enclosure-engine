/*
 * STEP metninden katı gövde adlarını kurtarma (Web Worker içinde importScripts ile yüklenir).
 *
 * Neden: Montajı tek parçaya dönüştürülmüş dosyalarda (ör. SolidWorks'te montajı
 * "parça olarak kaydet") bileşen bilgisi yalnızca MANIFOLD_SOLID_BREP adlarında kalır:
 *   'Kart_i.step-1/Waveshare_UART_TO_ETH.step-1/...-solid9'
 * occt-import-js bu alt gövde adlarını aktarmaz. Burada adları metinden okuyup her
 * gövdenin köşe noktalarının sınır kutusunu hesaplıyor, üçgen ağlarla kutu
 * eşleştirmesi yaparak adları doğru ağa bağlıyoruz.
 */

const STEP_NAME_MAX_BYTES = 80 * 1024 * 1024;

const STEP_KEEP_TYPES = new Set([
  'MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'CLOSED_SHELL', 'OPEN_SHELL', 'ORIENTED_CLOSED_SHELL',
  'ADVANCED_FACE', 'FACE_SURFACE', 'FACE_OUTER_BOUND', 'FACE_BOUND', 'EDGE_LOOP', 'VERTEX_LOOP',
  'ORIENTED_EDGE', 'EDGE_CURVE', 'VERTEX_POINT', 'CARTESIAN_POINT',
]);
const STEP_SOLID_TYPES = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS']);
const STEP_TOPO_TYPES = new Set([
  'CLOSED_SHELL', 'OPEN_SHELL', 'ORIENTED_CLOSED_SHELL', 'ADVANCED_FACE', 'FACE_SURFACE',
  'FACE_OUTER_BOUND', 'FACE_BOUND', 'EDGE_LOOP', 'VERTEX_LOOP', 'ORIENTED_EDGE', 'EDGE_CURVE', 'VERTEX_POINT',
]);

/** STEP dizgisini çözer: '' → ', \X2\hhhh\X0\ (UTF-16), \X\hh (Latin-1). */
function stepDecodeString(s) {
  return s
    .replace(/''/g, "'")
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex) => {
      let out = '';
      for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Dosyadaki uzunluk biriminin mm karşılığı. */
function stepLengthScale(text) {
  if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) return 25.4;
  const m = /LENGTH_UNIT\s*\(\s*\)[^;]*?SI_UNIT\s*\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\.\s*\)/i.exec(text);
  if (!m) return 1;
  const prefix = { '.MILLI.': 1, '.CENTI.': 10, '.DECI.': 100, '.MICRO.': 0.001, '$': 1000 };
  return prefix[m[1].toUpperCase()] ?? 1;
}

function stepMeshBox(position) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = position[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * meshes: occt-import-js ağları (position: Float32Array, name: string).
 * İsimsiz ağlara STEP metnindeki gövde adlarını yazar. Sonuç istatistiği döner.
 */
function recoverSolidNames(bytes, meshes) {
  const stats = { applied: 0, solids: 0, unnamed: 0 };
  stats.unnamed = meshes.filter((m) => !m.name).length;
  if (stats.unnamed < 2 || bytes.length > STEP_NAME_MAX_BYTES) return stats;

  const text = new TextDecoder('utf-8').decode(bytes);
  const dataStart = text.search(/\bDATA\s*;/);
  if (dataStart < 0) return stats;
  const scale = stepLengthScale(text);

  // Yalnızca topoloji ve nokta varlıklarını sakla
  const ents = new Map();
  const solids = [];
  const re = /#(\d+)\s*=\s*((?:[^;']|'(?:[^']|'')*')*);/g;
  re.lastIndex = dataStart;
  let m;
  while ((m = re.exec(text))) {
    const bodyText = m[2].trimStart();
    const t = /^([A-Z_0-9]+)/.exec(bodyText);
    if (!t || !STEP_KEEP_TYPES.has(t[1])) continue;
    const id = Number(m[1]);
    ents.set(id, { type: t[1], body: bodyText });
    if (STEP_SOLID_TYPES.has(t[1])) solids.push(id);
  }
  stats.solids = solids.length;
  if (solids.length < 2) return stats;

  const refsOf = (body) => {
    const noStrings = body.replace(/'(?:[^']|'')*'/g, "''");
    const out = [];
    for (const r of noStrings.matchAll(/#(\d+)/g)) out.push(Number(r[1]));
    return out;
  };
  const pointOf = (id) => {
    const e = ents.get(id);
    if (!e || e.type !== 'CARTESIAN_POINT') return null;
    const c = /\(\s*([-+0-9.Ee]+)\s*,\s*([-+0-9.Ee]+)\s*(?:,\s*([-+0-9.Ee]+))?\s*\)/.exec(e.body);
    return c ? [Number(c[1]) * scale, Number(c[2]) * scale, Number(c[3] || 0) * scale] : null;
  };

  const named = solids.map((id) => {
    const e = ents.get(id);
    const nm = /^[A-Z_]+\s*\(\s*'((?:[^']|'')*)'/.exec(e.body);
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const cur = ents.get(stack.pop());
      if (!cur) continue;
      if (cur.type === 'VERTEX_POINT') {
        const p = pointOf(refsOf(cur.body)[0]);
        if (p) for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], p[k]); box.max[k] = Math.max(box.max[k], p[k]); }
        continue;
      }
      for (const r of refsOf(cur.body)) {
        if (seen.has(r)) continue;
        const child = ents.get(r);
        if (child && STEP_TOPO_TYPES.has(child.type)) { seen.add(r); stack.push(r); }
      }
    }
    return { name: nm ? stepDecodeString(nm[1]).trim() : '', box };
  });

  // Kutu eşleştirmesi: ağ kutusu, gövdenin köşe kutusunu içermeli; en yakın olan seçilir.
  const meshBoxes = meshes.map((mm) => stepMeshBox(mm.position));
  const used = new Set();
  const fits = (mb, sb) => {
    const size = Math.max(mb.max[0] - mb.min[0], mb.max[1] - mb.min[1], mb.max[2] - mb.min[2]);
    const tol = 0.01 + size * 1e-4;
    for (let k = 0; k < 3; k++) {
      if (sb.min[k] < mb.min[k] - tol || sb.max[k] > mb.max[k] + tol) return false;
    }
    return true;
  };
  const distance = (mb, sb) => {
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs(mb.min[k] - sb.min[k]) + Math.abs(mb.max[k] - sb.max[k]);
    return d;
  };

  named.forEach((s, k) => {
    if (!s.name || !(s.box.min[0] <= s.box.max[0])) return;
    // Önce aynı sıradaki ağı dene (okuyucu gövdeleri genellikle dosya sırasıyla verir)
    if (k < meshes.length && !used.has(k) && !meshes[k].name && fits(meshBoxes[k], s.box) && distance(meshBoxes[k], s.box) < 0.05) {
      meshes[k].name = s.name; used.add(k); stats.applied++;
      return;
    }
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < meshes.length; i++) {
      if (used.has(i) || meshes[i].name || !fits(meshBoxes[i], s.box)) continue;
      const d = distance(meshBoxes[i], s.box) + Math.abs(i - k) * 1e-9;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { meshes[best].name = s.name; used.add(best); stats.applied++; }
  });
  return stats;
}
