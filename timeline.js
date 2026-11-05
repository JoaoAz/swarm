// timeline.js: todos os tempos e parâmetros "de realização" da sequência.
// Mexer aqui não exige tocar na lógica: o director lê este objeto.
// Tempos em segundos.

export const TIMELINE = {
  duration: 172,       // ~2:50
  loop: true,          // true: no fim faz fade e recomeça. false: fica parada no preto.
  seed: 1337,          // seed fixa: a sequência é sempre igual (a interação do participante à parte)

  phases: [
    { id: 'intro',     start: 0,   end: 6,   label: 'Vazio: só o piso; surge o teu cursor' },
    { id: 'play',      start: 6,   end: 34,  label: 'Controlas o cursor; o pinch desenha as primeiras linhas' },
    { id: 'release',   start: 34,  end: 48,  label: 'Os outros chegam; perdes o controlo' },
    { id: 'gather',    start: 48,  end: 56,  label: 'O swarm paira' },
    { id: 'build1',    start: 56,  end: 92,  label: 'Construção 1: túnel quadrado', blueprint: 'squareTunnel' },
    { id: 'complete1', start: 92,  end: 104, label: 'Estrutura completa, onda de luz' },
    { id: 'morph',     start: 104, end: 121, label: 'Desconstrução: os cursores apagam as linhas' },
    { id: 'build2',    start: 121, end: 153, label: 'Construção 2: arcos e chevrons', blueprint: 'chevronCorridor' },
    { id: 'climax',    start: 153, end: 172, label: 'Clímax, eco e fade' },
  ],

  // Abertura: o cursor do participante (o "líder").
  leader: {
    appearAt: 2.5,         // surge à frente da mão
    autoAfter: 4,          // sem input durante isto, entra o piloto automático
    autoPinches: [9, 13, 17, 21, 25, 28.5, 31.5], // pinches do piloto automático (os 4 primeiros desenham linhas)
    lossStart: 34,         // começa a ter atraso e a desobedecer
    lossEnd: 44,           // deixa de te seguir e voa para o swarm
    joinAt: 48,            // passa a ser um cursor como os outros
    scale: 0.32,           // escala do cursor junto à mão (0,2 m * 0,32 ≈ 6 cm)
    axisLen: [1.4, 9],     // as linhas do pinch: do centro (r=1,4 m) até perto do primeiro anel
  },

  // Aparecimento dos outros cursores, à volta do teu: o i-ésimo surge em
  // first + (last-first) * (i/N)^curve. curve > 1: os primeiros bem espaçados, depois acelera.
  spawn: { first: 18, last: 44, curve: 1.8, near: [1.5, 6] },

  // Eco no clímax: um cursor volta ao participante por um instante.
  echo: { at: 157.5, hold: 3 },

  // Nuvem em que o swarm paira antes de construir (à frente do utilizador).
  cloud: { center: [0, 5.5, -16], radius: [7, 3.2, 6], breathe: 0.12, breathePeriod: 7 },

  build: {
    tailMargin: 5,      // segundos reservados no fim da fase para os últimos anéis acabarem
    ringOverlap: 1.8,   // >1: cada anel começa antes de o anterior acabar (menos sequencial)
    pieceStagger: 0.12, // atraso entre peças consecutivas da mesma aresta (fila de "formigas")
    jitter: 0.7,        // caos na libertação das tarefas
    autoFinish: 2.5,    // depois do fim da fase + isto, segmentos por acabar completam-se sozinhos
  },

  complete: { waveAt: 93.5, waveDuration: 5.5, pulse: 0.25 },

  morph: {
    reuse: 0,           // fração dos segmentos da planta 1 arrastada para a planta 2 (0 = apagar tudo e desenhar de novo)
    order: 'random',    // 'random' (cada cursor apaga o que tem mais perto) | 'backToFront'
    moveWindow: 9,     // segundos em que os morphs são libertados
  },

  climax: { pulseFrom: 153, disperseAt: 156, disperseWindow: 4, fadeStart: 162, fadeEnd: 171.5 },

  // Paleta ao longo do tempo (interpolada entre chaves). line: halo das linhas, warm: variação
  // quente do halo, hot: núcleo, ambient: tom da névoa, do chão e do horizonte.
  palette: [
    { t: 0,   line: '#ff1a2a', warm: '#ff3b1a', hot: '#ff9aa6', ambient: '#ff1a2a' },
    { t: 68,  line: '#ff1a2a', warm: '#ff3b1a', hot: '#ff9aa6', ambient: '#ff1a2a' },
    { t: 93,  line: '#ff3a14', warm: '#ff6a10', hot: '#ffa888', ambient: '#ff3010' },
    { t: 100, line: '#ff6a10', warm: '#ffa020', hot: '#ffc080', ambient: '#ff5a10' },
    { t: 110, line: '#ff1450', warm: '#ff2a80', hot: '#ff9ccc', ambient: '#c0103a' },
    { t: 123, line: '#ff2a1a', warm: '#ff5a1a', hot: '#ffa48c', ambient: '#ff2010' },
    { t: 147, line: '#ff7a14', warm: '#ffb02a', hot: '#ffc870', ambient: '#ff6a12' },
    { t: 156, line: '#ff2a6a', warm: '#ff60a0', hot: '#ffc8e0', ambient: '#ff2060' },
    { t: 172, line: '#ff1a2a', warm: '#ff3b1a', hot: '#ff9aa6', ambient: '#ff1a2a' },
  ],

  // Câmara do modo cinemático (Desktop). pos e look interpolados com suavização.
  cinematic: [
    { t: 0,   pos: [0, 1.6, 0.6],  look: [0, 1.3, -3] },
    { t: 30,  pos: [0.4, 1.6, 0.8], look: [0, 1.6, -4] },
    { t: 48,  pos: [0, 1.6, 2],    look: [0, 5, -20] },
    { t: 70,  pos: [-1.5, 1.4, 0], look: [-20, 6, -30] },
    { t: 95,  pos: [1.2, 1.7, -2], look: [0, 9, -80] },
    { t: 112, pos: [-2, 1.5, -1],  look: [30, 10, -30] },
    { t: 140, pos: [0.8, 1.6, 1],  look: [0, 12, -60] },
    { t: 160, pos: [0, 1.5, 0],    look: [0, 18, -40] },
    { t: 172, pos: [0, 1.6, 0.6],  look: [0, 1.3, -3] },
  ],
};

export function phaseAt(t) {
  const ps = TIMELINE.phases;
  for (const p of ps) if (t >= p.start && t < p.end) return p;
  return ps[ps.length - 1];
}

// Tempo "antigo" (sequência de 120 s) para o áudio, cuja partitura (audio/score.js) foi escrita
// para essa sequência: cada fase nova é mapeada linearmente na fase correspondente antiga.
const LEGACY = [[0, 0], [34, 10], [56, 25], [92, 55], [104, 65], [121, 80], [153, 105], [172, 120]];
export function legacyTime(t) {
  for (let i = 0; i < LEGACY.length - 1; i++) {
    const [a0, b0] = LEGACY[i], [a1, b1] = LEGACY[i + 1];
    if (t < a1 || i === LEGACY.length - 2) return b0 + (Math.min(t, a1) - a0) * (b1 - b0) / (a1 - a0);
  }
  return t;
}
