// timeline.js: todos os tempos e parâmetros "de realização" da sequência.
// Mexer aqui não exige tocar na lógica: o director lê este objeto.
// Tempos em segundos.

export const TIMELINE = {
  duration: 120,
  loop: true,          // true: no fim faz fade e recomeça. false: fica parada no preto.
  seed: 1337,          // seed fixa: a sequência é sempre igual

  phases: [
    { id: 'dark',      start: 0,   end: 10,  label: 'Escuridão, primeiros cursores' },
    { id: 'gather',    start: 10,  end: 25,  label: 'O swarm cresce e paira' },
    { id: 'build1',    start: 25,  end: 55,  label: 'Construção 1: túnel quadrado', blueprint: 'squareTunnel' },
    { id: 'complete1', start: 55,  end: 65,  label: 'Estrutura completa, onda de luz' },
    { id: 'morph',     start: 65,  end: 80,  label: 'Desconstrução: os cursores apagam as linhas' },
    { id: 'build2',    start: 80,  end: 105, label: 'Construção 2: arcos e chevrons', blueprint: 'chevronCorridor' },
    { id: 'climax',    start: 105, end: 120, label: 'Clímax e fade' },
  ],

  // Aparecimento dos cursores: o i-ésimo surge em first + (last-first) * (i/N)^curve.
  // curve > 1 deixa os primeiros bem espaçados ("um a um") e acelera depois.
  spawn: { first: 1.5, last: 21, curve: 1.8 },

  // Nuvem em que o swarm paira antes de construir (à frente do utilizador).
  cloud: { center: [0, 5.5, -16], radius: [7, 3.2, 6], breathe: 0.12, breathePeriod: 7 },

  build: {
    tailMargin: 5,      // segundos reservados no fim da fase para os últimos anéis acabarem
    ringOverlap: 1.8,   // >1: cada anel começa antes de o anterior acabar (menos sequencial)
    pieceStagger: 0.12, // atraso entre peças consecutivas da mesma aresta (fila de "formigas")
    jitter: 0.7,        // caos na libertação das tarefas
    autoFinish: 2.5,    // depois do fim da fase + isto, segmentos por acabar completam-se sozinhos
  },

  complete: { waveAt: 56.5, waveDuration: 5.5, pulse: 0.25 },

  morph: {
    reuse: 0,           // fração dos segmentos da planta 1 arrastada para a planta 2 (0 = apagar tudo e desenhar de novo)
    order: 'random',    // 'random' (cada cursor apaga o que tem mais perto) | 'backToFront'
    moveWindow: 9,     // segundos em que os morphs são libertados
  },

  climax: { pulseFrom: 105, disperseAt: 108, disperseWindow: 4, fadeStart: 113, fadeEnd: 119.5 },

  // Paleta ao longo do tempo (interpolada entre chaves). line: halo das linhas, warm: variação
  // quente do halo, hot: núcleo, ambient: tom da névoa, do chão e do horizonte.
  palette: [
    { t: 0,   line: '#ff1a2a', warm: '#ff3b1a', hot: '#ff9aa6', ambient: '#ff1a2a' },
    { t: 40,  line: '#ff1a2a', warm: '#ff3b1a', hot: '#ff9aa6', ambient: '#ff1a2a' },
    { t: 56,  line: '#ff3a14', warm: '#ff6a10', hot: '#ffa888', ambient: '#ff3010' },
    { t: 63,  line: '#ff6a10', warm: '#ffa020', hot: '#ffc080', ambient: '#ff5a10' },
    { t: 72,  line: '#ff1450', warm: '#ff2a80', hot: '#ff9ccc', ambient: '#c0103a' },
    { t: 82,  line: '#ff2a1a', warm: '#ff5a1a', hot: '#ffa48c', ambient: '#ff2010' },
    { t: 100, line: '#ff7a14', warm: '#ffb02a', hot: '#ffc870', ambient: '#ff6a12' },
    { t: 108, line: '#ff2a6a', warm: '#ff60a0', hot: '#ffc8e0', ambient: '#ff2060' },
    { t: 120, line: '#ff1a2a', warm: '#ff3b1a', hot: '#ff9aa6', ambient: '#ff1a2a' },
  ],

  // Câmara do modo cinemático (Desktop). pos e look interpolados com suavização.
  cinematic: [
    { t: 0,   pos: [0, 1.6, 2],    look: [0, 4, -40] },
    { t: 20,  pos: [-1.5, 1.4, 0], look: [0, 6, -30] },
    { t: 40,  pos: [1.2, 1.7, -4], look: [0, 7, -60] },
    { t: 60,  pos: [0, 1.6, -8],   look: [0, 9, -120] },
    { t: 78,  pos: [-2, 1.5, -6],  look: [3, 10, -50] },
    { t: 95,  pos: [0.8, 1.6, -2], look: [0, 12, -80] },
    { t: 110, pos: [0, 1.5, 0],    look: [0, 18, -60] },
    { t: 120, pos: [0, 1.6, 2],    look: [0, 20, -60] },
  ],
};

export function phaseAt(t) {
  const ps = TIMELINE.phases;
  for (const p of ps) if (t >= p.start && t < p.end) return p;
  return ps[ps.length - 1];
}
