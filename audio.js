// audio.js
// Sonoplastia e ambiente musical do Swarm, segundo o doc "Arquitetura de síntese áudio em
// tempo real para VR" (variante WebXR):
//  - a música (pad com voice-leading, sub, arpejo, delay, ar, impactos e reverb FDN) é
//    sintetizada num AudioWorklet (audio/synth-worklet.js), com relógio musical ao sample;
//  - os efeitos do swarm (cliques, ignições, apagar) são amostras sintetizadas no arranque
//    e tocadas por um conjunto FIXO de emissores HRTF reutilizados (voice stealing), em vez
//    de criar um PannerNode por clique;
//  - o néon e o murmúrio do swarm são fontes mono contínuas, ancoradas no espaço;
//  - tudo passa por um compressor/limitador antes da saída, com um nível pensado para os
//    altifalantes do Quest (sem sub-graves que eles não reproduzem).
//
// API pública (usada pelo director, main e debug): start, onSwarmEvent, sweep, climax,
// restart, update, setVolume, volume, note.

import { SCORE, chordAt, sectionAt, mtof } from './audio/score.js';
import { clamp } from './util/math.js';

const WORKLET_URL = new URL('./audio/synth-worklet.js', import.meta.url);

// néon: um emissor por braço do cruzamento (o utilizador está no centro). Ficam a ~7 m de
// altura, à altura das molduras, e não por cima da cabeça.
const ARMS = [[0, -1], [-1, 0], [0, 1], [1, 0]]; // braço 0 = -Z (à frente), depois -X, +Z, +X
const ZONES = ARMS.map(([dx, dz]) => ({ pos: [dx * 24, 7, dz * 24], dir: [dx, dz] }));

export class SwarmAudio {
  constructor(listener, { quest = false } = {}) {
    this.listener = listener;
    this.ctx = listener.context;
    this.quest = quest;
    this.ready = false;
    this.volume = 0.8;
    this.swarm = null;
    this.lines = null;
    this._tmp = { x: 0, y: 0, z: 0 };
    this._rate = { click: 0, lit: 0, erase: 0, spawn: 0 };
    this._last = { click: 0, lit: 0, erase: 0, spawn: 0 };
    this._activity = 0;
    this._t = 0;
    this._frame = 0;
  }

