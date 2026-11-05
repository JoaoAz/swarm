// swarm/cursorAtlas.js
// Atlas 2x2 desenhado em canvas: seta clássica, mão de apontar, ampulheta, cruz de seleção.
// Branco com contorno preto. A ponta de cada ícone fica no mesmo sítio (TIP) para o
// segmento de néon sair sempre da ponta do cursor.

import * as THREE from 'three';

export const SHAPE = { ARROW: 0, HAND: 1, WAIT: 2, CROSS: 3 };
export const ICON_PX = 128;
export const TIP = [10 / ICON_PX, 10 / ICON_PX];              // em fração do ícone, a partir do canto sup. esquerdo
export const ARROW_FORWARD = Math.atan2(15, -6);              // direção da ponta da seta (rad, y para cima)

export function makeCursorAtlas() {
  const S = ICON_PX * 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  const u = 5.1; // px por unidade de desenho
  const drawIcon = (cx, cy, path) => {
    g.save();
    g.translate(cx * ICON_PX + 10, cy * ICON_PX + 10);
    g.lineJoin = 'round';
    g.lineWidth = 2.2 * u * 0.5;
    path(g);
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#000000';
    g.fill(); g.stroke();
    g.restore();
  };
  const poly = (pts) => (c) => {
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x * u, y * u) : c.moveTo(x * u, y * u)));
    c.closePath();
  };
  // seta clássica
  drawIcon(0, 0, poly([[0, 0], [0, 17], [4, 13.2], [7, 20], [10, 18.8], [7.1, 12.2], [12.4, 12.2]]));
  // mão de apontar (o dedo é a ponta)
  drawIcon(1, 0, (c) => {
    const p = new Path2D();
    const r = (x, y, w, h, rad) => p.roundRect((x + 3.6) * u, y * u, w * u, h * u, rad * u);
    c.beginPath();
    r(0, 0, 3.2, 12, 1.6);          // indicador
    r(3.2, 6.5, 3, 7, 1.4);
    r(6.2, 7.2, 3, 6.5, 1.4);
    r(9.2, 8.2, 2.8, 5.5, 1.3);
    r(-3.4, 10.5, 4.5, 3.4, 1.6);   // polegar
    r(-0.3, 11.5, 12.3, 8.5, 2.6);  // palma
    c.fillStyle = '#fff'; c.strokeStyle = '#000';
    c.lineWidth = 2.2 * u * 0.5;
    c.stroke(p); c.fill(p);
    c.beginPath();
  });
  // ampulheta
  drawIcon(0, 1, poly([[0, 0], [12, 0], [12, 2], [7.4, 9.8], [12, 17.6], [12, 19.6], [0, 19.6], [0, 17.6], [4.6, 9.8], [0, 2]]));
  // cruz de seleção
  drawIcon(1, 1, poly([
    [5, 0], [7, 0], [7, 5], [12, 5], [12, 7], [7, 7], [7, 12], [5, 12], [5, 7], [0, 7], [0, 5], [5, 5],
  ]));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}
