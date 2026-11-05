// audio/score.js
// Partitura do ambiente musical, alinhada com timeline.js. Tudo em Ré (eólio/dórico),
// com um Ré maior (terceira picarda) no clímax. Os acordes têm sempre 5 vozes, ordenadas
// do grave para o agudo, para que o pad possa fazer voice-leading por glissando
// (cada voz desliza para a nota da mesma posição no acorde seguinte).
//
// Este objeto é passado ao AudioWorklet (processorOptions) e usado no thread principal
// para afinar os cliques e as ignições pelo acorde que está a soar.

const C = {
  D5:    [50, 57, 62, 69, 74],          // vazio: Ré + Lá (só soam as duas vozes de baixo)
  Dm9:   [50, 57, 60, 64, 65],
  Bbma7: [46, 53, 57, 60, 62],
  Bbma9: [46, 53, 57, 60, 72],
  Gm9:   [43, 50, 53, 57, 58],
  Asus:  [45, 52, 55, 62, 64],
  A7s:   [45, 52, 55, 61, 64],          // Lá com sétima e Dó#: puxa para o Ré
  Fma9:  [53, 60, 64, 67, 69],
  FA:    [45, 53, 60, 64, 67],          // Fá/Lá
  Ebma7: [51, 58, 62, 65, 69],          // Mib maj7#11: napolitano, sombra
  Em7b5: [52, 58, 62, 67, 70],
  DM9:   [50, 57, 61, 64, 66],          // Ré maior: clímax
};

// secções: [início, fim, sequência de acordes, duração de cada acorde (s), parâmetros]
//   bright 0..1: abertura do filtro do pad. arp: 0 sem arpejo, 1 semicolcheias, 2 tercinas rápidas.
//   rate: passos de arpejo por segundo. voices: quantas vozes do pad soam (as restantes calam).
export const SCORE = {
  key: 'D',
  sections: [
    { id: 'dark',      t0: 0,   t1: 10,  chords: ['D5'],                         dur: 10,   bright: 0.14, arp: 0, rate: 0,   voices: 2, air: 0.25 },
    { id: 'gather',    t0: 10,  t1: 25,  chords: ['Dm9'],                        dur: 15,   bright: 0.26, arp: 0, rate: 0,   voices: 5, air: 0.4 },
    { id: 'build1',    t0: 25,  t1: 55,  chords: ['Dm9', 'Bbma7', 'Gm9', 'Asus'], dur: 7.5,  bright: 0.42, arp: 1, rate: 7,   voices: 5, air: 0.35 },
    { id: 'complete1', t0: 55,  t1: 65,  chords: ['Fma9', 'Dm9'],                dur: 6,    bright: 0.7,  arp: 3, rate: 3.5, voices: 5, air: 0.8 },
    { id: 'morph',     t0: 65,  t1: 80,  chords: ['Ebma7', 'Em7b5'],             dur: 7.5,  bright: 0.3,  arp: 2, rate: 5.25, voices: 5, air: 0.5 },
    { id: 'build2',    t0: 80,  t1: 105, chords: ['Gm9', 'Bbma9', 'FA', 'A7s'],  dur: 6.25, bright: 0.55, arp: 1, rate: 8.75, voices: 5, air: 0.45 },
    { id: 'climax',    t0: 105, t1: 120, chords: ['DM9'],                        dur: 15,   bright: 0.95, arp: 1, rate: 8.75, voices: 5, air: 1 },
  ],
  chords: C,
  glide: 1.6,       // s de glissando entre acordes
};

export function sectionAt(t) {
  const s = SCORE.sections;
  for (const x of s) if (t >= x.t0 && t < x.t1) return x;
  return t < 0 ? s[0] : s[s.length - 1];
}

export function chordAt(t) {
  const s = sectionAt(t);
  const k = Math.floor(Math.max(0, t - s.t0) / s.dur) % s.chords.length;
  return SCORE.chords[s.chords[k]];
}

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
