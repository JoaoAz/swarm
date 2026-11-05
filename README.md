# Swarm (WebXR + three.js)

Um swarm de cursores de rato constrói, desfaz e reconstrói um corredor monumental de néon vermelho.
Sequência fixa de ~2 min, determinística (seed fixa), com áudio procedural. Funciona em Desktop
(com bloom) e em VR no Meta Quest (glow feito com geometria), com o mesmo código.

Sem bundler: `index.html` carrega `main.js` como ES module e o three.js 0.169 e o lil-gui vêm do
CDN (jsdelivr) através de um import map.

## Correr localmente (Desktop)

Qualquer servidor estático serve (os módulos ES não abrem com `file://`):

```bash
cd app
npx serve .            # ou: python3 -m http.server 8000
```

Abrir `http://localhost:3000` (ou `:8000`) e carregar em **START** (o áudio só arranca com um gesto).

## Correr no Quest (precisa de HTTPS)

O WebXR só funciona em contexto seguro. Duas opções:

**Vite com certificado autoassinado** (já há um `vite.config.js`), na mesma rede Wi-Fi que o Quest:

```bash
cd app
npm i -D vite @vitejs/plugin-basic-ssl
npx vite
```

Abrir `https://<ip-do-computador>:5173` no browser do Quest, aceitar o aviso do certificado e
carregar em **ENTER VR**. A sequência começa ao entrar em VR.

**ngrok** (mais simples, sem certificado):

```bash
cd app && python3 -m http.server 8000
ngrok http 8000
```

Abrir o URL `https://….ngrok-free.app` no Quest.

## Controlos (Desktop)

- Arrastar: olhar à volta. Duplo clique: pointer lock.
- Espaço: play/pausa. Setas ←/→: recuar/avançar 5 s.
- C: câmara cinemática (para gravar vídeo). H: esconder o painel.
- Painel de debug (lil-gui): play/pause, scrub da timeline, velocidade 0,25x–4x, N de cursores,
  bloom, volume, planta atual, loop, botão "reconstruir".

Parâmetros de URL úteis: `?autostart` (começa sem clicar, sem som até haver um clique),
`?n=500` (forçar N), `?t=60` (começar aos 60 s), `?cinematic`, `?bloom=0.6`, `?noloop`, `?nogui`.

## Estrutura

```
index.html            página, import map, overlay START
main.js               renderer, câmara, caminho Desktop (bloom) vs VR (sem pós), ciclo
timeline.js           TODOS os tempos da sequência e da câmara cinemática (afinar aqui)
director.js           timeline + máquina de estados, tarefas, morph, onda de luz, fade
scene/environment.js  névoa, chão com circuito que aquece com os cursores, paredes, fade
structure/blueprints.js  plantas: túnel quadrado, corredor de arcos/chevrons, mistura
structure/neonLines.js   todas as linhas num buffer; estado de construção por atributo
swarm/steering.js     steering + curl noise; parâmetros de "organicidade" comentados
swarm/agents.js       simulação dos cursores (arrays tipados) e render (InstancedMesh)
swarm/cursorAtlas.js  seta, mão, ampulheta e cruz desenhadas em canvas
audio.js              drone, reverb, cliques HRTF, zumbidos, sweep, clímax (Web Audio)
xr/session.js         VRButton, foveation, local-floor, deteção do Quest
debug.js              painel lil-gui (só Desktop)
```

## Como funciona (resumo)

- **Linhas**: cada segmento é um quad expandido no vertex shader, virado para a câmara, com núcleo
  branco-rosado e halo vermelho no fragment shader. O estado de construção (`lo`, `hi`) é um atributo;
  só se envia para a GPU o intervalo que mudou. O reflexo no chão é a mesma geometria com `y → -y`.
- **Cursores**: um `InstancedMesh` com atributos por instância (posição, direção, escala, tinta,
  forma, inclinação). Billboard em torno do eixo de visão, seta alinhada com o movimento, rasto curto.
- **Tarefas**: o director gera tarefas de desenhar, apagar e arrastar e liberta-as no tempo certo
  (por anéis, do perto para o longe, com sobreposição; na transição apagam tudo e desenham de novo). Cada cursor livre escolhe uma das tarefas
  abertas mais próximas, com algum ruído. Arestas longas são partidas em peças de ~4 m, e as peças
  saem em fila, por isso vários cursores desenham a mesma aresta como formigas.
- **Garantia de timing**: se no fim de uma fase ainda faltarem segmentos, completam-se sozinhos com
  uma animação curta (nada salta). Com 120 cursores (Quest) isto acontece a ~20 % da construção 2.
- **Scrub**: recuar recomeça do zero e simula até ao instante pedido (passo fixo de 1/60 s,
  ~1 s de espera por cada 25 s de sequência).
