// director.js
// Timeline + máquina de estados. Lê os tempos de timeline.js, cria as tarefas de cada
// construção/desconstrução, liberta-as no tempo certo e calcula os parâmetros visuais
// (pulso, onda de luz, fade) em função do tempo. Simulação em passo fixo com seed fixa:
// a sequência é sempre igual.

import * as THREE from 'three';
import { TIMELINE, legacyTime } from './timeline.js';
import { BLUEPRINTS } from './structure/blueprints.js';
import { mulberry32, smooth, clamp } from './util/math.js';

export const TASK = { DRAW: 0, ERASE: 1, CARRY: 2 };
const T_PENDING = 0, T_OPEN = 1, T_CLAIMED = 2, T_DONE = 3;
export const SIM_DT = 1 / 60;
// direção de cada braço do cruzamento no chão (x, z): 0 = -Z (à frente), 1 = -X, 2 = +Z, 3 = +X
const ARM_DIRS = [[0, -1], [-1, 0], [0, 1], [1, 0]];
const ST_RETURN = 10;

class TaskBoard {
  constructor() { this.clear(); }
  clear() { this.tasks = []; this.pending = []; this.open = []; this.cursor = 0; }
  add(task) {
    task.id = this.tasks.length; task.status = T_PENDING; task.agent = -1;
    this.tasks.push(task);
    return task.id;
  }
  finalize() {
    this.pending = this.tasks.map((t) => t.id).sort((a, b) => this.tasks[a].release - this.tasks[b].release);
    this.cursor = 0;
  }
  update(t) {
    while (this.cursor < this.pending.length && this.tasks[this.pending[this.cursor]].release <= t) {
      const id = this.pending[this.cursor++];
      const tk = this.tasks[id];
      if (tk.status === T_PENDING) { tk.status = T_OPEN; this.open.push(id); }
    }
  }
  hasOpen() { return this.open.length > 0; }
  // escolhe entre as tarefas abertas mais antigas e algumas ao acaso a mais próxima,
  // com algum caos (ruído na pontuação)
  claim(agent, x, y, z, R) {
    const open = this.open;
    if (!open.length) return -1;
    let best = -1, bestScore = Infinity;
    const nOld = Math.min(open.length, 10);
    const tries = nOld + Math.min(open.length, 6);
    for (let k = 0; k < tries; k++) {
      const idx = k < nOld ? k : Math.floor(R() * open.length);
      const tk = this.tasks[open[idx]];
      const p = tk.type === TASK.DRAW ? tk.a : tk.grab;
      const d = Math.hypot(p[0] - x, p[1] - y, p[2] - z);
      const score = d + idx * 0.15 + R() * 2.5;
      if (score < bestScore) { bestScore = score; best = idx; }
    }
    const id = open[best];
    open.splice(best, 1);
    const tk = this.tasks[id];
    tk.status = T_CLAIMED; tk.agent = agent;
    return id;
  }
  unclaim(id) {
    const tk = this.tasks[id];
    if (tk.status !== T_CLAIMED) return;
    tk.status = T_OPEN; tk.agent = -1; this.open.unshift(id);
  }
  complete(id) { const tk = this.tasks[id]; tk.status = T_DONE; }
  // ponto onde o cursor "clica": início do segmento, ponta atual, ou centro (arrastar)
  grabPoint(tk, lines, out) {
    const s3 = tk.slot * 3, A = lines.A, B = lines.B;
    if (tk.type === TASK.DRAW) { out[0] = A[s3]; out[1] = A[s3 + 1]; out[2] = A[s3 + 2]; }
    else if (tk.type === TASK.ERASE) {
      const h = lines.hi(tk.slot);
      out[0] = A[s3] + (B[s3] - A[s3]) * h; out[1] = A[s3 + 1] + (B[s3 + 1] - A[s3 + 1]) * h; out[2] = A[s3 + 2] + (B[s3 + 2] - A[s3 + 2]) * h;
    } else {
      out[0] = (A[s3] + B[s3]) / 2; out[1] = (A[s3 + 1] + B[s3 + 1]) / 2; out[2] = (A[s3 + 2] + B[s3 + 2]) / 2;
    }
    return out;
  }
}

