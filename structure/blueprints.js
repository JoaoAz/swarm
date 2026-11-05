// structure/blueprints.js
// Cada planta é uma lista de segmentos { a, b, ring, stagger } gerada proceduralmente.
// Arestas longas são partidas em peças de no máximo MAX_PIECE metros: cada peça é uma
// tarefa de um cursor, e peças consecutivas da mesma aresta saem com um pequeno atraso
// (stagger), por isso vê-se uma fila de cursores a desenhar a mesma linha, tipo formigas.

import { mulberry32 } from '../util/math.js';

const MAX_PIECE = 4.2;

// Escala: valores escolhidos dentro das propostas do prompt (molduras 12–20 m, corredor 150–250 m).
export const SCALE = {
  squareSize: 16,      // molduras quadradas: 16 x 16 m
  squareRings: 16,
  squareSpacing: 12,   // 16 anéis * 12 m: o túnel vai até ~-192 m
  archHeight: 24,      // arcos Λ: 24 m de altura, mais monumentais
  archHalfBase: 14,
  archRings: 18,
  archSpacing: 11,     // até ~-197 m
  firstZ: -12,
};

class Builder {
  constructor() { this.segments = []; }
  edge(a, b, ring, opts = {}) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    const n = Math.max(1, Math.ceil(len / (opts.maxPiece || MAX_PIECE)));
    const base = opts.delay || 0;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      this.segments.push({
        a: [a[0] + dx * t0, a[1] + dy * t0, a[2] + dz * t0],
        b: [a[0] + dx * t1, a[1] + dy * t1, a[2] + dz * t1],
        ring,
        stagger: base + i,          // ordem dentro do anel (em "passos" de pieceStagger)
        weight: opts.weight ?? 1,   // intensidade de néon relativa
      });
    }
  }
  poly(pts, ring, closed = false, opts = {}) {
    let d = opts.delay || 0;
    const m = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      this.edge(a, b, ring, { ...opts, delay: d });
      d += Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / MAX_PIECE);
    }
  }
}

// Retângulo de cantos arredondados no plano YZ (painel lateral, x fixo).
function roundedRectYZ(x, y0, y1, z0, z1, r, steps = 3) {
  const pts = [];
  const corner = (cy, cz, a0) => {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (i / steps) * (Math.PI / 2);
      pts.push([x, cy + Math.sin(a) * r, cz + Math.cos(a) * r]);
    }
  };
  // z0 > z1 (mais perto -> mais longe). Percorre: canto (y1,z0) ... sentido anti-horário
  corner(y1 - r, z0 - r, 0);                 // topo/perto
  corner(y1 - r, z1 + r, Math.PI / 2);       // topo/longe
  corner(y0 + r, z1 + r, Math.PI);           // baixo/longe
  corner(y0 + r, z0 - r, Math.PI * 1.5);     // baixo/perto
  return pts;
}

// Marcadores à escala humana na base das estruturas (para se perceber o tamanho do resto).
function baseMarkers(B, x, z, ring) {
  const s = x > 0 ? -1 : 1;
  B.edge([x, 0, z], [x + s * 0.6, 0, z], ring, { weight: 0.7, delay: 0 });
  B.edge([x, 0, z], [x, 0.9, z], ring, { weight: 0.7, delay: 0 });
  B.edge([x + s * 0.3, 0, z + 0.4], [x + s * 0.3, 0, z - 0.4], ring, { weight: 0.5, delay: 1 });
}

