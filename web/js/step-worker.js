/*
 * STEP okuma işçisi (Web Worker).
 * OpenCascade'in WebAssembly derlemesi olan occt-import-js ile STEP dosyasını
 * okur, üçgen ağa çevirir ve sonucu ana iş parçacığına aktarır. Ağır iş burada
 * yapıldığı için arayüz donmaz. Dosya hiçbir sunucuya gönderilmez.
 */

const OCCT_VERSION = '0.0.23';
const OCCT_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;

importScripts(OCCT_BASE + 'occt-import-js.js');

let occtPromise = null;

function getOcct() {
  if (!occtPromise) {
    occtPromise = occtimportjs({ locateFile: (path) => OCCT_BASE + path });
    occtPromise.catch(() => { occtPromise = null; });
  }
  return occtPromise;
}

const IMPORT_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};

self.onmessage = async (ev) => {
  const { id, buffer } = ev.data;
  try {
    self.postMessage({ id, type: 'progress', stage: 'engine' });
    const occt = await getOcct();

    self.postMessage({ id, type: 'progress', stage: 'parse' });
    const t0 = performance.now();
    const result = occt.ReadStepFile(new Uint8Array(buffer), IMPORT_PARAMS);
    const parseMs = performance.now() - t0;

    if (!result || !result.success) {
      throw new Error('STEP dosyası okunamadı. Dosya bozuk olabilir ya da desteklenmeyen bir STEP sürümü içeriyor olabilir.');
    }
    if (!result.meshes || result.meshes.length === 0) {
      throw new Error('Dosyada 3B katı model bulunamadı.');
    }

    const transfer = [];
    const meshes = result.meshes.map((m) => {
      const position = new Float32Array(m.attributes.position.array);
      const normal = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const index = new Uint32Array(m.index.array);
      transfer.push(position.buffer, index.buffer);
      if (normal) transfer.push(normal.buffer);
      return {
        name: m.name || '',
        color: m.color || null,
        faces: (m.brep_faces || []).map((f) => ({ first: f.first, last: f.last, color: f.color || null })),
        position,
        normal,
        index,
      };
    });

    self.postMessage({ id, type: 'result', root: result.root, meshes, parseMs }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
