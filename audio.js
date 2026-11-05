// audio.js
// Áudio 100% procedural com Web Audio, ligado ao AudioListener da câmara (three.js):
// drone grave com reverb longo, cliques espacializados (HRTF) com limite de vozes,
// zumbido elétrico por segmento que acende, hum coletivo, sweep da onda de luz e clímax.

import { clamp, smooth } from './util/math.js';

const MAX_CLICK_VOICES = 16;
const MAX_HUM_VOICES = 8;

export class SwarmAudio {
  constructor(listener) {
    this.listener = listener;
    this.ctx = listener.context;
    this.ready = false;
    this.clickVoices = 0;
    this.humVoices = 0;
    this.volume = 0.8;
  }

  async start() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* ignorar */ } }
    if (this.ready) return;
    this.ready = true;
    const out = this.listener.getInput();
    this.listener.setMasterVolume(this.volume);

    this.bus = ctx.createGain(); this.bus.gain.value = 1;
    this.bus.connect(out);
    // reverb longo: impulso gerado (ruído estéreo com decaimento exponencial) = espaço de catedral
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(7.5, 2.6);
    this.wet = ctx.createGain(); this.wet.gain.value = 0.55;
    this.reverb.connect(this.wet).connect(this.bus);
    this.send = ctx.createGain(); this.send.gain.value = 1; this.send.connect(this.reverb);

    // drone: osciladores ligeiramente desafinados -> lowpass que abre com a timeline
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass'; this.droneFilter.frequency.value = 90; this.droneFilter.Q.value = 3.5;
    this.droneGain = ctx.createGain(); this.droneGain.gain.value = 0;
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.bus); this.droneGain.connect(this.send);
    const freqs = [[55, 'sawtooth', 0.22], [55.35, 'sawtooth', 0.22], [82.4, 'sawtooth', 0.12], [110.2, 'triangle', 0.1], [27.5, 'sine', 0.5]];
    for (const [f, type, g] of freqs) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og).connect(this.droneFilter); o.start();
    }
    // LFO lento no filtro, para o drone "respirar"
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 40;
    lfo.connect(lfoG).connect(this.droneFilter.frequency); lfo.start();

    // hum coletivo da estrutura (50/100 Hz), proporcional à fração construída
    this.humFilter = ctx.createBiquadFilter(); this.humFilter.type = 'lowpass'; this.humFilter.frequency.value = 320;
    this.humGain = ctx.createGain(); this.humGain.gain.value = 0;
    this.humFilter.connect(this.humGain); this.humGain.connect(this.bus); this.humGain.connect(this.send);
    for (const [f, type, g] of [[50, 'sawtooth', 0.25], [100.3, 'sine', 0.35], [150.5, 'sine', 0.08]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og).connect(this.humFilter); o.start();
    }

    this.noiseBuf = this._noise(0.4);
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = rnd() * Math.pow(1 - i / n, decay) * (i < 400 ? i / 400 : 1);
    }
    return buf;
  }
  _noise(seconds) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 777;
    for (let i = 0; i < n; i++) d[i] = ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    return buf;
  }
  _panner(x, y, z, ref = 2) {
    const p = new PannerNode(this.ctx, {
      panningModel: 'HRTF', distanceModel: 'inverse', refDistance: ref, maxDistance: 400, rolloffFactor: 0.9,
      positionX: x, positionY: y, positionZ: z,
    });
    p.connect(this.bus);
    return p;
  }

  // clique curto e seco, espacializado; pitch varia um pouco
  click(x, y, z, vol = 1) {
    if (!this.ready || this.clickVoices >= MAX_CLICK_VOICES) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this.clickVoices++;
    const pan = this._panner(x, y, z, 1.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * vol, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    g.connect(pan);
    const sendG = ctx.createGain(); sendG.gain.value = 0.15; g.connect(sendG).connect(this.send);
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6;
    bp.frequency.value = 2600 * (0.8 + Math.random() * 0.45);
    n.connect(bp).connect(g);
    const o = ctx.createOscillator(); o.type = 'square';
    o.frequency.value = 1900 * (0.85 + Math.random() * 0.3);
    const og = ctx.createGain(); og.gain.value = 0.12;
    o.connect(og).connect(g);
    n.start(t, Math.random() * 0.3, 0.05); o.start(t); o.stop(t + 0.03);
    n.onended = () => { this.clickVoices--; pan.disconnect(); };
  }

  // zumbido elétrico quando um segmento acende
  hum(x, y, z) {
    if (!this.ready || this.humVoices >= MAX_HUM_VOICES) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this.humVoices++;
    const pan = this._panner(x, y, z, 3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    g.connect(pan);
    const sg = ctx.createGain(); sg.gain.value = 0.3; g.connect(sg).connect(this.send);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 2;
    lp.connect(g);
    const f = 100 * (0.97 + Math.random() * 0.06);
    for (const [m, type, gg] of [[1, 'sawtooth', 0.5], [1.2, 'square', 0.15], [3, 'sine', 0.2]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * m;
      const og = ctx.createGain(); og.gain.value = gg; o.connect(og).connect(lp);
      o.start(t); o.stop(t + 1.4);
      if (m === 1) o.onended = () => { this.humVoices--; pan.disconnect(); };
    }
  }

  // sweep tonal que viaja de perto para longe, a acompanhar a onda de luz
  sweep(duration) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const pan = this._panner(0, 8, -6, 8);
    pan.positionZ.setValueAtTime(-6, t);
    pan.positionZ.linearRampToValueAtTime(-216, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.5);
    g.connect(pan);
    const sg = ctx.createGain(); sg.gain.value = 0.6; g.connect(sg).connect(this.send);
    for (const [f0, f1, type, gg] of [[220, 880, 'triangle', 0.4], [330, 1320, 'sine', 0.25], [110, 440, 'sawtooth', 0.08]]) {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + duration);
      const og = ctx.createGain(); og.gain.value = gg; o.connect(og).connect(g);
      o.start(t); o.stop(t + duration + 0.6);
    }
  }

  climax() { /* o drone e o hum sobem em update(); aqui só um impacto grave */
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(30, t + 4);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 5);
    o.connect(g); g.connect(this.bus); g.connect(this.send);
    o.start(t); o.stop(t + 5.2);
  }

  restart() {}

  // drone e hum seguem a timeline
  update(t, { built = 0, pulse = 0, fade = 0 } = {}) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    let cut;
    if (t < 10) cut = 70 + t * 4;
    else if (t < 25) cut = 110 + (t - 10) * 10;
    else if (t < 55) cut = 260 + (t - 25) * 22;
    else if (t < 65) cut = 920;
    else if (t < 80) cut = 920 - (t - 65) * 20;
    else if (t < 105) cut = 620 + (t - 80) * 36;
    else cut = 1520 + smooth(105, 112, t) * 2600;
    cut *= 1 + pulse * 0.3;
    const dg = (0.06 + 0.18 * smooth(0, 8, t) + 0.12 * smooth(105, 112, t)) * (1 - fade);
    this.droneFilter.frequency.setTargetAtTime(cut, now, 0.25);
    this.droneGain.gain.setTargetAtTime(dg, now, 0.3);
    this.humGain.gain.setTargetAtTime(clamp(built, 0, 1) * 0.12 * (1 + pulse) * (1 - fade), now, 0.4);
  }

  setVolume(v) { this.volume = v; this.listener.setMasterVolume(v); }
}
