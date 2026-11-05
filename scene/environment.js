// scene/environment.js
// Fundo preto, névoa exponencial preto-avermelhada, chão escuro e brilhante com padrão
// de circuito impresso quase invisível que se acende quando os cursores passam perto,
// linhas de perspetiva nas paredes e a esfera de fade para preto.

import * as THREE from 'three';
import { NeonLines } from '../structure/neonLines.js';
import { wallPerspectiveLines } from '../structure/blueprints.js';

export const FLOOR = { x0: -115, x1: 115, z0: 115, z1: -115 }; // zona do cruzamento com mapa de calor
const HEAT_W = 128, HEAT_H = 128;

const floorVert = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const floorFrag = /* glsl */`
  uniform sampler2D uHeat;
  uniform vec4 uBounds;       // x0, x1, z0, z1
  uniform float uFogDensity;
  uniform vec3 uFogColor;
  uniform vec3 uColor;
  uniform vec3 uAmbient;     // cor da iluminação ambiente (muda com a timeline)
  uniform float uGlow;        // iluminação geral do chão (sobe com a estrutura)
  uniform float uWaveZ;
  uniform float uWaveAmp;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float lineAA(float d, float w) { float fw = fwidth(d); return 1.0 - smoothstep(w - fw, w + fw, d); }

  // padrão de circuito: grelha técnica + pistas por célula + pads
  float circuit(vec2 p) {
    vec2 g1 = abs(fract(p) - 0.5);
    float grid = max(lineAA(0.5 - g1.x, 0.012), lineAA(0.5 - g1.y, 0.012)) * 0.25;
    vec2 q = p / 4.0;
    vec2 g4 = abs(fract(q) - 0.5);
    grid = max(grid, max(lineAA(0.5 - g4.x, 0.006), lineAA(0.5 - g4.y, 0.006)) * 0.6);
    vec2 cell = floor(p / 2.0);
    vec2 f = fract(p / 2.0);
    float h = hash(cell);
    float tr = 0.0;
    if (h < 0.35) tr = lineAA(abs(f.y - 0.5), 0.02) * step(0.2, f.x) * step(f.x, 0.85);
    else if (h < 0.7) tr = lineAA(abs(f.x - 0.5), 0.02) * step(0.15, f.y) * step(f.y, 0.8);
    float pad = 0.0;
    if (h < 0.7) {
      vec2 c = h < 0.35 ? vec2(0.85, 0.5) : vec2(0.5, 0.8);
      float r = length(f - c);
      pad = lineAA(abs(r - 0.06), 0.015);
    }
    return max(grid, max(tr, pad));
  }

  void main() {
    vec2 uv = vec2((vWorld.x - uBounds.x) / (uBounds.y - uBounds.x), (vWorld.z - uBounds.z) / (uBounds.w - uBounds.z));
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    float heat = texture2D(uHeat, clamp(uv, 0.0, 1.0)).r * inside;
    float dist = length(cameraPosition - vWorld);
    float c = circuit(vWorld.xz) * (1.0 - smoothstep(60.0, 160.0, dist)); // sem moiré ao longe
    float wave = uWaveAmp * exp(-pow((length(vWorld.xz) - uWaveZ) / 9.0, 2.0)); // onda radial a partir do centro
    // base quase preta e um pouco brilhante; o padrão quase invisível acende com o calor
    vec3 base = uAmbient * 0.0075;
    vec3 col = base + uColor * c * (0.01 + uGlow * 0.018 + heat * 0.4 + wave * 0.2);
    col += uColor * heat * 0.02;
    // névoa exp2 (igual às linhas) + um decaimento exponencial mais suave só no chão:
    // o piso desvanece devagar até ao preto e não se vê nenhuma linha de horizonte
    float fog = exp(-pow(uFogDensity * dist, 2.0)) * exp(-dist * 0.012);
    col = mix(uFogColor, col, fog);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class Environment {
  constructor(scene, { reflections = true } = {}) {
    this.scene = scene;
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.FogExp2(0x070102, 0.011);

    // mapa de calor dos cursores (CPU -> DataTexture), em XZ
    this.heat = new Float32Array(HEAT_W * HEAT_H);
    this.heatBytes = new Uint8Array(HEAT_W * HEAT_H);
    this.heatTex = new THREE.DataTexture(this.heatBytes, HEAT_W, HEAT_H, THREE.RedFormat, THREE.UnsignedByteType);
    this.heatTex.magFilter = THREE.LinearFilter;
    this.heatTex.minFilter = THREE.LinearFilter;
    this.heatTex.needsUpdate = true;

    // chão "infinito": um plano enorme que a névoa apaga muito antes da borda
    // (o mapa de calor só cobre a zona do corredor, definida em FLOOR)
    const geo = new THREE.PlaneGeometry(4000, 4000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.floorUniforms = {
      uHeat: { value: this.heatTex },
      uBounds: { value: new THREE.Vector4(FLOOR.x0, FLOOR.x1, FLOOR.z0, FLOOR.z1) },
      uFogDensity: { value: scene.fog.density },
      uFogColor: { value: new THREE.Color().setRGB(0.0035, 0.0006, 0.0008) }, // = cor da névoa no horizonte
      uColor: { value: new THREE.Color('#ff1a2a') },
      uAmbient: { value: new THREE.Color('#ff2a3a') },
      uGlow: { value: 0 },
      uWaveZ: { value: 1000 },
      uWaveAmp: { value: 0 },
    };
    this.floor = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: floorVert, fragmentShader: floorFrag, uniforms: this.floorUniforms,
      // não escreve profundidade: o reflexo (geometria espelhada abaixo de y=0) é desenhado
      // por cima, em modo aditivo, e parece estar "dentro" do chão polido
      depthWrite: false,
    }));
    this.floor.renderOrder = 0;
    scene.add(this.floor);

    // névoa no horizonte: uma esfera enorme com um gradiente preto-avermelhado junto ao
    // horizonte e preto absoluto acima. A cor junto ao horizonte é a mesma para onde o chão
    // desvanece, por isso o piso parece prolongar-se até se perder na névoa, sem borda.
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(550, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: { uFogColor: this.floorUniforms.uFogColor },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uFogColor; varying vec3 vDir;
          void main(){ float h = exp(-max(vDir.y, 0.0) * 18.0); gl_FragColor = vec4(uFogColor * h, 1.0);
          #include <colorspace_fragment>
          }`,
        side: THREE.BackSide, depthWrite: false, fog: false,
      })
    );
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // linhas de perspetiva nas paredes (estáticas, sempre desenhadas, intensidade via uGlobal)
    const wall = wallPerspectiveLines();
    this.walls = new NeonLines(wall.length, { mirror: reflections, width: 0.05, pxAngle: 0.0018 });
    for (const s of wall) {
      const i = this.walls.allocate(s.a, s.b, s.weight, 0.5);
      this.walls.setRange(i, 0, 1);
    }
    this.walls.uniforms.uGlobal.value = 0;
    this.walls.addToScene(scene);
  }

  // esfera preta presa à câmara: funciona igual em Desktop e em VR
  makeFader(camera) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 1, depthTest: false, depthWrite: false, fog: false })
    );
    m.renderOrder = 999;
    m.frustumCulled = false;
    camera.add(m);
    this.fader = m;
    return m;
  }
  setFade(v) { this.fader.material.opacity = v; this.fader.visible = v > 0.001; }

  // cursores perto do chão aquecem o padrão de circuito
  splatHeat(positions, count, alive) {
    const H = this.heat;
    for (let i = 0; i < H.length; i++) H[i] *= 0.955;
    const sx = HEAT_W / (FLOOR.x1 - FLOOR.x0), sz = HEAT_H / (FLOOR.z1 - FLOOR.z0);
    for (let i = 0; i < count; i++) {
      if (!alive[i]) continue;
      const y = positions[i * 3 + 1];
      if (y > 7) continue;
      const k = (1 - y / 7) * 0.09;
      const fx = (positions[i * 3] - FLOOR.x0) * sx, fz = (positions[i * 3 + 2] - FLOOR.z0) * sz;
      const ix = Math.floor(fx), iz = Math.floor(fz);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x = ix + dx, z = iz + dz;
        if (x < 0 || z < 0 || x >= HEAT_W || z >= HEAT_H) continue;
        const fall = dx === 0 && dz === 0 ? 1 : (dx === 0 || dz === 0 ? 0.5 : 0.3);
        H[z * HEAT_W + x] = Math.min(1, H[z * HEAT_W + x] + k * fall);
      }
    }
    const B = this.heatBytes;
    for (let i = 0; i < H.length; i++) B[i] = H[i] * 255;
    this.heatTex.needsUpdate = true;
  }

  clearHeat() { this.heat.fill(0); }
}
