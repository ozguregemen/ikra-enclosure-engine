/*
 * Yön küpü (ViewCube): CAD ve dilimleyici programlardaki gibi, ana kamerayla birlikte dönen
 * küçük bir küp. Yüz, kenar veya köşeye tıklamak kamerayı o yöne çevirir (26 yön).
 * Dünya Z yukarıdır: +X SAĞ, −X SOL, +Y ARKA, −Y ÖN, +Z ÜST, −Z ALT.
 */
import * as THREE from 'three';

const SIZE = 112; // CSS piksel
const EDGE_ZONE = 0.56; // yüz yarı genişliğinin bu oranından dışarısı kenar/köşe bölgesi
const AXIS_COLORS = { x: '#e03131', y: '#2f9e44', z: '#1c7ed6' };

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// BoxGeometry malzeme sırası: +x, −x, +y, −y, +z, −z. Küp X ekseninde +90° döndürülür
// (yerel +Y → dünya +Z), böylece yan yüzlerdeki yazılar Z yukarıyken dik okunur.
const FACE_LABELS = ['SAĞ', 'SOL', 'ÜST', 'ALT', 'ÖN', 'ARKA'];

function faceTexture(label, colors) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = colors.face;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = colors.border;
  g.lineWidth = 10;
  g.strokeRect(5, 5, 246, 246);
  g.fillStyle = colors.text;
  g.font = `700 ${label.length > 3 ? 50 : 58}px system-ui, "Segoe UI", Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 128, 134);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function labelSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.font = '700 46px system-ui, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 32, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(0.5, 0.5, 0.5);
  return s;
}

/** Küp üzerindeki bir noktadan bakış yönü: yüz (1 eksen), kenar (2), köşe (3) */
function regionDirection(p) {
  const d = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = p[k];
    if (Math.abs(v) > 0.999 || Math.abs(v) > EDGE_ZONE) d[k] = Math.sign(v);
  }
  return d;
}

export class ViewCube {
  /**
   * container: küpün çizileceği eleman; mainCamera: izlenecek kamera;
   * onSelect(dirVector): tıklanan yöne dön
   */
  constructor(container, mainCamera, onSelect) {
    this.container = container;
    this.mainCamera = mainCamera;
    this.onSelect = onSelect;
    this.hoverKey = '';

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(SIZE, SIZE);
    this.renderer.domElement.className = 'viewcube-canvas';
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.setAttribute('aria-label', 'Yön küpü: yüz, kenar veya köşeye tıklayarak görünüşü değiştir');
    container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);

    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), []);
    this.cube.rotation.x = Math.PI / 2;
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial());
    this.edges.rotation.x = Math.PI / 2;
    this.highlight = new THREE.Group();
    this.scene.add(this.cube, this.edges, this.highlight);

    // Eksen üçlüsü (küpün sol-ön-alt köşesinden)
    const o = new THREE.Vector3(-1.32, -1.32, -1.32);
    const triad = new THREE.Group();
    for (const [axis, dir] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) {
      const end = o.clone().add(new THREE.Vector3(...dir).multiplyScalar(1.05));
      const geom = new THREE.BufferGeometry().setFromPoints([o, end]);
      triad.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: AXIS_COLORS[axis], depthTest: false })));
      const sp = labelSprite(axis.toUpperCase(), AXIS_COLORS[axis]);
      sp.position.copy(o.clone().add(new THREE.Vector3(...dir).multiplyScalar(1.32)));
      triad.add(sp);
    }
    triad.renderOrder = 10;
    this.scene.add(triad);

    this.applyTheme();
    this.setupPointer();
  }

  applyTheme() {
    const colors = {
      face: cssVar('--cube-face', '#eef2f6'),
      border: cssVar('--cube-border', '#c3ccd6'),
      text: cssVar('--cube-text', '#3b4652'),
    };
    for (const m of this.cube.material || []) { m.map?.dispose(); m.dispose(); }
    this.cube.material = FACE_LABELS.map((l) => new THREE.MeshBasicMaterial({ map: faceTexture(l, colors) }));
    this.edges.material.color.set(cssVar('--cube-edge', '#8794a2'));
    this.highlightColor = new THREE.Color(cssVar('--accent', '#0b7285'));
    this.render();
  }

  render() {
    // Küp kamerası ana kamerayla aynı yönelimde
    this.camera.quaternion.copy(this.mainCamera.quaternion);
    this.camera.position.set(0, 0, 7.2).applyQuaternion(this.mainCamera.quaternion);
    this.renderer.render(this.scene, this.camera);
  }

  setHover(dir) {
    const key = dir ? dir.join(',') : '';
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    for (const ch of [...this.highlight.children]) { ch.geometry.dispose(); ch.material.dispose(); this.highlight.remove(ch); }
    this.renderer.domElement.style.cursor = dir ? 'pointer' : 'default';
    if (dir) {
      // Seçilen yönün dokunduğu her yüzde ilgili bölgeyi boya
      for (let a = 0; a < 3; a++) {
        if (!dir[a]) continue;
        const [b, c] = [0, 1, 2].filter((k) => k !== a);
        const range = (k) => (dir[k] ? (dir[k] > 0 ? [EDGE_ZONE, 1] : [-1, -EDGE_ZONE]) : [-EDGE_ZONE, EDGE_ZONE]);
        const [b0, b1] = range(b);
        const [c0, c1] = range(c);
        const pt = (bv, cv) => { const p = [0, 0, 0]; p[a] = dir[a] * 1.004; p[b] = bv; p[c] = cv; return new THREE.Vector3(...p); };
        const geom = new THREE.BufferGeometry().setFromPoints([pt(b0, c0), pt(b1, c0), pt(b1, c1), pt(b0, c0), pt(b1, c1), pt(b0, c1)]);
        const mat = new THREE.MeshBasicMaterial({ color: this.highlightColor, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
        this.highlight.add(new THREE.Mesh(geom, mat));
      }
    }
    this.render();
  }

  pick(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.cube, false)[0];
    return hit ? regionDirection([hit.point.x, hit.point.y, hit.point.z]) : null;
  }

  setupPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointermove', (e) => this.setHover(this.pick(e)));
    el.addEventListener('pointerleave', () => this.setHover(null));
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
      down = null;
      const dir = this.pick(e);
      if (dir) this.onSelect(new THREE.Vector3(...dir).normalize());
    });
  }
}