export function squareTunnel() {
  const B = new Builder();
  const { squareSize: S, squareRings: R, squareSpacing: D, firstZ } = SCALE;
  const h = S / 2;
  for (let r = 0; r < R; r++) {
    const z = firstZ - r * D;
    // moldura exterior: começa num canto do chão, sobe, atravessa o topo e desce
    B.poly([[-h, 0, z], [-h, S, z], [h, S, z], [h, 0, z]], r, false);
    // linha do chão da moldura (mais fina)
    B.edge([-h, 0, z], [h, 0, z], r, { weight: 0.6, delay: 2 });
    // moldura concêntrica interior
    const i1 = 1.4;
    B.poly([[-h + i1, 0, z], [-h + i1, S - i1, z], [h - i1, S - i1, z], [h - i1, 0, z]], r, false, { delay: 3, weight: 0.8 });
    // terceira moldura, em anéis alternados (ritmo)
    if (r % 2 === 0) {
      const i2 = 3.2;
      B.poly([[-h + i2, S - i2 - 4, z], [-h + i2, S - i2, z], [h - i2, S - i2, z], [h - i2, S - i2 - 4, z]], r, false, { delay: 6, weight: 0.55 });
    }
    baseMarkers(B, -h, z, r);
    baseMarkers(B, h, z, r);
    // calhas longitudinais que ligam este anel ao seguinte (topo e chão)
    if (r < R - 1) {
      const z2 = z - D;
      B.edge([-h, S, z], [-h, S, z2], r, { delay: 5, weight: 0.7 });
      B.edge([h, S, z], [h, S, z2], r, { delay: 5, weight: 0.7 });
      B.edge([-h, 0, z], [-h, 0, z2], r, { delay: 4, weight: 0.5 });
      B.edge([h, 0, z], [h, 0, z2], r, { delay: 4, weight: 0.5 });
    }
  }
  // linhas do chão à escala humana, ao longo do eixo (guias de 1 m)
  for (let k = 0; k < 2; k++) {
    const x = k ? 1.1 : -1.1;
    B.edge([x, 0, -4], [x, 0, firstZ], 0, { weight: 0.35, delay: 0 });
  }
  return { name: 'squareTunnel', segments: B.segments, rings: R };
}

export function chevronCorridor() {
  const B = new Builder();
  const { archHeight: H, archHalfBase: W, archRings: R, archSpacing: D, firstZ } = SCALE;
  for (let r = 0; r < R; r++) {
    const z = firstZ + 2 - r * D;
    // arco triangular Λ: sobe pelas duas pernas em simultâneo (delay igual) até ao vértice
    B.edge([-W, 0, z], [0, H, z], r, {});
    B.edge([W, 0, z], [0, H, z], r, {});
    // Λ interior
    const k = 0.78;
    B.edge([-W * k, 0, z], [0, H * k, z], r, { delay: 2, weight: 0.75 });
    B.edge([W * k, 0, z], [0, H * k, z], r, { delay: 2, weight: 0.75 });
    // chevrons junto ao vértice
    for (let c = 0; c < 2; c++) {
      const y = H * (0.86 - c * 0.08), w = W * (0.1 + c * 0.08);
      const yt = y + w * (H / W);
      B.poly([[-w, y, z], [0, yt, z], [w, y, z]], r, false, { delay: 5 + c, weight: 0.6 });
    }
    baseMarkers(B, -W, z, r);
    baseMarkers(B, W, z, r);
    if (r < R - 1) {
      const z2 = z - D;
      // cumeeira que liga os vértices
      B.edge([0, H, z], [0, H, z2], r, { delay: 6, weight: 0.8 });
      B.edge([-W, 0, z], [-W, 0, z2], r, { delay: 4, weight: 0.5 });
      B.edge([W, 0, z], [W, 0, z2], r, { delay: 4, weight: 0.5 });
    }
  }
  for (let k = 0; k < 2; k++) {
    const x = k ? 1.1 : -1.1;
    B.edge([x, 0, -4], [x, 0, firstZ + 2], 0, { weight: 0.35 });
  }
  return { name: 'chevronCorridor', segments: B.segments, rings: R };
}

// Mistura: anéis alternados quadrados e triangulares (para o painel de debug).
export function mixed() {
  const sq = squareTunnel(), ch = chevronCorridor();
  const segs = [];
  for (const s of sq.segments) if (s.ring % 2 === 0) segs.push(s);
  for (const s of ch.segments) if (s.ring % 2 === 1) segs.push(s);
  return { name: 'mixed', segments: segs, rings: Math.max(sq.rings, ch.rings) };
}

export const BLUEPRINTS = { squareTunnel, chevronCorridor, mixed };

// Linhas de perspetiva nas paredes laterais, a convergir para o ponto de fuga do corredor.
export function wallPerspectiveLines() {
  const segs = [];
  const vp = [0, 1.6, -320];
  for (const sx of [-1, 1]) {
    const x = sx * 26;
    for (let i = 0; i < 9; i++) {
      const y = i * 4.5;
      const a = [x, y, 4];
      const t = 0.62; // até onde a linha vai em direção ao ponto de fuga
      const b = [x, y + (vp[1] - y) * t, a[2] + (vp[2] - a[2]) * t];
      segs.push({ a, b, ring: 0, stagger: 0, weight: 0.22 });
    }
  }
  return segs;
}

export function shuffleWithSeed(arr, seed) {
  const r = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
