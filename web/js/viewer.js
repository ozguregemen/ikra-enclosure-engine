/*
 * 3B önizleme (three.js). Yalnızca gösterir; geometri hesabı yapmaz.
 * Koordinatlar CAD alışkanlığına uygun olarak Z yukarı kabul edilir.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ViewCube } from './viewcube.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildScrew, buildInsert, buildWasher, buildNut, buildStandoff, buildPanelPart, createFastenerMaterials } from './fastener-meshes.js';

// Kameranın hedeften bakan yönü (izleyicinin bulunduğu taraf)
const VIEW_DIRS = {
  iso: [1, -1, 0.85],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};
const ANIM_MS = 380;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Z yukarı kamerada tam üst/alt bakışta yön belirsiz kalmasın diye çok küçük −Y payı */
function safeDir(v) {
  const d = v.clone().normalize();
  if (Math.abs(d.z) > 0.9995) d.set(0, -0.002, Math.sign(d.z)).normalize();
  return d;
}

const DEFAULT_COLOR = [0.62, 0.65, 0.69];
const BOARD_COLOR = [0.12, 0.48, 0.28];
// Dosyada renk yoksa ya da hepsi aynıysa bileşenleri ayırt etmek için kullanılan palet
const PART_PALETTE = [
  [0.55, 0.58, 0.64], [0.78, 0.55, 0.30], [0.36, 0.56, 0.73], [0.60, 0.48, 0.71],
  [0.42, 0.65, 0.54], [0.72, 0.42, 0.42], [0.77, 0.69, 0.31], [0.37, 0.64, 0.64],
];

