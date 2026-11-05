// debug.js: painel lil-gui (só Desktop) + teclas de atalho.

import GUI from 'lil-gui';
import { TIMELINE } from './timeline.js';
import { STEER } from './swarm/steering.js';

export function setupDebug({ director, swarm, bloom, audio, app }) {
  const gui = new GUI({ title: 'Swarm · debug' });
  const st = {
    playing: true,
    time: 0,
    speed: 1,
    cursors: swarm.n,
    bloom: bloom ? bloom.strength : 0,
    volume: audio.volume,
    plan: '',
    phase: '',
    loop: TIMELINE.loop,
    cinematic: false,
    rebuild: () => { director.reset(); director.play(); },
  };
  const tl = gui.addFolder('Timeline');
  tl.add(st, 'playing').name('play / pause').onChange((v) => (v ? director.play() : director.pause())).listen();
  const scrub = tl.add(st, 'time', 0, TIMELINE.duration - 0.05, 0.05).name('tempo (s)').listen();
  scrub.onFinishChange((v) => { director.seek(v); });
  scrub.onChange(() => { st._scrubbing = true; clearTimeout(st._st); st._st = setTimeout(() => (st._scrubbing = false), 400); });
  tl.add(st, 'speed', { '0,25x': 0.25, '0,5x': 0.5, '1x': 1, '2x': 2, '4x': 4 }).name('velocidade').onChange((v) => (director.speed = +v));
  tl.add(st, 'phase').name('momento').disable().listen();
  tl.add(st, 'plan').name('planta atual').disable().listen();
  tl.add(st, 'loop').name('loop no fim').onChange((v) => (TIMELINE.loop = v));
  tl.add(st, 'rebuild').name('reconstruir (do início)');

  const sw = gui.addFolder('Swarm');
  sw.add(st, 'cursors', 20, swarm.maxN, 10).name('N cursores').onFinishChange((v) => {
    swarm.setCount(v); const t = director.t; director.reset(); director.seek(t);
  });
  sw.add(STEER, 'travelSpeed', 4, 30, 0.5).name('velocidade de voo');
  sw.add(STEER, 'drawSpeed', 1, 15, 0.5).name('velocidade a desenhar');
  sw.add(STEER, 'noiseIdle', 0, 6, 0.1).name('curl noise (livres)');
  sw.add(STEER, 'tauTravel', 0.1, 1.5, 0.01).name('inércia (tau)');
  sw.close();

  const look = gui.addFolder('Look');
  if (bloom) look.add(st, 'bloom', 0, 3, 0.01).name('bloom').onChange((v) => (bloom.strength = v));
  look.add(st, 'volume', 0, 1, 0.01).name('volume').onChange((v) => audio.setVolume(v));
  look.add(st, 'cinematic').name('câmara cinemática (C)').onChange((v) => (app.cinematic = v)).listen();

  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { st.playing = !st.playing; st.playing ? director.play() : director.pause(); e.preventDefault(); }
    if (e.code === 'KeyC') { app.cinematic = !app.cinematic; st.cinematic = app.cinematic; }
    if (e.code === 'KeyH') gui.show(gui._hidden = !gui._hidden);
    if (e.code === 'ArrowRight') director.seek(director.t + 5);
    if (e.code === 'ArrowLeft') director.seek(director.t - 5);
  });

  return {
    gui,
    update() {
      if (!st._scrubbing) st.time = director.t;
      st.playing = director.playing;
      st.phase = director.phase.label;
      st.plan = director.t < 65 ? director.blueprint1 : director.blueprint2;
    },
  };
}
