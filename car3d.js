import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const loader = new GLTFLoader().setDRACOLoader(
  new DRACOLoader().setDecoderPath(import.meta.resolve('three/addons/libs/draco/gltf/')));
const cars = new Map();
let stage;

function setup(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.2;
  controls.addEventListener('start', () => { controls.autoRotate = false; });
  new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }).observe(container);
  renderer.setAnimationLoop(() => { if (container.offsetParent) { controls.update(); renderer.render(scene, camera); } });
  return { scene, camera, controls };
}

function loadCar(id) {
  if (!cars.has(id)) cars.set(id, loader.loadAsync(`cars/${id}.glb`).then(({ scene }) => {
    const paints = new Set();
    scene.traverse((o) => { if (o.material?.userData.wrap) paints.add(o.material); });
    return { scene, paints: [...paints] };
  }).catch((err) => { cars.delete(id); throw err; }));
  return cars.get(id);
}

// The car UI paints the wrap over white, so transparent (off-car) pixels never tint the body.
function wrapTexture(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const tmp = new OffscreenCanvas(img.width, img.height);
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.anisotropy = 8;
  return tex;
}

export async function show(container, id, wrap) {
  stage ??= setup(container);
  const car = await loadCar(id);
  const { scene, camera, controls } = stage;
  if (stage.car !== car) {
    if (stage.car) scene.remove(stage.car.scene);
    scene.add(car.scene);
    stage.car = car;
    const box = new THREE.Box3().setFromObject(car.scene);
    const size = box.getSize(new THREE.Vector3()).length();
    controls.target.copy(box.getCenter(new THREE.Vector3()));
    camera.position.copy(controls.target).add(new THREE.Vector3(-0.75, 0.32, 0.62).multiplyScalar(size * 1.85));
    controls.minDistance = size * 0.8;
    controls.maxDistance = size * 2.5;
    controls.autoRotate = true;
  }
  if (car.wrap !== wrap) {
    const tex = wrapTexture(wrap);
    for (const m of car.paints) {
      m.map?.dispose();
      m.map = tex;
      tex.channel = m.userData.wrapTexCoord ?? 0;
      m.color.set(0xffffff);
      m.aoMap = null; // Tesla's AO bake doesn't line up in three.js and blacks out the body
      m.needsUpdate = true;
    }
    car.wrap = wrap;
  }
}
