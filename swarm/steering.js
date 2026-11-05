// swarm/steering.js
// Steering behaviours (seek/arrive, separação, alinhamento, coesão) sobre arrays tipados,
// grelha espacial para vizinhos e curl noise 3D para a deriva orgânica.

import { makeNoise3 } from '../util/math.js';

// ---------------------------------------------------------------------------
// PARÂMETROS DE "ORGANICIDADE" (afinar aqui)
// ---------------------------------------------------------------------------
export const STEER = {
  // velocidades máximas (m/s) e acelerações máximas (m/s²) por tipo de movimento
  idleSpeed: 2.6,     // a pairar na nuvem: lento
  travelSpeed: 21,    // a voar até um segmento: rápido como um rato, mas com limite
  drawSpeed: 5.5,     // velocidade a que a linha cresce atrás do cursor
  eraseSpeed: 9,      // a apagar: a linha encolhe mais depressa do que cresce
  carrySpeed: 10,      // a arrastar um segmento: mais pesado
  maxAccel: 34,       // acima disto o movimento parece "teleporte"
  idleAccel: 6,
  // tempo de resposta do seek (s). Maior = mais preguiçoso e curvo.
  tauTravel: 0.42,
  tauDraw: 0.09,      // a desenhar segue a "cenoura" de muito perto
  tauIdle: 0.9,
  arriveRadius: 4.5,  // começa a travar a esta distância do alvo
  // boids (só a pairar; a trabalhar só a separação conta)
  sepRadius: 0.9, sepGain: 9,
  alignRadius: 3.5, alignGain: 0.35,
  cohGain: 0.12,
  // curl noise: frequência espacial, velocidade de evolução e amplitude por estado
  noiseFreq: 0.075, noiseTime: 0.11,
  noiseIdle: 2.4, noiseTravel: 1.6, noiseDraw: 0.15, noiseCarry: 0.6,
  // rotação da seta: taxa de alinhamento com a direção (1/s) e inclinação nas curvas
  turnRate: 7, bankGain: 0.11, bankMax: 0.7,
  // vida: micro-tremor (probabilidade por segundo e força do impulso)
  tremorRate: 0.25, tremorKick: 0.9,
};

export class SpatialGrid {
  constructor(maxItems, cell = 2.0, tableSize = 4096) {
    this.cell = cell; this.size = tableSize;
    this.head = new Int32Array(tableSize);
    this.next = new Int32Array(maxItems);
  }
  key(x, y, z) {
    const c = this.cell;
    const ix = Math.floor(x / c), iy = Math.floor(y / c), iz = Math.floor(z / c);
    return (((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) >>> 0) % this.size;
  }
  build(pos, count, alive) {
    this.head.fill(-1);
    for (let i = 0; i < count; i++) {
      if (!alive[i]) continue;
      const k = this.key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      this.next[i] = this.head[k]; this.head[k] = i;
    }
  }
  // chama fn(j) para todos os itens nas 27 células vizinhas
  forNeighbors(x, y, z, fn) {
    const c = this.cell;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      let j = this.head[this.key(x + dx * c, y + dy * c, z + dz * c)];
      while (j !== -1) { fn(j); j = this.next[j]; }
    }
  }
}

export function makeCurl(seed) {
  const n1 = makeNoise3(seed), n2 = makeNoise3(seed + 1), n3 = makeNoise3(seed + 2);
  const e = 0.35;
  // devolve o rotacional de um potencial vetorial de ruído: campo sem divergência,
  // por isso os cursores "rodopiam" sem se acumularem em pontos.
  return function curl(x, y, z, t, out) {
    const f = STEER.noiseFreq;
    x *= f; y *= f; z = z * f + t;
    const a0 = n1(x, y, z), a_y = n1(x, y + e, z), a_z = n1(x, y, z + e);
    const b0 = n2(x, y, z), b_x = n2(x + e, y, z), b_z = n2(x, y, z + e);
    const c0 = n3(x, y, z), c_x = n3(x + e, y, z), c_y = n3(x, y + e, z);
    out[0] = ((c_y - c0) - (b_z - b0)) / e;
    out[1] = ((a_z - a0) - (c_x - c0)) / e;
    out[2] = ((b_x - b0) - (a_y - a0)) / e;
    return out;
  };
}

// seek + arrive: devolve aceleração para chegar a (tx,ty,tz) com velocidade máx. vmax
export function arrive(px, py, pz, vx, vy, vz, tx, ty, tz, vmax, tau, slowR, out) {
  let dx = tx - px, dy = ty - py, dz = tz - pz;
  const d = Math.hypot(dx, dy, dz);
  let s = 0;
  if (d > 1e-5) { s = vmax * Math.min(1, d / slowR) / d; }
  out[0] = (dx * s - vx) / tau;
  out[1] = (dy * s - vy) / tau;
  out[2] = (dz * s - vz) / tau;
  return d;
}