/** Ağların renkleri anlamlı mı? Hiç renk yoksa ya da hepsi aynıysa false. */
function hasMeaningfulColors(meshes) {
  const keys = new Set();
  for (const m of meshes) {
    if (m.color) keys.add(m.color.map((v) => v.toFixed(3)).join(','));
    for (const f of m.faces || []) if (f.color) keys.add(f.color.map((v) => v.toFixed(3)).join(','));
    if (keys.size > 1) return true;
  }
  return false;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class Viewer {
  constructor(container, { onPick, cubeContainer } = {}) {
    this.container = container;
    this.onPick = onPick || (() => {});
    this.materialCache = new Map();
    this.partMeshes = new Map();
    this.highlighted = null;
    this.guidesVisible = true;
    this.modelBox = null;
    this.analysis = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -120, 100);
    this.scene.add(this.camera);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x7d8594, 1.5);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    const headlight = new THREE.DirectionalLight(0xffffff, 1.8);
    headlight.position.set(0.6, 1, 0.4);
    const headTarget = new THREE.Object3D();
    headTarget.position.set(0, 0, -1);
    this.camera.add(headlight, headTarget);
    headlight.target = headTarget;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.render());
    this.controls.addEventListener('start', () => { this.anim = null; });

    this.cube = cubeContainer
      ? new ViewCube(cubeContainer, this.camera,
        (dir) => this.orientTo(dir, { fit: false }),
        (dx, dy) => this.orbitBy(dx, dy))
      : null;

    this.modelGroup = new THREE.Group();
    this.guideGroup = new THREE.Group();
    this.gridGroup = new THREE.Group();
    this.enclosureGroup = new THREE.Group();
    this.scene.add(this.modelGroup, this.guideGroup, this.gridGroup, this.enclosureGroup);
    this.enclosure = null;
    this.encOpts = { base: true, lid: true, pcb: true, transparent: true, exploded: false };
    this.enclosureMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    this.enclosureEdgeMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 });

    this.highlightMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide,
      emissiveIntensity: 0.35, polygonOffset: true, polygonOffsetFactor: -1,
    });
    // İnceleme bulgusu "Göster": vurgulanan muhafaza parçası
    this.focusMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide, transparent: true, opacity: 0.7,
      emissiveIntensity: 0.3, depthWrite: false,
    });
    this.focusedPart = null;

    this.applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.refreshTheme());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setupPicking();
    this.buildGrid(new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 0)));
    this.render();
  }

  applyTheme() {
    const accent = new THREE.Color(cssVar('--accent') || '#0b7285');
    this.scene.background = new THREE.Color(cssVar('--viewer-bg') || '#e9edf1');
    this.highlightMaterial.color.copy(accent);
    this.highlightMaterial.emissive.copy(accent);
    this.focusMaterial.color.copy(accent);
    this.focusMaterial.emissive.copy(accent);
    this.enclosureMaterial.color.set(cssVar('--enclosure') || '#a9bccf');
    this.enclosureEdgeMaterial.color.set(cssVar('--enclosure-edge') || '#4a5866');
    this.cube?.applyTheme();
  }

  /** Tema değişti (sistem tercihi ya da uygulamadaki seçim): renkler belirteçlerden yeniden okunur */
  refreshTheme() {
    this.applyTheme();
    this.rebuildHelpers();
    this.render();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.renderer.render(this.scene, this.camera);
      this.cube?.render();
    });
  }

  materialFor(rgb) {
    const c = rgb || DEFAULT_COLOR;
    const key = c.map((v) => v.toFixed(3)).join(',');
    let mat = this.materialCache.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace),
        roughness: 0.62,
        metalness: 0.08,
        side: THREE.DoubleSide,
      });
      this.materialCache.set(key, mat);
    }
    return mat;
  }

  clear() {
    this.clearEnclosure();
    for (const child of [...this.modelGroup.children]) {
      child.geometry.dispose();
      this.modelGroup.remove(child);
    }
    for (const mat of this.materialCache.values()) mat.dispose();
    this.materialCache.clear();
    this.partMeshes.clear();
    this.highlighted = null;
    this.clearGroup(this.guideGroup);
    this.modelBox = null;
    this.analysis = null;
  }

  clearGroup(group) {
    for (const child of [...group.children]) {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
      group.remove(child);
    }
  }

  /** meshes: işçiden gelen ağlar, analysis: analyzeAssembly çıktısı */
  setModel(meshes, analysis) {
    this.clear();
    this.analysis = analysis;
    const boardPartId = analysis.board ? analysis.board.partId : -1;

    const partOf = new Int32Array(meshes.length).fill(-1);
    for (const p of analysis.parts) for (const i of p.meshIdx) partOf[i] = p.id;
    const useFileColors = hasMeaningfulColors(meshes);
    const paletteColor = (partId) => (partId === boardPartId ? BOARD_COLOR
      : PART_PALETTE[((partId % PART_PALETTE.length) + PART_PALETTE.length) % PART_PALETTE.length]);

    meshes.forEach((m, i) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
      if (m.normal && m.normal.length === m.position.length) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
      } else {
        geometry.computeVertexNormals();
      }
      geometry.setIndex(new THREE.BufferAttribute(m.index, 1));

      const partId = partOf[i];
      const baseColor = useFileColors ? (m.color || (partId === boardPartId ? BOARD_COLOR : null)) : paletteColor(partId);
      let material;
      if (useFileColors && m.faces && m.faces.some((f) => f.color)) {
        const mats = [];
        const slot = new Map();
        for (const f of m.faces) {
          const mat = this.materialFor(f.color || baseColor);
          if (!slot.has(mat)) { slot.set(mat, mats.length); mats.push(mat); }
          geometry.addGroup(f.first * 3, (f.last - f.first + 1) * 3, slot.get(mat));
        }
        material = mats;
      } else {
        material = this.materialFor(baseColor);
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.partId = partId;
      mesh.userData.baseMaterial = material;
      this.modelGroup.add(mesh);
      if (!this.partMeshes.has(partId)) this.partMeshes.set(partId, []);
      this.partMeshes.get(partId).push(mesh);
    });

    this.modelBox = new THREE.Box3().setFromObject(this.modelGroup);
    this.rebuildHelpers();
    this.setView('iso', { animate: false });
  }

  /** Muhafaza dahil görüntülenen her şeyin sınır kutusu */
  viewBox() {
    if (!this.modelBox) return null;
    const box = this.modelBox.clone();
    if (this.enclosure) box.union(new THREE.Box3().setFromObject(this.enclosureGroup));
    return box;
  }

  /**
   * meshes: { base: {position, normal, index}, lid: {...}, clip?: {...} } — cad-worker çıktısı (clip: DIN ray klipsi)
   * screws: [{x, y, z (baş alt yüzü), d, headD, headH, length, lid}] — yalnızca görsel
   */
  setEnclosure(meshes, { explodeOffset = 20, screws = [], inserts = [], panel = [] } = {}) {
    this.clearEnclosure();
    this.enclosure = {};
    for (const key of ['base', 'lid', 'clip']) {
      const m = meshes[key];
      if (!m) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
      geometry.setIndex(new THREE.BufferAttribute(m.index, 1));
      const holder = new THREE.Group();
      holder.add(new THREE.Mesh(geometry, this.enclosureMaterial));
      holder.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), this.enclosureEdgeMaterial));
      this.enclosureGroup.add(holder);
      this.enclosure[key] = holder;
    }
    // Vidalar ve dişli burçlar: diş helisi, oyulmuş tahrik izi, tırtıllı insert, tel Helicoil (yalnızca görsel)
    const mats = this.fastenerMaterials();
    for (const s of screws) {
      if (!s.length) continue;
      const g = buildScrew(s, mats);
      g.position.set(s.x, s.y, s.z + (s.seat || 0));
      if (s.washer) {
        const w = buildWasher(s.washer, mats);
        w.position.set(s.x, s.y, s.z);
        (s.lid ? this.enclosure.lid : this.enclosure.base).add(w);
      }
      (s.lid ? this.enclosure.lid : this.enclosure.base).add(g);
    }
    for (const b of inserts) {
      if (b.kind === 'nut') {
        const g = buildNut(b, mats);
        g.position.set(b.x, b.y, b.zTop);
        this.enclosure.base.add(g);
        continue;
      }
      if (b.kind === 'standoff') {
        const g = buildStandoff(b, mats);
        g.position.set(b.x, b.y, b.zBottom);
        this.enclosure.base.add(g);
        if (b.bottom?.kind === 'screw' && b.bottom.length) {
          // Alttan vida: üst vidayla aynı tip; ters çevrilip taban altına oturur
          const top = screws.find((s) => Math.abs(s.x - b.x) < 1e-6 && Math.abs(s.y - b.y) < 1e-6) || screws[0];
          if (top) {
            const bs = buildScrew({ ...top, length: b.bottom.length, seat: 0, washer: null }, mats);
            bs.rotation.x = Math.PI;
            bs.position.set(b.x, b.y, b.zBase);
            this.enclosure.base.add(bs);
          }
        } else if (b.bottom?.kind === 'nut') {
          const n = buildNut({ shape: 'hex', s: b.bottom.s, m: b.bottom.m, dIn: b.dIn, P: b.P, material: b.bottom.material }, mats);
          n.position.set(b.x, b.y, b.zBase);
          this.enclosure.base.add(n);
        }
        continue;
      }
      const g = buildInsert(b, mats);
      g.position.set(b.x, b.y, b.z);
      this.enclosure.base.add(g);
    }
    // Panel elemanları: yerel +Z dışa bakan yöne çevrilip dış yüz noktasına oturtulur
    const zAxis = new THREE.Vector3(0, 0, 1);
    for (const v of panel) {
      const g = buildPanelPart(v, mats);
      g.quaternion.setFromUnitVectors(zAxis, new THREE.Vector3(...v.dir).normalize());
      g.position.set(...v.anchor);
      (v.part === 'lid' ? this.enclosure.lid : this.enclosure.base).add(g);
    }
    this.explodeOffset = explodeOffset;
    this.applyEnclosureOptions();
    this.rebuildHelpers();
    this.render();
  }

  /**
   * Metal bağlantı elemanı malzemeleri. Yansıma için oda ortamından (RoomEnvironment) üretilen ortam haritası
   * yalnızca bu malzemelere verilir; muhafaza ve kart renkleri etkilenmez. İlk kullanımda bir kez hazırlanır.
   */
  fastenerMaterials() {
    if (!this._fastenerMats) {
      let env = null;
      try {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
      } catch (err) {
        console.warn('Ortam haritası oluşturulamadı', err);
      }
      this._fastenerMats = createFastenerMaterials(env);
    }
    return this._fastenerMats;
  }

  clearEnclosure() {
    this.focusedPart = null;
    for (const holder of [...this.enclosureGroup.children]) {
      holder.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.enclosureGroup.remove(holder);
    }
    this.enclosure = null;
    this.modelGroup.visible = true;
  }

  setEnclosureOptions(opts) {
    Object.assign(this.encOpts, opts);
    this.applyEnclosureOptions();
    this.rebuildHelpers();
    this.render();
  }

  applyEnclosureOptions() {
    if (!this.enclosure) return;
    const o = this.encOpts;
    this.enclosure.base.visible = o.base;
    this.enclosure.lid.visible = o.lid;
    this.enclosure.lid.position.z = o.exploded ? this.explodeOffset : 0;
    // DIN klipsi gövdeyle birlikte görünür; patlatılmış görünüşte aşağı ayrılır
    if (this.enclosure.clip) {
      this.enclosure.clip.visible = o.base;
      this.enclosure.clip.position.z = o.exploded ? -Math.max(15, this.explodeOffset * 0.9) : 0;
    }
    this.modelGroup.visible = o.pcb;
    const mat = this.enclosureMaterial;
    mat.transparent = o.transparent;
    mat.opacity = o.transparent ? 0.32 : 1;
    mat.depthWrite = !o.transparent;
    mat.needsUpdate = true;
  }

  rebuildHelpers() {
    this.clearGroup(this.guideGroup);
    const box = this.viewBox();
    if (!box || box.isEmpty()) return;
    this.buildGrid(box);

    const a = this.analysis;
    if (a && a.board) {
      const toBox3 = (b) => new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
      const boardHelper = new THREE.Box3Helper(toBox3(a.board.box), new THREE.Color(cssVar('--accent')));
      const envHelper = new THREE.Box3Helper(toBox3(a.envelope.box), new THREE.Color(cssVar('--envelope')));
      this.guideGroup.add(envHelper, boardHelper);

      // Montaj deliği işaretleri
      const ringMat = new THREE.LineBasicMaterial({ color: new THREE.Color(cssVar('--accent')) });
      for (const h of a.holes || []) {
        if (!h.mount) continue;
        const pts = [];
        const r = h.d / 2 + 0.8;
        for (let i = 0; i < 48; i++) {
          const t = (i / 48) * Math.PI * 2;
          pts.push(new THREE.Vector3(h.x + r * Math.cos(t), h.y + r * Math.sin(t), a.board.top + 0.05));
        }
        this.guideGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
      }
    }
    this.guideGroup.visible = this.guidesVisible;
  }

  buildGrid(box) {
    this.clearGroup(this.gridGroup);
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, 20) * 1.6;
    const step = niceStep(span / 12);
    const divisions = Math.max(2, Math.round(span / step));
    const grid = new THREE.GridHelper(divisions * step, divisions,
      new THREE.Color(cssVar('--grid-major')), new THREE.Color(cssVar('--grid-minor')));
    grid.rotation.x = Math.PI / 2;
    const c = box.getCenter(new THREE.Vector3());
    grid.position.set(c.x, c.y, box.min.z - Math.max(size.z, 1) * 0.002);
    this.gridGroup.add(grid);
  }

  setGuidesVisible(on) {
    this.guidesVisible = on;
    this.guideGroup.visible = on;
    this.render();
  }

  /** Adlandırılmış görünüş: iso, top, front, back, right, left (modele sığdırarak) */
  setView(key, { animate = true } = {}) {
    this.orientTo(new THREE.Vector3(...(VIEW_DIRS[key] || VIEW_DIRS.iso)), { fit: true, animate });
  }

  /**
   * Yön küpü sürüklenince kamerayı hedef etrafında döndürür (piksel cinsinden hareket).
   * İşaretler OrbitControls ile aynı: sağa sürükle → model sağa döner, aşağı → üstü görünür.
   * Z yukarı küresel koordinat: θ = XY düzleminde açı, φ = +Z'den kutup açısı.
   */
  orbitBy(dxPx, dyPx) {
    const K = (2 * Math.PI) / 320; // rad / piksel: küp genişliğinde (~112 px) yaklaşık 125°
    this.anim = null;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const r = offset.length();
    if (!(r > 0)) return;
    let theta = Math.atan2(offset.y, offset.x);
    let phi = Math.acos(THREE.MathUtils.clamp(offset.z / r, -1, 1));
    theta -= dxPx * K;
    phi = THREE.MathUtils.clamp(phi - dyPx * K, 0.002, Math.PI - 0.002);
    offset.set(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi));
    this.camera.position.copy(target).add(offset);
    this.camera.up.set(0, 0, 1);
    this.controls.update();
    this.render();
  }

  /** Mevcut bakış yönünü koruyarak modeli ekrana sığdır */
  fit() {
    const dir = this.camera.position.clone().sub(this.controls.target);
    this.orientTo(dir, { fit: true });
  }

  fitParams(boxIn = null, margin = 1.08) {
    const box = boxIn || this.viewBox();
    if (!box || box.isEmpty()) return null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    let dist = Math.max(sphere.radius, 1) / Math.sin(halfFov);
    if (this.camera.aspect < 1) dist /= this.camera.aspect;
    return { center: sphere.center, dist: dist * margin };
  }

  /**
   * İnceleme bulgusunu 3B'de göster: PCB bileşeni (partId) vurgulanır ya da muhafaza parçası (base | lid | clip)
   * renklendirilir; kamera mevcut bakış yönünü koruyarak o öğeye yaklaşır. Gösterilecek bir şey yoksa false.
   */
  focus({ partId = null, part = null } = {}) {
    this.clearFocus();
    if (partId !== null && partId !== undefined && this.partMeshes.has(partId)) {
      this.highlight(partId);
      const box = new THREE.Box3();
      for (const m of this.partMeshes.get(partId)) box.expandByObject(m);
      this.orientTo(this.camera.position.clone().sub(this.controls.target), { fit: true, box, margin: 2.4 });
      return true;
    }
    const holder = part && this.enclosure ? this.enclosure[part] : null;
    if (holder) {
      if (!this.encOpts[part === 'clip' ? 'base' : part]) this.setEnclosureOptions({ [part === 'clip' ? 'base' : part]: true });
      const mesh = holder.children.find((c) => c.isMesh);
      if (mesh) { mesh.material = this.focusMaterial; this.focusedPart = { mesh }; }
      this.orientTo(this.camera.position.clone().sub(this.controls.target), { fit: true, box: new THREE.Box3().setFromObject(holder), margin: 1.3 });
      this.render();
      return true;
    }
    if (part === 'all' && this.enclosure) { this.fit(); return true; }
    return false;
  }

  clearFocus() {
    if (this.focusedPart?.mesh) this.focusedPart.mesh.material = this.enclosureMaterial;
    this.focusedPart = null;
    this.highlight(null);
  }

  /**
   * Kamerayı hedefin dir yönündeki tarafa çevirir (yumuşak geçişle).
   * fit: true ise hedef ve uzaklık modele (ya da verilen kutuya) göre yeniden hesaplanır; değilse korunur.
   */
  orientTo(dirIn, { fit = false, animate = true, box = null, margin = 1.08 } = {}) {
    const fp = this.fitParams(box, margin);
    const toDir = safeDir(dirIn);
    const fromTarget = this.controls.target.clone();
    const fromOffset = this.camera.position.clone().sub(fromTarget);
    const fromDist = fromOffset.length() || 1;
    const fromDir = fromOffset.clone().normalize();
    const toTarget = fit && fp ? fp.center.clone() : fromTarget.clone();
    const toDist = fit && fp ? fp.dist : fromDist;
    if (fp) {
      this.camera.near = Math.max(Math.min(toDist, fromDist) / 200, 0.01);
      this.camera.far = Math.max(toDist, fromDist) * 50;
      this.camera.updateProjectionMatrix();
    }
    const q = new THREE.Quaternion().setFromUnitVectors(fromDir, toDir);
    const apply = (t) => {
      const qt = new THREE.Quaternion().slerp(q, t);
      const dir = fromDir.clone().applyQuaternion(qt);
      const target = fromTarget.clone().lerp(toTarget, t);
      const dist = fromDist + (toDist - fromDist) * t;
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(dir, dist);
      this.camera.up.set(0, 0, 1);
      this.controls.update();
      this.render();
    };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) { this.anim = null; apply(1); return; }
    const start = performance.now();
    const token = {};
    this.anim = token;
    const step = (now) => {
      if (this.anim !== token) return;
      const t = Math.min(1, (now - start) / ANIM_MS);
      apply(easeInOut(t));
      if (t < 1) requestAnimationFrame(step);
      else this.anim = null;
    };
    requestAnimationFrame(step);
  }

  highlight(partId) {
    if (this.highlighted === partId) return;
    if (this.highlighted !== null) {
      for (const m of this.partMeshes.get(this.highlighted) || []) m.material = m.userData.baseMaterial;
    }
    this.highlighted = partId ?? null;
    if (this.highlighted !== null) {
      for (const m of this.partMeshes.get(this.highlighted) || []) m.material = this.highlightMaterial;
    }
    this.render();
  }

  setupPicking() {
    const el = this.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4 || !this.modelGroup.children.length || !this.modelGroup.visible) return;
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, this.camera);
      const hit = raycaster.intersectObjects(this.modelGroup.children, false)[0];
      this.onPick(hit ? hit.object.userData.partId : null);
    });
  }
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}
