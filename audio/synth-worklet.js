// audio/synth-worklet.js
// Núcleo de síntese em tempo real (AudioWorklet). Segue a arquitetura do doc
// "Arquitetura de síntese áudio em tempo real para VR": osciladores band-limited (PolyBLEP),
// filtros SVF (TPT), parâmetros suavizados, eventos agendados ao sample a partir do relógio
// musical (nunca disparados do requestAnimationFrame), voice stealing, reverb partilhado
// num bus e saídas MONO para as fontes que o thread principal espacializa com HRTF.
//
// Entradas:  0 = envio de reverb dos efeitos espacializados (mono)
// Saídas:    0 = cama musical estéreo (pad, sub, arpejo, delay, ar, impactos, reverb)
//            1..4 = zumbido dos quatro braços de néon (mono, espacializadas fora daqui)
//            5 = murmúrio do swarm (mono, segue o centro do swarm)
//
// Sem alocação no process(): tudo é pré-alocado no construtor.

const TAU = Math.PI * 2;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// SVF topology-preserving (Cytomic). Coeficientes calculados por bloco.
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1; }
  set(fc, q, sr) {
    fc = Math.min(Math.max(fc, 20), sr * 0.45);
    const g = Math.tan(Math.PI * fc / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  lp(v0) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }
  bp(v0) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return v1;
  }
}

class Delay {
  constructor(n) { this.b = new Float32Array(n); this.n = n; this.w = 0; }
  read(d) { let r = this.w - d; if (r < 0) r += this.n; return this.b[r]; }
  readFrac(d) {
    let r = this.w - d; while (r < 0) r += this.n;
    const i = Math.floor(r), f = r - i, j = (i + 1) % this.n;
    return this.b[i] + (this.b[j] - this.b[i]) * f;
  }
  write(x) { this.b[this.w] = x; this.w = (this.w + 1) % this.n; }
}

class Allpass {
  constructor(n, g) { this.d = new Delay(n); this.len = n - 1; this.g = g; }
  run(x) {
    const y = this.d.read(this.len);
    const v = x + this.g * y;
    this.d.write(v);
    return y - this.g * v;
  }
}

// ruído determinístico barato
class Noise {
  constructor(seed) { this.s = seed >>> 0 || 1; }
  next() { let x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x >>> 0; return (this.s / 2147483648) - 1; }
}

const ARP_VOICES = 6;

