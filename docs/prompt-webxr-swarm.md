# Prompt: Swarm de cursores (WebXR + three.js)

> Rascunho v2. Decisões: utilizador só observa, fica dentro do corredor à escala humana com estruturas monumentais, sequência fixa de ~2 min, com áudio. Os valores entre [colchetes] ainda estão em aberto.

---

## PROMPT

Cria uma experiência WebXR em **three.js** (ES modules, sem bundler obrigatório, a correr num único `index.html` + `main.js`) em que um **swarm de ponteiros de rato** constrói, desfaz e reconstrói continuamente uma **estrutura digital de néon**. Tem de funcionar em **Desktop** (rato/teclado) e em **VR** (Meta Quest via browser, botão "Enter VR" do `VRButton`), com o mesmo código.

### 1. Ambiente (estética)
- Fundo preto absoluto, névoa exponencial muito escura (`FogExp2`, preto-avermelhado) para dar profundidade.
- Paleta monocromática: vermelho néon `#ff1a2a` como cor principal, variações para laranja-avermelhado `#ff3b1a` e para branco-rosado nos pontos mais quentes (núcleo das linhas).
- Chão escuro e brilhante, com **reflexos** das linhas de néon (usar `Reflector` ou um plano com material muito liso + bloom; em VR preferir um falso reflexo: geometria espelhada em Y com opacidade baixa e fade).
- Padrão subtil tipo **circuito impresso / grelha técnica** no chão, quase invisível, que se ilumina quando os cursores passam por perto.
- Linhas de perspetiva radiais ao longe nas paredes laterais, a convergir para o ponto de fuga do corredor.
- Pós-processamento: **UnrealBloomPass** forte nas linhas (no Desktop). Em VR, simular o glow com geometria (linha fina brilhante + quad aditivo mais largo e transparente à volta), porque o pós-processamento em WebXR é caro.

### 2. A estrutura
A estrutura é um **corredor/túnel** formado por uma sequência de "molduras" de néon dispostas ao longo do eixo Z, que o utilizador vê em perspetiva:
- **Molduras quadradas concêntricas** (portais quadrados que se repetem para o fundo).
- **Arcos triangulares / chevrons** (Λ) que se repetem em profundidade, com as bases pousadas no chão.
- Painéis laterais com recortes retangulares e cantos arredondados, desenhados só a traço.

**Escala e monumentalidade**: o utilizador está dentro do corredor, à altura dos olhos (~1,6 m), mas as estruturas são muito maiores do que ele. As molduras mais próximas têm [12–20 m] de altura e o corredor estende-se por [150–250 m] até se perder na névoa. Há poucos elementos à escala humana (por exemplo, as linhas do chão e pequenos marcadores na base das molduras) para que se perceba o tamanho do resto. O utilizador sente-se pequeno, como numa catedral. Os cursores são pequenos (~15–25 cm) em comparação com as estruturas, por isso vê-se bem que são precisos muitos para construir algo tão grande.

Tudo é feito de **segmentos de linha** (tubos finos ou `Line2`/`LineSegments2` com largura em pixels). Cada segmento tem um estado de construção de 0 a 1 (desenhado progressivamente de um extremo ao outro).

A estrutura é gerada proceduralmente a partir de um conjunto de **"plantas"** (blueprints): túnel quadrado, túnel triangular, corredor de chevrons, e mistura. Cada planta é uma lista de segmentos com posição inicial/final.

### 3. O swarm de cursores
- **[N = 300 no Desktop / 120 no Quest]** cursores, cada um com a forma clássica da seta de ponteiro (seta branca com contorno preto), renderizados com `InstancedMesh` (uma geometria plana extrudida muito fina) ou sprites instanciados, sempre virados para a câmara (billboard em torno do eixo de visão).
- Cor: seta branca que ganha tinta vermelha e emissividade quando está a "desenhar".
- Movimento **fluído e orgânico**: steering behaviours (seek + arrive + separation + alignment + cohesion leves) combinados com **curl noise 3D** para deriva natural. Sem teleportes, sem movimentos lineares. Velocidade e aceleração máximas limitadas; rotação da seta suavemente alinhada com a direção de movimento (slerp), com pequena inclinação nas curvas.
- Pequenos detalhes de "vida": atraso aleatório na reação, micro-tremor ocasional, alguns cursores "distraídos" que se afastam e voltam, e um rasto curto e ténue (trail) atrás de cada um.
- Opcional: alguns cursores mudam de forma momentaneamente (mão de apontar, ampulheta, cruz de seleção) conforme o estado: a ampulheta quando estão à espera, a mão quando estão a "pegar" num segmento.

### 4. Sequência de ~2 minutos (timeline)
Para já, a experiência é uma **sequência fixa de cerca de 2 minutos**, controlada por um "director" com timeline e determinística (seed fixa), para se poder afinar o look and feel e repetir sempre igual. No fim, faz um fade para preto e recomeça (ou fica parada, conforme uma flag).

| Tempo | Momento |
|---|---|
| 0:00–0:10 | Escuridão. Ouve-se o drone. Aparecem os primeiros cursores, um a um, ao longe. |
| 0:10–0:25 | O swarm cresce e paira em nuvem à frente do utilizador. Ainda não há estrutura. |
| 0:25–0:55 | **Construção 1, túnel de molduras quadradas**, do primeiro anel (perto) para o fundo. |
| 0:55–1:05 | Estrutura completa: pausa e uma onda de luz percorre o túnel. |
| 1:05–1:20 | **Desconstrução e morph**: os segmentos são arrastados e reaproveitados. |
| 1:20–1:45 | **Construção 2, corredor de arcos triangulares e chevrons**, mais alto e mais monumental do que o primeiro. |
| 1:45–2:00 | Clímax: todo o corredor pulsa, o áudio sobe, os cursores dispersam-se para cima e a cena faz fade para preto. |

