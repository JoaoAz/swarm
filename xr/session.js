// xr/session.js
// Botão "Enter VR", foveation, espaço de referência local-floor e deteção do Quest.
// O utilizador fica de pé num ponto fixo do eixo do corredor: sem locomoção nem raios.

import { VRButton } from 'three/addons/webxr/VRButton.js';

export function isQuestBrowser() {
  const ua = navigator.userAgent || '';
  return /OculusBrowser|Quest|Pico/i.test(ua);
}

export function setupXR(renderer, { onStart, onEnd } = {}) {
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFoveation(1.0);          // foveation máxima: poupa muito fill-rate no Quest
  if (renderer.xr.setFramebufferScaleFactor) renderer.xr.setFramebufferScaleFactor(1.0);

  const button = VRButton.createButton(renderer, { optionalFeatures: ['local-floor', 'hand-tracking'] });
  button.id = 'vr-button';
  document.body.appendChild(button);

  renderer.xr.addEventListener('sessionstart', () => {
    renderer.xr.setFoveation(1.0);
    onStart && onStart(renderer.xr.getSession());
  });
  renderer.xr.addEventListener('sessionend', () => onEnd && onEnd());
  return button;
}