export class Director {
  constructor({ lines, swarm, env, audio }) {
    this.lines = lines; this.swarm = swarm; this.env = env; this.audio = audio;
    this.board = new TaskBoard();
    this.cfg = TIMELINE;
    this.t = 0;
    this.playing = false;
    this.speed = 1;
    this.silent = false;
    this.blueprint1 = TIMELINE.phases.find((p) => p.id === 'build1').blueprint;
    this.blueprint2 = TIMELINE.phases.find((p) => p.id === 'build2').blueprint;
    this._acc = 0;
    swarm.onEvent = (type, i, slot, x, y, z) => this._onSwarmEvent(type, i, slot, x, y, z);
    this.reset();
  }

  P(id) { return this.cfg.phases.find((p) => p.id === id); }

  // ------------------------------------------------------------------ planeamento
  reset() {
    const cfg = this.cfg;
    const R = mulberry32(cfg.seed);
    this.t = 0; this._acc = 0;
    this.fired = new Set();
    this.auto = [];
    this.lines.reset();
    this.board.clear();
    this.swarm.reset(cfg.seed, cfg.spawn, cfg.cloud, cfg.leader);
    // abertura: as quatro linhas do chão que o participante desenha com o pinch
    const [r0, r1] = cfg.leader.axisLen;
    this.axisSlots = ARM_DIRS.map(([dx, dz]) => this.lines.allocate([dx * r0, 0, dz * r0], [dx * r1, 0, dz * r1], 0.9, R()));
    this.axisDone = [false, false, false, false];
    this.pinchCount = 0;
    this.lastPick = null;
    this.handPos = [0.12, 1.3, -0.55];
    this.env.clearHeat();
    this.litCount = 0;

    const bpA = BLUEPRINTS[this.blueprint1]();
    const bpB = BLUEPRINTS[this.blueprint2]();
    this.planName = bpA.name;
    this.slotsA = bpA.segments.map((s) => this.lines.allocate(s.a, s.b, s.weight, R()));
    this.taskBuild(bpA, this.slotsA, this.P('build1'), R);

    // morph: uma fração dos segmentos de A é arrastada para posições de B (pares por profundidade)
    const K = Math.round(cfg.morph.reuse * Math.min(bpA.segments.length, bpB.segments.length));
    const pickA = shuffled([...bpA.segments.keys()], R).slice(0, K);
    const pickB = shuffled([...bpB.segments.keys()], R).slice(0, K);
    const zmid = (s) => (s.a[2] + s.b[2]) / 2;
    pickA.sort((a, b) => zmid(bpA.segments[b]) - zmid(bpA.segments[a]));
    pickB.sort((a, b) => zmid(bpB.segments[b]) - zmid(bpB.segments[a]));
    const reusedA = new Set(pickA), reusedB = new Set(pickB);
    const pm = this.P('morph');
    const W = cfg.morph.moveWindow;
    bpA.segments.forEach((s, k) => {
      const slot = this.slotsA[k];
      const depth = s.ring / Math.max(1, bpA.rings - 1);
      const order = cfg.morph.order === 'random' ? R() : 1 - depth;
      if (!reusedA.has(k)) {
        this.board.add({ type: TASK.ERASE, slot, release: pm.start + order * W + R() * 1.2, grab: s.b, phase: 'morph' });
      }
    });
    pickA.forEach((ka, n) => {
      const sb = bpB.segments[pickB[n]];
      const sa = bpA.segments[ka];
      const depth = sa.ring / Math.max(1, bpA.rings - 1);
      this.board.add({
        type: TASK.CARRY, slot: this.slotsA[ka], release: pm.start + 0.6 + (cfg.morph.order === 'random' ? R() : 1 - depth) * W * 0.85 + R() * 1.5,
        grab: [(sa.a[0] + sa.b[0]) / 2, (sa.a[1] + sa.b[1]) / 2, (sa.a[2] + sa.b[2]) / 2],
        ta: sb.a, tb: sb.b, phase: 'morph',
      });
      this.lines.weight[this.slotsA[ka]] = sb.weight;
    });
    // o resto de B é desenhado de novo na construção 2
    const restB = bpB.segments.filter((_, k) => !reusedB.has(k));
    const slotsB = restB.map((s) => this.lines.allocate(s.a, s.b, s.weight, R()));
    this.taskBuild({ ...bpB, segments: restB }, slotsB, this.P('build2'), R);
    this.board.finalize();
    this.totalSlots = this.lines.count;
    this.exitOrder = shuffled([...Array(this.swarm.n).keys()], R);
    this.applyVisuals();
  }

