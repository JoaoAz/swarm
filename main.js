// main.js: monta a cena, escolhe o caminho Desktop (bloom) ou VR (glow por geometria)
// e corre tudo com renderer.setAnimationLoop.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { TIMELINE } from './timeline.js';
import { Environment } from './scene/environment.js';
import { NeonLines } from './structure/neonLines.js';
import { Swarm } from './swarm/agents.js';
import { Director } from './director.js';
import { SwarmAudio } from './audio.js';
import { setupXR, isQuestBrowser } from './xr/session.js';
import { smooth } from './util/math.js';

const params = new URLSearchParams(location.search);
const QUEST = isQuestBrowser();
// N = 300 no Desktop, 120 no Quest (pode-se forçar com ?n=)
const N = +(params.get('n') || (QUEST ? 120 : 300));
if (params.has('noloop')) TIMELINE.loop = false;

// ------------------------------------------------------------------ renderer e cena
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUEST ? 1 : 1.5)); // pixel ratio limitado
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 600);
const EYE = new THREE.Vector3(0, 1.6, 0);
camera.position.copy(EYE);
const rig = new THREE.Group(); // o utilizador fica parado na origem, no eixo do corredor
rig.add(camera);
scene.add(rig);

const listener = new THREE.AudioListener();
camera.add(listener);

const env = new Environment(scene, { reflections: true });
env.makeFader(camera);

const lines = new NeonLines(2800, { mirror: true });
lines.addToScene(scene);

const swarm = new Swarm(Math.max(N, QUEST ? 200 : 600));
swarm.setCount(N);
swarm.addToScene(scene, { mirror: true });

const audio = new SwarmAudio(listener);
const director = new Director({ lines, swarm, env, audio });

// ------------------------------------------------------------------ pós-processamento (só Desktop)
// render target com MSAA (4 amostras): sem isto as linhas finas ficam serrilhadas e o bloom
// transforma o serrilhado em "contas" ao longo das linhas
const composerTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, composerTarget);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), +(params.get('bloom') ?? 0.7), 0.22, 0.6);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ------------------------------------------------------------------ app / estado
const app = { cinematic: params.has('cinematic'), started: false };
const overlay = document.getElementById('overlay');

function startSequence(fromXR = false) {
  audio.start();
  if (!app.started || fromXR) { director.reset(); if (params.has('t')) director.seek(+params.get('t')); }
  director.play();
  app.started = true;
  overlay.classList.add('hidden');
}
document.getElementById('start').addEventListener('click', () => startSequence(false));

setupXR(renderer, {
  onStart: () => {
    // em VR não há bloom: o halo das linhas fica um pouco mais largo para compensar
    lines.uniforms.uGlowBoost.value = 1.35;
    setPixel(2 * Math.tan(50 * Math.PI / 180) / 1800); // ~Quest: 100° de FOV, ~1800 px por olho
    startSequence(true);
  },
  onEnd: () => {
    lines.uniforms.uGlowBoost.value = 1;
    onResize();
    camera.position.copy(EYE); camera.quaternion.identity();
  },
});

// ------------------------------------------------------------------ olhar à volta (Desktop)
const look = { yaw: 0, pitch: 0.08, dragging: false, lx: 0, ly: 0 };
const cv = renderer.domElement;
cv.addEventListener('pointerdown', (e) => { look.dragging = true; look.lx = e.clientX; look.ly = e.clientY; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointerup', (e) => { look.dragging = false; cv.releasePointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => {
  const locked = document.pointerLockElement === cv;
  if (!look.dragging && !locked) return;
  const dx = locked ? e.movementX : e.clientX - look.lx, dy = locked ? e.movementY : e.clientY - look.ly;
  look.lx = e.clientX; look.ly = e.clientY;
  look.yaw -= dx * 0.0035; look.pitch = Math.max(-1.3, Math.min(1.45, look.pitch - dy * 0.0035));
});
cv.addEventListener('dblclick', () => cv.requestPointerLock && cv.requestPointerLock());

// modo cinemático: keyframes de timeline.js com interpolação suave
const _p = new THREE.Vector3(), _l = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
function cinematicCamera(t) {
  const K = TIMELINE.cinematic;
  let k = 0;
  while (k < K.length - 2 && t > K[k + 1].t) k++;
  const A = K[k], B = K[k + 1];
  const u = smooth(0, 1, (t - A.t) / (B.t - A.t));
  _p.fromArray(A.pos).lerp(_a.fromArray(B.pos), u);
  _l.fromArray(A.look).lerp(_b.fromArray(B.look), u);
  camera.position.copy(_p);
  camera.lookAt(_l);
}

// tamanho de 1 px por metro de distância: as linhas garantem um núcleo com ~1 px no mínimo
function setPixel(v) { lines.uniforms.uPixel.value = v; env.walls.uniforms.uPixel.value = v; }
function onResize() {
  setPixel(2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (window.innerHeight * renderer.getPixelRatio()));
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
onResize();

// ------------------------------------------------------------------ debug (só Desktop)
let debug = null;
if (!QUEST && !params.has('nogui')) {
  import('./debug.js').then(({ setupDebug }) => { debug = setupDebug({ director, swarm, bloom, audio, app }); });
}

// ------------------------------------------------------------------ ciclo
const clock = new THREE.Clock();
const stats = { frames: 0, acc: 0, fps: 0 };
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  director.advance(dt);
  director.applyVisuals();
  lines.update(dt, director.t);
  swarm.updateRender(dt);
  env.splatHeat(swarm.pos, swarm.n, swarm.alive);

  if (renderer.xr.isPresenting) {
    renderer.render(scene, camera);          // caminho leve: sem pós-processamento
  } else {
    if (app.cinematic) cinematicCamera(director.t);
    else if (window.__freeze) { /* câmara controlada pela consola */ }
    else { camera.position.copy(EYE); camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ'); }
    composer.render();
  }
  if (debug) debug.update();
  stats.frames++; stats.acc += dt;
  if (stats.acc > 1) { stats.fps = stats.frames / stats.acc; stats.frames = 0; stats.acc = 0; }
});

if (params.has('autostart')) startSequence(false);

// para testes e afinação na consola
window.__swarm = { director, swarm, lines, env, audio, renderer, camera, stats, app };
