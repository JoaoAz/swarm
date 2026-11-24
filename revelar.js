// revelar.js: fundo oculto que só aparece por instantes onde o rato passa, por trás de uma máscara
// circular com feather alto. Pensado para ser copiado tal e qual para as outras páginas de projeto.
//
// Uso: um <canvas class="revelar"> dentro do ecrã inicial, com o vídeo e/ou a imagem nos atributos:
//   <canvas class="revelar" aria-hidden="true"
//           data-video="./media/fundo-oculto.mp4" data-imagem="./media/fundo-oculto.jpg"
//           data-raio="220" data-feather="0.85" data-intensidade="0.75" data-duracao="1.1"></canvas>
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
};
const ESCALA_MASCARA = 0.5; // a máscara é toda degradê: meia resolução chega

for (const canvas of document.querySelectorAll('canvas.revelar')) revelar(canvas);

function revelar(canvas) {
  const d = canvas.dataset;
  const cfg = {};
  for (const k in PADRAO) cfg[k] = d[k] != null && d[k] !== '' ? +d[k] : PADRAO[k];

  const ctx = canvas.getContext('2d');
  const mascara = document.createElement('canvas');
  const mctx = mascara.getContext('2d');
  // Some com o ecrã inicial (o main.js põe .hidden no #overlay ao começar).
  const ecra = canvas.closest('#overlay') || canvas.parentElement;

  // ---- fonte: vídeo em loop (com a imagem como poster) ou só a imagem
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
    if (ecra.classList.contains('hidden')) { ultimo = null; return; }
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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!carimbos.length || ecra.classList.contains('hidden')) {
      carimbos.length = 0;
      aCorrer = false;
      // o vídeo descansa quando não há nada à vista
      if (video && !video.paused) video.pause();
      return;
    }

    // 1. máscara
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect(0, 0, mascara.width, mascara.height);
    for (const c of carimbos) carimbo(c.x * ESCALA_MASCARA, c.y * ESCALA_MASCARA, cfg.forca * vida(agora - c.t));

    // 2. fundo (cobre o ecrã, como object-fit: cover) e 3. só fica onde a máscara deixa
    const f = fonte && pronto(fonte) ? fonte : null;
    if (f) {
      const [fw, fh] = tamanho(f);
      const s = Math.max(canvas.width / fw, canvas.height / fh);
      const w = fw * s, h = fh * s;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(f, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mascara, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    canvas.style.opacity = cfg.intensidade;
    requestAnimationFrame(desenhar);
  }

  if (new URLSearchParams(location.search).has('afinar')) painel(cfg, canvas);
}

// ---- painel de afinação (?afinar): mostra os valores para colar nos data-* do canvas
async function painel(cfg, canvas) {
  const { default: GUI } = await import('https://cdn.jsdelivr.net/npm/lil-gui@0.19.2/dist/lil-gui.esm.js');
  const gui = new GUI({ title: 'Fundo oculto' });
  gui.domElement.style.zIndex = 50;
  gui.add(cfg, 'raio', 40, 700, 1).name('raio (px)');
  gui.add(cfg, 'feather', 0, 1, 0.01);
  gui.add(cfg, 'intensidade', 0, 1, 0.01);
  gui.add(cfg, 'duracao', 0.2, 5, 0.05).name('duração (s)');
  gui.add(cfg, 'espera', 0, 2, 0.01).name('espera (s)');
  gui.add(cfg, 'forca', 0.05, 1, 0.01).name('força do rasto');
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