  taskBuild(bp, slots, phase, R) {
    const b = this.cfg.build;
    const dur = phase.end - phase.start - b.tailMargin;
    const ringSlot = dur / (bp.rings - 1 + b.ringOverlap);
    const maxStag = new Map();
    for (const s of bp.segments) maxStag.set(s.ring, Math.max(maxStag.get(s.ring) || 0, s.stagger));
    bp.segments.forEach((s, k) => {
      const ms = Math.max(1, maxStag.get(s.ring));
      const within = (s.stagger / ms) * ringSlot * b.ringOverlap;
      const rel = phase.start + s.ring * ringSlot + Math.min(within, s.stagger * b.pieceStagger * 6) + R() * b.jitter;
      this.board.add({ type: TASK.DRAW, slot: slots[k], release: rel, a: s.a, phase: phase.id });
    });
  }

  // ------------------------------------------------------------------ tempo
  play() { this.playing = true; }
  pause() { this.playing = false; }

  // avança em passos fixos (determinístico); dt real * velocidade
  advance(realDt) {
    if (!this.playing) return 0;
    this._acc += Math.min(realDt, 0.1) * this.speed;
    let steps = 0;
    while (this._acc >= SIM_DT && steps < 16) { this.step(); this._acc -= SIM_DT; steps++; }
    if (steps === 16) this._acc = 0;
    return steps;
  }

  seek(target) {
    target = clamp(target, 0, this.cfg.duration - 0.01);
    if (target < this.t) this.reset();
    this.silent = true;
    while (this.t < target) this.step();
    this.silent = false;
    this.swarm.resetTrails();
  }

  once(key, cond, fn) { if (cond && !this.fired.has(key)) { this.fired.add(key); fn(); } }

  step() {
    const cfg = this.cfg, t = this.t;
    const sw = this.swarm;
    this.board.update(t);

    const b1 = this.P('build1'), b2 = this.P('build2'), pm = this.P('morph'), cx = cfg.climax;
    this.once('b1', t >= b1.start, () => { sw.setAnchorsToCloud(); sw.mode = 'anchor'; });
    this.once('b1fin', t >= b1.end + cfg.build.autoFinish, () => this.forceFinish('build1'));
    this.once('wave', t >= cfg.complete.waveAt, () => this.audio && !this.silent && this.audio.sweep(cfg.complete.waveDuration));
    this.once('mfin', t >= pm.end - 1.5, () => this.forceFinish('morph'));
    this.once('b2fin', t >= b2.end + cfg.build.autoFinish, () => this.forceFinish('build2'));
    this.once('climax', t >= cx.pulseFrom, () => this.audio && !this.silent && this.audio.climax(cfg.duration - cx.pulseFrom));
    if (t >= cx.disperseAt) {
      const n = sw.n, k = Math.floor(clamp((t - cx.disperseAt) / cx.disperseWindow, 0, 1) * n);
      for (let j = this._exited || 0; j < k; j++) {
        const i = this.exitOrder[j];
        if (sw.task[i] >= 0) { this.board.unclaim(sw.task[i]); sw.task[i] = -1; }
        sw.exit(i);
      }
      this._exited = k;
    } else this._exited = 0;

    this.stepLeader(t);
    this.once('echo', t >= cfg.echo.at, () => this.startEcho());

    this.stepAuto(SIM_DT);
    sw.step(SIM_DT, t, this.board, this.lines);
    this.t += SIM_DT;

    if (this.t >= cfg.duration) {
      if (cfg.loop) { this.reset(); this._restartFade = true; if (this.audio && !this.silent) this.audio.restart(); }
      else { this.t = cfg.duration; this.playing = false; }
    }
  }

