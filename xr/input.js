// xr/input.js
// A "mão" do participante, numa só interface para todas as entradas:
//   VR com hand tracking: ponta do indicador; pinch (polegar + indicador) = clique
//   VR com comandos:      ponta do raio do comando; gatilho = clique
//   Desktop:              rato (o cursor fica a 1,2 m ao longo do raio); botão esquerdo = clique
// Expõe: pos (Vector3, mundo), pinching, active (houve input recente), source, e os
// callbacks onPinchStart / onPinchEnd.

import * as THREE from 'three';

const PINCH_ON = 0.018, PINCH_OFF = 0.032; // m, com histerese para não "tremer"

export class ParticipantInput {
  constructor(renderer, camera, rig, dom) {
    this.renderer = renderer;
    this.camera = camera;
    this.pos = new THREE.Vector3(0.12, 1.3, -0.55);
    this.pinching = false;
    this.source = 'none';
    this.lastActivity = -Infinity; // performance.now() em s
    this.onPinchStart = () => {};
    this.onPinchEnd = () => {};
    this.mouseEnabled = false;      // o main liga isto durante a fase em que controlas o cursor
    this._ndc = new THREE.Vector2(0.12, -0.15);
    this._ray = new THREE.Raycaster();
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    // mãos (hand tracking)
    this.hands = [0, 1].map((i) => {
      const h = renderer.xr.getHand(i);
      h.userData.handedness = null;
      h.addEventListener('connected', (e) => { h.userData.handedness = e.data && e.data.handedness; h.userData.on = true; });
      h.addEventListener('disconnected', () => { h.userData.on = false; });
      rig.add(h);
      return h;
    });
    // comandos (fallback)
    this.controllers = [0, 1].map((i) => {
      const c = renderer.xr.getController(i);
      c.addEventListener('connected', (e) => {
        c.userData.on = !(e.data && e.data.hand); // um "comando" que é uma mão é tratado acima
        c.userData.handedness = e.data && e.data.handedness;
      });
      c.addEventListener('disconnected', () => { c.userData.on = false; });
      c.addEventListener('selectstart', () => { if (c.userData.on) this._setPinch(true, 'controller'); });
      c.addEventListener('selectend', () => { if (c.userData.on) this._setPinch(false, 'controller'); });
      rig.add(c);
      return c;
    });

    // rato
    dom.addEventListener('pointermove', (e) => {
      const r = dom.getBoundingClientRect();
      this._ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      if (this.mouseEnabled) this._touch('mouse');
    });
    dom.addEventListener('pointerdown', (e) => { if (this.mouseEnabled && e.button === 0) this._setPinch(true, 'mouse'); });
    window.addEventListener('pointerup', (e) => { if (e.button === 0 && this.pinching && this.source === 'mouse') this._setPinch(false, 'mouse'); });
  }

  _touch(src) { this.source = src; this.lastActivity = performance.now() / 1000; }
  _setPinch(v, src) {
    this._touch(src);
    if (v === this.pinching) return;
    this.pinching = v;
    (v ? this.onPinchStart : this.onPinchEnd)(this.pos.clone());
  }

  // segundos desde o último input real
  idleFor() { return performance.now() / 1000 - this.lastActivity; }

  update() {
    const xr = this.renderer.xr;
    if (xr.isPresenting) {
      // 1) hand tracking: prefere a mão direita
      const hands = this.hands.filter((h) => h.userData.on && h.joints && h.joints['index-finger-tip']);
      hands.sort((a, b) => (b.userData.handedness === 'right') - (a.userData.handedness === 'right'));
      const h = hands[0];
      if (h) {
        const tip = h.joints['index-finger-tip'], thumb = h.joints['thumb-tip'];
        if (tip.visible !== false) {
          tip.getWorldPosition(this._tmpA);
          const moved = this._tmpA.distanceToSquared(this.pos) > 1e-6;
          this.pos.copy(this._tmpA);
          if (moved) this._touch('hand');
          if (thumb) {
            thumb.getWorldPosition(this._tmpB);
            const d = this._tmpA.distanceTo(this._tmpB);
            if (!this.pinching && d < PINCH_ON) this._setPinch(true, 'hand');
            else if (this.pinching && this.source === 'hand' && d > PINCH_OFF) this._setPinch(false, 'hand');
          }
          return;
        }
      }
      // 2) comando: 8 cm à frente da ponta do raio
      const cs = this.controllers.filter((c) => c.userData.on);
      cs.sort((a, b) => (b.userData.handedness === 'right') - (a.userData.handedness === 'right'));
      const c = cs[0];
      if (c) {
        c.getWorldPosition(this._tmpA);
        c.getWorldQuaternion(this._q);
        this._tmpB.set(0, 0, -0.08).applyQuaternion(this._q);
        const p = this._tmpA.add(this._tmpB);
        if (p.distanceToSquared(this.pos) > 1e-6) this._touch('controller');
        this.pos.copy(p);
      }
      return;
    }
    // 3) rato: ponto a 1,2 m ao longo do raio que passa pelo ponteiro
    if (this.mouseEnabled) {
      this._ray.setFromCamera(this._ndc, this.camera);
      this.pos.copy(this._ray.ray.origin).addScaledVector(this._ray.ray.direction, 1.2);
    }
  }
}
