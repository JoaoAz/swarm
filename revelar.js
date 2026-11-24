// revelar.js: fundo oculto que só aparece por instantes onde o rato passa, por trás de uma máscara
// circular com feather alto. Na borda da máscara a imagem chega pixelizada e vai-se resolvendo até
// ficar nítida no centro; ao desvanecer, volta a desfazer-se em pixéis.
// Pensado para ser copiado tal e qual para as outras páginas de projeto.
//
// Uso: um <canvas class="revelar"> dentro do ecrã inicial, com o vídeo e/ou a imagem nos atributos:
//   <canvas class="revelar" aria-hidden="true"
//           data-video="./media/fundo-oculto.mp4" data-imagem="./media/fundo-oculto.jpg"
//           data-raio="220" data-feather="0.85" data-intensidade="0.75" data-duracao="1.1"
//           data-pixel="48"></canvas>
//   <script type="module" src="./revelar.js"></script>
// Todos os data-* são opcionais (valores por omissão em PADRAO). Com ?afinar na URL abre um painel
// para afinar os valores à mão; copia-os depois para os data-* do canvas.

const PADRAO = {
  raio: 220,        // raio do círculo, em px CSS
  feather: 0.85,    // 0 = borda dura, 1 = todo o círculo é degradê
  intensidade: 0.75,// opacidade máxima do fundo revelado
  duracao: 1.1,     // segundos até um rasto desaparecer depois de o rato passar
  espera: 0.12,     // segundos em que o rasto fica inteiro antes de começar a desvanecer
  forca: 0.35,      // opacidade de cada carimbo: os carimbos sobrepõem-se e somam
  pixel: 48,        // tamanho do pixel maior, na borda (px CSS); 0 = sem pixelização
  nitidez: 0.85,    // a partir de que valor da máscara (0–1) a imagem fica nítida
  inverter: 0,      // 1 = negativo da imagem (em páginas de fundo claro, o preto passa a papel)
};
const ESCALA_MASCARA = 0.5; // a máscara é toda degradê: meia resolução chega

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Cada fragmento lê a máscara no centro de um bloco grande; quanto mais forte a máscara ali, mais
// fino o bloco (metade de cada vez), até 1 px. A cor e o alfa são lidos no centro do bloco, por isso
// a própria borda da máscara fica em degraus.
const FRAG = `
precision highp float;
uniform sampler2D uFonte, uMascara;
uniform vec2 uEcra, uFonteTam;
uniform float uPixel, uNitido, uIntens, uInverter;
float mascara(vec2 p) { return texture2D(uMascara, p / uEcra).a; }
vec3 fonte(vec2 p) {
  float s = max(uEcra.x / uFonteTam.x, uEcra.y / uFonteTam.y);
  vec2 tam = uFonteTam * s;
  vec2 uv = (p - (uEcra - tam) * 0.5) / tam;
  vec3 c = texture2D(uFonte, uv).rgb;
  return mix(c, 1.0 - c, uInverter);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag;
  if (uPixel > 1.0) {
    float m0 = mascara((floor(frag / uPixel) + 0.5) * uPixel);
    float n = ceil(log2(uPixel));                       // níveis até chegar a 1 px
    float k = floor(clamp(m0 / max(uNitido, 0.01), 0.0, 1.0) * n + 0.0001);
    float bloco = uPixel / exp2(k);
    if (bloco > 1.0) p = (floor(frag / bloco) + 0.5) * bloco;
  }
  float a = clamp(mascara(p), 0.0, 1.0) * uIntens;
  gl_FragColor = vec4(fonte(p) * a, a);
}`;

for (const canvas of document.querySelectorAll('canvas.revelar')) revelar(canvas);