  async start() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* ignorar */ } }
    if (this.ready || this._starting) return;
    this._starting = true;
    this.listener.setMasterVolume(this.volume);

    // ---------------- cadeia de saída: soma -> high-pass -> compressor (limitador) -> listener
    this.master = ctx.createGain(); this.master.gain.value = this.quest ? 0.9 : 0.8;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = this.quest ? 45 : 28; hp.Q.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.25;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1;
    this.master.connect(hp).connect(comp).connect(lim).connect(this.listener.getInput());

    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 1; this.sfxBus.connect(this.master);
    this.revSend = ctx.createGain(); this.revSend.gain.value = 1;

    // ---------------- amostras sintetizadas
    this.buf = this._renderSamples();

    // ---------------- conjunto de emissores HRTF para eventos
    const NSLOTS = this.quest ? 8 : 14;
    this.slots = [];
    for (let i = 0; i < NSLOTS; i++) {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 16000; lp.Q.value = 0.5;
      const pan = this._panner(0, 0, -5, 3, 1.1);
      lp.connect(pan).connect(this.sfxBus);
      this.slots.push({ lp, pan, src: null, g: null, until: 0, start: 0 });
    }
    this._slotNext = 0;

    // ---------------- worklet (música + fontes contínuas)
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL.href);
      this.synth = new AudioWorkletNode(ctx, 'swarm-synth', {
        numberOfInputs: 1, numberOfOutputs: 6, outputChannelCount: [2, 1, 1, 1, 1, 1],
        processorOptions: { score: SCORE, quest: this.quest },
      });
      this.revSend.connect(this.synth);
      this.bed = ctx.createGain(); this.bed.gain.value = 1;
      this.synth.connect(this.bed, 0).connect(this.master);
      // néon: um emissor fixo por braço
      this.zonePan = ZONES.map((z, k) => {
        const p = this._panner(z.pos[0], z.pos[1], z.pos[2], 8, 1);
        this.synth.connect(p, k + 1);
        p.connect(this.sfxBus);
        return p;
      });
      // murmúrio do swarm: segue o centro de massa
      this.murPan = this._panner(0, 4, -16, 6, 1);
      this.synth.connect(this.murPan, 5);
      this.murPan.connect(this.sfxBus);
      const murRev = ctx.createGain(); murRev.gain.value = 0.25;
      this.synth.connect(murRev, 5); murRev.connect(this.revSend);
    } catch (e) {
      console.warn('[audio] AudioWorklet indisponível (precisa de HTTPS/localhost); só efeitos espacializados.', e);
      this.revSend.disconnect();
    }
    this.ready = true;
    this._starting = false;
  }

  _panner(x, y, z, ref, roll) {
    return new PannerNode(this.ctx, {
      panningModel: 'HRTF', distanceModel: 'inverse', refDistance: ref, maxDistance: 300, rolloffFactor: roll,
      positionX: x, positionY: y, positionZ: z,
    });
  }

  // ------------------------------------------------------------------ amostras (síntese offline)
  _renderSamples() {
    const sr = this.ctx.sampleRate;
    let seed = 4242;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const make = (sec, fn) => {
      const n = Math.floor(sr * sec), b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
      fn(d, n);
      // normalizar o pico a 0.9
      let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[i]));
      if (pk > 0) for (let i = 0; i < n; i++) d[i] *= 0.9 / pk;
      // fade-out final de 4 ms (sem cliques de corte)
      const f = Math.min(n, Math.floor(sr * 0.004));
      for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
      return b;
    };
    const TAU = Math.PI * 2;

    // clique de rato: transiente de "press" e "release", corpo plástico ressonante
    const clicks = [];
    for (let v = 0; v < 4; v++) {
      const f1 = 1900 + rnd() * 900, f2 = 3800 + rnd() * 1200, f3 = 900 + rnd() * 500, rel = 0.055 + rnd() * 0.03;
      clicks.push(make(0.14, (d, n) => {
        let prev = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          let x = 0;
          for (const [t0, a] of [[0, 1], [rel, 0.45]]) {
            const u = t - t0; if (u < 0) continue;
            const nz = rnd() * 2 - 1;
            const hpN = nz - prev; prev = nz;
            x += a * (hpN * Math.exp(-u / 0.0004) * 0.25
              + Math.sin(TAU * f1 * u) * Math.exp(-u / 0.0022)
              + Math.sin(TAU * f2 * u) * Math.exp(-u / 0.0008) * 0.2
              + Math.sin(TAU * f3 * u) * Math.exp(-u / 0.004) * 0.35);
          }
          d[i] = x;
        }
      }));
    }
    // "tick" de vidro afinado (base C6): o swarm a tocar o acorde
    const TICK_F = 1046.5;
    const tick = make(1.4, (d, n) => {
      for (let i = 0; i < n; i++) {
        const t = i / sr, a = Math.min(1, t / 0.002);
        d[i] = a * (Math.sin(TAU * TICK_F * t) * Math.exp(-t / 0.32)
          + Math.sin(TAU * TICK_F * 2.756 * t) * Math.exp(-t / 0.07) * 0.35
          + Math.sin(TAU * TICK_F * 5.404 * t) * Math.exp(-t / 0.025) * 0.15);
      }
    });
    // ignição de néon (base C5): estalido + tom com o zumbido de 100 Hz da rede
    const IGN_F = 523.25;
    const ignite = make(2.4, (d, n) => {
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let crackle = 0;
        if (t < 0.05 && rnd() < 0.004) crackle = (rnd() * 2 - 1);
        lp += (crackle - lp) * 0.12;
        const a = Math.min(1, t / 0.018) * Math.exp(-t / 0.75);
        const flutter = 1 + 0.28 * Math.sin(TAU * 100 * t);
        d[i] = lp * 0.25 + a * flutter * (Math.sin(TAU * IGN_F * t) * 0.6
          + Math.sin(TAU * IGN_F * 2 * t) * 0.22 * Math.exp(-t / 0.3)
          + Math.sin(TAU * IGN_F * 3.01 * t) * 0.1 * Math.exp(-t / 0.15)
          + Math.sin(TAU * IGN_F * 0.5 * t) * 0.25);
      }
    });
    // apagar: glissando descendente curto ("unzip") com grão
    const ERASE_F = 1200;
    const erase = make(0.36, (d, n) => {
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const f = ERASE_F * Math.pow(0.28, t / 0.3);
        ph += f / sr;
        const a = Math.min(1, t / 0.003) * Math.exp(-t / 0.09);
        const grain = 0.7 + 0.3 * Math.sign(Math.sin(TAU * 38 * t));
        d[i] = a * grain * (Math.sin(TAU * ph) * 0.7 + Math.sin(TAU * ph * 1.5) * 0.2) + (rnd() * 2 - 1) * a * 0.08;
      }
    });
    return { clicks, tick, TICK_F, ignite, IGN_F, erase, ERASE_F };
  }

  // ------------------------------------------------------------------ eventos espacializados
  _listenerPos() {
    const e = this.listener.matrixWorld.elements;
    return [e[12], e[13], e[14]];
  }

  // limitador de taxa: aceita no máximo `max` eventos/s por tipo; os longínquos são os
  // primeiros a ser descartados. Devolve o ganho de compensação (muitos eventos => cada um mais baixo).
  _admit(type, max, dist) {
    const now = this.ctx.currentTime;
    const r = this._rate;
    const dt = Math.max(1e-3, now - this._last[type]);
    r[type] = r[type] * Math.exp(-dt / 0.5) + 1; // eventos nos últimos ~0.5 s
    this._last[type] = now;
    const rate = r[type] / 0.5;
    this._activity = Math.min(1, this._activity + 0.03);
    const near = clamp(1.4 - dist / 30, 0.15, 1);
    if (rate > max && Math.random() > (max / rate) * near * 1.4) return 0;
    return 1 / Math.sqrt(Math.max(1, rate / (max * 0.35)));
  }

  _play(buf, x, y, z, { gain = 1, rate = 1, send = 0.2, dist = 0 } = {}) {
    const ctx = this.ctx, t = ctx.currentTime;
    // escolhe o emissor livre, senão rouba o mais antigo
    let slot = null;
    for (let k = 0; k < this.slots.length; k++) {
      const s = this.slots[(this._slotNext + k) % this.slots.length];
      if (s.until <= t) { slot = s; break; }
    }
    if (!slot) {
      slot = this.slots.reduce((a, b) => (a.start < b.start ? a : b));
      if (slot.g) { slot.g.gain.cancelScheduledValues(t); slot.g.gain.setTargetAtTime(0, t, 0.004); }
      if (slot.src) { try { slot.src.stop(t + 0.03); } catch (e) { /* já parou */ } }
    }
    this._slotNext = (this.slots.indexOf(slot) + 1) % this.slots.length;
    // posição: salto imediato (o emissor estava calado ou acabou de ser silenciado)
    slot.pan.positionX.setValueAtTime(x, t + 0.002);
    slot.pan.positionY.setValueAtTime(y, t + 0.002);
    slot.pan.positionZ.setValueAtTime(z, t + 0.002);
    // absorção do ar: mais longe, mais escuro
    slot.lp.frequency.setValueAtTime(clamp(17000 * Math.exp(-dist / 45), 1800, 17000), t);

    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.004);
    src.connect(g).connect(slot.lp);
    if (send > 0 && this.synth) { const sg = ctx.createGain(); sg.gain.value = send * gain; g.connect(sg).connect(this.revSend); src.onended = () => sg.disconnect(); }
    src.start(t + 0.003);
    slot.src = src; slot.g = g; slot.start = t; slot.until = t + 0.003 + buf.duration / rate;
  }

  _chordFreq(octaveUp, pick) {
    const c = chordAt(this._t);
    const m = c[1 + (pick % 4)] + 12 * octaveUp;
    return mtof(m);
  }

  onSwarmEvent(type, x, y, z) {
    if (!this.ready) return;
    const lp = this._listenerPos();
    const dist = Math.hypot(x - lp[0], y - lp[1], z - lp[2]);
    const q = this.quest;
    if (type === 'click') {
      const g = this._admit('click', q ? 10 : 16, dist); if (!g) return;
      const b = this.buf.clicks[(Math.random() * 4) | 0];
      this._play(b, x, y, z, { gain: 0.3 * g, rate: 0.9 + Math.random() * 0.2, send: 0.12, dist });
      // um em cada três cliques também "toca" uma nota do acorde (vidro, duas oitavas acima)
      if (Math.random() < 0.33) {
        const f = this._chordFreq(2, (Math.random() * 4) | 0);
        this._play(this.buf.tick, x, y, z, { gain: 0.16 * g, rate: f / this.buf.TICK_F, send: 0.5, dist });
      }
    } else if (type === 'lit' || type === 'placed') {
      const g = this._admit('lit', q ? 7 : 10, dist); if (!g) return;
      const pick = (Math.random() * 4) | 0;
      const f = this._chordFreq(type === 'placed' ? 0 : 1, pick);
      this._play(this.buf.ignite, x, y, z, { gain: 0.26 * g, rate: f / this.buf.IGN_F, send: 0.45, dist });
    } else if (type === 'erased') {
      const g = this._admit('erase', q ? 10 : 16, dist); if (!g) return;
      this._play(this.buf.erase, x, y, z, { gain: 0.24 * g, rate: 0.8 + Math.random() * 0.5, send: 0.3, dist });
    } else if (type === 'spawn') {
      // na escuridão, cada cursor que nasce é uma nota do acorde vazio
      if (this._t > 25) return;
      const g = this._admit('spawn', 6, dist); if (!g) return;
      const f = this._chordFreq(2, (Math.random() * 4) | 0);
      this._play(this.buf.tick, x, y, z, { gain: 0.12 * g, rate: f / this.buf.TICK_F, send: 0.6, dist });
    }
  }

  // nota do participante (pinch na abertura) e eco dos cursores que a repetem: o "vidro"
  // afinado numa nota do acorde atual (pick 0..3), mais um pouco de ignição por baixo
  note(x, y, z, pick = 0, gain = 1) {
    if (!this.ready) return;
    const lp = this._listenerPos();
    const dist = Math.hypot(x - lp[0], y - lp[1], z - lp[2]);
    const f = this._chordFreq(1, pick);
    this._play(this.buf.tick, x, y, z, { gain: 0.32 * gain, rate: f / this.buf.TICK_F, send: 0.55, dist });
    if (gain > 0.6) this._play(this.buf.ignite, x, y, z, { gain: 0.1 * gain, rate: (f / 2) / this.buf.IGN_F, send: 0.4, dist });
  }

  // compatibilidade com a API antiga
  click(x, y, z) { this.onSwarmEvent('click', x, y, z); }
  hum(x, y, z) { this.onSwarmEvent('lit', x, y, z); }

  // onda de luz radial: o acorde de Fá maj9 sai do centro e afasta-se pelos quatro braços
  sweep(duration) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.6);
    g.gain.setTargetAtTime(0, t + duration - 0.5, 0.6);
    const pans = ARMS.map(([dx, dz]) => {
      const p = this._panner(dx * 6, 6, dz * 6, 10, 0.7);
      p.positionX.linearRampToValueAtTime(dx * 116, t + duration);
      p.positionZ.linearRampToValueAtTime(dz * 116, t + duration);
      g.connect(p).connect(this.sfxBus);
      return p;
    });
    if (this.synth) { const sg = ctx.createGain(); sg.gain.value = 1.2; g.connect(sg).connect(this.revSend); }
    const notes = SCORE.chords.Fma9;
    notes.forEach((m, k) => {
      const o = ctx.createOscillator(); o.type = k < 2 ? 'triangle' : 'sine';
      o.frequency.value = mtof(m + 12);
      o.detune.setValueAtTime(0, t); o.detune.linearRampToValueAtTime(k % 2 ? 7 : -7, t + duration);
      const og = ctx.createGain(); og.gain.value = 0.16 / (1 + k * 0.3);
      o.connect(og).connect(g); o.start(t + k * 0.06); o.stop(t + duration + 3);
      if (k === 0) o.onended = () => pans.forEach((p) => p.disconnect());
    });
  }

  climax() {
    if (!this.ready || !this.synth) return;
    this.synth.port.postMessage({ type: 'impact', f: 62, gain: 1 });
  }

  restart() { this._activity = 0; }

  // estado contínuo para o worklet e para as fontes ancoradas
  update(t, { built = 0, pulse = 0, fade = 0 } = {}, playing = true) {
    if (!this.ready) return;
    const ctx = this.ctx, now = ctx.currentTime;
    this._t = t;
    this._frame++;
    // atividade: decai sozinha (~1,5 s), sobe com os eventos; independente do framerate
    const dt = Math.min(0.1, Math.max(0, now - (this._lastUpdate || now)));
    this._lastUpdate = now;
    this._activity *= Math.exp(-dt / 1.5);
    // zonas de néon: fração construída em cada zona
    let zones = [built, built, built, built];
    if (this.lines && (this._frame % 15 === 0 || !this._zones)) this._zones = this._zoneFill();
    if (this._zones) zones = this._zones;
    if (this.synth) {
      this.synth.port.postMessage({ type: 'state', t, at: now, playing, built, pulse, fade, activity: this._activity, zones });
    }
    // murmúrio segue o centro do swarm
    if (this.swarm && this.murPan && this._frame % 6 === 0) {
      const c = this._swarmCenter();
      if (c) {
        this.murPan.positionX.setTargetAtTime(c[0], now, 0.25);
        // a altura fica limitada: o swarm paira alto e o sopro não deve vir de cima da cabeça
        this.murPan.positionY.setTargetAtTime(clamp(c[1], 1.5, 4), now, 0.25);
        this.murPan.positionZ.setTargetAtTime(c[2], now, 0.25);
      }
    }
    if (this.bed) this.bed.gain.setTargetAtTime(1 - fade * 0.2, now, 0.3);
  }

  _swarmCenter() {
    const s = this.swarm, P = s.pos, A = s.alive;
    let x = 0, y = 0, z = 0, c = 0;
    for (let i = 0; i < s.n; i += 2) {
      if (!A[i]) continue;
      x += P[i * 3]; y += P[i * 3 + 1]; z += P[i * 3 + 2]; c++;
    }
    return c ? [x / c, y / c, z / c] : null;
  }

  _zoneFill() {
    const L = this.lines, st = L.state, A = L.A, B = L.B;
    const sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
    for (let i = 0; i < L.count; i++) {
      const xm = (A[i * 3] + B[i * 3]) / 2, zm = (A[i * 3 + 2] + B[i * 3 + 2]) / 2;
      // braço = eixo dominante do ponto médio
      const k = Math.abs(zm) >= Math.abs(xm) ? (zm < 0 ? 0 : 2) : (xm < 0 ? 1 : 3);
      sum[k] += st[i * 4 + 1] - st[i * 4]; cnt[k]++;
    }
    return sum.map((s, k) => (cnt[k] ? clamp(s / Math.max(cnt[k], 20), 0, 1) : 0));
  }

  setVolume(v) { this.volume = v; this.listener.setMasterVolume(v); }
}

export { sectionAt };