  // ------------------------------------------------------------------ abertura
  // posição da "mão" quando ninguém está a controlar (vídeo, Desktop parado, scrub):
  // um gesto lento e determinístico à frente do participante
  autoHand(t, out) {
    out[0] = 0.1 + 0.16 * Math.sin(t * 0.55) + 0.04 * Math.sin(t * 1.7);
    out[1] = 1.28 + 0.08 * Math.sin(t * 0.8 + 1);
    out[2] = -0.55 + 0.05 * Math.sin(t * 0.4);
    return out;
  }

  userInControl() {
    return !!(this.input && !this.silent && this.input.idleFor() < this.cfg.leader.autoAfter);
  }

  stepLeader(t) {
    const Lc = this.cfg.leader, sw = this.swarm, L = sw.leader;
    if (!L.on) return;
    const user = this.userInControl();
    const h = this.handPos;
    if (user) { h[0] = this.input.pos.x; h[1] = this.input.pos.y; h[2] = this.input.pos.z; }
    else this.autoHand(t, h);
    // perda de controlo: atraso e desobediência crescem; depois voa para a nuvem do swarm
    L.control = 1 - smooth(Lc.lossStart, Lc.lossEnd, t);
    const away = smooth(Lc.lossEnd - 1, Lc.joinAt, t);
    const cc = this.cfg.cloud.center;
    for (let k = 0; k < 3; k++) L.target[k] = h[k] + (cc[k] - h[k]) * away;
    L.scale = Lc.scale + (1 - Lc.scale) * smooth(Lc.lossEnd - 2, Lc.joinAt, t);
    L.pinch = user ? this.input.pinching : (this._autoPinchUntil || 0) > t;
    // piloto automático: pinches marcados na timeline, só se ninguém estiver a controlar
    Lc.autoPinches.forEach((ap, k) => this.once('ap' + k, t >= ap, () => {
      if (!user) { this._autoPinchUntil = t + 0.22; this.pinch(h, false); }
    }));
    this.once('cloudmode', t >= Lc.lossEnd, () => { sw.mode = 'cloud'; });
    this.once('join', t >= Lc.joinAt, () => { sw.releaseLeader(); L.on = false; });
  }

  // pinch (ou clique) do participante: uma nota; os primeiros desenham as linhas do cruzamento
  pinch(pos, fromUser = true) {
    const Lc = this.cfg.leader, t = this.t;
    const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    if (t < Lc.appearAt || t >= Lc.lossEnd) return;
    if (fromUser && t >= Lc.lossStart && Math.random() < smooth(Lc.lossStart, Lc.lossEnd, t)) return; // já não obedece
    const pick = this.pinchCount % 4;
    this.pinchCount++;
    this.lastPick = pick;
    this.swarm.pulse[0] = 1;
    if (this.audio && !this.silent && this.audio.note) this.audio.note(p[0], p[1], p[2], pick, 1);
    // braço para onde a mão aponta (ainda por desenhar)
    let best = -1, bestDot = -Infinity;
    const len = Math.hypot(p[0], p[2]);
    const fx = len > 0.05 ? p[0] / len : 0, fz = len > 0.05 ? p[2] / len : -1;
    ARM_DIRS.forEach(([dx, dz], k) => {
      if (this.axisDone[k]) return;
      const d = dx * fx + dz * fz;
      if (d > bestDot) { bestDot = d; best = k; }
    });
    if (best >= 0) {
      this.axisDone[best] = true;
      const slot = this.axisSlots[best];
      this.lines.doFlash(slot, 1.6);
      this.auto.push({ type: TASK.DRAW, slot, k: 0, dur: 1.8, h0: 0 });
    }
  }

