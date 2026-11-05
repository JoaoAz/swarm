// structure/blueprints.js
// Cada planta é uma lista de segmentos { a, b, ring, stagger } gerada proceduralmente.
// Arestas longas são partidas em peças de no máximo MAX_PIECE metros: cada peça é uma
// tarefa de um cursor, e peças consecutivas da mesma aresta saem com um pequeno atraso
// (stagger), por isso vê-se uma fila de cursores a desenhar a mesma linha, tipo formigas.

import { mulberry32 } from '../util/math.js';

const MAX_PIECE = 4.2;

// Escala: molduras 16 m, arcos 24 m. O participante está no centro de um cruzamento:
// quatro corredores (braços) saem do centro, um para cada lado, e perdem-se na névoa.
export const SCALE = {
  squareSize: 16,      // molduras quadradas: 16 x 16 m
  squareRings: 9,      // anéis por braço
  squareSpacing: 12,   // 9 anéis * 12 m: cada braço vai até ~106 m
  squareFirst: 10,     // distância do centro ao primeiro anel
  archHeight: 24,      // arcos Λ: 24 m de altura, mais monumentais
  archHalfBase: 14,
  archRings: 9,
  archSpacing: 11,
  archFirst: 15,       // > meia-base: os arcos de braços vizinhos não se cruzam
  arms: 4,
};

// roda um ponto em torno do eixo vertical, 90° por braço (braço 0 = -Z, à frente)
function rotArm([x, y, z], k) {
  const a = (k * Math.PI) / 2, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  return [x * c + z * s, y, -x * s + z * c];
}
function inArms(build) {
  const B = new Builder();
  for (let k = 0; k < SCALE.arms; k++) {
    const sub = new Builder();
    build(sub);
    for (const seg of sub.segments) B.segments.push({ ...seg, a: rotArm(seg.a, k), b: rotArm(seg.b, k) });
  }
  return B.segments;
}

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

// Uma única moldura por anel (sem molduras concêntricas, que se liam como linhas duplicadas).
export function squareTunnel() {
  const { squareSize: S, squareRings: R, squareSpacing: D, squareFirst } = SCALE;
  const h = S / 2;
  const segments = inArms((B) => {
    for (let r = 0; r < R; r++) {
      const z = -squareFirst - r * D;
      // moldura: começa num canto do chão, sobe, atravessa o topo e desce
      B.poly([[-h, 0, z], [-h, S, z], [h, S, z], [h, 0, z]], r, false);
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
  });
  return { name: 'squareTunnel', segments, rings: R };
}

// Um único arco Λ por anel (sem o Λ interior nem os chevrons junto ao vértice).
export function chevronCorridor() {
  const { archHeight: H, archHalfBase: W, archRings: R, archSpacing: D, archFirst } = SCALE;
  const segments = inArms((B) => {
    for (let r = 0; r < R; r++) {
      const z = -archFirst - r * D;
      // sobe pelas duas pernas em simultâneo (delay igual) até ao vértice
      B.edge([-W, 0, z], [0, H, z], r, {});
      B.edge([W, 0, z], [0, H, z], r, {});
      baseMarkers(B, -W, z, r);
      baseMarkers(B, W, z, r);
      if (r < R - 1) {
        const z2 = z - D;
        B.edge([0, H, z], [0, H, z2], r, { delay: 6, weight: 0.8 }); // cumeeira
        B.edge([-W, 0, z], [-W, 0, z2], r, { delay: 4, weight: 0.5 });
        B.edge([W, 0, z], [W, 0, z2], r, { delay: 4, weight: 0.5 });
      }
    }
  });
  return { name: 'chevronCorridor', segments, rings: R };
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

// Linhas de perspetiva nas paredes: retiradas no cruzamento (não há paredes laterais).
export function wallPerspectiveLines() { return []; }

export function shuffleWithSeed(arr, seed) {
  const r = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