function revelar(canvas) {
  const d = canvas.dataset;
  const cfg = {};
  for (const k in PADRAO) cfg[k] = d[k] != null && d[k] !== '' ? +d[k] : PADRAO[k];

  const mascara = document.createElement('canvas');
  const mctx = mascara.getContext('2d', { willReadFrequently: true }); // fica na CPU: sobe para o WebGL sem ler da GPU
  // Some com o ecrã inicial: o main.js de cada página esconde o #overlay ao começar
  // (classe .hidden ou .leaving, ou o atributo hidden).
  const ecra = canvas.closest('#overlay') || canvas.parentElement;
  const escondido = () => ecra.hidden || ecra.classList.contains('hidden') || ecra.classList.contains('leaving');

  // ---- fonte: vídeo em loop (com a imagem enquanto o vídeo não chega) ou só a imagem
  let fonte = null;
  let video = null;
  if (d.imagem) {
    const img = new Image();
    img.decoding = 'async';
    img.src = d.imagem;
    img.onload = () => { if (!fonte || !pronto(fonte)) fonte = img; };
  }
  if (d.video) {
    video = document.createElement('video');
    Object.assign(video, { src: d.video, muted: true, loop: true, playsInline: true, preload: 'auto' });
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.addEventListener('loadeddata', () => { fonte = video; });
  }
  const pronto = (f) => (f instanceof HTMLVideoElement ? f.readyState >= 2 : f.complete && f.naturalWidth > 0);
  const tamanho = (f) => (f instanceof HTMLVideoElement ? [f.videoWidth, f.videoHeight] : [f.naturalWidth, f.naturalHeight]);

  const pintor = criarGL(canvas) || criar2D(canvas);

  // ---- tamanho do canvas = ecrã
  let L = 0, A = 0, dpr = 1;
  function redimensionar() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    L = window.innerWidth; A = window.innerHeight;
    canvas.width = Math.round(L * dpr); canvas.height = Math.round(A * dpr);
    mascara.width = Math.max(1, Math.round(L * ESCALA_MASCARA));
    mascara.height = Math.max(1, Math.round(A * ESCALA_MASCARA));
  }
  redimensionar();
  window.addEventListener('resize', redimensionar);
  canvas.style.opacity = 1;

  // ---- carimbos: cada ponto por onde o rato passa, com a hora em que nasceu
  const carimbos = [];
  const MAX = 600;
  let ultimo = null;
  let aCorrer = false;

  function vida(idade) {
    if (idade < cfg.espera) return 1;
    const t = Math.min(1, (idade - cfg.espera) / Math.max(0.05, cfg.duracao - cfg.espera));
    return 1 - t * t * (3 - 2 * t); // smoothstep invertido
  }

  function aoMover(e) {
    if (escondido()) { ultimo = null; return; }
    const x = e.clientX, y = e.clientY, agora = performance.now() / 1000;
    if (ultimo) {
      // preencher o caminho entre dois eventos, para o rasto não sair às bolinhas
      const dx = x - ultimo.x, dy = y - ultimo.y;
      const passo = Math.max(4, cfg.raio * 0.18);
      const n = Math.min(40, Math.floor(Math.hypot(dx, dy) / passo));
      for (let i = 1; i <= n; i++) carimbos.push({ x: ultimo.x + (dx * i) / (n + 1), y: ultimo.y + (dy * i) / (n + 1), t: agora });
    }
    carimbos.push({ x, y, t: agora });
    if (carimbos.length > MAX) carimbos.splice(0, carimbos.length - MAX);
    ultimo = { x, y };
    if (video && video.paused) video.play().catch(() => {});
    if (!aCorrer) { aCorrer = true; requestAnimationFrame(desenhar); }
  }
  window.addEventListener('pointermove', aoMover, { passive: true });
  document.addEventListener('pointerleave', () => { ultimo = null; });
  window.addEventListener('blur', () => { ultimo = null; });

  // degradê radial com queda suave (perto de gaussiana) entre o miolo e a borda
  function carimbo(x, y, alfa) {
    const r = cfg.raio * ESCALA_MASCARA;
    const r0 = r * (1 - Math.min(1, Math.max(0, cfg.feather)));
    const g = mctx.createRadialGradient(x, y, r0, x, y, r);
    for (let i = 0; i <= 6; i++) {
      const s = i / 6, q = 1 - s;
      g.addColorStop(s, `rgba(255,255,255,${(alfa * q * q * (3 - 2 * q)).toFixed(4)})`);
    }
    mctx.fillStyle = g;
    mctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function desenhar() {
    const agora = performance.now() / 1000;
    while (carimbos.length && agora - carimbos[0].t > cfg.duracao) carimbos.shift();

    if (!carimbos.length || escondido()) {
      carimbos.length = 0;
      aCorrer = false;
      pintor.limpar();
      // o vídeo descansa quando não há nada à vista
      if (video && !video.paused) video.pause();
      return;
    }

    mctx.clearRect(0, 0, mascara.width, mascara.height);
    for (const c of carimbos) carimbo(c.x * ESCALA_MASCARA, c.y * ESCALA_MASCARA, cfg.forca * vida(agora - c.t));

    const f = fonte && pronto(fonte) ? fonte : null;
    if (f) pintor.pintar(f, tamanho(f), mascara, cfg, dpr);
    else pintor.limpar();
    requestAnimationFrame(desenhar);
  }

  if (new URLSearchParams(location.search).has('afinar')) painel(cfg, canvas);
}