  // eco no clímax: um cursor volta à mão do participante por um instante
  startEcho() {
    const sw = this.swarm, cfg = this.cfg;
    let j = -1;
    for (let k = this.exitOrder.length - 1; k >= 0; k--) {
      const i = this.exitOrder[k];
      if (sw.alive[i] && sw.state[i] !== 8 && i !== 0) { j = i; break; }
    }
    if (j < 0) return;
    const h = this.userInControl() ? [this.input.pos.x, this.input.pos.y, this.input.pos.z] : this.autoHand(this.t, [0, 0, 0]);
    sw.returnTarget = [h[0], h[1] + 0.03, h[2] - 0.12];
    sw.returnHold = cfg.echo.hold;
    if (sw.task[j] >= 0) { this.board.unclaim(sw.task[j]); sw.task[j] = -1; }
    sw.state[j] = ST_RETURN; sw.timer[j] = 0;
  }

  forceFinish(phaseId) {
    const L = this.lines, sw = this.swarm;
    for (const tk of this.board.tasks) {
      if (tk.phase !== phaseId || tk.status === T_DONE) continue;
      if (tk.agent >= 0 && sw.task[tk.agent] === tk.id) { sw.task[tk.agent] = -1; sw.state[tk.agent] = 1; }
      const oi = this.board.open.indexOf(tk.id);
      if (oi >= 0) this.board.open.splice(oi, 1);
      // o que faltar completa-se sozinho, mas animado (nada "salta")
      const s3 = tk.slot * 3;
      this.auto.push({
        type: tk.type, slot: tk.slot, k: 0, dur: 1.2 + (this.auto.length % 7) * 0.08,
        h0: L.hi(tk.slot),
        a0: [L.A[s3], L.A[s3 + 1], L.A[s3 + 2]], b0: [L.B[s3], L.B[s3 + 1], L.B[s3 + 2]],
        ta: tk.ta, tb: tk.tb,
      });
      tk.status = T_DONE;
    }
  }

  stepAuto(dt) {
    const L = this.lines;
    for (let n = this.auto.length - 1; n >= 0; n--) {
      const a = this.auto[n];
      a.k = Math.min(1, a.k + dt / a.dur);
      const e = a.k * a.k * (3 - 2 * a.k);
      if (a.type === TASK.DRAW) L.setRange(a.slot, 0, a.h0 + (1 - a.h0) * e);
      else if (a.type === TASK.ERASE) L.setRange(a.slot, 0, a.h0 * (1 - e));
      else {
        const A = [0, 1, 2].map((j) => a.a0[j] + (a.ta[j] - a.a0[j]) * e);
        const B = [0, 1, 2].map((j) => a.b0[j] + (a.tb[j] - a.b0[j]) * e);
        L.setEnds(a.slot, A, B); L.setRange(a.slot, 0, Math.max(a.h0, e));
      }
      if (a.k >= 1) { if (a.type !== TASK.ERASE) L.doFlash(a.slot, 0.8); this.auto.splice(n, 1); }
    }
  }

  _onSwarmEvent(type, i, slot, x, y, z) {
    if (this.silent || !this.audio) return;
    const A = this.audio;
    // os cursores que chegam repetem a última nota do participante
    if (type === 'spawn' && this.lastPick != null && this.t < this.cfg.leader.joinAt && A.note) { A.note(x, y, z, this.lastPick, 0.45); return; }
    if (type === 'returned' && A.note) { A.note(x, y, z, this.lastPick ?? 0, 0.9); return; }
    if (type === 'leader') return;
    A.onSwarmEvent(type, x, y, z);
  }

  get phase() {
    for (const p of this.cfg.phases) if (this.t >= p.start && this.t < p.end) return p;
    return this.cfg.phases[this.cfg.phases.length - 1];
  }

  builtFraction() {
    const L = this.lines; let s = 0;
    for (let i = 0; i < L.count; i++) s += L.state[i * 4 + 1] - L.state[i * 4];
    return L.count ? s / L.count : 0;
  }

