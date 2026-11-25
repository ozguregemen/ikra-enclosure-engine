/*
 * 3B önizleme (three.js). Yalnızca gösterir; geometri hesabı yapmaz.
 * Koordinatlar CAD alışkanlığına uygun olarak Z yukarı kabul edilir.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const VIEW_DIRS = {
  iso: [1, -1, 0.85],
  top: [0, -0.0001, 1],
  front: [0, -1, 0],
  right: [1, 0, 0],
};

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
  constructor(container, { onPick } = {}) {
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

    this.applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.applyTheme();
      this.rebuildHelpers();
      this.render();
    });

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
    this.enclosureMaterial.color.set(cssVar('--enclosure') || '#a9bccf');
    this.enclosureEdgeMaterial.color.set(cssVar('--enclosure-edge') || '#4a5866');
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
    this.setView('iso');
  }

  /** Muhafaza dahil görüntülenen her şeyin sınır kutusu */
  viewBox() {
    if (!this.modelBox) return null;
    const box = this.modelBox.clone();
    if (this.enclosure) box.union(new THREE.Box3().setFromObject(this.enclosureGroup));
    return box;
  }

  /** meshes: { base: {position, normal, index}, lid: {...} } — cad-worker çıktısı */
  setEnclosure(meshes, { explodeOffset = 20 } = {}) {
    this.clearEnclosure();
    this.enclosure = {};
    for (const key of ['base', 'lid']) {
      const m = meshes[key];
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
    this.explodeOffset = explodeOffset;
    this.applyEnclosureOptions();
    this.rebuildHelpers();
    this.render();
  }

  clearEnclosure() {
    for (const holder of [...this.enclosureGroup.children]) {
      for (const child of holder.children) child.geometry.dispose();
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
    }
    const size = box.getSize(new THREE.Vector3());
    const axes = new THREE.AxesHelper(Math.max(size.x, size.y, size.z) * 0.22);
    axes.position.copy(box.min);
    this.guideGroup.add(axes);
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

  setView(key) {
    const box = this.viewBox();
    if (!box || box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = new THREE.Vector3(...(VIEW_DIRS[key] || VIEW_DIRS.iso)).normalize();
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    let dist = sphere.radius / Math.sin(halfFov);
    if (this.camera.aspect < 1) dist /= this.camera.aspect;
    dist *= 1.08;
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 200, 0.01);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.update();
    this.render();
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
