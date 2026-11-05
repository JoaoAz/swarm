// structure/neonLines.js
// Todas as linhas de néon num só buffer: cada segmento é um quad (4 vértices) expandido
// no vertex shader, sempre virado para a câmara. O fragment shader desenha um núcleo fino
// branco-rosado e um halo vermelho à volta, o que dá "glow" mesmo sem bloom (caminho VR).
// O estado de construção [lo, hi] (0..1 ao longo do segmento) é um atributo: crescer ou
// encolher uma linha só muda floats, nunca se recria geometria.
// O reflexo no chão é o mesmo geometry desenhado outra vez com uMirror = 1 (y -> -y).

import * as THREE from 'three';

const vert = /* glsl */`
  attribute vec3 aA;
  attribute vec3 aB;
  attribute vec4 aState;   // lo, hi, intensidade, seed
  attribute vec2 aCorner;  // x: 0 = ponta lo, 1 = ponta hi; y: -1/1 lado
  uniform float uMirror;
  uniform float uWidth;     // meia-largura mínima do halo (m)
  uniform float uPxAngle;   // meia-largura do halo em função da distância
  uniform float uPixel;     // tamanho de 1 px por metro de distância (tan(fov/2)*2/altura)
  uniform float uGlowBoost;
  varying vec2 vLocal;      // (ao longo, de lado) em metros, para a cápsula
  varying float vLen;
  varying float vW;
  varying float vCore;      // meia-largura do núcleo em fração de vW
  varying float vInt;
  varying float vDist;
  varying float vMirrorDepth;
  varying vec3 vWorld;
  void main() {
    float lo = aState.x, hi = aState.y;
    vInt = aState.z;
    vec3 A = aA, B = aB;
    if (uMirror > 0.5) { A.y = -A.y; B.y = -B.y; }
    vec3 dir = B - A;
    float L = length(dir);
    dir = L > 1e-5 ? dir / L : vec3(1.0, 0.0, 0.0);
    vec3 p = mix(A, B, mix(lo, hi, aCorner.x));
    float dist = length(cameraPosition - p);
    // o vetor lateral é o MESMO nas 4 esquinas (calculado no ponto médio): o quad fica plano.
    // Calculado por vértice, o quad torcia-se nas peças próximas e os dois triângulos
    // interpolavam o halo de forma diferente, o que se via como um tracejado.
    vec3 mid = mix(A, B, 0.5 * (lo + hi));
    vec3 side = normalize(cross(dir, normalize(cameraPosition - mid)) + vec3(1e-6));
    float w = max(uWidth, dist * uPxAngle) * uGlowBoost;
    // núcleo com pelo menos ~0,75 px de meia-largura: sem isto fica tracejado e o bloom "corta-o"
    float core = max(0.010, dist * uPixel * 0.75);
    w = max(w, core * 3.0);
    float len = L * (hi - lo);
    if (hi - lo < 1e-4) w = 0.0;
    // o quad estende-se w para lá de cada ponta: as pontas são semicírculos (cápsula)
    float e = aCorner.x * 2.0 - 1.0;
    p += dir * e * w + side * aCorner.y * w;
    vLocal = vec2(aCorner.x * len + e * w, aCorner.y * w);
    vLen = len;
    vW = max(w, 1e-5);
    vCore = core / max(w, 1e-5);
    vDist = dist;
    vWorld = p;
    vMirrorDepth = uMirror > 0.5 ? -p.y : 0.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const frag = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform vec3 uWarm;
  uniform float uMirror;
  uniform float uOpacity;
  uniform float uFogDensity;
  uniform float uGlobal;
  uniform float uPulse;
  uniform float uWaveZ;
  uniform float uWaveAmp;
  uniform float uTime;
  varying vec2 vLocal;
  varying float vLen;
  varying float vW;
  varying float vCore;
  varying float vInt;
  varying float vDist;
  varying float vMirrorDepth;
  varying vec3 vWorld;
  void main() {
    // distância ao eixo do segmento (cápsula), normalizada pela meia-largura
    float s = vLocal.x;
    float dx = s < 0.0 ? -s : (s > vLen ? s - vLen : 0.0);
    float d = length(vec2(dx, vLocal.y)) / vW;
    if (d >= 1.0) discard;
    // antialiasing do núcleo em espaço de ecrã (fwidth), para não serrilhar
    float fw = max(fwidth(d), 1e-4);
    float core = 1.0 - smoothstep(vCore - fw, vCore + fw, d);
    // halo que chega a zero exatamente na borda do quad: sem arestas visíveis
    float win = (1.0 - d * d); win *= win;
    float glow = (exp(-d * d * 9.0) * 0.5 + exp(-d * 4.0) * 0.12) * win;
    float wave = uWaveAmp * exp(-pow((vWorld.z - uWaveZ) / 7.0, 2.0));
    float flicker = 0.95 + 0.05 * sin(uTime * 23.0 + vWorld.z * 0.21 + vWorld.y * 0.13);
    float I = vInt * uGlobal * flicker * (1.0 + uPulse + wave * 2.5);
    vec3 halo = mix(uColor, uWarm, 0.25 + 0.25 * sin(vWorld.z * 0.045 + vWorld.x * 0.08));
    vec3 col = halo * glow * I * 1.25 + uHot * core * I * (1.1 + wave);
    float fog = exp(-pow(uFogDensity * vDist, 2.0));
    col *= fog;
    if (uMirror > 0.5) col *= uOpacity * exp(-vMirrorDepth * 0.14);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class NeonLines {
  constructor(capacity, { mirror = true, width = 0.08, pxAngle = 0.0024 } = {}) {
    this.capacity = capacity;
    this.count = 0;
    const n = capacity;
    this.A = new Float32Array(n * 3);
    this.B = new Float32Array(n * 3);
    this.state = new Float32Array(n * 4); // lo, hi, intensidade, seed
    this.weight = new Float32Array(n).fill(1);
    this.flash = new Float32Array(n);

    const g = new THREE.BufferGeometry();
    const corner = new Float32Array(n * 8);
    const index = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      corner.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8);
      const v = i * 4;
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    this.aA = new THREE.BufferAttribute(new Float32Array(n * 12), 3).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.BufferAttribute(new Float32Array(n * 12), 3).setUsage(THREE.DynamicDrawUsage);
    this.aState = new THREE.BufferAttribute(new Float32Array(n * 16), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 12), 3)); // não usado, só para o three
    g.setAttribute('aA', this.aA);
    g.setAttribute('aB', this.aB);
    g.setAttribute('aState', this.aState);
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;

    this.uniforms = {
      uColor: { value: new THREE.Color('#ff1a2a') },
      uWarm: { value: new THREE.Color('#ff3b1a') },
      uHot: { value: new THREE.Color('#ffd6dc') },
      uMirror: { value: 0 },
      uOpacity: { value: 0.3 },
      uWidth: { value: width },
      uPxAngle: { value: pxAngle },
      uGlowBoost: { value: 1 },
      uPixel: { value: 2 * Math.tan((70 / 2) * Math.PI / 180) / 900 },
      uFogDensity: { value: 0.011 },
      uGlobal: { value: 1 },
      uPulse: { value: 0 },
      uWaveZ: { value: 1000 },
      uWaveAmp: { value: 0 },
      uTime: { value: 0 },
    };
    const mk = (mirrorVal) => new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag,
      uniforms: { ...this.uniforms, uMirror: { value: mirrorVal } },
      // blending MAX (não aditivo): onde duas peças ou halos se sobrepõem não há "contas"
      // mais brilhantes nas juntas; fica o mais brilhante dos dois, como um tubo de néon contínuo
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mk(0));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    if (mirror) {
      this.mirrorMesh = new THREE.Mesh(g, mk(1));
      this.mirrorMesh.frustumCulled = false;
      this.mirrorMesh.renderOrder = 1;
    }
    this._dirtyMin = Infinity; this._dirtyMax = -1;
    this._dirtyPos = false;
  }

  addToScene(scene) { scene.add(this.mesh); if (this.mirrorMesh) scene.add(this.mirrorMesh); }

  allocate(a, b, weight = 1, seed = Math.random()) {
    const i = this.count++;
    if (i >= this.capacity) throw new Error('NeonLines: capacidade esgotada');
    this.setEnds(i, a, b);
    this.weight[i] = weight;
    this.state.set([0, 0, weight, seed], i * 4);
    this._mark(i);
    this.geometry.setDrawRange(0, this.count * 6);
    return i;
  }

  reset() {
    this.count = 0;
    this.state.fill(0);
    this.flash.fill(0);
    this.geometry.setDrawRange(0, 0);
    this._dirtyMin = 0; this._dirtyMax = this.capacity - 1;
  }

  setEnds(i, a, b) {
    this.A[i * 3] = a[0]; this.A[i * 3 + 1] = a[1]; this.A[i * 3 + 2] = a[2];
    this.B[i * 3] = b[0]; this.B[i * 3 + 1] = b[1]; this.B[i * 3 + 2] = b[2];
    this._mark(i);
  }
  setRange(i, lo, hi) { this.state[i * 4] = lo; this.state[i * 4 + 1] = hi; this._mark(i); }
  lo(i) { return this.state[i * 4]; }
  hi(i) { return this.state[i * 4 + 1]; }
  doFlash(i, amount = 1.5) { this.flash[i] = amount; this._mark(i); }

  _mark(i) { if (i < this._dirtyMin) this._dirtyMin = i; if (i > this._dirtyMax) this._dirtyMax = i; }

  // decai os flashes e envia para a GPU só o intervalo alterado
  update(dt, time) {
    this.uniforms.uTime.value = time;
    const f = this.flash, st = this.state, w = this.weight;
    for (let i = 0; i < this.count; i++) {
      if (f[i] > 0) {
        f[i] = Math.max(0, f[i] - dt * 2.2);
        st[i * 4 + 2] = w[i] * (1 + f[i]);
        this._mark(i);
      }
    }
    if (this._dirtyMax < this._dirtyMin) return;
    const lo = this._dirtyMin, hi = Math.min(this._dirtyMax, this.capacity - 1);
    const A = this.aA.array, B = this.aB.array, S = this.aState.array;
    for (let i = lo; i <= hi; i++) {
      for (let v = 0; v < 4; v++) {
        const o3 = (i * 4 + v) * 3, o4 = (i * 4 + v) * 4;
        A[o3] = this.A[i * 3]; A[o3 + 1] = this.A[i * 3 + 1]; A[o3 + 2] = this.A[i * 3 + 2];
        B[o3] = this.B[i * 3]; B[o3 + 1] = this.B[i * 3 + 1]; B[o3 + 2] = this.B[i * 3 + 2];
        S[o4] = st[i * 4]; S[o4 + 1] = st[i * 4 + 1]; S[o4 + 2] = st[i * 4 + 2]; S[o4 + 3] = st[i * 4 + 3];
      }
    }
    for (const [attr, size] of [[this.aA, 3], [this.aB, 3], [this.aState, 4]]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo * 4 * size, (hi - lo + 1) * 4 * size);
      attr.needsUpdate = true;
    }
    this._dirtyMin = Infinity; this._dirtyMax = -1;
  }
}