// ---- WebGL: máscara + pixelização num só passo
function criarGL(canvas) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;
  const sh = (tipo, src) => { const s = gl.createShader(tipo); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('revelar.js:', gl.getProgramInfoLog(prog)); return null; }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (n) => gl.getUniformLocation(prog, n);
  const U = { fonte: u('uFonte'), mascara: u('uMascara'), ecra: u('uEcra'), fonteTam: u('uFonteTam'), pixel: u('uPixel'), nitido: u('uNitido'), intens: u('uIntens'), inverter: u('uInverter') };
  const textura = (unidade) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unidade);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const tFonte = textura(0), tMascara = textura(1);
  gl.uniform1i(U.fonte, 0);
  gl.uniform1i(U.mascara, 1);
  // as imagens vêm de cima para baixo; o gl_FragCoord conta de baixo para cima
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  return {
    limpar() { gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
    pintar(f, [fw, fh], mascara, cfg, dpr) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tFonte);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tMascara);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mascara);
      gl.uniform2f(U.ecra, canvas.width, canvas.height);
      gl.uniform2f(U.fonteTam, fw, fh);
      gl.uniform1f(U.pixel, Math.max(0, cfg.pixel) * dpr);
      gl.uniform1f(U.nitido, cfg.nitidez);
      gl.uniform1f(U.intens, cfg.intensidade);
      gl.uniform1f(U.inverter, cfg.inverter ? 1 : 0);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

// ---- sem WebGL: só a máscara suave, sem pixelização
function criar2D(canvas) {
  const ctx = canvas.getContext('2d');
  return {
    limpar() { ctx.clearRect(0, 0, canvas.width, canvas.height); },
    pintar(f, [fw, fh], mascara, cfg) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const s = Math.max(canvas.width / fw, canvas.height / fh), w = fw * s, h = fh * s;
      ctx.globalAlpha = cfg.intensidade;
      ctx.filter = cfg.inverter ? 'invert(1)' : 'none';
      ctx.drawImage(f, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mascara, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    },
  };
}

// ---- painel de afinação (?afinar): mostra os valores para colar nos data-* do canvas
async function painel(cfg, canvas) {
  const { default: GUI } = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/lil-gui@0.19.2/dist/lil-gui.esm.js');
  const gui = new GUI({ title: 'Fundo oculto' });
  gui.domElement.style.zIndex = 50;
  gui.add(cfg, 'raio', 40, 700, 1).name('raio (px)');
  gui.add(cfg, 'feather', 0, 1, 0.01);
  gui.add(cfg, 'intensidade', 0, 1, 0.01);
  gui.add(cfg, 'duracao', 0.2, 5, 0.05).name('duração (s)');
  gui.add(cfg, 'espera', 0, 2, 0.01).name('espera (s)');
  gui.add(cfg, 'forca', 0.05, 1, 0.01).name('força do rasto');
  gui.add(cfg, 'pixel', 0, 128, 1).name('pixel maior (px)');
  gui.add(cfg, 'nitidez', 0.05, 1, 0.01).name('nítido a partir de');
  gui.add(cfg, 'inverter', { normal: 0, negativo: 1 }).name('imagem');
  const st = {
    copiar() {
      const txt = Object.keys(PADRAO).map((k) => `data-${k}="${cfg[k]}"`).join(' ');
      navigator.clipboard?.writeText(txt).catch(() => {});
      console.log(txt);
      alert(txt);
    },
  };
  gui.add(st, 'copiar').name('copiar valores');
  canvas.dataset.afinar = '';
}