class SwarmSynth extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.score = o.score;
    this.quest = !!o.quest;
    const sr = sampleRate;
    this.sr = sr;

    // estado vindo do thread principal (suavizado aqui)
    this.st = { t: 0, at: 0, playing: false, built: 0, pulse: 0, fade: 0, activity: 0, zones: [0, 0, 0, 0] };
    this.sm = { bright: 0.05, pad: 0, arp: 0, air: 0, sub: 0, built: 0, pulse: 0, fade: 0, act: 0, wet: 0.3, zones: [0, 0, 0, 0] };

    // pad: 5 vozes x 2 serras
    this.padF = new Float32Array(5); this.padTarget = new Float32Array(5);
    this.padPh = new Float32Array(10); this.padAmp = new Float32Array(5); this.padAmpT = new Float32Array(5);
    for (let i = 0; i < 10; i++) this.padPh[i] = (i * 0.137) % 1;
    const c0 = this.score.chords.D5;
    for (let v = 0; v < 5; v++) { this.padF[v] = this.padTarget[v] = mtof(c0[v]); }
    this.padPan = [-0.55, 0.45, -0.2, 0.6, -0.4];
    this.padL = new SVF(); this.padR = new SVF();
    this.lfo = 0;
    this.subPh = 0;

    // arpejo
    this.arp = [];
    for (let i = 0; i < ARP_VOICES; i++) this.arp.push({ ph: 0, ph2: 0, f: 440, env: 0, fenv: 0, dec: 0.999, amp: 0, pan: 0, f1: new SVF(), on: false });
    this.arpNext = 0; this.lastStep = -1; this.lastSection = null;
    this.dlyL = new Delay(Math.ceil(sr * 1.2)); this.dlyR = new Delay(Math.ceil(sr * 1.2));
    this.dlyLp = 0; this.dlyRp = 0; this.dlyTime = 0.3 * sr;

    // ar (ruído filtrado)
    this.nL = new Noise(11); this.nR = new Noise(23); this.nM = new Noise(37);
    this.airL = new SVF(); this.airR = new SVF();

    // impacto
    this.imp = { env: 0, ph: 0, f: 60, gain: 0 };
    this.impLp = new SVF();

    // reverb FDN de 4 linhas
    const ms = (x) => Math.round(x * sr / 1000);
    this.pre = new Delay(ms(30) + 2);
    this.ap = [new Allpass(ms(4.7), 0.62), new Allpass(ms(11.3), 0.6), new Allpass(ms(17.9), 0.55)];
    this.fdnLen = [ms(89.3), ms(107.9), ms(131.7), ms(151.1)];
    this.fdn = this.fdnLen.map((n) => new Delay(n + 2));
    this.fdnLp = new Float32Array(4);
    this.fdnG = new Float32Array(4);
    this.rt = 0; this.setRT(4.5);
    this.modPh = 0;

    // néon: 3 zonas
    this.zone = [0, 1, 2, 3].map((k) => ({ ph1: k * 0.3, ph2: k * 0.7, ph3: 0, flick: 1, flickT: 1, lp: new SVF(), n: new Noise(101 + k) }));
    for (const z of this.zone) z.lp.set(380, 0.8, sr);

    // murmúrio
    // sopro suave e contínuo (sem grãos: os grãos curtos soavam a estática)
    this.mur = { lp: new SVF(), lp2: new SVF(), n: new Noise(77), drift: 0, am: 0 };

    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  setRT(rt) {
    if (Math.abs(rt - this.rt) < 0.05) return;
    this.rt = rt;
    for (let i = 0; i < 4; i++) this.fdnG[i] = Math.pow(10, -3 * this.fdnLen[i] / (rt * this.sr));
  }

  onMsg(d) {
    if (d.type === 'state') {
      const s = this.st;
      if (d.t < s.t - 0.5) this.onRewind();
      s.t = d.t; s.at = d.at; s.playing = d.playing;
      s.built = d.built; s.pulse = d.pulse; s.fade = d.fade; s.activity = d.activity;
      s.zones = d.zones || s.zones;
    } else if (d.type === 'impact') {
      this.imp.env = 1; this.imp.ph = 0; this.imp.f = d.f || 62; this.imp.gain = d.gain || 1;
    }
  }

  onRewind() {
    this.lastStep = -1; this.lastSection = null;
    for (const a of this.arp) { a.env = 0; a.on = false; }
  }

  section(t) {
    const S = this.score.sections;
    for (let i = 0; i < S.length; i++) if (t >= S[i].t0 && t < S[i].t1) return S[i];
    return t < 0 ? S[0] : S[S.length - 1];
  }
  chordNotes(sec, t) {
    const k = Math.floor(Math.max(0, t - sec.t0) / sec.dur) % sec.chords.length;
    return this.score.chords[sec.chords[k]];
  }

  // disparo de uma nota de arpejo (voice stealing round-robin)
  trigger(sec, step, notes) {
    let m, vel = 0.75, dec = 0.16, bell = 0;
    const n = notes.length;
    if (sec.arp === 1) {
      // sobe e desce pelas vozes 1..4, com uma oitava acima a cada 8 passos
      const pat = [1, 2, 3, 4, 3, 2, 4, 1, 2, 3, 4, 1 + 5, 3, 2, 4, 3];
      const p = pat[step % pat.length];
      m = notes[(p % 5)] + 12 + (p >= 5 ? 12 : 0);
      vel = (step % 4 === 0) ? 1 : 0.62 + 0.15 * ((step * 7) % 3) / 2;
    } else if (sec.arp === 2) {
      // desconstrução: notas ao acaso (determinístico) com silêncios e saltos de oitava
      const h = Math.sin(step * 12.9898 + 78.233) * 43758.5453; const r = h - Math.floor(h);
      if (r < 0.38) return;
      m = notes[1 + Math.floor(r * 37) % 4] + (r > 0.8 ? 24 : 12);
      vel = 0.45 + 0.4 * r; dec = 0.09 + 0.25 * r;
    } else {
      // sinos lentos nas notas de cima
      m = notes[2 + (step % 3)] + 12 + ((step % 6) >= 3 ? 12 : 0);
      vel = 0.9; dec = 1.1; bell = 1;
    }
    const a = this.arp[this.arpNext]; this.arpNext = (this.arpNext + 1) % ARP_VOICES;
    a.f = mtof(m); a.env = 1; a.fenv = 1; a.amp = vel; a.on = true; a.bell = bell;
    a.dec = Math.exp(-1 / (dec * this.sr));
    a.fdec = Math.exp(-1 / ((bell ? 0.5 : 0.07) * this.sr));
    a.pan = (step % 2 ? 0.38 : -0.38);
    a.ph = 0; a.ph2 = 0;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const zb = [1, 2, 3, 4].map((k) => outputs[k] && outputs[k][0]);
    const mo = outputs[5] && outputs[5][0];
    const inp = inputs[0] && inputs[0][0];
    const N = L.length, sr = this.sr, s = this.st, sm = this.sm;

    // relógio musical: tempo da timeline no início do bloco
    const lead = s.playing ? Math.min(Math.max(currentTime - s.at, 0), 0.1) : 0;
    const t0 = s.t + lead;
    const sec = this.section(t0);
    const notes = this.chordNotes(sec, t0);
    if (sec !== this.lastSection) { this.lastSection = sec; this.lastStep = sec.rate ? Math.floor((t0 - sec.t0) * sec.rate) - 1 : -1; }

    // alvos suavizados por bloco (constantes de ~0.3–2 s)
    const kb = (tau) => 1 - Math.exp(-N / (tau * sr));
    const fade = s.fade;
    const climax = sec.id === 'climax' ? 1 : 0;
    sm.fade += (fade - sm.fade) * kb(0.3);
    sm.bright += (sec.bright * (1 + 0.25 * s.pulse) + 0.1 * s.built - sm.bright) * kb(2.2);
    sm.built += (s.built - sm.built) * kb(1);
    sm.pulse += (s.pulse - sm.pulse) * kb(0.08);
    sm.act += (s.activity - sm.act) * kb(0.4);
    const padT = (sec.id === 'dark' ? 0.55 : 1) * (1 - sm.fade);
    sm.pad += (padT - sm.pad) * kb(1.5);
    const arpT = (s.playing && sec.arp ? (sec.arp === 3 ? 0.9 : sec.arp === 2 ? 0.75 : 0.6 + 0.4 * sm.built) : 0) * (1 - sm.fade);
    sm.arp += (arpT - sm.arp) * kb(0.8);
    sm.air += (sec.air * (1 - sm.fade) - sm.air) * kb(1.5);
    sm.sub += ((sec.id === 'dark' ? 0.7 : 1) * (1 - sm.fade) - sm.sub) * kb(1.2);
    for (let k = 0; k < 4; k++) sm.zones[k] += ((s.zones[k] || 0) * (1 + 0.6 * s.pulse) * (1 - sm.fade) - sm.zones[k]) * kb(0.6);
    this.setRT(climax ? 6.5 : sec.id === 'complete1' ? 5.5 : 4.2);

    // pad: alvos de frequência e máscara de vozes
    for (let v = 0; v < 5; v++) {
      this.padTarget[v] = mtof(notes[v]);
      this.padAmpT[v] = v < sec.voices ? 1 : 0;
    }
    const glideK = 1 - Math.exp(-1 / (this.score.glide * 0.35 * sr));
    this.lfo += TAU * 0.05 * N / sr; if (this.lfo > TAU) this.lfo -= TAU;
    const cut = 110 * Math.pow(2, sm.bright * 6.2) * (1 + 0.12 * Math.sin(this.lfo)) * (1 + 0.5 * sm.pulse);
    this.padL.set(cut, 0.85, sr); this.padR.set(cut * 1.04, 0.85, sr);
    this.airL.set(1400 + 500 * Math.sin(this.lfo * 0.7), 0.9, sr); this.airR.set(1700 + 500 * Math.cos(this.lfo * 0.6), 0.9, sr);
    for (const a of this.arp) if (a.on) a.f1.set(Math.min(9000, 380 + 3800 * a.fenv * (0.5 + sm.bright)), 1.1, sr);
    this.impLp.set(220, 0.7, sr);

    // delay: 3 passos (colcheia pontuada no caso das semicolcheias)
    const dT = sec.rate ? Math.min(1.0, 3 / sec.rate) * sr : 0.4 * sr;
    // néon: frequências fixas no Ré (não chocam com nenhum acorde)
    const fz1 = mtof(74), fz2 = mtof(81), fBuzz = 100;
    // murmúrio
    this.mur.drift += N / sr * 0.25;
    this.mur.lp.set(520 + 260 * Math.sin(this.mur.drift), 0.6, sr);
    this.mur.lp2.set(520 + 260 * Math.sin(this.mur.drift), 0.6, sr);
    const murGain = (0.03 + 0.12 * sm.act) * (1 - sm.fade);

    const subMul = this.quest ? 0.45 : 1, sub2 = this.quest ? 0.9 : 0.25;
    const padGain = 0.055, arpGain = 0.11, airGain = 0.006;
    const wet = 0.32 + 0.1 * climax;

    for (let i = 0; i < N; i++) {
      // ---------- relógio ao sample: passos de arpejo
      if (sec.rate && s.playing) {
        const tt = t0 + i / sr;
        const st = Math.floor((tt - sec.t0) * sec.rate);
        if (st !== this.lastStep && st >= 0) { this.lastStep = st; if (arpT > 0.01) this.trigger(sec, st, notes); }
      }

      // ---------- pad
      let pl = 0, pr = 0;
      for (let v = 0; v < 5; v++) {
        this.padF[v] += (this.padTarget[v] - this.padF[v]) * glideK;
        this.padAmp[v] += (this.padAmpT[v] - this.padAmp[v]) * 0.00005;
        const f = this.padF[v], av = this.padAmp[v];
        if (av < 1e-4) continue;
        const det = 0.0035 + v * 0.0008;
        const j = v * 2;
        const d1 = f * (1 - det) / sr, d2 = f * (1 + det) / sr;
        let p1 = this.padPh[j] + d1; if (p1 >= 1) p1 -= 1; this.padPh[j] = p1;
        let p2 = this.padPh[j + 1] + d2; if (p2 >= 1) p2 -= 1; this.padPh[j + 1] = p2;
        const s1 = (2 * p1 - 1) - blep(p1, d1), s2 = (2 * p2 - 1) - blep(p2, d2);
        const pn = this.padPan[v];
        pl += av * (s1 * (0.5 - pn * 0.35) + s2 * (0.5 - pn * 0.15));
        pr += av * (s1 * (0.5 + pn * 0.15) + s2 * (0.5 + pn * 0.35));
      }
      pl = this.padL.lp(pl) * padGain * sm.pad; pr = this.padR.lp(pr) * padGain * sm.pad;

      // ---------- sub (seno na fundamental do acorde; no Quest reforça a 2.ª harmónica)
      let fs = this.padF[0]; if (fs < 55) fs *= 2;
      this.subPh += fs / sr; if (this.subPh >= 1) this.subPh -= 1;
      const sb = (Math.sin(TAU * this.subPh) * subMul + Math.sin(2 * TAU * this.subPh) * sub2 * 0.5) * (this.quest ? 0.035 : 0.05) * sm.sub;

      // ---------- arpejo
      let al = 0, ar = 0;
      for (let k = 0; k < ARP_VOICES; k++) {
        const a = this.arp[k];
        if (!a.on) continue;
        const dt = a.f / sr;
        a.ph += dt; if (a.ph >= 1) a.ph -= 1;
        a.ph2 += dt * 2.0; if (a.ph2 >= 1) a.ph2 -= 1;
        let x;
        if (a.bell) x = Math.sin(TAU * a.ph) * 0.8 + Math.sin(TAU * a.ph2) * 0.25 * a.fenv;
        else x = ((2 * a.ph - 1) - blep(a.ph, dt)) * 0.6 + Math.sin(TAU * a.ph2) * 0.25;
        const atk = a.env > 0.995 ? 1 : 1; // ataque implícito pelo filtro
        x = a.f1.lp(x) * a.env * a.amp * atk;
        a.env *= a.dec; a.fenv *= a.fdec;
        if (a.env < 1e-4) a.on = false;
        al += x * (0.5 - a.pan); ar += x * (0.5 + a.pan);
      }
      al *= arpGain * sm.arp; ar *= arpGain * sm.arp;

      // delay ping-pong com low-pass no feedback
      this.dlyTime += (dT - this.dlyTime) * 0.00002;
      const dl = this.dlyL.readFrac(this.dlyTime), dr = this.dlyR.readFrac(this.dlyTime);
      this.dlyLp += (dr - this.dlyLp) * 0.35; this.dlyRp += (dl - this.dlyRp) * 0.35;
      this.dlyL.write(al + this.dlyLp * 0.42);
      this.dlyR.write(ar * 0.3 + this.dlyRp * 0.42);
      al += dl * 0.45; ar += dr * 0.45;

      // ---------- ar
      const ax = this.airL.bp(this.nL.next()) * airGain * sm.air, ay = this.airR.bp(this.nR.next()) * airGain * sm.air;

      // ---------- impacto
      let im = 0;
      if (this.imp.env > 1e-4) {
        const p = this.imp;
        p.f += (38 - p.f) * 0.000012;
        p.ph += p.f / sr; if (p.ph >= 1) p.ph -= 1;
        const body = Math.sin(TAU * p.ph) + (this.quest ? 0.45 : 0.2) * Math.sin(2 * TAU * p.ph);
        const n = this.impLp.lp(this.nM.next()) * (p.env > 0.9 ? 1.5 : 0.25);
        im = (body * 0.5 + n * 0.4) * p.env * p.gain * 0.5;
        p.env *= Math.exp(-1 / (1.8 * sr));
      }

      // ---------- reverb (FDN 4x4 Hadamard, amortecimento no loop, ligeira modulação)
      const sendIn = (inp ? inp[i] : 0) + (pl + pr) * 0.45 + (al + ar) * 0.55 + im * 0.5 + (ax + ay) * 0.6;
      this.pre.write(sendIn);
      let x = this.pre.read(Math.round(0.024 * sr));
      for (let a = 0; a < 3; a++) x = this.ap[a].run(x);
      this.modPh += 0.4 / sr; if (this.modPh > 1) this.modPh -= 1;
      const md = Math.sin(TAU * this.modPh) * 6;
      const y0 = this.fdn[0].readFrac(this.fdnLen[0] + md), y1 = this.fdn[1].read(this.fdnLen[1]);
      const y2 = this.fdn[2].readFrac(this.fdnLen[2] - md), y3 = this.fdn[3].read(this.fdnLen[3]);
      const h0 = (y0 + y1 + y2 + y3) * 0.5, h1 = (y0 - y1 + y2 - y3) * 0.5, h2 = (y0 + y1 - y2 - y3) * 0.5, h3 = (y0 - y1 - y2 + y3) * 0.5;
      const damp = 0.42;
      this.fdnLp[0] += (h0 - this.fdnLp[0]) * damp; this.fdnLp[1] += (h1 - this.fdnLp[1]) * damp;
      this.fdnLp[2] += (h2 - this.fdnLp[2]) * damp; this.fdnLp[3] += (h3 - this.fdnLp[3]) * damp;
      this.fdn[0].write(x + this.fdnLp[0] * this.fdnG[0]);
      this.fdn[1].write(x * 0.9 + this.fdnLp[1] * this.fdnG[1]);
      this.fdn[2].write(-x * 0.8 + this.fdnLp[2] * this.fdnG[2]);
      this.fdn[3].write(x * 0.7 + this.fdnLp[3] * this.fdnG[3]);
      const rl = (y0 + y2 * 0.6 - y3 * 0.3) * wet, rr = (y1 + y3 * 0.6 - y2 * 0.3) * wet;

      let oL = pl + al + ax + sb + im + rl, oR = pr + ar + ay + sb + im + rr;
      // saturação suave: nunca clipa duro
      L[i] = oL / (1 + Math.abs(oL) * 0.6);
      if (R !== L) R[i] = oR / (1 + Math.abs(oR) * 0.6);

      // ---------- néon (3 zonas): seno em Ré5 + quinta + zumbido de 100 Hz com cintilação
      {
        for (let k = 0; k < 4; k++) {
          const zz = this.zone[k], g = sm.zones[k];
          const buf = zb[k];
          if (!buf) continue;
          if (g < 1e-4) { buf[i] = 0; continue; }
          zz.ph1 += fz1 * (1 + k * 0.0012) / sr; if (zz.ph1 >= 1) zz.ph1 -= 1;
          zz.ph2 += fz2 * (1 - k * 0.001) / sr; if (zz.ph2 >= 1) zz.ph2 -= 1;
          zz.ph3 += fBuzz / sr; if (zz.ph3 >= 1) zz.ph3 -= 1;
          if ((i & 63) === 0) { if (zz.n.next() > 0.995) zz.flickT = 0.35; else zz.flickT += (1 - zz.flickT) * 0.08; }
          zz.flick += (zz.flickT - zz.flick) * 0.004;
          const buzz = zz.lp.lp((2 * zz.ph3 - 1) - blep(zz.ph3, fBuzz / sr));
          buf[i] = (Math.sin(TAU * zz.ph1) * 0.5 + Math.sin(TAU * zz.ph2) * 0.18 + buzz * 0.45) * g * zz.flick * 0.05;
        }
      }

      // ---------- murmúrio do swarm: grãos curtos de ruído filtrado
      if (mo) {
        const m = this.mur;
        // ruído em dupla passa-baixo (~12 dB/oct x2) com respiração lenta: um sopro, não estática
        m.am += TAU * 0.6 / sr; if (m.am > TAU) m.am -= TAU;
        const breath = 0.7 + 0.3 * Math.sin(m.am);
        mo[i] = m.lp2.lp(m.lp.lp(m.n.next())) * breath * murGain;
      }
    }
    return true;
  }
}

registerProcessor('swarm-synth', SwarmSynth);