Expõe os tempos num objeto de configuração (`timeline.js`) para se poder afinar sem mexer na lógica. No Desktop, adiciona controlos de debug: play/pause, scrub da timeline e velocidade (0,25x a 4x).

Cada construção segue estes estados:
1. **Dispersão**: os cursores pairam em nuvem, a respirar com o noise.
2. **Atribuição**: cada segmento da planta seguinte é atribuído a um ou mais cursores (os mais próximos, com algum caos).
3. **Construção**: o cursor voa até ao ponto inicial do segmento, "clica" (pequeno pulso de luz + escala), e arrasta ao longo do segmento enquanto a linha de néon cresce atrás dele. Segmentos maiores são desenhados por vários cursores em fila, tipo formigas.
4. **Estrutura completa**: pausa de [6–10 s]; a estrutura pulsa suavemente, uma onda de luz percorre o túnel do primeiro ao último anel.
5. **Desconstrução**: os cursores voltam, "agarram" segmentos e desmontam-nos (a linha encolhe, ou parte-se em fragmentos que os cursores levam), por uma ordem diferente da construção (ex.: do fundo para a frente, ou aleatório).
6. **Transição** para a planta seguinte, com morph quando possível: segmentos reaproveitados deslizam para a nova posição em vez de serem destruídos.

A ordem de construção deve ser legível e bonita: por anéis, do mais próximo para o mais distante, com sobreposição entre anéis para não parecer sequencial demais.

### 5. Câmara e interação
Nesta versão, o utilizador **só observa**: não interage com o swarm.
- **VR**: o utilizador está de pé, em posição fixa, no eixo do corredor, e pode olhar à volta livremente. Não há locomoção nem raios nos comandos. A sequência começa ao entrar em VR.
- **Desktop**: câmara à altura dos olhos, no mesmo ponto, e o rato só serve para olhar à volta (arrastar ou pointer lock). Também há um modo "cinemático" opcional, com movimentos de câmara lentos e pré-definidos, para gravar vídeo. O cursor do sistema fica escondido para não competir com o swarm.
- Deixa a arquitetura preparada para mais tarde se acrescentar interação (por exemplo, um cursor "líder" controlado pelo utilizador), mas não a implementes já.

### 6. Performance e técnica
- Alvo: **72 fps estáveis no Quest 2/3**, 60+ fps em Desktop médio.
- Um único `InstancedMesh` para todos os cursores; simulação do swarm em CPU com arrays tipados (ou GPGPU com `GPUComputationRenderer` se N > 1000, só no Desktop).
- Linhas agrupadas num número pequeno de draw calls; atualizar o estado de construção via atributo/uniform, não recriando geometria.
- Deteção de modo (`renderer.xr.isPresenting`) para trocar entre caminho com bloom (Desktop) e caminho leve (VR). `renderer.setAnimationLoop` para ambos.
- `foveation` ativado em VR, pixel ratio limitado no Desktop.
- Painel de debug (lil-gui) só no Desktop: N cursores, velocidade, intensidade do bloom, planta atual, botão "reconstruir".

### 7. Áudio
O áudio é gerado por **Web Audio** (síntese procedural, sem ficheiros) e ligado ao `AudioListener` da câmara:
- **Drone** grave contínuo que evolui com a timeline: filtro a abrir nas construções e a subir no clímax. Usar um reverb longo (convolver com impulso gerado) dá a sensação de espaço monumental.
- **Cliques** curtos e secos, espacializados (`PositionalAudio` ou `PannerNode` HRTF), quando os cursores "clicam" num segmento. Para não saturar, limita o número de vozes em simultâneo ([~16]) e varia um pouco o pitch.
- **Zumbido elétrico** baixo, espacializado, em cada segmento de néon que acende, com um "hum" coletivo da estrutura completa.
- **Onda de luz** acompanhada de um sweep tonal que viaja pelo espaço (de perto para longe).
- O áudio começa com o gesto de "Enter VR" ou com um clique em "Start" no Desktop (por causa da política de autoplay). Inclui um controlo de volume geral no painel de debug.

### 8. Entregáveis
- Código completo, organizado em módulos: `scene/environment`, `structure/blueprints`, `swarm/agents`, `swarm/steering`, `director` (timeline + state machine), `audio`, `xr/session`.
- Instruções para correr localmente (HTTPS necessário para WebXR no Quest: ex. `vite --host` com certificado ou ngrok).
- Comentários curtos a explicar os parâmetros que afinam a "organicidade" do movimento.

---

## Dúvidas e sugestões em aberto

1. **Escala.** Propus molduras de 12 a 20 m e um corredor de 150 a 250 m. Queres mais ou menos monumental?
2. **Número de cursores.** No Quest, 100–150 com rastos é seguro; no Desktop podemos ir a milhares com GPGPU. Preferes um número igual nos dois, ou maximizar cada plataforma?
3. **Cursores: só a seta clássica, ou vários tipos** (mão, ampulheta, cruz)? Os vários tipos dão leitura de "estado" e humor.
4. **Bloom em VR.** Recomendo glow falso com geometria em VR e bloom real só no Desktop. Aceitas que o VR fique ligeiramente menos "brilhante"?
5. **Cor:** só vermelho, ou mudar de tom por planta (ex.: vermelho → laranja)?
6. **Destino:** é para portfolio/web, instalação, ou protótipo? Muda o peso dado a performance, UI e instruções.
7. Nota: as imagens de referência têm marca d'água iStock, por isso servem apenas como moodboard; o prompt descreve o estilo em vez de pedir para as copiar.