  // ------------------------------------------------------------------ visuais em função de t
  // transição de cor: interpola as chaves de TIMELINE.palette e aplica às linhas, cursores,
  // chão, névoa e horizonte
  applyPalette(t) {
    const P = this.cfg.palette;
    if (!this._pal) {
      this._pal = P.map((k) => ({ t: k.t, line: new THREE.Color(k.line), warm: new THREE.Color(k.warm), hot: new THREE.Color(k.hot), ambient: new THREE.Color(k.ambient) }));
      this._c = { line: new THREE.Color(), warm: new THREE.Color(), hot: new THREE.Color(), ambient: new THREE.Color() };
    }
    const K = this._pal;
    let i = 0;
    while (i < K.length - 2 && t > K[i + 1].t) i++;
    const A = K[i], B = K[i + 1];
    const u = smooth(0, 1, (t - A.t) / Math.max(1e-3, B.t - A.t));
    for (const key of ['line', 'warm', 'hot', 'ambient']) this._c[key].copy(A[key]).lerp(B[key], u);
    const U = this.lines.uniforms, F = this.env.floorUniforms, c = this._c;
    U.uColor.value.copy(c.line); U.uWarm.value.copy(c.warm); U.uHot.value.copy(c.hot);
    this.swarm.uniforms.uRed.value.copy(c.line);
    F.uColor.value.copy(c.line);
    F.uAmbient.value.copy(c.ambient);
    F.uFogColor.value.copy(c.ambient).multiplyScalar(0.0045);
    if (this.env.scene.fog) this.env.scene.fog.color.copy(c.ambient).multiplyScalar(0.03);
  }

  applyVisuals() {
    const t = this.t, cfg = this.cfg, U = this.lines.uniforms, cx = cfg.climax, c = cfg.complete;
    this.applyPalette(t);
    const p1 = this.P('complete1');
    let pulse = 0, waveZ = 1000, waveAmp = 0;
    // estrutura completa: respiração suave + onda do primeiro ao último anel
    if (t >= p1.start && t < p1.end) {
      pulse = c.pulse * (0.5 + 0.5 * Math.sin((t - p1.start) * Math.PI * 2 / 2.4)) * smooth(p1.start, p1.start + 1, t) * (1 - smooth(p1.end - 1, p1.end, t));
    }
    if (t >= c.waveAt && t < c.waveAt + c.waveDuration + 1) {
      const k = (t - c.waveAt) / c.waveDuration;
      waveZ = 6 + k * 110; waveAmp = 1.3 * (1 - smooth(0.85, 1.15, k));
    }
    // clímax: pulso cada vez mais rápido e ondas repetidas
    if (t >= cx.pulseFrom) {
      const k = smooth(cx.pulseFrom, cx.disperseAt + 2, t);
      const f = 0.6 + 2.2 * k;
      pulse = 0.15 + 0.85 * k * (0.5 + 0.5 * Math.sin((t - cx.pulseFrom) * f * Math.PI * 2));
      const wt = (t - cx.pulseFrom) % 2.2;
      waveZ = 6 + wt / 2.2 * 115; waveAmp = 1.2 * k;
    }
    U.uPulse.value = pulse;
    U.uWaveZ.value = waveZ;
    U.uWaveAmp.value = waveAmp;
    const fu = this.env.floorUniforms;
    fu.uWaveZ.value = waveZ; fu.uWaveAmp.value = waveAmp;
    if (!this._bfClock || Math.abs(this._bfClock - t) > 0.25) { this._bf = this.builtFraction(); this._bfClock = t; }
    fu.uGlow.value = this._bf * (1 + pulse);
    this.env.walls.uniforms.uGlobal.value = smooth(26, 42, t) * (0.7 + pulse * 0.6);
    // fade: entrada no início de cada ciclo e saída no fim
    const fadeIn = 1 - smooth(0, 2.5, t);
    const fadeOut = smooth(cx.fadeStart, cx.fadeEnd, t);
    this.env.setFade(Math.max(fadeIn * 0.85, fadeOut));
    if (this.audio && !this.silent) this.audio.update(legacyTime(t), { built: this._bf, pulse, fade: fadeOut }, this.playing);
  }
}

function shuffled(arr, R) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
