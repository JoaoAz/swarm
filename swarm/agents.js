// swarm/agents.js
// Simulação do swarm em CPU (arrays tipados) + render num único InstancedMesh.
// Cada cursor é uma pequena máquina de estados; as tarefas (desenhar, apagar, arrastar)
// vêm do TaskBoard do director.

import * as THREE from 'three';
import { STEER, SpatialGrid, makeCurl, arrive } from './steering.js';
import { makeCursorAtlas, SHAPE, TIP, ARROW_FORWARD } from './cursorAtlas.js';
import { TASK } from '../director.js';
import { mulberry32, clamp } from '../util/math.js';

export const ST = { HIDDEN: 0, IDLE: 1, REACT: 2, GOTO: 3, CLICK: 4, DRAW: 5, ERASE: 6, CARRY: 7, EXIT: 8 };

const CURSOR_SIZE = 0.2; // ~20 cm
const TRAIL_LEN = 7;

const vert = /* glsl */`
  attribute vec3 iPos;
  attribute vec3 iHead;
  attribute vec4 iParams; // escala, tinta, forma, inclinação
  uniform float uMirror;
  uniform float uBaseSize;
  uniform float uMinAngle;
  uniform vec2 uTip;
  uniform float uForward;
  varying vec2 vUv;
  varying float vTint;
  varying float vDist;
  varying float vDepth;
  void main() {
    vec3 c = iPos;
    vec3 h = iHead;
    if (uMirror > 0.5) { c.y = -c.y; h.y = -h.y; }
    vec4 mv = viewMatrix * vec4(c, 1.0);
    float dist = length(mv.xyz);
    float size = max(uBaseSize, dist * uMinAngle) * iParams.x;
    // direção de movimento projetada no ecrã -> ângulo da seta (billboard em torno do eixo de visão)
    vec3 hv = (viewMatrix * vec4(h, 0.0)).xyz;
    float ang = length(hv.xy) > 1e-4 ? atan(hv.y, hv.x) : uForward;
    float shape = iParams.z;
    if (shape > 0.5) ang = uForward + (ang - uForward) * 0.25; // mão/ampulheta/cruz quase direitas
    float rot = ang - uForward;
    vec2 p = vec2(position.x - uTip.x, position.y + uTip.y);
    // inclinação nas curvas: comprime o eixo perpendicular à ponta (falso roll 3D)
    vec2 f = vec2(cos(uForward), sin(uForward));
    vec2 pf = dot(p, f) * f;
    p = pf + (p - pf) * cos(iParams.w);
    float cr = cos(rot), sr = sin(rot);
    p = vec2(cr * p.x - sr * p.y, sr * p.x + cr * p.y) * size;
    mv.xy += p;
    gl_Position = projectionMatrix * mv;
    float cx = mod(shape, 2.0), cy = floor(shape / 2.0);
    vUv = vec2(cx * 0.5 + uv.x * 0.5, (1.0 - cy * 0.5 - 0.5) + uv.y * 0.5);
    vTint = iParams.y;
    vDist = dist;
    vDepth = c.y;
    if (iParams.x < 1e-3) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  }
`;
const frag = /* glsl */`
  uniform sampler2D uAtlas;
  uniform float uMirror;
  uniform float uFogDensity;
  uniform vec3 uRed;
  uniform float uGlobal;
  varying vec2 vUv;
  varying float vTint;
  varying float vDist;
  varying float vDepth;
  void main() {
    vec4 t = texture2D(uAtlas, vUv);
    if (t.a < 0.5) discard;
    // branco abaixo do limiar do bloom (fica nítido); a desenhar passa a vermelho emissivo (brilha)
    vec3 fill = mix(vec3(0.55), uRed * 2.6, vTint);
    vec3 col = mix(vec3(0.0), fill, smoothstep(0.35, 0.75, t.r));
    // ao longe, o cursor vira um ponto quente: mais vermelho e luminoso
    float far = smoothstep(25.0, 90.0, vDist);
    col = mix(col, uRed * (1.2 + vTint), far * 0.6);
    float fog = exp(-pow(uFogDensity * vDist, 2.0));
    col *= fog * uGlobal;
    if (uMirror > 0.5) col *= 0.22 * exp(vDepth * 0.25);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class Swarm {
  constructor(maxN) {
    this.maxN = maxN;
    this.n = maxN;
    const n = maxN;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.head = new Float32Array(n * 3);
    this.noise = new Float32Array(n * 3);
    this.anchor = new Float32Array(n * 3);   // onde pairar quando está livre
    this.offset = new Float32Array(n * 3);   // posição na nuvem (elipsoide unitário)
    this.state = new Uint8Array(n);
    this.alive = new Uint8Array(n);
    this.timer = new Float32Array(n);
    this.task = new Int32Array(n).fill(-1);
    this.param = new Float32Array(n);        // "cenoura" ao longo do segmento (0..1)
    this.carryD0 = new Float32Array(n);
    this.react = new Float32Array(n);        // atraso de reação próprio de cada cursor
    this.distracted = new Uint8Array(n);
    this.wander = new Float32Array(n);
    this.spawnT = new Float32Array(n);
    this.scale = new Float32Array(n);
    this.pulse = new Float32Array(n);
    this.tint = new Float32Array(n);
    this.shape = new Uint8Array(n);
    this.bank = new Float32Array(n);
    this.exitDir = new Float32Array(n * 3);
    this.trail = new Float32Array(n * TRAIL_LEN * 3);
    this.grid = new SpatialGrid(n, 2.0);
    this._acc = [0, 0, 0];
    this._tmp = [0, 0, 0];
    this.onEvent = () => {};
    this.mode = 'cloud';
    this.cloud = { center: [0, 5, -16], radius: [7, 3, 6], breathe: 0.1, breathePeriod: 7 };
    this._buildRender();
  }

  // ---------------------------------------------------------------- render
  _buildRender() {
    const n = this.maxN;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0.5, -0.5, 0); // canto superior esquerdo na origem
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iHead = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iParams = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos);
    geo.setAttribute('iHead', this.iHead);
    geo.setAttribute('iParams', this.iParams);
    const atlas = makeCursorAtlas();
    const uniforms = {
      uAtlas: { value: atlas },
      uBaseSize: { value: CURSOR_SIZE },
      uMinAngle: { value: 0.0052 },
      uTip: { value: new THREE.Vector2(TIP[0], TIP[1]) },
      uForward: { value: ARROW_FORWARD },
      uFogDensity: { value: 0.011 },
      uRed: { value: new THREE.Color('#ff1a2a') },
      uGlobal: { value: 1 },
    };
    this.uniforms = uniforms;
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: { ...uniforms, uMirror: { value: 0 } } });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    const mmat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, uniforms: { ...uniforms, uMirror: { value: 1 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mirrorMesh = new THREE.InstancedMesh(geo, mmat, n);
    this.mirrorMesh.frustumCulled = false;
    this.mirrorMesh.renderOrder = 1;

    // rastos: segmentos de linha com cor a desvanecer, aditivos
    const tg = new THREE.BufferGeometry();
    const segs = n * (TRAIL_LEN - 1);
    this.trailPos = new THREE.BufferAttribute(new Float32Array(segs * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.trailCol = new THREE.BufferAttribute(new Float32Array(segs * 6), 3).setUsage(THREE.DynamicDrawUsage);
    tg.setAttribute('position', this.trailPos);
    tg.setAttribute('color', this.trailCol);
    this.trails = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
    }));
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 2;
  }

  addToScene(scene, { mirror = true } = {}) {
    scene.add(this.mesh, this.trails);
    if (mirror) scene.add(this.mirrorMesh);
  }

  setCount(n) {
    this.n = Math.min(n, this.maxN);
    this.mesh.count = this.n;
    this.mirrorMesh.count = this.n;
    this.trails.geometry.setDrawRange(0, this.n * (TRAIL_LEN - 1) * 2);
  }

  // ---------------------------------------------------------------- reset determinístico
  reset(seed, spawnCfg, cloud) {
    const r = mulberry32(seed);
    this.rng = mulberry32(seed + 99);
    this.curl = makeCurl(seed);
    this.cloud = cloud;
    this.mode = 'cloud';
    const n = this.n;
    this.state.fill(ST.HIDDEN); this.alive.fill(0); this.task.fill(-1);
    this.vel.fill(0); this.scale.fill(0); this.tint.fill(0); this.pulse.fill(0); this.bank.fill(0);
    this.timer.fill(0); this.shape.fill(0); this.wander.fill(0); this.noise.fill(0); this.param.fill(0);
    for (let i = 0; i < n; i++) {
      // posição na nuvem: elipsoide, mais denso no centro
      let x, y, z, d;
      do { x = r.signed(); y = r.signed(); z = r.signed(); d = x * x + y * y + z * z; } while (d > 1);
      this.offset.set([x, y, z], i * 3);
      // aparecem ao longe, espalhados no fundo do corredor
      const sp = [r.range(-14, 14), r.range(3, 18), r.range(-45, -110)];
      this.pos.set(sp, i * 3);
      this.anchor.set(sp, i * 3);
      this.head.set([r.signed() * 0.3, 1, 0], i * 3);
      this.react[i] = r.range(0.08, 0.7);
      this.distracted[i] = r() < 0.07 ? 1 : 0;
      const u = n > 1 ? i / (n - 1) : 0;
      this.spawnT[i] = spawnCfg.first + (spawnCfg.last - spawnCfg.first) * Math.pow(u, spawnCfg.curve) + r() * 0.3;
      const a = r() * Math.PI * 2;
      this.exitDir.set([Math.cos(a) * r.range(0.2, 1), 1, Math.sin(a) * r.range(0.2, 1) - 0.3], i * 3);
      for (let k = 0; k < TRAIL_LEN; k++) this.trail.set(sp, (i * TRAIL_LEN + k) * 3);
    }
    this.time = 0;
    this._trailClock = 0;
  }

  // ---------------------------------------------------------------- simulação (passo fixo)
  step(dt, t, board, lines) {
    this.time = t;
    const n = this.n, P = this.pos, V = this.vel, S = this.state;
    const acc = this._acc, tmp = this._tmp, R = this.rng;
    this.grid.build(P, n, this.alive);
    const c = this.cloud;
    const breathe = 1 + c.breathe * Math.sin((t / c.breathePeriod) * Math.PI * 2);
    const noiseT = t * STEER.noiseTime;
    const doNoise = (Math.round(t * 60) % 3);

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      if (S[i] === ST.HIDDEN) {
        if (t >= this.spawnT[i]) {
          S[i] = ST.IDLE; this.alive[i] = 1; this.pulse[i] = 1;
          this.onEvent('spawn', i, -1, P[i3], P[i3 + 1], P[i3 + 2]);
        } else continue;
      }
      let px = P[i3], py = P[i3 + 1], pz = P[i3 + 2];
      const vx = V[i3], vy = V[i3 + 1], vz = V[i3 + 2];
      acc[0] = acc[1] = acc[2] = 0;
      let vmax = STEER.idleSpeed, amax = STEER.idleAccel, noiseAmp = STEER.noiseIdle;
      let flock = false;
      const st = S[i];
      const tk = this.task[i] >= 0 ? board.tasks[this.task[i]] : null;
      this.timer[i] += dt;

      if (st === ST.IDLE || st === ST.REACT) {
        flock = true;
        // alvo de repouso: nuvem (antes de construir) ou âncora junto ao último trabalho
        let tx, ty, tz;
        if (this.mode === 'cloud') {
          tx = c.center[0] + this.offset[i3] * c.radius[0] * breathe;
          ty = c.center[1] + this.offset[i3 + 1] * c.radius[1] * breathe;
          tz = c.center[2] + this.offset[i3 + 2] * c.radius[2] * breathe;
        } else {
          tx = this.anchor[i3]; ty = this.anchor[i3 + 1]; tz = this.anchor[i3 + 2];
        }
        // cursores "distraídos": de vez em quando afastam-se e voltam
        if (this.distracted[i]) {
          if (this.wander[i] <= 0 && R() < dt * 0.06) this.wander[i] = 3 + R() * 3;
          if (this.wander[i] > 0) {
            this.wander[i] -= dt;
            tx += 9 * Math.sin(i * 1.7); ty += 3 + 2 * Math.cos(i); tz += 6 * Math.cos(i * 2.3);
          }
        }
        arrive(px, py, pz, vx, vy, vz, tx, ty, tz, vmax * (this.wander[i] > 0 ? 2 : 1.6), STEER.tauIdle, 6, tmp);
        acc[0] += tmp[0]; acc[1] += tmp[1]; acc[2] += tmp[2];
        this.shape[i] = SHAPE.ARROW;
        if (st === ST.IDLE) {
          // procurar tarefa (com um pequeno intervalo para não ser todos ao mesmo tempo)
          if (this.timer[i] > 0.12 && board.hasOpen()) {
            this.timer[i] = 0;
            const id = board.claim(i, px, py, pz, R);
            if (id >= 0) { this.task[i] = id; S[i] = ST.REACT; this.timer[i] = 0; }
          }
        } else {
          // atraso de reação; os mais lentos mostram a ampulheta
          if (this.react[i] > 0.45) this.shape[i] = SHAPE.WAIT;
          if (this.timer[i] >= this.react[i]) { S[i] = ST.GOTO; this.timer[i] = 0; }
        }
      } else if (st === ST.GOTO) {
        vmax = STEER.travelSpeed; amax = STEER.maxAccel; noiseAmp = STEER.noiseTravel;
        const g = board.grabPoint(tk, lines, tmp);
        const gx = g[0], gy = g[1], gz = g[2];
        const d = arrive(px, py, pz, vx, vy, vz, gx, gy, gz, vmax, STEER.tauTravel, STEER.arriveRadius, acc);
        noiseAmp *= clamp(d / 8, 0, 1);
        this.shape[i] = d < 1.6 ? (tk.type === TASK.DRAW ? SHAPE.CROSS : SHAPE.HAND) : SHAPE.ARROW;
        this._near = d;
        if (d < 0.3) {
          S[i] = ST.CLICK; this.timer[i] = 0;
          this.carryD0[i] = 0;
        }
      } else if (st === ST.CLICK) {
        amax = STEER.maxAccel; noiseAmp = 0;
        const g = board.grabPoint(tk, lines, tmp);
        arrive(px, py, pz, vx, vy, vz, g[0], g[1], g[2], 2, 0.06, 0.5, acc);
        this.shape[i] = tk.type === TASK.DRAW ? SHAPE.ARROW : SHAPE.HAND;
        if (this.timer[i] > 0.17) {
          this.pulse[i] = 1;
          this.onEvent('click', i, tk.slot, g[0], g[1], g[2]);
          if (tk.type === TASK.DRAW) { S[i] = ST.DRAW; this.param[i] = 0; lines.setRange(tk.slot, 0, 0.0001); }
          else if (tk.type === TASK.ERASE) { S[i] = ST.ERASE; this.param[i] = lines.hi(tk.slot); }
          else {
            S[i] = ST.CARRY;
            const s3 = tk.slot * 3;
            const mx = (tk.ta[0] + tk.tb[0]) / 2, my = (tk.ta[1] + tk.tb[1]) / 2, mz = (tk.ta[2] + tk.tb[2]) / 2;
            this.carryD0[i] = Math.max(0.5, Math.hypot(mx - px, my - py, mz - pz));
            tk.oa = [lines.A[s3], lines.A[s3 + 1], lines.A[s3 + 2]];
            tk.ob = [lines.B[s3], lines.B[s3 + 1], lines.B[s3 + 2]];
          }
          this.timer[i] = 0;
        }
      } else if (st === ST.DRAW || st === ST.ERASE) {
        vmax = STEER.travelSpeed; amax = STEER.maxAccel * 1.5; noiseAmp = STEER.noiseDraw;
        const s3 = tk.slot * 3, A = lines.A, B = lines.B;
        const ax = A[s3], ay = A[s3 + 1], az = A[s3 + 2];
        const dx = B[s3] - ax, dy = B[s3 + 1] - ay, dz = B[s3 + 2] - az;
        const L = Math.max(1e-3, Math.hypot(dx, dy, dz));
        const dir = st === ST.DRAW ? 1 : -1;
        // a "cenoura" avança ao longo do segmento; o cursor segue-a de perto
        const cx = ax + dx * this.param[i], cy = ay + dy * this.param[i], cz = az + dz * this.param[i];
        const lag = Math.hypot(cx - px, cy - py, cz - pz);
        const spd = st === ST.DRAW ? STEER.drawSpeed : STEER.eraseSpeed;
        if (lag < 0.6) this.param[i] = clamp(this.param[i] + dir * (spd / L) * dt * (1 - lag / 0.6 * 0.5), 0, 1);
        arrive(px, py, pz, vx, vy, vz, cx, cy, cz, vmax, STEER.tauDraw, 0.8, acc);
        // a linha vai até à projeção da ponta do cursor (nunca à frente da cenoura)
        let proj = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / (L * L);
        this.shape[i] = st === ST.DRAW ? SHAPE.ARROW : SHAPE.HAND;
        if (st === ST.DRAW) {
          proj = clamp(Math.min(proj, this.param[i]), 0, 1);
          if (proj > lines.hi(tk.slot)) lines.setRange(tk.slot, 0, proj);
          if (this.param[i] >= 1 && lag < 0.12) {
            lines.setRange(tk.slot, 0, 1); lines.doFlash(tk.slot, 1.4);
            this.onEvent('lit', i, tk.slot, px, py, pz);
            this._finish(i, board, px, py, pz);
          }
        } else {
          proj = clamp(Math.max(proj, this.param[i]), 0, 1);
          if (proj < lines.hi(tk.slot)) lines.setRange(tk.slot, 0, proj);
          if (this.param[i] <= 0 && lag < 0.15) {
            lines.setRange(tk.slot, 0, 0);
            this.onEvent('erased', i, tk.slot, px, py, pz);
            this._finish(i, board, px, py, pz);
          }
        }
      } else if (st === ST.CARRY) {
        vmax = STEER.carrySpeed; amax = STEER.maxAccel * 0.6; noiseAmp = STEER.noiseCarry;
        const mx = (tk.ta[0] + tk.tb[0]) / 2, my = (tk.ta[1] + tk.tb[1]) / 2, mz = (tk.ta[2] + tk.tb[2]) / 2;
        const d = arrive(px, py, pz, vx, vy, vz, mx, my, mz, vmax, STEER.tauTravel * 1.2, 3, acc);
        noiseAmp *= clamp(d / 5, 0, 1);
        this.shape[i] = SHAPE.HAND;
        // o segmento vai preso à mão: centro = cursor, orientação/comprimento em morph
        const s = clamp(1 - d / this.carryD0[i], 0, 1);
        const e = s * s * (3 - 2 * s);
        const ohx = (tk.ob[0] - tk.oa[0]) / 2, ohy = (tk.ob[1] - tk.oa[1]) / 2, ohz = (tk.ob[2] - tk.oa[2]) / 2;
        const nhx = (tk.tb[0] - tk.ta[0]) / 2, nhy = (tk.tb[1] - tk.ta[1]) / 2, nhz = (tk.tb[2] - tk.ta[2]) / 2;
        const hx = ohx + (nhx - ohx) * e, hy = ohy + (nhy - ohy) * e, hz = ohz + (nhz - ohz) * e;
        tmp[0] = px - hx; tmp[1] = py - hy; tmp[2] = pz - hz;
        lines.setEnds(tk.slot, tmp, [px + hx, py + hy, pz + hz]);
        if (d < 0.25) {
          lines.setEnds(tk.slot, tk.ta, tk.tb); lines.setRange(tk.slot, 0, 1); lines.doFlash(tk.slot, 1.8);
          this.pulse[i] = 1;
          this.onEvent('placed', i, tk.slot, mx, my, mz);
          this._finish(i, board, px, py, pz);
        }
      } else if (st === ST.EXIT) {
        vmax = 13; amax = 9; noiseAmp = STEER.noiseIdle * 1.5;
        const e3 = this.exitDir;
        const k = Math.min(1, this.timer[i] / 1.5);
        acc[0] += (e3[i3] * 5 * k - vx) * 1.2;
        acc[1] += (e3[i3 + 1] * 11 * k - vy) * 1.2;
        acc[2] += (e3[i3 + 2] * 5 * k - vz) * 1.2;
      }

      // separação (sempre) + alinhamento e coesão leves (só livres)
      let sx = 0, sy = 0, sz = 0, ax2 = 0, ay2 = 0, az2 = 0, cx2 = 0, cy2 = 0, cz2 = 0, cnt = 0;
      const sepR = STEER.sepRadius, alR = STEER.alignRadius;
      this.grid.forNeighbors(px, py, pz, (j) => {
        if (j === i) return;
        const j3 = j * 3;
        const dx = px - P[j3], dy = py - P[j3 + 1], dz = pz - P[j3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < sepR * sepR && d2 > 1e-6) {
          const f = (1 - Math.sqrt(d2) / sepR) / Math.sqrt(d2);
          sx += dx * f; sy += dy * f; sz += dz * f;
        }
        if (flock && d2 < alR * alR) {
          ax2 += V[j3]; ay2 += V[j3 + 1]; az2 += V[j3 + 2];
          cx2 += P[j3]; cy2 += P[j3 + 1]; cz2 += P[j3 + 2]; cnt++;
        }
      });
      // a trabalhar (ou a chegar ao ponto de clique) a separação quase desliga, senão os
      // cursores nunca chegam aos pontos partilhados entre peças consecutivas
      let sepK = 1;
      if (st === ST.DRAW || st === ST.ERASE || st === ST.CLICK) sepK = 0.15;
      else if (st === ST.GOTO) sepK = clamp(this._near / 3, 0.1, 1);
      acc[0] += sx * STEER.sepGain * sepK; acc[1] += sy * STEER.sepGain * sepK; acc[2] += sz * STEER.sepGain * sepK;
      if (cnt > 0) {
        acc[0] += (ax2 / cnt - vx) * STEER.alignGain + (cx2 / cnt - px) * STEER.cohGain;
        acc[1] += (ay2 / cnt - vy) * STEER.alignGain + (cy2 / cnt - py) * STEER.cohGain;
        acc[2] += (az2 / cnt - vz) * STEER.alignGain + (cz2 / cnt - pz) * STEER.cohGain;
      }

      // curl noise (recalculado a cada 3 passos, intercalado entre cursores)
      if ((i % 3) === doNoise) this.curl(px, py, pz + i * 0.01, noiseT, this.noise.subarray(i3, i3 + 3));
      acc[0] += this.noise[i3] * noiseAmp;
      acc[1] += this.noise[i3 + 1] * noiseAmp * 0.6;
      acc[2] += this.noise[i3 + 2] * noiseAmp;

      // limitar aceleração e velocidade
      let am = Math.hypot(acc[0], acc[1], acc[2]);
      if (am > amax) { const k = amax / am; acc[0] *= k; acc[1] *= k; acc[2] *= k; }
      let nvx = vx + acc[0] * dt, nvy = vy + acc[1] * dt, nvz = vz + acc[2] * dt;
      // micro-tremor ocasional
      if (st <= ST.REACT && R() < STEER.tremorRate * dt) {
        nvx += R.signed() * STEER.tremorKick; nvy += R.signed() * STEER.tremorKick * 0.5; nvz += R.signed() * STEER.tremorKick;
      }
      const sp = Math.hypot(nvx, nvy, nvz);
      const vlim = vmax * (flock ? 2.2 : 1.05);
      if (sp > vlim) { const k = vlim / sp; nvx *= k; nvy *= k; nvz *= k; }
      V[i3] = nvx; V[i3 + 1] = nvy; V[i3 + 2] = nvz;
      px += nvx * dt; py += nvy * dt; pz += nvz * dt;
      if (py < 0.05) { py = 0.05; if (V[i3 + 1] < 0) V[i3 + 1] *= -0.3; }
      P[i3] = px; P[i3 + 1] = py; P[i3 + 2] = pz;

      // rotação suave da seta em direção ao movimento (slerp simplificado) + inclinação
      if (sp > 0.25) {
        const H = this.head;
        const hx = H[i3], hy = H[i3 + 1], hz = H[i3 + 2];
        const tx = nvx / sp, ty = nvy / sp, tz = nvz / sp;
        const k = 1 - Math.exp(-dt * STEER.turnRate * clamp(sp / 3, 0.3, 1.5));
        let nx = hx + (tx - hx) * k, ny = hy + (ty - hy) * k, nz = hz + (tz - hz) * k;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        // velocidade angular (sinal pelo eixo vertical) -> inclinação
        const cross = hx * nz - hz * nx + (hy * nx - hx * ny) * 0.5;
        const target = clamp(cross / dt * STEER.bankGain, -STEER.bankMax, STEER.bankMax);
        this.bank[i] += (target - this.bank[i]) * Math.min(1, dt * 6);
        H[i3] = nx; H[i3 + 1] = ny; H[i3 + 2] = nz;
      }

      // estado visual
      const working = st >= ST.CLICK && st <= ST.CARRY;
      this.tint[i] += ((working ? 1 : 0) - this.tint[i]) * Math.min(1, dt * (working ? 10 : 2));
      this.pulse[i] = Math.max(0, this.pulse[i] - dt * 4);
      const grow = Math.min(1, (t - this.spawnT[i]) / 0.8);
      this.scale[i] = grow * (1 + this.pulse[i] * 0.7);
    }
  }

  _finish(i, board, px, py, pz) {
    board.complete(this.task[i]);
    this.task[i] = -1;
    this.state[i] = ST.IDLE;
    this.timer[i] = 0;
    // fica a pairar um pouco acima e ao lado de onde acabou
    const R = this.rng;
    this.anchor[i * 3] = px + R.signed() * 1.5;
    this.anchor[i * 3 + 1] = Math.max(1, py + 0.8 + R() * 1.5);
    this.anchor[i * 3 + 2] = pz + R.signed() * 1.5;
  }

  releaseAll(board) {
    for (let i = 0; i < this.n; i++) {
      if (this.task[i] >= 0) { board.unclaim(this.task[i]); this.task[i] = -1; }
      if (this.state[i] !== ST.HIDDEN && this.state[i] !== ST.EXIT) this.state[i] = ST.IDLE;
    }
  }

  setAnchorsToCloud() {
    const c = this.cloud;
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3;
      this.anchor[i3] = c.center[0] + this.offset[i3] * c.radius[0];
      this.anchor[i3 + 1] = c.center[1] + this.offset[i3 + 1] * c.radius[1];
      this.anchor[i3 + 2] = c.center[2] + this.offset[i3 + 2] * c.radius[2];
    }
  }

  exit(i) {
    if (this.state[i] === ST.HIDDEN) return;
    this.state[i] = ST.EXIT; this.timer[i] = 0;
  }

  // ---------------------------------------------------------------- envio para a GPU
  updateRender(dt) {
    const n = this.n;
    this.iPos.array.set(this.pos.subarray(0, n * 3));
    this.iHead.array.set(this.head.subarray(0, n * 3));
    const pa = this.iParams.array;
    for (let i = 0; i < n; i++) {
      pa[i * 4] = this.alive[i] ? this.scale[i] : 0;
      pa[i * 4 + 1] = this.tint[i];
      pa[i * 4 + 2] = this.shape[i];
      pa[i * 4 + 3] = this.bank[i];
    }
    for (const a of [this.iPos, this.iHead, this.iParams]) {
      a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true;
    }

    // rastos: amostra a posição a ~30 Hz
    this._trailClock += dt;
    const T = this.trail, P = this.pos;
    if (this._trailClock > 1 / 30) {
      this._trailClock = 0;
      for (let i = 0; i < n; i++) {
        const base = i * TRAIL_LEN * 3;
        T.copyWithin(base + 3, base, base + (TRAIL_LEN - 1) * 3);
        T[base] = P[i * 3]; T[base + 1] = P[i * 3 + 1]; T[base + 2] = P[i * 3 + 2];
      }
    }
    const tp = this.trailPos.array, tc = this.trailCol.array;
    let o = 0;
    for (let i = 0; i < n; i++) {
      const base = i * TRAIL_LEN * 3;
      const on = this.alive[i] ? 1 : 0;
      const tint = this.tint[i];
      for (let k = 0; k < TRAIL_LEN - 1; k++) {
        // o primeiro ponto do rasto é sempre a posição atual (sem "salto")
        const a = k === 0 ? i * 3 : base + k * 3;
        const aa = k === 0 ? P : T;
        const b = base + (k + 1) * 3;
        tp[o] = aa[a]; tp[o + 1] = aa[a + 1]; tp[o + 2] = aa[a + 2];
        tp[o + 3] = T[b]; tp[o + 4] = T[b + 1]; tp[o + 5] = T[b + 2];
        const f0 = (1 - k / (TRAIL_LEN - 1)) * on * (0.10 + tint * 0.25);
        const f1 = (1 - (k + 1) / (TRAIL_LEN - 1)) * on * (0.10 + tint * 0.25);
        tc[o] = f0; tc[o + 1] = f0 * (0.12 + 0.5 * (1 - tint)); tc[o + 2] = f0 * (0.14 + 0.5 * (1 - tint));
        tc[o + 3] = f1; tc[o + 4] = f1 * (0.12 + 0.5 * (1 - tint)); tc[o + 5] = f1 * (0.14 + 0.5 * (1 - tint));
        o += 6;
      }
    }
    this.trailPos.needsUpdate = true;
    this.trailCol.needsUpdate = true;
  }

  resetTrails() {
    for (let i = 0; i < this.n; i++)
      for (let k = 0; k < TRAIL_LEN; k++) this.trail.set(this.pos.subarray(i * 3, i * 3 + 3), (i * TRAIL_LEN + k) * 3);
  }
}
