/* ==========================================================================
   CODE COM - front-end
   Sem framework nenhum: JavaScript puro, pra dar pra ler tudo que acontece.
   ========================================================================== */

// Atalho: $("#id") em vez de document.querySelector("#id")
const $ = (s) => document.querySelector(s);

/* --------------------------------------------------------------------------
   ESTADO
   Tudo que o app "sabe" no momento fica num objeto so. Quando algo muda,
   mexemos aqui e redesenhamos a tela a partir dele.
   -------------------------------------------------------------------------- */
const estado = {
  token: localStorage.getItem("token") || null,
  eu: null,
  ws: null,

  servidores: [],
  dms: [],
  usuarios: [],

  precisaConvite: false,   // o servidor exige senha pra criar conta?

  servidorAtual: null,     // null = tela de DMs
  canais: [],
  membros: [],
  canalAtual: null,

  online: new Set(),
  digitando: new Map(),    // userId -> timer
  vozPorCanal: {},         // channelId -> [userIds]

  // voz
  vozCanal: null,
  microfoneBruto: null,    // o que sai do microfone, sem tratamento
  meuAudio: null,          // o audio ja tratado, que vai pros amigos
  peers: {},               // userId -> RTCPeerConnection
  mutado: false,
  soOuvir: false,
  ativandoMicrofone: false,
  mudos: {},
  audioTelaSemFiltroEco: false,
  portaoLigado: true,      // supressao de ruido ligada por padrao
  minhaTela: null,         // MediaStream da tela, quando estou compartilhando
  qualidadeTela: "1080-30",
  telaDe: {},              // userId -> id do stream da tela que ele transmite
  volumeUsuario: null,

  // amigos e perfil
  amigos: { amigos: [], recebidos: [], enviados: [] },
  corEscolhida: null,

  perfilAberto: null,       // id de quem esta com o cartao de perfil aberto
  arquivoEscolhido: null,
  mensagensPorId: new Map(),
  mensagensPendentes: new Map(),
  respostaAtual: null,
  filtroMensagens: null,
  microfoneId: localStorage.getItem("codecom-microfone") || "",
  saidaAudioId: localStorage.getItem("codecom-saida") || "",
  pushToTalk: localStorage.getItem("codecom-ptt") === "true",
  sonsCall: localStorage.getItem("codecom-sons") !== "false",
  microfonePressionado: false,
  tema: localStorage.getItem("codecom-tema") || "aurora",
  statsCallTimer: null,
  bitrateTelaPeer: {},
  temMensagensAntigas: false,
  carregandoMensagensAntigas: false,
  idMensagemMaisAntiga: null,
  retrySocketTimer: null,
  intervaloReconexao: 1000,
  precisouReconectar: false,
};

// Servidores STUN publicos do Google: ajudam dois navegadores a descobrirem
// o proprio IP publico pra conseguirem se achar na internet.
const CONFIG_RTC = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};

// Tetos por espectador. Nao dividimos a qualidade escolhida pelo numero de pessoas.
const PERFIS_TELA = {
  "720-30": { largura: 1280, altura: 720, fps: 30, bitrate: 4000000 },
  "720-60": { largura: 1280, altura: 720, fps: 60, bitrate: 6000000 },
  "1080-30": { largura: 1920, altura: 1080, fps: 30, bitrate: 8000000 },
  "1080-60": { largura: 1920, altura: 1080, fps: 60, bitrate: 12000000 },
};
let contextoSaida = null;
const volumesLocais = new Map();
let instalacaoPendente = null;


/* ==========================================================================
   UTILIDADES
   ========================================================================== */

function aviso(texto, cor = "#23a55a", duracao = 2600) {
  const el = $("#aviso");
  el.textContent = texto;
  el.style.background = cor;
  el.classList.remove("escondido");
  clearTimeout(aviso._t);
  aviso._t = setTimeout(() => el.classList.add("escondido"), duracao);
}

function codecomInstalado() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

function atualizarBotoesInstalacao() {
  const instalado = codecomInstalado();
  ["#btn-instalar-login", "#btn-instalar-config"].forEach((seletor) => {
    const botao = $(seletor);
    if (botao) botao.classList.toggle("escondido", instalado);
  });
}

async function instalarCodecom() {
  if (codecomInstalado()) {
    aviso("O Code com já está instalado neste aparelho.");
    return;
  }
  if (!window.isSecureContext) {
    aviso("Para instalar, abra pelo launcher do Desktop em localhost ou use um endereço HTTPS.", "#f0b232", 7000);
    return;
  }
  if (instalacaoPendente) {
    const evento = instalacaoPendente;
    instalacaoPendente = null;
    await evento.prompt();
    const escolha = await evento.userChoice;
    if (escolha?.outcome === "accepted") aviso("Instalação do Code com iniciada!");
    atualizarBotoesInstalacao();
    return;
  }

  let instrucao = "No menu do Edge ou Chrome, escolha Aplicativos > Instalar Code com.";
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    instrucao = "No Safari, toque em Compartilhar e escolha Adicionar à Tela de Início.";
  } else if (/android/i.test(navigator.userAgent)) {
    instrucao = "No menu do navegador, escolha Instalar app ou Adicionar à tela inicial.";
  } else if (/(opera|opr\/)/i.test(navigator.userAgent)) {
    instrucao = "Você pode usar o Code com no Opera. Para criar um atalho na Área de Trabalho que abra por ele, execute Instalar Code com.bat na pasta Codecom - Instalável.";
  }
  aviso(instrucao, "#f0b232", 7000);
}

function prepararInstalacao() {
  atualizarBotoesInstalacao();
  window.addEventListener("beforeinstallprompt", (evento) => {
    evento.preventDefault();
    instalacaoPendente = evento;
  });
  window.addEventListener("appinstalled", () => {
    instalacaoPendente = null;
    atualizarBotoesInstalacao();
    aviso("Code com instalado com sucesso!");
  });
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" })
    .catch((erro) => console.warn("Não foi possível preparar o modo instalável", erro));
}

/** Chamada a API, ja com o token de login no cabecalho. */
async function api(rota, opcoes = {}) {
  const cabecalhos = { ...(opcoes.headers || {}) };
  if (estado.token) cabecalhos["Authorization"] = "Bearer " + estado.token;
  if (opcoes.body && !(opcoes.body instanceof FormData)) {
    cabecalhos["Content-Type"] = "application/json";
    opcoes.body = JSON.stringify(opcoes.body);
  }
  const r = await fetch(rota, { ...opcoes, headers: cabecalhos });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.error || "Erro no servidor");
  return dados;
}

function iniciais(nome) {
  return (nome || "?").slice(0, 2);
}

function horaCurta(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function diaLegivel(iso) {
  const d = new Date(iso);
  const hoje = new Date();
  const ontem = new Date(); ontem.setDate(hoje.getDate() - 1);
  const mesmoDia = (a, b) => a.toDateString() === b.toDateString();
  if (mesmoDia(d, hoje)) return "Hoje";
  if (mesmoDia(d, ontem)) return "Ontem";
  return d.toLocaleDateString("pt-BR");
}

/** Monta um elemento com classe e texto. Usar textContent (e nao innerHTML)
 *  impede que alguem mande "<script>" numa mensagem e ele execute. */
function el(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

function avatarDe(usuario, tamanho) {
  const a = el("div", "avatar", iniciais(usuario.display_name || usuario.username));
  pintarAvatar(a, usuario);
  if (tamanho) {
    a.style.width = a.style.height = tamanho + "px";
    a.style.fontSize = Math.round(tamanho * 0.4) + "px";
  }
  return a;
}

/** Com foto, mostra a foto; sem foto, a cor + as iniciais. */
function pintarAvatar(elemento, usuario) {
  elemento.textContent = iniciais(usuario.display_name || usuario.username);
  if (usuario.avatar_url) {
    elemento.classList.add("com-foto");
    elemento.style.backgroundImage = `url("${usuario.avatar_url}")`;
    elemento.style.backgroundColor = usuario.avatar_color;
  } else {
    elemento.classList.remove("com-foto");
    elemento.style.backgroundImage = "";
    elemento.style.background = usuario.avatar_color;
  }
}


/* ==========================================================================
   LOGIN
   ========================================================================== */

async function entrar(criarConta) {
  const username = $("#in-user").value.trim();
  const password = $("#in-pass").value;
  const campoConvite = $("#in-convite");
  $("#erro-login").textContent = "";

  if (!username || !password) {
    $("#erro-login").textContent = "Preencha usuario e senha";
    return;
  }

  // Se o dono do servidor exigiu convite, revelamos o campo no primeiro
  // clique em "Criar conta" em vez de recusar sem explicar o motivo.
  if (criarConta && estado.precisaConvite && campoConvite.classList.contains("escondido")) {
    campoConvite.classList.remove("escondido");
    campoConvite.focus();
    $("#erro-login").textContent = "Esse servidor pede uma senha de convite";
    return;
  }

  try {
    const rota = criarConta ? "/api/register" : "/api/login";
    const corpo = { username, password };
    if (criarConta) corpo.invite = campoConvite.value;
    const r = await api(rota, { method: "POST", body: corpo });
    estado.token = r.token;
    estado.eu = r.user;
    localStorage.setItem("token", r.token);
    await iniciarApp();
  } catch (e) {
    $("#erro-login").textContent = e.message;
  }
}

async function sairDaConta() {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  localStorage.removeItem("token");
  location.reload();
}


/* ==========================================================================
   INICIO DO APP
   ========================================================================== */

async function iniciarApp() {
  const dados = await api("/api/bootstrap");
  estado.eu = dados.user;
  estado.servidores = dados.servers;
  estado.dms = dados.dms;
  estado.usuarios = dados.users;
  estado.online = new Set(dados.online);

  $("#tela-login").classList.add("escondido");
  $("#app").classList.remove("escondido");

  aplicarMeuPerfil(dados.user);

  desenharServidores();
  conectarWebSocket();
  await recarregarAmigos();   // ja desenha a tela inicial com os amigos
}


/* ==========================================================================
   WEBSOCKET - o tempo real
   ========================================================================== */

function conectarWebSocket() {
  // ws:// se o site e http, wss:// se e https
  const protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocolo}//${location.host}/ws?token=${estado.token}`);
  estado.ws = ws;

  ws.onopen = () => {
    clearTimeout(estado.retrySocketTimer);
    estado.intervaloReconexao = 1000;
    $("#estado-conexao").className = "estado-conexao conectado";
    $("#estado-conexao").lastChild.textContent = " Conectado";
    esvaziarFila();
    if (estado.precisouReconectar) {
      estado.precisouReconectar = false;
      if (estado.canalAtual) recarregarCanalAtual();
      if (estado.vozCanal) mandarWS({ type: "voice_join", channel_id: estado.vozCanal });
    }
  };
  ws.onmessage = (ev) => tratarEvento(JSON.parse(ev.data));

  ws.onclose = (ev) => {
    if (estado.ws !== ws) return;
    if (ev.code === 4001) { sairDaConta(); return; }  // token invalido
    estado.ws = null;
    estado.precisouReconectar = true;
    if (estado.vozCanal) Object.keys(estado.peers).forEach((id) => fecharLigacao(Number(id)));
    $("#estado-conexao").className = "estado-conexao reconectando";
    $("#estado-conexao").lastChild.textContent = " Reconectando…";
    aviso("Conexao perdida, reconectando...", "#f0b232");
    const atraso = Math.min(30000, estado.intervaloReconexao) + Math.random() * 400;
    estado.intervaloReconexao = Math.min(30000, estado.intervaloReconexao * 1.8);
    estado.retrySocketTimer = setTimeout(conectarWebSocket, atraso);
  };
}

// Coisas que tentamos mandar antes da conexao estar pronta ficam guardadas
// aqui e saem assim que ela abrir. Sem isso, uma mensagem escrita logo apos
// abrir o app (ou durante uma reconexao) sumia sem nenhum aviso.
const fila = [];

function mandarWS(obj) {
  if (estado.ws && estado.ws.readyState === WebSocket.OPEN) {
    estado.ws.send(JSON.stringify(obj));
    return;
  }
  // "digitando" e sinalizacao de voz nao valem nada atrasados: descartamos
  if (obj.type === "typing" || obj.type === "signal") return;
  fila.push(obj);
}

function esvaziarFila() {
  while (fila.length && estado.ws.readyState === WebSocket.OPEN) {
    estado.ws.send(JSON.stringify(fila.shift()));
  }
}

function tratarEvento(ev) {
  switch (ev.type) {
    case "ready":
      estado.online = new Set(ev.online);
      desenharMembros();
      break;

    case "message":
      if (ev.client_id && estado.mensagensPendentes.has(ev.client_id)) {
        const pendente = estado.mensagensPendentes.get(ev.client_id);
        estado.mensagensPendentes.delete(ev.client_id);
        if (lerRascunho(pendente.channelId) === pendente.content) salvarRascunho(pendente.channelId, "");
      }
      if (ev.message.channel_id === estado.canalAtual) {
        if (!estado.filtroMensagens) adicionarMensagem(ev.message);
        pararDigitando(ev.message.user_id);
      } else if (ev.message.user_id !== estado.eu.id) {
        aviso(`${ev.message.display_name}: ${ev.message.content.slice(0, 40)}`, "#5865f2");
      }
      break;

    case "message_updated":
      if (ev.message.channel_id === estado.canalAtual) atualizarMensagemNaTela(ev.message);
      break;

    case "message_reactions": {
      const msg = estado.mensagensPorId.get(Number(ev.message_id));
      if (ev.channel_id && ev.channel_id !== estado.canalAtual) break;
      if (msg) {
        msg.reactions = ev.reactions || [];
        atualizarMensagemNaTela(msg);
      }
      break;
    }

    case "message_deleted":
      if (ev.channel_id === estado.canalAtual) {
        const m = document.querySelector(`[data-msg="${ev.message_id}"]`);
        if (m) m.remove();
        estado.mensagensPorId.delete(Number(ev.message_id));
      }
      break;

    case "typing":
      if (ev.channel_id === estado.canalAtual) mostrarDigitando(ev.user);
      break;

    case "presence":
      if (ev.online) estado.online.add(ev.user_id);
      else estado.online.delete(ev.user_id);
      desenharMembros();
      break;

    case "channel_created":
      if (estado.servidorAtual && ev.channel.server_id === estado.servidorAtual.id) {
        estado.canais.push(ev.channel);
        desenharCanais();
      }
      break;

    case "member_joined":
      if (estado.servidorAtual && ev.server_id === estado.servidorAtual.id) {
        abrirServidor(estado.servidorAtual.id);
      }
      break;

    case "dm_opened":
      recarregarDMs();
      break;

    case "voice_state":
      estado.vozPorCanal[ev.channel_id] = ev.users;
      desenharCanais();
      if (ev.channel_id === estado.vozCanal) desenharParticipantesCall();
      break;

    case "voice_peers":
      // Cheguei na sala: ligo pra cada pessoa que ja estava
      ev.peers.forEach((id) => criarLigacao(id, true));
      break;

    case "voice_mute":
      estado.mudos[ev.user_id] = Boolean(ev.muted);
      desenharParticipantesCall();
      if (estado.servidorAtual) desenharCanais();
      break;

    case "voice_left":
      fecharLigacao(ev.user_id);
      delete estado.mudos[ev.user_id];
      desenharParticipantesCall();
      break;

    case "signal":
      receberSinal(ev.from, ev.data);
      break;

    // ---- perfil e amizades ------------------------------------------
    case "profile_updated": {
      // troca os dados dessa pessoa em todas as listas que ja temos
      const trocar = (lista) => {
        const i = lista.findIndex((p) => p.id === ev.user.id);
        if (i >= 0) lista[i] = { ...lista[i], ...ev.user };
      };
      [estado.usuarios, estado.membros, estado.amigos.amigos,
       estado.amigos.recebidos, estado.amigos.enviados].forEach(trocar);
      const dm = estado.dms.find((d) => d.user_id === ev.user.id);
      if (dm) Object.assign(dm, {
        display_name: ev.user.display_name,
        avatar_color: ev.user.avatar_color,
        avatar_url: ev.user.avatar_url,
      });

      if (ev.user.id === estado.eu.id) aplicarMeuPerfil(ev.user);
      desenharMembros();
      atualizarPerfilAberto(ev.user.id);
      if (!estado.servidorAtual) abrirHome();
      break;
    }

    case "friend_request":
      aviso(`${ev.user.display_name} quer ser seu amigo!`, "#5865f2");
      recarregarAmigos();
      atualizarPerfilAberto(ev.user.id);
      break;

    case "friend_accepted":
      aviso(`${ev.user.display_name} aceitou seu pedido!`);
      recarregarAmigos();
      atualizarPerfilAberto(ev.user.id);
      break;

    case "friend_removed":
      recarregarAmigos();
      atualizarPerfilAberto(ev.user_id);
      break;
  }
}


/* ==========================================================================
   DESENHAR: servidores, canais, membros
   ========================================================================== */

function desenharServidores() {
  const accent = estado.servidorAtual?.icon_color || "#55dfb2";
  document.documentElement.style.setProperty("--server-accent", /^#[\da-f]{6}$/i.test(accent) ? accent : "#55dfb2");
  const lista = $("#lista-servidores");
  lista.innerHTML = "";
  estado.servidores.forEach((s) => {
    const b = el("button", "rail-btn", iniciais(s.name));
    b.title = s.name;
    b.style.background = s.icon_color;
    if (estado.servidorAtual && estado.servidorAtual.id === s.id) b.classList.add("ativo");
    b.onclick = () => abrirServidor(s.id);
    lista.appendChild(b);
  });
  $("#btn-home").classList.toggle("ativo", !estado.servidorAtual);
}

/** Tela inicial: lista de DMs e de pessoas. */
function abrirHome() {
  estado.servidorAtual = null;
  estado.membros = [];
  $("#titulo-sidebar").textContent = "Conversas";
  $("#btn-convite").classList.add("escondido");
  desenharServidores();

  const lista = $("#lista-canais");
  lista.innerHTML = "";

  lista.appendChild(el("div", "grupo-titulo", "Mensagens diretas"));
  estado.dms.forEach((d) => {
    const linha = el("div", "canal");
    if (estado.canalAtual === d.channel_id) linha.classList.add("ativo");
    linha.appendChild(avatarDe(d, 22));
    linha.appendChild(el("span", "nome", d.display_name));
    linha.onclick = () => abrirCanal(d.channel_id, "@" + d.display_name);
    lista.appendChild(linha);
  });

  desenharAmigos(lista);

  lista.appendChild(el("div", "grupo-titulo", "Todas as pessoas"));
  estado.usuarios.forEach((u) => {
    const linha = el("div", "canal");
    linha.appendChild(avatarDe(u, 22));
    linha.appendChild(el("span", "nome", u.display_name));
    // clicar numa pessoa abre o perfil dela (e de la da pra mandar mensagem)
    linha.onclick = () => verPerfil(u.id);
    lista.appendChild(linha);
  });

  $("#lista-membros").innerHTML = "";
  if (!estado.canalAtual) telaVazia("Escolha uma conversa ao lado");
}

async function abrirServidor(id) {
  const dados = await api("/api/servers/" + id);
  estado.servidorAtual = dados.server;
  estado.canais = dados.channels;
  estado.membros = dados.members;
  estado.vozPorCanal = dados.voice || {};

  $("#titulo-sidebar").textContent = dados.server.name;
  $("#btn-convite").classList.remove("escondido");

  desenharServidores();
  desenharCanais();
  desenharMembros();

  // Ja deixamos o primeiro canal carregado, mas no celular NAO pulamos pra
  // ele: quem clicou num servidor quer ver a lista de canais primeiro.
  const primeiro = estado.canais.find((c) => c.kind === "text");
  if (primeiro) await abrirCanal(primeiro.id, "# " + primeiro.name, false);
  else telaVazia("Esse servidor ainda nao tem canal de texto");
}

function desenharCanais() {
  if (!estado.servidorAtual) return;
  const lista = $("#lista-canais");
  lista.innerHTML = "";

  const grupos = [
    { titulo: "Canais de texto", kind: "text" },
    { titulo: "Canais de voz", kind: "voice" },
  ];

  grupos.forEach((g) => {
    const cab = el("div", "grupo-titulo");
    cab.appendChild(el("span", null, g.titulo));
    const mais = el("button", null, "+");
    mais.title = "Criar canal";
    mais.onclick = () => criarCanal(g.kind);
    cab.appendChild(mais);
    lista.appendChild(cab);

    estado.canais.filter((c) => c.kind === g.kind).forEach((c) => {
      const linha = el("div", "canal");
      if (c.id === estado.canalAtual && g.kind === "text") linha.classList.add("ativo");
      linha.appendChild(el("span", "hash", g.kind === "voice" ? "🔊" : "#"));
      linha.appendChild(el("span", "nome", c.name));
      linha.onclick = () => {
        if (g.kind === "voice") entrarNaVoz(c.id, c.name);
        else abrirCanal(c.id, "# " + c.name);
      };
      if (g.kind === "voice") {
        const ouvir = el("button", "canal-ouvir", "Ouvir");
        ouvir.title = "Entrar sem ligar o microfone";
        ouvir.onclick = (ev) => { ev.stopPropagation(); entrarNaVoz(c.id, c.name, true); };
        linha.appendChild(ouvir);
      }
      lista.appendChild(linha);

      // quem esta na sala de voz
      (estado.vozPorCanal[c.id] || []).forEach((uid) => {
        const pessoa = estado.membros.find((m) => m.id === uid);
        if (!pessoa) return;
        const mb = el("button", "voz-membro");
        mb.type = "button";
        mb.dataset.voiceId = uid;
        mb.title = "Ajustar volume de " + pessoa.display_name;
        mb.onclick = () => uid === estado.eu.id ? abrirEditarPerfil() : abrirVolume(uid);
        mb.appendChild(avatarDe(pessoa, 20));
        mb.appendChild(el("span", null, pessoa.display_name));
        lista.appendChild(mb);
      });
    });
  });
}

function desenharMembros() {
  const lista = $("#lista-membros");
  lista.innerHTML = "";
  const pessoas = estado.servidorAtual ? estado.membros : estado.usuarios;
  pessoas.forEach((m) => {
    const linha = el("div", "membro");
    if (!estado.online.has(m.id)) linha.classList.add("offline");

    const wrap = el("div", "avatar-wrap");
    wrap.appendChild(avatarDe(m, 28));
    const ponto = el("div", "ponto-status");
    if (estado.online.has(m.id)) ponto.classList.add("on");
    wrap.appendChild(ponto);

    linha.appendChild(wrap);
    const bloco = el("div");
    bloco.appendChild(el("div", null, m.display_name));
    if (m.status_texto) {
      const st = el("div", null, m.status_texto);
      st.style.cssText = "font-size:11px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      bloco.appendChild(st);
    }
    linha.appendChild(bloco);
    linha.onclick = () => verPerfil(m.id);
    lista.appendChild(linha);
  });
}


/* ==========================================================================
   MENSAGENS
   ========================================================================== */

function telaVazia(texto) {
  estado.canalAtual = null;
  $("#chat-titulo").textContent = "";
  $("#mensagens").innerHTML = "";
  $("#mensagens").appendChild(el("div", "vazio", texto));
}

async function abrirCanal(channelId, titulo, trocarTela = true) {
  estado.canalAtual = channelId;
  estado.filtroMensagens = null;
  estado.mensagensPorId.clear();
  $("#busca-mensagens").value = "";
  $("#chat-titulo").textContent = titulo;
  // o aviso de "digitando" e por canal: ao trocar de canal, zeramos
  estado.digitando.forEach((d) => clearTimeout(d.timer));
  estado.digitando.clear();
  $("#digitando").textContent = "";

  const caixa = $("#mensagens");
  caixa.innerHTML = "";
  // limpar o HTML nao apaga essas duas marcas, entao zeramos na mao;
  // senao o canal novo herda o "ultimo autor" do canal anterior e a
  // primeira mensagem dele aparece agrupada por engano
  caixa._ultimoDia = null;
  caixa._ultimoAutor = null;

  const { messages } = await api(`/api/channels/${channelId}/messages`);

  // Enquanto o historico vinha pela rede, a pessoa pode ter clicado em outro
  // canal. Se isso aconteceu, jogamos esta resposta fora: senao as mensagens
  // do canal antigo apareceriam dentro do canal novo.
  if (estado.canalAtual !== channelId) return;

  if (!messages.length) {
    caixa.appendChild(el("div", "vazio", "Nenhuma mensagem ainda.\nSeja o primeiro a falar!"));
  } else {
    messages.forEach((m) => adicionarMensagem(m, false));
    caixa.scrollTop = caixa.scrollHeight;
  }
  estado.temMensagensAntigas = messages.length >= 50;
  estado.idMensagemMaisAntiga = messages.length ? messages[0].id : null;

  const rascunho = lerRascunho(channelId);
  $("#input-msg").value = rascunho;

  if (estado.servidorAtual) desenharCanais(); else abrirHome();
  if (trocarTela) mostrarChatNoCelular();
  // No celular nao damos foco automatico: focar abre o teclado por cima
  // da conversa antes da pessoa nem ter lido nada.
  if (!ehCelular()) $("#input-msg").focus();
}

async function recarregarCanalAtual() {
  if (!estado.canalAtual) return;
  const canal = estado.canalAtual;
  const caixa = $("#mensagens");
  const fim = caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight < 120;
  const { messages } = await api(`/api/channels/${canal}/messages`);
  if (estado.canalAtual !== canal || estado.filtroMensagens) return;
  caixa.replaceChildren();
  caixa._ultimoDia = null;
  caixa._ultimoAutor = null;
  estado.mensagensPorId.clear();
  messages.forEach((m) => adicionarMensagem(m, false));
  estado.temMensagensAntigas = messages.length >= 50;
  estado.idMensagemMaisAntiga = messages.length ? messages[0].id : null;
  if (fim) caixa.scrollTop = caixa.scrollHeight;
}

async function carregarMensagensAntigas() {
  if (estado.carregandoMensagensAntigas || !estado.temMensagensAntigas ||
      !estado.idMensagemMaisAntiga || estado.filtroMensagens || !estado.canalAtual) return;
  estado.carregandoMensagensAntigas = true;
  const canal = estado.canalAtual;
  const caixa = $("#mensagens");
  const alturaAnterior = caixa.scrollHeight;
  const topoAnterior = caixa.scrollTop;
  try {
    const { messages } = await api(`/api/channels/${canal}/messages?before_id=${estado.idMensagemMaisAntiga}`);
    if (estado.canalAtual !== canal) return;
    if (!messages.length) { estado.temMensagensAntigas = false; return; }
    const combinadas = new Map([...messages, ...estado.mensagensPorId.values()].map((m) => [Number(m.id), m]));
    caixa.replaceChildren();
    caixa._ultimoDia = null; caixa._ultimoAutor = null;
    estado.mensagensPorId.clear();
    [...combinadas.values()].sort((a, b) => a.id - b.id).forEach((m) => adicionarMensagem(m, false));
    estado.idMensagemMaisAntiga = messages[0].id;
    estado.temMensagensAntigas = messages.length >= 50;
    caixa.scrollTop = topoAnterior + caixa.scrollHeight - alturaAnterior;
  } catch (erro) { aviso("Não consegui carregar mensagens antigas", "#f0b232"); }
  finally { estado.carregandoMensagensAntigas = false; }
}

async function buscarMensagens(fixadas = false) {
  if (!estado.canalAtual) return aviso("Escolha uma conversa para buscar", "#f0b232");
  const busca = $("#busca-mensagens").value.trim();
  if (!fixadas && !busca) {
    estado.filtroMensagens = null;
    return recarregarCanalAtual();
  }
  const canal = estado.canalAtual;
  estado.filtroMensagens = { busca, fixadas };
  const query = new URLSearchParams();
  if (busca) query.set("q", busca);
  if (fixadas) query.set("pinned", "true");
  const { messages } = await api(`/api/channels/${canal}/messages?${query}`);
  if (estado.canalAtual !== canal || !estado.filtroMensagens) return;
  const caixa = $("#mensagens");
  caixa.replaceChildren();
  caixa._ultimoDia = null;
  caixa._ultimoAutor = null;
  estado.mensagensPorId.clear();
  if (!messages.length) caixa.appendChild(el("div", "vazio", fixadas ? "Nenhuma mensagem fixada." : "Nenhum resultado para essa busca."));
  else messages.forEach((m, i) => adicionarMensagem(m, false));
  caixa.scrollTop = 0;
  $("#btn-fixadas").classList.toggle("ativo", fixadas);
  aviso(`${messages.length} resultado${messages.length === 1 ? "" : "s"}`);
}

/* --- Navegacao do celular ------------------------------------------------
   Na tela pequena o app vira duas telas: a lista e o chat. Aqui so ligamos
   e desligamos a classe que o CSS usa pra decidir qual delas aparece. */

function ehCelular() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function mostrarChatNoCelular() {
  if (ehCelular()) $("#app").classList.add("ver-chat");
}

function voltarParaLista() {
  $("#app").classList.remove("ver-chat");
  $("#painel-membros").classList.remove("aberto");
}

function adicionarMensagem(m, rolar = true) {
  const caixa = $("#mensagens");

  // Protecao contra mensagem repetida: se ela chegar pelo WebSocket enquanto
  // o historico ainda esta vindo pela rede, o historico traria a mesma
  // mensagem de novo e ela apareceria duas vezes.
  if (caixa.querySelector(`[data-msg="${m.id}"]`)) return;

  const vazio = caixa.querySelector(".vazio");
  if (vazio) vazio.remove();

  // divisor de dia, quando a data muda
  const ultima = caixa.lastElementChild;
  const diaAtual = diaLegivel(m.created_at);
  if (caixa._ultimoDia !== diaAtual) {
    caixa.appendChild(el("div", "divisor-dia", diaAtual));
    caixa._ultimoDia = diaAtual;
    caixa._ultimoAutor = null;
  }

  const div = construirMensagem(m);
  // mensagens seguidas da mesma pessoa aparecem sem repetir nome e avatar
  if (caixa._ultimoAutor === m.user_id) div.classList.add("agrupada");
  caixa._ultimoAutor = m.user_id;
  estado.mensagensPorId.set(Number(m.id), m);

  // Se a pessoa ja estava no fim da conversa, rolamos junto.
  // Se ela subiu pra ler algo antigo, NAO arrastamos a tela dela.
  const estavaNoFim = caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight < 120;
  caixa.appendChild(div);
  if (rolar && estavaNoFim) caixa.scrollTop = caixa.scrollHeight;
}

function construirMensagem(m) {
  const div = el("article", "msg" + (m.pinned ? " fixada" : ""));
  div.dataset.msg = m.id;
  div.appendChild(avatarDe(m, 38));
  const corpo = el("div", "msg-corpo");
  const topo = el("div", "msg-topo");
  const autor = el("span", "msg-autor", m.display_name);
  autor.style.color = m.avatar_color;
  topo.appendChild(autor);
  topo.appendChild(el("span", "msg-hora", horaCurta(m.created_at)));
  if (m.edited_at) topo.appendChild(el("span", "msg-editada", "editada"));
  if (m.pinned) topo.appendChild(el("span", "msg-selo-fixada", "📌 Fixada"));
  corpo.appendChild(topo);

  if (m.reply_to && m.reply) {
    const citacao = el("button", "msg-citada", `↪ ${m.reply.author}: ${m.reply.content || "anexo"}`);
    citacao.type = "button";
    citacao.onclick = () => document.querySelector(`[data-msg="${m.reply_to}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    corpo.appendChild(citacao);
  }
  if (m.content) corpo.appendChild(formatarTexto(m.content));
  if (m.file_url) {
    if ((m.file_type || "").startsWith("image/")) {
      const img = el("img", "anexo-img");
      img.decoding = "async";
      img.loading = "lazy";
      img.src = m.file_url;
      img.alt = m.file_name || "Imagem enviada";
      img.title = "Abrir imagem";
      img.onclick = () => abrirFoto(m.file_url, img.alt);
      img.onerror = () => img.classList.add("imagem-falhou");
      corpo.appendChild(img);
    } else {
      const a = el("a", "anexo-arquivo", "📎 " + m.file_name);
      a.href = m.file_url;
      a.download = m.file_name;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      corpo.appendChild(a);
    }
  }
  div.appendChild(corpo);

  const acoes = el("div", "msg-acoes");
  const responder = el("button", "msg-acao", "↩");
  responder.type = "button"; responder.title = "Responder";
  responder.onclick = () => definirResposta(m);
  acoes.appendChild(responder);
  const reacao = el("button", "msg-acao", "☺");
  reacao.type = "button"; reacao.title = "Reagir";
  reacao.onclick = () => div.querySelector(".seletor-reacao").classList.toggle("aberto");
  acoes.appendChild(reacao);
  const fixar = el("button", "msg-acao", m.pinned ? "📌" : "⌖");
  fixar.type = "button"; fixar.title = m.pinned ? "Desafixar" : "Fixar mensagem";
  fixar.onclick = () => mandarWS({ type: "pin", message_id: m.id, pinned: !m.pinned });
  acoes.appendChild(fixar);
  if (m.user_id === estado.eu.id) {
    const editar = el("button", "msg-acao", "✎");
    editar.type = "button"; editar.title = "Editar mensagem";
    editar.onclick = () => editarMensagemUI(m);
    acoes.appendChild(editar);
    const apagar = el("button", "msg-acao perigo", "⌫");
    apagar.type = "button"; apagar.title = "Apagar mensagem";
    apagar.onclick = () => mandarWS({ type: "delete", message_id: m.id });
    acoes.appendChild(apagar);
  }
  const paleta = el("div", "seletor-reacao");
  ["👍", "❤️", "😂", "😮", "😢", "🔥"].forEach((emoji) => {
    const botao = el("button", null, emoji);
    botao.type = "button"; botao.title = `Reagir com ${emoji}`;
    botao.onclick = () => { mandarWS({ type: "react", message_id: m.id, emoji }); paleta.classList.remove("aberto"); };
    paleta.appendChild(botao);
  });
  acoes.appendChild(paleta);
  div.appendChild(acoes);

  if (m.reactions?.length) {
    const reacoes = el("div", "msg-reacoes");
    m.reactions.forEach((r) => {
      const botao = el("button", "reacao" + (r.user_ids?.includes(estado.eu.id) ? " minha" : ""), `${r.emoji} ${r.count}`);
      botao.type = "button"; botao.title = "Alternar reação";
      botao.onclick = () => mandarWS({ type: "react", message_id: m.id, emoji: r.emoji });
      reacoes.appendChild(botao);
    });
    corpo.appendChild(reacoes);
  }
  return div;
}

function atualizarMensagemNaTela(m) {
  const atual = document.querySelector(`[data-msg="${m.id}"]`);
  estado.mensagensPorId.set(Number(m.id), m);
  if (atual) atual.replaceWith(construirMensagem(m));
}

function editarMensagemUI(m) {
  const dialog = $("#dialog-editar-mensagem");
  $("#texto-editar-mensagem").value = m.content || "";
  dialog.dataset.messageId = m.id;
  dialog.showModal();
  $("#texto-editar-mensagem").focus();
}

function definirResposta(m) {
  estado.respostaAtual = m;
  $("#resposta-autor").textContent = m.display_name;
  $("#resposta-texto").textContent = (m.content || m.file_name || "Anexo").slice(0, 140);
  $("#resposta-previa").classList.remove("escondido");
  $("#input-msg").focus();
}

function abrirFoto(url, titulo) {
  $("#foto-ampliada").src = url;
  $("#foto-ampliada").alt = titulo || "Imagem enviada";
  $("#visualizador-foto").showModal();
}

/** Deixa **negrito**, *italico*, `codigo` e links clicaveis.
 *  Montamos no DOM em vez de innerHTML pra nao abrir brecha de XSS. */
function formatarTexto(texto) {
  const p = el("div", "msg-texto");
  const partes = texto.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|https?:\/\/\S+)/g);
  partes.forEach((parte) => {
    if (!parte) return;
    if (parte.startsWith("**") && parte.endsWith("**") && parte.length > 4) {
      p.appendChild(el("strong", null, parte.slice(2, -2)));
    } else if (parte.startsWith("`") && parte.endsWith("`") && parte.length > 2) {
      p.appendChild(el("code", null, parte.slice(1, -1)));
    } else if (parte.startsWith("*") && parte.endsWith("*") && parte.length > 2) {
      p.appendChild(el("em", null, parte.slice(1, -1)));
    } else if (/^https?:\/\//.test(parte)) {
      const a = el("a", null, parte);
      a.href = parte;
      a.target = "_blank";
      a.rel = "noopener noreferrer";   // seguranca: a pagina aberta nao mexe na nossa
      p.appendChild(a);
    } else {
      p.appendChild(document.createTextNode(parte));
    }
  });
  return p;
}

function mostrarDigitando(usuario) {
  const anterior = estado.digitando.get(usuario.id);
  if (anterior) clearTimeout(anterior.timer);
  // Se a pessoa parar de digitar, o aviso some sozinho em 3s.
  estado.digitando.set(usuario.id, {
    nome: usuario.display_name,
    timer: setTimeout(() => pararDigitando(usuario.id), 3000),
  });
  atualizarLinhaDigitando();
}

function pararDigitando(userId) {
  const item = estado.digitando.get(userId);
  if (item) clearTimeout(item.timer);
  estado.digitando.delete(userId);
  atualizarLinhaDigitando();
}

function atualizarLinhaDigitando() {
  const nomes = [...estado.digitando.values()].map((d) => d.nome);
  const linha = $("#digitando");
  if (nomes.length === 0) linha.textContent = "";
  else if (nomes.length === 1) linha.textContent = `${nomes[0]} esta digitando...`;
  else if (nomes.length === 2) linha.textContent = `${nomes[0]} e ${nomes[1]} estao digitando...`;
  else linha.textContent = "varias pessoas estao digitando...";
}


/* ==========================================================================
   ENVIAR
   ========================================================================== */

async function enviarMensagem(e) {
  e.preventDefault();
  const input = $("#input-msg");
  const texto = input.value.trim();
  if (!estado.canalAtual) { aviso("Escolha um canal primeiro", "#f0b232"); return; }
  if (!texto && !estado.arquivoEscolhido) return;

  if (estado.arquivoEscolhido) {
    const canalEnvio = estado.canalAtual;
    const fd = new FormData();
    fd.append("channel_id", canalEnvio);
    fd.append("content", texto);
    if (estado.respostaAtual) fd.append("reply_to", estado.respostaAtual.id);
    fd.append("file", estado.arquivoEscolhido);
    const arquivo = estado.arquivoEscolhido;
    $("#progresso-upload").classList.remove("escondido");
    $("#progresso-upload").value = 0;
    $("#previa-cancelar").disabled = true;
    try {
      await enviarUploadComProgresso(fd, (porcentagem) => { $("#progresso-upload").value = porcentagem; });
      if (estado.canalAtual === canalEnvio) input.value = "";
      salvarRascunho(canalEnvio, "");
      limparArquivo();
      cancelarResposta();
    } catch (err) {
      aviso(err.message, "#f23f43");
      estado.arquivoEscolhido = arquivo;
    } finally {
      $("#previa-cancelar").disabled = false;
      $("#progresso-upload").classList.add("escondido");
    }
    return;
  }

  const clientId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  estado.mensagensPendentes.set(clientId, { channelId: estado.canalAtual, content: texto });
  mandarWS({ type: "send", client_id: clientId, channel_id: estado.canalAtual, content: texto,
    ...(estado.respostaAtual ? { reply_to: estado.respostaAtual.id } : {}) });
  input.value = "";
  cancelarResposta();
}

function enviarUploadComProgresso(form, aoProgredir) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    if (estado.token) xhr.setRequestHeader("Authorization", "Bearer " + estado.token);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) aoProgredir(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      let dados = {};
      try { dados = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(dados);
      else reject(new Error(dados.error || "Falha ao enviar o arquivo"));
    };
    xhr.onerror = () => reject(new Error("Conexão interrompida durante o envio. Tente novamente."));
    xhr.onabort = () => reject(new Error("Envio cancelado"));
    xhr.send(form);
  });
}

function chaveRascunho(channelId) { return `codecom-rascunho:${estado.eu?.id || "local"}:${channelId}`; }
function lerRascunho(channelId) {
  try { return localStorage.getItem(chaveRascunho(channelId)) || ""; } catch { return ""; }
}
function salvarRascunho(channelId, texto) {
  if (!channelId) return;
  try {
    if (texto) localStorage.setItem(chaveRascunho(channelId), texto.slice(0, 4000));
    else localStorage.removeItem(chaveRascunho(channelId));
  } catch {}
}

// Avisa "digitando", no maximo 1 vez a cada 2s (pra nao inundar o servidor)
let ultimoTyping = 0;
function aoDigitar() {
  salvarRascunho(estado.canalAtual, $("#input-msg").value);
  const agora = Date.now();
  if (estado.canalAtual && agora - ultimoTyping > 2000) {
    ultimoTyping = agora;
    mandarWS({ type: "typing", channel_id: estado.canalAtual });
  }
}

function escolherArquivo(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) { aviso("Maximo 25 MB", "#f23f43"); return; }
  estado.arquivoEscolhido = file;
  $("#previa-nome").textContent = "📎 " + file.name;
  $("#previa-arquivo").classList.remove("escondido");
}

function limparArquivo() {
  estado.arquivoEscolhido = null;
  $("#input-arquivo").value = "";
  $("#previa-arquivo").classList.add("escondido");
}

function cancelarResposta() {
  estado.respostaAtual = null;
  $("#resposta-previa").classList.add("escondido");
}


/* ==========================================================================
   DMs E SERVIDORES
   ========================================================================== */

async function iniciarDM(userId, nome) {
  const { channel_id } = await api("/api/dm/" + userId, { method: "POST" });
  await recarregarDMs();
  abrirHome();
  await abrirCanal(channel_id, "@" + nome);
}

async function recarregarDMs() {
  const dados = await api("/api/bootstrap");
  estado.dms = dados.dms;
  estado.usuarios = dados.users;
  if (!estado.servidorAtual) abrirHome();
}

function criarCanal(kind) {
  perguntar(kind === "voice" ? "Nome do canal de voz" : "Nome do canal de texto",
    async (nome) => {
      await api(`/api/servers/${estado.servidorAtual.id}/channels`,
        { method: "POST", body: { name: nome, kind } });
    });
}

function novoServidor() {
  perguntar("Nome do servidor (ou cole um codigo de convite)", async (valor) => {
    let r;
    try {
      // tentamos primeiro como convite; se nao for, criamos um servidor novo
      r = await api("/api/join", { method: "POST", body: { code: valor } });
      aviso("Voce entrou em " + r.server.name);
    } catch {
      r = await api("/api/servers", { method: "POST", body: { name: valor } });
      aviso("Servidor criado!");
    }
    estado.servidores.push(r.server);
    desenharServidores();
    abrirServidor(r.server.id);
  });
}

function copiarConvite() {
  const codigo = estado.servidorAtual.invite_code;
  navigator.clipboard.writeText(codigo)
    .then(() => aviso("Convite copiado: " + codigo))
    .catch(() => aviso("Codigo do convite: " + codigo));
}


/* ==========================================================================
   VOZ (WebRTC)

   Como funciona: o audio NAO passa pelo servidor Python. Cada par de
   navegadores abre uma conexao direta entre si (P2P). O servidor so entrega
   os "bilhetes" de apresentacao (offer / answer / ICE candidate) pra eles
   conseguirem se achar. Isso se chama sinalizacao.
   ========================================================================== */

async function entrarNaVoz(channelId, nome, soOuvir = false) {
  if (estado.vozCanal === channelId) {
    if (soOuvir) ouvirSemMicrofone();
    return;
  }
  if (estado.vozCanal) sairDaVoz();
  ajustarSessaoAudio(soOuvir);
  prepararSaidaAudio(); // dentro do clique, inclusive no Safari do celular
  let bruto;
  try {
    // Pede permissao do microfone. O navegador mostra o popup.
    // Estes tres tratamentos sao do proprio navegador, feitos em codigo
    // nativo: cancelar eco, reduzir ruido de fundo e equilibrar o volume.
    if (!soOuvir) bruto = await navigator.mediaDevices.getUserMedia(restricoesMicrofone());
  } catch {
    aviso("Nao consegui acessar o microfone", "#f23f43");
    return;
  }

  // Em cima do tratamento do navegador, passamos o audio pelo nosso
  // portao de ruido (ver montarPortaoDeRuido).
  estado.microfoneBruto = bruto || null;
  estado.meuAudio = bruto ? montarPortaoDeRuido(bruto) : new MediaStream();
  estado.soOuvir = soOuvir;
  estado.mutado = soOuvir;
  estado.mudos[estado.eu.id] = soOuvir;
  estado.vozCanal = channelId;
  const micAberto = aplicarEstadoMicrofone(false);
  $("#painel-voz").classList.remove("escondido");
  $("#voz-canal").textContent = nome;
  ligarLayoutDaCall(nome);
  tocarSomCall("entrar");
  mandarWS({ type: "voice_join", channel_id: channelId });
  if (!micAberto) mandarWS({ type: "voice_mute", muted: true });
}

function sairDaVoz() {
  tocarSomCall("sair");
  mandarWS({ type: "voice_leave" });
  pararDeCompartilhar();
  Object.keys(estado.peers).forEach((id) => fecharLigacao(Number(id)));

  // Desligar o microfone de verdade e desligar a FONTE (o stream bruto).
  // O stream processado e so a saida do nosso tratamento de audio.
  if (estado.microfoneBruto) {
    estado.microfoneBruto.getTracks().forEach((t) => t.stop());
    estado.microfoneBruto = null;
  }
  estado.meuAudio = null;
  desmontarPortaoDeRuido();
  if (contextoSaida) {
    const contextoAnterior = contextoSaida;
    contextoSaida = null;
    setTimeout(() => contextoAnterior.close().catch(() => {}), 450);
  }

  estado.vozCanal = null;
  estado.soOuvir = false;
  estado.mudos = {};
  ajustarSessaoAudio(true);
  $("#painel-voz").classList.add("escondido");
  desligarLayoutDaCall();
}

let medidorRemotoTimer = null;

function ligarLayoutDaCall(nome) {
  $("#call-stage").classList.remove("escondido");
  $("#call-stage-titulo").textContent = nome || "Sala de voz";
  $("#call-controls").appendChild($("#painel-voz"));
  $("#call-screens").appendChild($("#visor"));
  desenharParticipantesCall();
  iniciarMedidorRemoto();
  mostrarChatNoCelular();
}

function desligarLayoutDaCall() {
  document.querySelector(".sidebar").insertBefore($("#painel-voz"), $("#painel-usuario"));
  document.body.insertBefore($("#visor"), $("#audios"));
  $("#call-stage").classList.add("escondido");
  $("#call-participantes").replaceChildren();
  clearInterval(medidorRemotoTimer);
  medidorRemotoTimer = null;
  clearInterval(estado.statsCallTimer);
  estado.statsCallTimer = null;
}

function desenharParticipantesCall() {
  const area = $("#call-participantes");
  if (!area || !estado.vozCanal) return;
  const ids = [...new Set([...(estado.vozPorCanal[estado.vozCanal] || []), estado.eu?.id].filter(Boolean))];
  area.replaceChildren();
  ids.forEach((id) => {
    const pessoa = [estado.membros, estado.usuarios, estado.amigos.amigos]
      .flat().find((u) => u.id === id) || { id, display_name: nomeDe(id), username: nomeDe(id), avatar_color: "#46d6ac" };
    const card = el("button", "call-person" + (estado.mudos[id] ? " mudo" : ""));
    card.type = "button";
    card.dataset.voiceId = id;
    card.title = id === estado.eu.id ? pessoa.display_name : "Ajustar volume de " + pessoa.display_name;
    const foto = avatarDe(pessoa, 64);
    foto.classList.add("call-avatar");
    card.appendChild(foto);
    card.appendChild(el("span", "call-person-name", pessoa.display_name || pessoa.username));
    card.appendChild(el("span", "call-person-state", estado.mudos[id] ? "Microfone mutado" : (id === estado.eu.id ? "Você" : "Conectado")));
    if (estado.mudos[id]) card.appendChild(el("span", "call-mute-icon", "MIC DESLIGADO"));
    card.onclick = () => id === estado.eu.id ? alternarMudo() : abrirVolume(id);
    area.appendChild(card);
  });
}

function atualizarVozFalando(userId, falando) {
  document.querySelectorAll(`[data-voice-id="${Number(userId)}"]`).forEach((item) => item.classList.toggle("falando", Boolean(falando)));
}

function iniciarMedidorRemoto() {
  if (medidorRemotoTimer) return;
  medidorRemotoTimer = setInterval(() => {
    const ativos = new Set();
    document.querySelectorAll('#audios audio[data-tipo="voz"]').forEach((audio) => {
      const analisador = audio.mixagem?.analisador;
      if (!analisador || audio.mixagem.silenciado || estado.mudos[audio.dataset.usuario]) return;
      const amostras = new Uint8Array(analisador.fftSize);
      analisador.getByteTimeDomainData(amostras);
      let soma = 0;
      for (const valor of amostras) { const amostra = (valor - 128) / 128; soma += amostra * amostra; }
      if (Math.sqrt(soma / amostras.length) > 0.035) ativos.add(Number(audio.dataset.usuario));
    });
    document.querySelectorAll(".call-person.falando").forEach((item) => {
      if (!ativos.has(Number(item.dataset.voiceId))) atualizarVozFalando(item.dataset.voiceId, false);
    });
    ativos.forEach((id) => atualizarVozFalando(id, true));
  }, 90);
  estado.statsCallTimer = setInterval(atualizarDiagnosticoCall, 2500);
  atualizarDiagnosticoCall();
}

async function atualizarDiagnosticoCall() {
  const pares = Object.entries(estado.peers);
  if (!estado.vozCanal) return;
  if (!pares.length) {
    $("#call-rede").textContent = "Só você";
    $("#call-latencia").textContent = "— ms";
    $("#call-perda").textContent = "—% perda";
    $("#call-video").textContent = estado.minhaTela ? "Transmitindo" : "Sem transmissão";
    return;
  }
  const rtts = [], perdas = [];
  let resolucao = null;
  let conectados = 0;
  for (const [id, pc] of pares) {
    try {
      const stats = await pc.getStats();
      const reports = [...stats.values()];
      if (pc.connectionState === "connected") conectados++;
      const par = reports.find((s) => s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded")));
      const retornoVoz = reports.find((s) => s.type === "remote-inbound-rtp" && s.kind === "audio");
      const retornoVideo = reports.find((s) => s.type === "remote-inbound-rtp" && s.kind === "video");
      const retorno = estado.minhaTela ? (retornoVideo || retornoVoz) : (retornoVoz || retornoVideo);
      const video = reports.find((s) => s.type === "outbound-rtp" && s.kind === "video");
      const rtt = par?.currentRoundTripTime ?? retorno?.roundTripTime;
      if (Number.isFinite(rtt)) rtts.push(rtt * 1000);
      const recebido = Number(retorno?.packetsReceived || 0);
      const perdido = Number(retorno?.packetsLost || 0);
      if (recebido + perdido > 0) perdas.push(perdido / (recebido + perdido));
      if (video?.frameWidth && video?.frameHeight) resolucao = `${video.frameWidth}×${video.frameHeight} · ${Math.round(video.framesPerSecond || 0)} fps`;
      ajustarQualidadeAdaptativa(id, rtt, retorno?.fractionLost);
    } catch (erro) { console.debug("Diagnóstico de conexão indisponível", erro); }
  }
  const media = (valores) => valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
  const ping = media(rtts);
  const perda = media(perdas);
  $("#call-rede").textContent = conectados === pares.length ? "Conexão estável" : "Conectando";
  $("#call-latencia").textContent = ping == null ? "— ms" : `${Math.round(ping)} ms`;
  $("#call-perda").textContent = perda == null ? "—% perda" : `${(perda * 100).toFixed(1)}% perda`;
  $("#call-video").textContent = estado.minhaTela ? (resolucao || "Ajustando vídeo") : "Sem transmissão";
  const health = $("#call-diagnostico");
  health.classList.toggle("instavel", (ping || 0) > 400 || (perda || 0) > 0.06);
  health.classList.toggle("bom", (ping || 0) < 150 && (perda || 0) < 0.02);
}

function ajustarQualidadeAdaptativa(userId, rttSegundos, perdaReportada) {
  if (!estado.minhaTela) return;
  const perfil = PERFIS_TELA[estado.qualidadeTela];
  const alvo = estado.bitrateTelaPeer[userId] || { bitrate: perfil.bitrate, fps: perfil.fps, ruins: 0, boas: 0 };
  // Mantemos também os contadores entre medições; sem isso cada leitura ruim
  // começaria do zero e a redução nunca seria aplicada.
  estado.bitrateTelaPeer[userId] = alvo;
  const perda = Number.isFinite(perdaReportada) ? perdaReportada : 0;
  const instavel = (Number.isFinite(rttSegundos) && rttSegundos > 0.4) || perda > 0.06;
  if (instavel) {
    alvo.ruins++; alvo.boas = 0;
    if (alvo.ruins >= 2) {
      const anterior = `${alvo.bitrate}:${alvo.fps}`;
      alvo.bitrate = Math.max(1500000, Math.round(alvo.bitrate * 0.78));
      alvo.fps = Math.max(24, Math.min(alvo.fps, 30));
      alvo.ruins = 0;
      if (anterior !== `${alvo.bitrate}:${alvo.fps}`) {
        estado.bitrateTelaPeer[userId] = alvo;
        atualizarEnvioTela();
      }
    }
  } else {
    alvo.ruins = 0; alvo.boas++;
    if (alvo.boas >= 5) {
      const anterior = `${alvo.bitrate}:${alvo.fps}`;
      alvo.bitrate = Math.min(perfil.bitrate, Math.round(alvo.bitrate * 1.12));
      alvo.fps = Math.min(perfil.fps, alvo.fps + 6);
      alvo.boas = 0;
      if (anterior !== `${alvo.bitrate}:${alvo.fps}`) {
        estado.bitrateTelaPeer[userId] = alvo;
        atualizarEnvioTela();
      }
    }
  }
}

function tocarSomCall(acao) {
  if (!estado.sonsCall) return;
  try {
    const Contexto = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Contexto) return;
    const ctx = contextoSaida || new Contexto({ latencyHint: "interactive" });
    const contextoProprio = ctx !== contextoSaida;
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    const notas = acao === "entrar" ? [523, 784] : acao === "sair" ? [784, 523] : acao === "mutar" ? [390] : [660];
    const agora = ctx.currentTime;
    notas.forEach((frequencia, i) => {
      const inicio = agora + i * 0.095;
      const oscilador = ctx.createOscillator();
      const ganho = ctx.createGain();
      oscilador.type = "sine";
      oscilador.frequency.value = frequencia;
      ganho.gain.setValueAtTime(0.0001, inicio);
      ganho.gain.exponentialRampToValueAtTime(0.12, inicio + 0.018);
      ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.09);
      oscilador.connect(ganho).connect(ctx.destination);
      oscilador.start(inicio);
      oscilador.stop(inicio + 0.1);
    });
    if (contextoProprio) setTimeout(() => ctx.close().catch(() => {}), 450);
  } catch (erro) { console.debug("Som da chamada indisponível", erro); }
}

function ajustarSessaoAudio(soOuvir) {
  try { if (navigator.audioSession) navigator.audioSession.type = soOuvir ? "playback" : "play-and-record"; } catch {}
}

function atualizarModoOuvir() {
  const aberto = Boolean(estado.meuAudio?.getAudioTracks().length && !estado.mutado &&
    (!estado.pushToTalk || estado.microfonePressionado));
  $("#btn-so-ouvir").classList.toggle("ativo", estado.soOuvir);
  $("#btn-so-ouvir").textContent = estado.soOuvir ? "🎧 Só ouvindo" : (ehCelular() ? "🎧 Sem mic" : "🎧 Ouvir sem microfone");
  $("#btn-so-ouvir").setAttribute("aria-label", estado.soOuvir ? "Você está ouvindo sem microfone" : "Entrar sem ligar o microfone");
  $("#btn-mudo").textContent = aberto ? "🎤" : "🔇";
  $("#btn-mudo").classList.toggle("mutado", !aberto);
  $("#btn-mudo").title = estado.pushToTalk ? "Segure V para falar" : (estado.soOuvir ? "Ligar microfone para falar" : (aberto ? "Mutar microfone" : "Ativar microfone"));
  $("#btn-mudo-call").textContent = aberto ? "🎤" : "🔇";
  $("#btn-mudo-call").classList.toggle("mutado", !aberto);
  $("#btn-mudo-call").title = estado.pushToTalk ? "Segure V para falar" : (estado.soOuvir ? "Ligar microfone para falar" : (aberto ? "Mutar microfone" : "Ativar microfone"));
}

function restricoesMicrofone(deviceId = estado.microfoneId) {
  return { audio: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  } };
}

function aplicarEstadoMicrofone(notificar = true) {
  const aberto = Boolean(estado.meuAudio?.getAudioTracks().length && !estado.mutado &&
    (!estado.pushToTalk || estado.microfonePressionado));
  estado.meuAudio?.getAudioTracks().forEach((track) => { track.enabled = aberto; });
  if (estado.eu) estado.mudos[estado.eu.id] = !aberto;
  atualizarModoOuvir();
  if (notificar && estado.vozCanal) mandarWS({ type: "voice_mute", muted: !aberto });
  if (!aberto) atualizarVozFalando(estado.eu?.id, false);
  desenharParticipantesCall();
  return aberto;
}

async function trocarMicrofone(deviceId) {
  const anterior = estado.microfoneId;
  estado.microfoneId = deviceId || "";
  try { localStorage.setItem("codecom-microfone", estado.microfoneId); } catch {}
  if (!estado.vozCanal || estado.soOuvir || !estado.meuAudio) return;
  const canal = estado.vozCanal;
  let novoBruto;
  try {
    novoBruto = await navigator.mediaDevices.getUserMedia(restricoesMicrofone(deviceId));
    if (estado.vozCanal !== canal) { novoBruto.getTracks().forEach((t) => t.stop()); return; }
    const antigas = new Set(estado.meuAudio.getAudioTracks());
    desmontarPortaoDeRuido();
    const novoAudio = montarPortaoDeRuido(novoBruto);
    const novaFaixa = novoAudio.getAudioTracks()[0];
    novaFaixa.enabled = Boolean(!estado.mutado && (!estado.pushToTalk || estado.microfonePressionado));
    const trocas = [];
    for (const pc of Object.values(estado.peers)) {
      for (const sender of pc.getSenders()) {
        if (antigas.has(sender.track)) trocas.push(sender.replaceTrack(novaFaixa));
      }
    }
    await Promise.allSettled(trocas);
    estado.microfoneBruto?.getTracks().forEach((t) => t.stop());
    estado.microfoneBruto = novoBruto;
    estado.meuAudio = novoAudio;
    aplicarEstadoMicrofone();
    aviso("Microfone atualizado");
  } catch (erro) {
    novoBruto?.getTracks().forEach((t) => t.stop());
    estado.microfoneId = anterior;
    $("#dispositivo-microfone").value = anterior;
    try { localStorage.setItem("codecom-microfone", anterior); } catch {}
    aviso("Não foi possível trocar o microfone", "#f23f43");
  }
}

function aplicarTema(tema) {
  const valido = ["aurora", "violeta", "claro", "hello-kitty"].includes(tema) ? tema : "aurora";
  estado.tema = valido;
  document.body.dataset.tema = valido;
  const cores = { aurora: "#0d1721", violeta: "#151020", claro: "#f8fbfa", "hello-kitty": "#fff0f6" };
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", cores[valido]);
  try { localStorage.setItem("codecom-tema", valido); } catch {}
}

function abrirConfiguracoes() {
  $("#tema-app").value = estado.tema;
  $("#atalho-ptt").checked = estado.pushToTalk;
  $("#sons-call").checked = estado.sonsCall;
  $("#dialog-config").showModal();
  atualizarDispositivosAudio();
}

async function atualizarDispositivosAudio() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const preencher = (seletor, kind, atual, padrao) => {
      const select = $(seletor);
      const valor = atual;
      select.replaceChildren(new Option(padrao, ""));
      devices.filter((d) => d.kind === kind).forEach((d, i) => {
        const option = new Option(d.label || `${kind === "audioinput" ? "Microfone" : "Saída"} ${i + 1}`, d.deviceId);
        select.appendChild(option);
      });
      select.value = valor;
      if (select.value !== valor) select.value = "";
    };
    preencher("#dispositivo-microfone", "audioinput", estado.microfoneId, "Microfone padrão");
    preencher("#dispositivo-saida", "audiooutput", estado.saidaAudioId, "Saída padrão");
  } catch (erro) { console.debug("Não foi possível listar dispositivos de áudio", erro); }
}

async function trocarSaidaAudio(deviceId) {
  estado.saidaAudioId = deviceId || "";
  try { localStorage.setItem("codecom-saida", estado.saidaAudioId); } catch {}
  const ctx = prepararSaidaAudio();
  if (!ctx?.setSinkId) {
    if (deviceId) aviso("Este navegador não permite escolher a saída de áudio", "#f0b232");
    return;
  }
  try { await ctx.setSinkId(deviceId || "default"); aviso("Saída de áudio atualizada"); }
  catch { aviso("Não foi possível trocar a saída de áudio", "#f23f43"); }
}

function testarSaidaAudio() {
  const ctx = prepararSaidaAudio();
  if (!ctx) return;
  const oscilador = ctx.createOscillator();
  const ganho = ctx.createGain();
  oscilador.frequency.value = 660;
  ganho.gain.setValueAtTime(0.0001, ctx.currentTime);
  ganho.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.03);
  ganho.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
  oscilador.connect(ganho).connect(ctx.destination);
  oscilador.start(); oscilador.stop(ctx.currentTime + 0.46);
}

function atualizarPushToTalk() {
  estado.pushToTalk = $("#atalho-ptt").checked;
  estado.microfonePressionado = false;
  try { localStorage.setItem("codecom-ptt", String(estado.pushToTalk)); } catch {}
  aplicarEstadoMicrofone();
  aviso(estado.pushToTalk ? "Pressione e segure V para falar" : "Pressione para falar desligado");
}

function ouvirSemMicrofone() {
  if (!estado.vozCanal) return;
  const tracks = new Set(estado.meuAudio?.getTracks() || []);
  for (const pc of Object.values(estado.peers)) {
    for (const sender of pc.getSenders()) if (tracks.has(sender.track)) pc.removeTrack(sender);
  }
  estado.microfoneBruto?.getTracks().forEach(t => t.stop());
  estado.meuAudio?.getTracks().forEach(t => t.stop());
  estado.microfoneBruto = null;
  estado.meuAudio = new MediaStream();
  desmontarPortaoDeRuido();
  estado.soOuvir = true;
  estado.mutado = true;
  estado.mudos[estado.eu.id] = true;
  ajustarSessaoAudio(true);
  atualizarModoOuvir();
  atualizarVozFalando(estado.eu.id, false);
  desenharParticipantesCall();
  tocarSomCall("mutar");
  mandarWS({ type: "voice_mute", muted: true });
  liberarSom();
}

/* --- Negociacao ----------------------------------------------------------

   Compartilhar tela obriga a RENEGOCIAR uma conexao que ja esta no ar: a
   gente adiciona uma faixa de video depois que a chamada comecou. Se os dois
   lados mandarem proposta ao mesmo tempo, a conexao quebra ("glare").

   A solucao padrao e a "negociacao educada": um dos dois e o educado e, num
   conflito, ele cede e aceita a proposta do outro. Usamos o numero do
   usuario pra decidir quem e quem - assim os dois lados chegam na mesma
   conclusao sem precisar combinar nada.
*/

function criarLigacao(outroId, iniciador) {
  if (estado.peers[outroId]) return estado.peers[outroId];

  const pc = new RTCPeerConnection(CONFIG_RTC);
  estado.peers[outroId] = pc;

  pc.educado = estado.eu.id < outroId;   // regra combinada implicitamente
  pc.fazendoOferta = false;
  pc.ignorandoOferta = false;

  // manda meu audio pra essa pessoa
  estado.meuAudio.getTracks().forEach((t) => pc.addTrack(t, estado.meuAudio));
  if (!estado.meuAudio.getTracks().length) {
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.addTransceiver("video", { direction: "recvonly" });
  }

  // se eu ja estiver compartilhando tela, essa pessoa tambem recebe
  // (getTracks e nao getVideoTracks: o som da tela tem que ir junto)
  if (estado.minhaTela) {
    estado.minhaTela.getTracks().forEach((t) => pc.addTrack(t, estado.minhaTela));
  }

  pc.ontrack = (ev) => {
    // O jitter buffer nativo absorve a variacao do Wi-Fi/rede movel.
    const stream = ev.streams[0] || new MediaStream([ev.track]);

    if (ev.track.kind === "video") {
      mostrarTela(outroId, stream);
      // quando a pessoa para de compartilhar, a faixa "morre" e tiramos da tela
      ev.track.onended = () => tirarTela(outroId);
      stream.addEventListener("removetrack", (evento) => {
        if (evento.track.kind === "video" && estado.telaDe[outroId] === stream.id) {
          tirarTela(outroId);
        }
      });
      return;
    }

    // Audio. Uma pessoa pode mandar DOIS audios ao mesmo tempo: o microfone
    // dela e o som da tela que ela compartilha. Sao streams diferentes, entao
    // cada um ganha o proprio <audio>. Com um elemento so, o segundo som
    // substituia o primeiro e a voz da pessoa sumia quando ela transmitia.
    const id = `audio-${outroId}-${stream.id}`;
    let audio = document.getElementById(id);
    if (audio) { removerAudioRemoto(audio); audio = null; }
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = id;
      audio.autoplay = true;
      audio.playsInline = true;
      $("#audios").appendChild(audio);
    }
    // O player de som recebe apenas audio; o video toca no visor, sem eco.
    desmontarAudioRemoto(audio);
    audio.dataset.usuario = String(outroId);
    audio.dataset.stream = stream.id;
    audio.dataset.tipo = stream.getVideoTracks().length || estado.telaDe[outroId] === stream.id ? "tela" : "voz";
    montarAudioRemoto(audio, ev.track);
    aplicarVolumeAudio(audio);
    reproduzirAudio(audio);
    const remover = () => {
      removerAudioRemoto(audio);
      atualizarBotaoSom();
    };
    ev.track.onended = remover;
    stream.addEventListener("removetrack", (evento) => {
      if (evento.track === ev.track) remover();
    });
  };

  // candidatos ICE = caminhos possiveis de rede. Repassamos pro outro lado.
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      mandarWS({ type: "signal", to: outroId, data: { candidate: ev.candidate } });
    }
  };

  // Dispara sozinho sempre que algo muda (entrar na chamada, ligar a tela,
  // desligar a tela). Por isso nao precisamos mais do "iniciador" aqui.
  pc.onnegotiationneeded = async () => {
    try {
      pc.fazendoOferta = true;
      await pc.setLocalDescription();
      atualizarEnvioTela();
      mandarWS({ type: "signal", to: outroId, data: { sdp: pc.localDescription } });
    } catch (e) {
      console.warn("falha ao negociar com", outroId, e);
    } finally {
      pc.fazendoOferta = false;
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") pc.restartIce();
    if (pc.connectionState === "connected") atualizarEnvioTela();
  };

  atualizarEnvioTela();
  return pc;
}

function atualizarEnvioTela() {
  const peers = Object.values(estado.peers);
  for (const [userId, pc] of Object.entries(estado.peers)) {
    // Serializa setParameters, que usa uma transacao por sender.
    pc.ajusteTela = (pc.ajusteTela || Promise.resolve()).then(async () => {
      if (!estado.minhaTela || pc.connectionState === "closed") return;
      const perfil = PERFIS_TELA[estado.qualidadeTela];
      const adaptacao = estado.bitrateTelaPeer[userId] || { bitrate: perfil.bitrate, fps: perfil.fps };
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video" || !estado.minhaTela.getTracks().includes(sender.track)) continue;
        const parametros = sender.getParameters();
        // Alguns navegadores so disponibilizam encodings apos negociar SDP.
        if (!parametros.encodings?.length) continue;
        const tamanho = sender.track.getSettings();
        const escala = Math.max(1, (tamanho.width || perfil.largura) / perfil.largura,
          (tamanho.height || perfil.altura) / perfil.altura);
        parametros.encodings.forEach((encoding) => {
          encoding.maxBitrate = Math.min(perfil.bitrate, adaptacao.bitrate);
          encoding.maxFramerate = Math.min(perfil.fps, adaptacao.fps);
          encoding.scaleResolutionDownBy = escala;
        });
        // Preserva detalhes; antes o navegador reduzia ate para 180p para manter FPS.
        parametros.degradationPreference = "maintain-resolution";
        try { await sender.setParameters(parametros); }
        catch (erro) { console.warn("Limite de video indisponivel", erro); }
      }
    }).catch((erro) => console.warn("Ajuste de transmissao indisponivel", erro));
  }
  return Promise.all(peers.map(pc => pc.ajusteTela));
}

function prepararSaidaAudio() {
  try {
    const Contexto = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Contexto) return null;
    if (!contextoSaida || contextoSaida.state === "closed") {
      contextoSaida = new Contexto({ latencyHint: "interactive" });
      if (estado.saidaAudioId && contextoSaida.setSinkId) {
        contextoSaida.setSinkId(estado.saidaAudioId).catch(() => {});
      }
      contextoSaida.onstatechange = () => {
        for (const audio of $("#audios").querySelectorAll("audio")) {
          if (audio.mixagem && contextoSaida?.state !== "running") audio.dataset.bloqueado = "true";
        }
        atualizarBotaoSom();
      };
    }
    if (contextoSaida.state !== "running") contextoSaida.resume().catch(() => {});
    return contextoSaida;
  } catch (erro) { console.warn("Controle de ganho indisponivel", erro); return null; }
}

function montarAudioRemoto(audio, track) {
  const stream = new MediaStream([track]);
  audio.muted = true;
  audio.srcObject = stream;
  const ctx = prepararSaidaAudio();
  if (ctx) {
    // O track remoto vai direto ao Web Audio. Não recapturamos a saída do player,
    // evitando o atraso extra de reproduzir um segundo MediaStream.
    const fonte = ctx.createMediaStreamSource(stream);
    const ganho = ctx.createGain();
    const analisador = ctx.createAnalyser();
    analisador.fftSize = 256;
    const limitador = ctx.createDynamicsCompressor();
    limitador.threshold.value = -3;
    limitador.knee.value = 0;
    limitador.ratio.value = 20;
    limitador.attack.value = 0.002;
    limitador.release.value = 0.1;
    fonte.connect(analisador);
    analisador.connect(ganho);
    ganho.connect(limitador);
    limitador.connect(ctx.destination);
    audio.mixagem = { fonte, ganho, limitador, analisador, ctx };
  }
}

function desmontarAudioRemoto(audio) {
  if (audio.mixagem) {
    audio.mixagem.fonte.disconnect();
    audio.mixagem.ganho.disconnect();
    audio.mixagem.limitador.disconnect();
    audio.mixagem.analisador.disconnect();
    delete audio.mixagem;
  }
  audio.srcObject = null;
}

function removerAudioRemoto(audio) {
  desmontarAudioRemoto(audio);
  audio.remove();
}

function lerVolume(userId) {
  const chave = `codecom-volume:${estado.eu.id}:${userId}`;
  if (volumesLocais.has(chave)) return { ...volumesLocais.get(chave) };
  try {
    const valores = JSON.parse(localStorage.getItem(chave));
    return { voz: normalizarVolume(valores?.voz), tela: normalizarVolume(valores?.tela) };
  } catch { return { voz: 100, tela: 100 }; }
}

function normalizarVolume(valor) {
  return typeof valor === "number" && Number.isFinite(valor) ? Math.max(0, Math.min(200, valor)) : 100;
}

function aplicarVolumeAudio(audio) {
  const volumeSalvo = lerVolume(audio.dataset.usuario)[audio.dataset.tipo] / 100;
  // O volume recebido continua independente do áudio que sai na transmissão.
  const volume = volumeSalvo;
  if (audio.mixagem) {
    audio.mixagem.silenciado = volume === 0;
    audio.mixagem.ganho.gain.setTargetAtTime(volume, audio.mixagem.ctx.currentTime, 0.015);
    audio.volume = 1;
  } else {
    audio.volume = Math.min(1, volume);
  }
  // A saída passa pelo grafo acima; silenciamos o elemento auxiliar para não duplicá-la.
  audio.muted = Boolean(audio.mixagem) || volume === 0;
}

function salvarVolume(userId, tipo, valor) {
  const valores = lerVolume(userId);
  valores[tipo] = normalizarVolume(Number(valor));
  volumesLocais.set(`codecom-volume:${estado.eu.id}:${userId}`, valores);
  try { localStorage.setItem(`codecom-volume:${estado.eu.id}:${userId}`, JSON.stringify(valores)); }
  catch { aviso("Nao foi possivel salvar o volume neste navegador", "#f0b232"); }
  for (const audio of $("#audios").querySelectorAll("audio")) {
    if (audio.dataset.usuario === String(userId)) aplicarVolumeAudio(audio);
  }
  return valores[tipo];
}

function abrirVolume(userId) {
  estado.volumeUsuario = userId;
  $("#volume-titulo").textContent = "Volume de " + nomeDe(userId);
  const valores = lerVolume(userId);
  for (const tipo of ["voz", "tela"]) {
    $("#volume-" + tipo).value = valores[tipo];
    $("#volume-" + tipo + "-valor").textContent = valores[tipo] + "%";
  }
  $("#modal-volume").showModal();
  liberarSom();
}

function atualizarBotaoSom() {
  const bloqueados = $("#audios").querySelectorAll("audio[data-bloqueado]");
  $("#btn-liberar-som").classList.toggle("escondido", bloqueados.length === 0);
}

async function reproduzirAudio(audio) {
  if (audio.mixagem && audio.mixagem.ctx.state !== "running") {
    audio.dataset.bloqueado = "true";
    atualizarBotaoSom();
  }
  try {
    // Com Web Audio, basta liberar o contexto; sem suporte, usamos o player nativo.
    await Promise.all([audio.mixagem ? Promise.resolve() : audio.play(), audio.mixagem?.ctx.resume()]);
    if (audio.mixagem && audio.mixagem.ctx.state !== "running") throw new Error("Audio suspenso");
    delete audio.dataset.bloqueado;
  } catch (erro) {
    if (!audio.isConnected) return;
    // O clique no botao permite tentar de novo dentro de um gesto do usuario.
    audio.dataset.bloqueado = "true";
    if (erro.name !== "NotAllowedError") console.warn("Falha ao tocar audio", erro);
  }
  atualizarBotaoSom();
}

function liberarSom() {
  $("#audios").querySelectorAll("audio").forEach((audio) => reproduzirAudio(audio));
}

async function receberSinal(deQuem, data) {
  if (!estado.meuAudio) return;   // nao estou em chamada, ignoro
  const pc = criarLigacao(deQuem, false);

  try {
    if (data.sdp) {
      // Conflito: chegou uma proposta enquanto eu tambem estava propondo.
      const conflito = data.sdp.type === "offer" &&
        (pc.fazendoOferta || pc.signalingState !== "stable");

      // O grosseiro ignora a proposta do outro e segue com a dele.
      pc.ignorandoOferta = !pc.educado && conflito;
      if (pc.ignorandoOferta) return;

      // O educado desfaz a propria proposta e aceita a do outro.
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === "offer") {
        await pc.setLocalDescription();
        mandarWS({ type: "signal", to: deQuem, data: { sdp: pc.localDescription } });
      }
      atualizarEnvioTela();
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        // candidato de uma proposta que ignoramos: pode descartar em silencio
        if (!pc.ignorandoOferta) throw e;
      }
    }
  } catch (e) {
    console.warn("erro na sinalizacao com", deQuem, e);
  }
}

function fecharLigacao(outroId) {
  const pc = estado.peers[outroId];
  if (pc) { pc.close(); delete estado.peers[outroId]; }
  delete estado.bitrateTelaPeer[outroId];
  // os <audio> dessa pessoa sao "audio-<id>-<stream>": podem ser mais de um
  // (microfone + som da tela), entao removemos todos de uma vez
  document.querySelectorAll(`[id^="audio-${outroId}-"]`).forEach(removerAudioRemoto);
  tirarTela(outroId);
  atualizarBotaoSom();
  atualizarEnvioTela();
}

async function alternarMudo() {
  if (!estado.meuAudio) { aviso("Voce nao esta numa chamada", "#f0b232"); return; }
  if (estado.soOuvir) {
    if (estado.ativandoMicrofone) return;
    estado.ativandoMicrofone = true;
    const canal = estado.vozCanal;
    try {
      ajustarSessaoAudio(false);
      const bruto = await navigator.mediaDevices.getUserMedia(restricoesMicrofone());
      if (estado.vozCanal !== canal) { bruto.getTracks().forEach(t => t.stop()); return; }
      estado.microfoneBruto = bruto;
      estado.meuAudio = montarPortaoDeRuido(bruto);
      for (const pc of Object.values(estado.peers)) estado.meuAudio.getTracks().forEach(t => pc.addTrack(t, estado.meuAudio));
      estado.soOuvir = false;
      estado.mutado = false;
      estado.mudos[estado.eu.id] = false;
      aplicarEstadoMicrofone();
    } catch {
      ajustarSessaoAudio(true);
      aviso("Microfone indisponivel. Voce continua ouvindo.", "#f0b232");
    } finally { estado.ativandoMicrofone = false; }
    return;
  }
  estado.mutado = !estado.mutado;
  const micAberto = aplicarEstadoMicrofone();
  atualizarVozFalando(estado.eu.id, false);
  tocarSomCall(micAberto ? "desmutar" : "mutar");
  desenharParticipantesCall();
  aviso(micAberto ? "Microfone ligado" : (estado.pushToTalk && !estado.mutado ? "Segure V para falar" : "Microfone mutado"));
}


/* ==========================================================================
   MODAL
   ========================================================================== */

function perguntar(titulo, aoConfirmar) {
  $("#modal-titulo").textContent = titulo;
  $("#modal-input").value = "";
  $("#modal-erro").textContent = "";
  $("#modal").classList.remove("escondido");
  $("#modal-input").focus();

  $("#modal-ok").onclick = async () => {
    const valor = $("#modal-input").value.trim();
    if (!valor) return;
    try {
      await aoConfirmar(valor);
      $("#modal").classList.add("escondido");
    } catch (e) {
      $("#modal-erro").textContent = e.message;
    }
  };
}


/* ==========================================================================
   SUPRESSAO DE RUIDO

   O navegador ja tem um supressor nativo (ligamos ele no getUserMedia).
   Ele resolve chiado constante - ventilador, ar-condicionado, hum da placa.

   O que ele NAO resolve bem e o silencio "sujo": voce parado, sem falar, e
   o microfone mandando teclado, respiracao, TV ao fundo. Pra isso existe o
   PORTAO DE RUIDO: medimos o volume o tempo todo e, quando esta abaixo de
   um limite, fechamos o volume. Quando voce fala, abre.

   Detalhes que fazem diferenca:
   - abrir RAPIDO (senao corta a primeira silaba)
   - fechar DEVAGAR, e so depois de um tempinho segurando aberto
     (senao a voz fica picotada nas pausas entre palavras)
   ========================================================================== */

const RUIDO = {
  ctx: null, fonte: null, analisador: null, ganho: null, destino: null,
  timer: null,
  corte: 0.022,        // abaixo disso consideramos que voce nao esta falando
  seguraAte: 0,        // mantem aberto ate este instante
  msSegurando: 260,    // quanto tempo o portao fica aberto depois da fala
};

function montarPortaoDeRuido(streamBruto) {
  try {
    const ctx = new AudioContext();
    const fonte = ctx.createMediaStreamSource(streamBruto);
    const analisador = ctx.createAnalyser();
    analisador.fftSize = 512;
    const ganho = ctx.createGain();
    const destino = ctx.createMediaStreamDestination();

    // microfone -> analisador -> ganho -> saida que vai pros amigos
    fonte.connect(analisador);
    analisador.connect(ganho);
    ganho.connect(destino);

    Object.assign(RUIDO, { ctx, fonte, analisador, ganho, destino });

    const amostras = new Float32Array(analisador.fftSize);
    RUIDO.timer = setInterval(() => {
      analisador.getFloatTimeDomainData(amostras);

      // volume = media quadratica (RMS). Serve melhor que o pico porque
      // um estalo isolado nao abre o portao.
      let soma = 0;
      for (let i = 0; i < amostras.length; i++) soma += amostras[i] * amostras[i];
      const volume = Math.sqrt(soma / amostras.length);

      const agora = performance.now();
      if (volume > RUIDO.corte) RUIDO.seguraAte = agora + RUIDO.msSegurando;
      const aberto = agora < RUIDO.seguraAte;

      if (estado.portaoLigado) {
        // setTargetAtTime faz a rampa suave; o 3o numero e a velocidade.
        // Abrir bem rapido (0.01), fechar devagar (0.12).
        ganho.gain.setTargetAtTime(aberto ? 1 : 0, ctx.currentTime, aberto ? 0.01 : 0.12);
      } else {
        ganho.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
      }

      atualizarMedidor(volume, aberto);
    }, 50);

    return destino.stream;
  } catch (e) {
    // Se o Web Audio falhar por qualquer motivo, melhor mandar o audio cru
    // do que ficar sem voz nenhuma.
    console.warn("portao de ruido indisponivel, usando audio direto", e);
    return streamBruto;
  }
}

function desmontarPortaoDeRuido() {
  clearInterval(RUIDO.timer);
  RUIDO.timer = null;
  if (RUIDO.ctx) { RUIDO.ctx.close().catch(() => {}); }
  Object.assign(RUIDO, { ctx: null, fonte: null, analisador: null,
                         ganho: null, destino: null });
  const barra = $("#medidor-barra");
  if (barra) barra.style.width = "0%";
}

function atualizarMedidor(volume, aberto) {
  const barra = $("#medidor-barra");
  // multiplicamos por 320 so pra barrinha ter um tamanho visivel
  if (barra) {
    barra.style.width = Math.min(100, volume * 320) + "%";
    barra.classList.toggle("cortado", estado.portaoLigado && !aberto);
  }
  const barraConfig = $("#medidor-config-barra");
  if (barraConfig) barraConfig.style.width = Math.min(100, volume * 320) + "%";
  if (estado.eu) atualizarVozFalando(estado.eu.id, volume > RUIDO.corte && !estado.mutado &&
    (!estado.pushToTalk || estado.microfonePressionado));
}

function alternarRuido() {
  if (!estado.meuAudio) { aviso("Voce nao esta numa chamada", "#f0b232"); return; }
  estado.portaoLigado = !estado.portaoLigado;
  $("#btn-ruido").classList.toggle("ativo", estado.portaoLigado);
  aviso(estado.portaoLigado ? "Supressao de ruido ligada" : "Supressao de ruido desligada");
}


/* ==========================================================================
   COMPARTILHAR TELA
   ========================================================================== */

function restricoesTela(chave = estado.qualidadeTela) {
  const perfil = PERFIS_TELA[chave];
  return {
    width: { ideal: perfil.largura, max: perfil.largura },
    height: { ideal: perfil.altura, max: perfil.altura },
    frameRate: { ideal: perfil.fps, max: perfil.fps },
  };
}

function restaurarQualidadeTela() {
  try {
    const salva = localStorage.getItem("codecom-qualidade-tela");
    if (Object.hasOwn(PERFIS_TELA, salva)) estado.qualidadeTela = salva;
  } catch {}
  $("#qualidade-tela").value = estado.qualidadeTela;
}

async function mudarQualidadeTela() {
  const seletor = $("#qualidade-tela");
  const chave = seletor.value;
  if (seletor.disabled || !Object.hasOwn(PERFIS_TELA, chave)) return;
  seletor.disabled = true;
  try {
    const track = estado.minhaTela?.getVideoTracks()[0];
    if (track) await track.applyConstraints(restricoesTela(chave));
    estado.qualidadeTela = chave;
    estado.bitrateTelaPeer = {};
    try { localStorage.setItem("codecom-qualidade-tela", chave); } catch {}
    await atualizarEnvioTela();
    atualizarStatusSomTela();
  } catch (erro) {
    seletor.value = estado.qualidadeTela;
    aviso("Nao foi possivel mudar a qualidade. Pare e compartilhe a tela novamente.", "#f0b232");
    console.warn("Falha ao mudar qualidade da captura", erro);
  } finally {
    seletor.disabled = false;
  }
}

async function alternarTela(superficie = null) {
  if (!estado.vozCanal) { aviso("Entre numa sala de voz primeiro", "#f0b232"); return; }
  if (estado.minhaTela) { pararDeCompartilhar(); return; }
  const botoes = [$("#btn-tela-janela"), $("#btn-tela-inteira")];
  if (botoes.some((botao) => botao.disabled)) return;
  const canal = estado.vozCanal;
  botoes.forEach((botao) => { botao.disabled = true; });
  $("#qualidade-tela").disabled = true;

  try {
    const suportesAudioProprio = navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio === true;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // displaySurface orienta o seletor nativo; a pessoa ainda escolhe a fonte final.
      video: { ...restricoesTela(), ...(superficie ? { displaySurface: superficie } : {}) },
      // audio: true faz o navegador oferecer a caixinha "compartilhar audio".
      // Desligamos os tratamentos de voz aqui de proposito: eles sao feitos
      // pra microfone e estragariam musica e som de jogo.
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        suppressLocalAudioPlayback: false,
        // Remove a voz recebida do Codecom da captura quando o navegador oferece esse filtro.
        ...(suportesAudioProprio ? { restrictOwnAudio: true } : {}),
      },
      systemAudio: "include",
      windowAudio: "window",
      selfBrowserSurface: "exclude",
    });
    // A pessoa pode sair da chamada enquanto escolhe a tela.
    if (estado.vozCanal !== canal) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    estado.minhaTela = stream;
    const audioCompartilhado = stream.getAudioTracks().find((t) => t.readyState === "live");
    const isolamentoAtivo = audioCompartilhado?.getSettings?.().restrictOwnAudio === true;
    // Não desabilite a faixa compartilhada: isso fazia a tela inteira ficar
    // muda em navegadores que não expõem getSettings().restrictOwnAudio.
    // O status avisa quando o navegador não consegue filtrar o retorno da call.
    estado.audioTelaSemFiltroEco = Boolean(audioCompartilhado && !isolamentoAtivo);
  } catch (erro) {
    aviso(erro.name === "NotAllowedError" ? "Compartilhamento cancelado ou sem permissao" :
      "Nao foi possivel capturar a tela neste navegador", "#f0b232");
    return;
  } finally {
    botoes.forEach((botao) => { botao.disabled = false; });
    $("#qualidade-tela").disabled = false;
  }

  const faixas = estado.minhaTela.getTracks();
  estado.minhaTela.getVideoTracks().forEach(t => { t.contentHint = "detail"; });

  // O navegador tem o proprio botao "parar de compartilhar". Quando a pessoa
  // usa ele, as faixas terminam e limpamos tudo do nosso lado tambem.
  estado.minhaTela.getVideoTracks().forEach((t) => { t.onended = pararDeCompartilhar; });
  estado.minhaTela.getAudioTracks().forEach((t) => {
    t.onended = atualizarStatusSomTela;
  });

  // Mandamos video E som. Adicionar faixa dispara o onnegotiationneeded de
  // cada conexao, e a negociacao educada cuida do resto.
  Object.values(estado.peers).forEach((pc) =>
    faixas.forEach((t) => pc.addTrack(t, estado.minhaTela)));
  atualizarEnvioTela();

  mostrarTela(estado.eu.id, estado.minhaTela, true);
  $("#btn-tela-janela").classList.add("escondido");
  $("#btn-tela-inteira").classList.add("escondido");
  $("#btn-parar-tela").classList.remove("escondido");

  // Marcar "compartilhar audio" e opcional e fica facil de esquecer.
  // Avisamos na hora, em vez de deixar a pessoa descobrir pelos amigos.
  atualizarStatusSomTela();
  if (estado.minhaTela.getAudioTracks().length) {
    if (estado.audioTelaSemFiltroEco) {
      aviso("Som da tela ativo; este navegador não filtra o retorno da call", "#f0b232", 5200);
    } else {
      aviso("Compartilhando tela com som");
    }
  } else {
    aviso("Tela sem som: marque 'Compartilhar áudio' ou 'Áudio do sistema' no seletor", "#f0b232", 5200);
  }
}

function atualizarStatusSomTela() {
  const status = $("#tela-som-status");
  const tela = estado.minhaTela;
  status.classList.toggle("escondido", !tela);
  if (!tela) { status.textContent = ""; return; }
  const comSom = tela.getAudioTracks().some((t) => t.readyState === "live" && t.enabled);
  status.classList.toggle("sem-som", !comSom);
  const perfil = PERFIS_TELA[estado.qualidadeTela];
  const superficie = tela.getVideoTracks()[0]?.getSettings?.().displaySurface;
  const nomeSuperficie = ({ browser: "Aba", window: "Janela", monitor: "Tela inteira" })[superficie] || "Tela";
  if (!comSom) {
    status.textContent = "Tela sem som. Marque Compartilhar áudio ou Áudio do sistema no seletor; a opção depende do navegador.";
  } else if (estado.audioTelaSemFiltroEco) {
    status.textContent = nomeSuperficie + " com som · o navegador não filtra o retorno do Codecom; outras pessoas podem ouvir o áudio da call junto.";
  } else {
    status.textContent = nomeSuperficie + " com som · perfil " + perfil.altura + "p/" + perfil.fps + " fps · retorno do Codecom filtrado";
  }
}

function pararDeCompartilhar() {
  if (!estado.minhaTela) return;

  // Tira as faixas da tela de cada conexao (isso tambem renegocia).
  // Comparamos por id de faixa, e nao por kind: se filtrassemos "todo audio",
  // o microfone ia junto e a pessoa ficava muda ao parar de transmitir.
  const daTela = new Set(estado.minhaTela.getTracks().map((t) => t.id));
  Object.values(estado.peers).forEach((pc) => {
    pc.getSenders()
      .filter((s) => s.track && daTela.has(s.track.id))
      .forEach((s) => { try { pc.removeTrack(s); } catch {} });
  });

  estado.minhaTela.getTracks().forEach((t) => t.stop());
  estado.minhaTela = null;
  estado.audioTelaSemFiltroEco = false;
  estado.bitrateTelaPeer = {};
  atualizarStatusSomTela();
  tirarTela(estado.eu.id);

  $("#btn-tela-janela").classList.remove("escondido");
  $("#btn-tela-inteira").classList.remove("escondido");
  $("#btn-parar-tela").classList.add("escondido");
}

function nomeDe(userId) {
  if (userId === estado.eu.id) return estado.eu.display_name;
  const p = estado.membros.find((m) => m.id === userId) ||
            estado.usuarios.find((u) => u.id === userId) ||
            estado.amigos.amigos.find((a) => a.id === userId);
  return p ? p.display_name : "alguem";
}

function mostrarTela(userId, stream, souEu = false) {
  const area = $("#area-telas");
  const visor = $("#visor");
  const novo = !document.getElementById("tela-" + userId);

  let item = document.getElementById("tela-" + userId);
  if (!item) {
    item = el("div", "tela-item");
    item.id = "tela-" + userId;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;      // sem isso o iPhone abre o video em cheio sozinho
    video.muted = true;            // a faixa e so imagem; o som vem pelo audio da chamada
    // tocar no video abre em tela cheia
    video.onclick = () => video.requestFullscreen?.();
    item.appendChild(video);

    item.appendChild(el("div", "tela-dono",
      souEu ? "Sua tela" : "Tela de " + nomeDe(userId)));
    if (!souEu) {
      const volume = el("button", "tela-volume", "🔊 Volume");
      volume.title = "Ajustar volume de " + nomeDe(userId);
      volume.onclick = () => abrirVolume(userId);
      item.appendChild(volume);
    }

    area.appendChild(item);
  }
  item.querySelector("video").srcObject = stream;
  // guardamos qual stream e a tela dessa pessoa, pra saber qual <audio>
  // desligar quando ela parar de transmitir
  estado.telaDe[userId] = stream.id;
  // Audio pode chegar antes da faixa de video: reclassifica sem trocar o player.
  for (const audio of $("#audios").querySelectorAll("audio")) {
    if (audio.dataset.usuario === String(userId) && audio.dataset.stream === stream.id) {
      audio.dataset.tipo = "tela";
      aplicarVolumeAudio(audio);
    }
  }

  visor.classList.remove("escondido");
  // se alguem chegou transmitindo, abrimos o visor mesmo que estivesse recolhido
  if (novo && !souEu) {
    visor.classList.remove("recolhido");
    aviso(nomeDe(userId) + " esta transmitindo a tela", "#5865f2");
  }
  atualizarTituloVisor();
}

function tirarTela(userId) {
  const item = document.getElementById("tela-" + userId);
  if (item) {
    // soltar o stream evita o video continuar segurando memoria
    const v = item.querySelector("video");
    if (v) v.srcObject = null;
    item.remove();
  }

  // desliga tambem o som daquela tela (o microfone da pessoa continua)
  const streamId = estado.telaDe[userId];
  if (streamId) {
    const audio = document.getElementById(`audio-${userId}-${streamId}`);
    if (audio) removerAudioRemoto(audio);
    delete estado.telaDe[userId];
  }
  if (!$("#area-telas").children.length) {
    $("#visor").classList.add("escondido");
  }
  atualizarTituloVisor();
  atualizarBotaoSom();
}

function atualizarTituloVisor() {
  const itens = [...$("#area-telas").children];
  const nomes = itens.map((i) => i.querySelector(".tela-dono").textContent);
  $("#visor-titulo").textContent =
    nomes.length === 1 ? nomes[0] : `${nomes.length} transmissoes`;
}

function alternarVisor() {
  const visor = $("#visor");
  visor.classList.toggle("recolhido");
  $("#visor-recolher").textContent = visor.classList.contains("recolhido") ? "+" : "–";
}


/* ==========================================================================
   PERFIL
   ========================================================================== */

async function verPerfil(userId) {
  if (userId === estado.eu.id) { abrirEditarPerfil(); return; }

  let dados;
  try {
    dados = await api("/api/users/" + userId);
  } catch (e) {
    aviso(e.message, "#f23f43");
    return;
  }
  const u = dados.user;

  $("#perfil-capa").style.background = u.avatar_color;
  pintarAvatar($("#perfil-avatar"), u);
  $("#perfil-nome").textContent = u.display_name;
  $("#perfil-user").textContent = "@" + u.username + (dados.online ? "  •  online" : "");
  $("#perfil-status").textContent = u.status_texto || "";

  $("#perfil-bio-bloco").classList.toggle("escondido", !u.bio);
  $("#perfil-bio").textContent = u.bio || "";
  $("#perfil-desde").textContent = new Date(u.created_at).toLocaleDateString("pt-BR",
    { day: "2-digit", month: "long", year: "numeric" });

  const comuns = dados.servidores_em_comum;
  $("#perfil-comuns-bloco").classList.toggle("escondido", !comuns.length);
  const caixaComuns = $("#perfil-comuns");
  caixaComuns.innerHTML = "";
  comuns.forEach((s) => {
    const item = el("div", "comum-item", iniciais(s.name));
    item.style.background = s.icon_color;
    item.title = s.name;
    caixaComuns.appendChild(item);
  });

  // Os botoes mudam conforme a situacao da amizade
  const botoes = $("#perfil-botoes");
  botoes.innerHTML = "";

  const msg = el("button", "btn-principal", "Mandar mensagem");
  msg.onclick = () => { fecharPerfil(); iniciarDM(u.id, u.display_name); };
  botoes.appendChild(msg);
  const volume = el("button", "btn-secundario", "🔊 Ajustar volume");
  volume.onclick = () => { fecharPerfil(); abrirVolume(u.id); };
  botoes.appendChild(volume);

  const acoes = {
    nenhuma: [["Adicionar amigo", "btn-secundario", async () => {
      await api("/api/friends/" + u.id, { method: "POST" });
      aviso("Pedido enviado!"); verPerfil(u.id); recarregarAmigos();
    }]],
    enviei: [["Cancelar pedido", "btn-secundario", async () => {
      await api("/api/friends/" + u.id, { method: "DELETE" });
      aviso("Pedido cancelado"); verPerfil(u.id); recarregarAmigos();
    }]],
    recebi: [["Aceitar pedido", "btn-principal", async () => {
      await api(`/api/friends/${u.id}/aceitar`, { method: "POST" });
      aviso("Voces agora sao amigos!"); verPerfil(u.id); recarregarAmigos();
    }], ["Recusar", "btn-perigo", async () => {
      await api("/api/friends/" + u.id, { method: "DELETE" });
      aviso("Pedido recusado"); verPerfil(u.id); recarregarAmigos();
    }]],
    amigos: [["Desfazer amizade", "btn-perigo", async () => {
      await api("/api/friends/" + u.id, { method: "DELETE" });
      aviso("Amizade desfeita"); verPerfil(u.id); recarregarAmigos();
    }]],
  };

  (acoes[dados.amizade] || []).forEach(([texto, classe, acao]) => {
    const b = el("button", classe, texto);
    b.onclick = async () => {
      try { await acao(); } catch (e) { aviso(e.message, "#f23f43"); }
    };
    botoes.appendChild(b);
  });

  estado.perfilAberto = userId;
  $("#modal-perfil").classList.remove("escondido");
}

function fecharPerfil() {
  estado.perfilAberto = null;
  $("#modal-perfil").classList.add("escondido");
}

/** Se o cartao de perfil estiver aberto, redesenha com os dados novos.
 *  Sem isso ele continua mostrando "Cancelar pedido" depois de a pessoa
 *  ja ter aceitado voce do outro lado. */
function atualizarPerfilAberto(userId) {
  if (estado.perfilAberto && (!userId || estado.perfilAberto === userId)) {
    verPerfil(estado.perfilAberto);
  }
}


/* ==========================================================================
   EDITAR MEU PERFIL
   ========================================================================== */

const PALETA = ["#5865F2", "#57F287", "#FEE75C", "#EB459E", "#ED4245",
                "#3BA55D", "#FAA81A", "#9B59B6", "#1ABC9C", "#E91E63"];

function abrirEditarPerfil() {
  const eu = estado.eu;
  $("#ed-nome").value = eu.display_name;
  $("#ed-status").value = eu.status_texto || "";
  $("#ed-bio").value = eu.bio || "";
  $("#editar-erro").textContent = "";
  $("#ed-senha-atual").value = "";
  $("#ed-senha-nova").value = "";
  estado.corEscolhida = eu.avatar_color;

  pintarAvatar($("#editar-avatar"), eu);

  const paleta = $("#ed-cores");
  paleta.innerHTML = "";
  PALETA.forEach((cor) => {
    const bolinha = el("div", "cor-opcao");
    bolinha.style.background = cor;
    if (cor.toLowerCase() === (eu.avatar_color || "").toLowerCase()) {
      bolinha.classList.add("escolhida");
    }
    bolinha.onclick = () => {
      estado.corEscolhida = cor;
      [...paleta.children].forEach((c) => c.classList.remove("escolhida"));
      bolinha.classList.add("escolhida");
      // previa na hora, sem precisar salvar
      pintarAvatar($("#editar-avatar"), { ...estado.eu, avatar_color: cor });
    };
    paleta.appendChild(bolinha);
  });

  $("#modal-editar").classList.remove("escondido");
}

async function salvarPerfil() {
  try {
    const r = await api("/api/me", {
      method: "PATCH",
      body: {
        display_name: $("#ed-nome").value,
        status_texto: $("#ed-status").value,
        bio: $("#ed-bio").value,
        avatar_color: estado.corEscolhida,
      },
    });
    aplicarMeuPerfil(r.user);
    $("#modal-editar").classList.add("escondido");
    aviso("Perfil salvo!");
  } catch (e) {
    $("#editar-erro").textContent = e.message;
  }
}

async function enviarAvatar(arquivo) {
  if (!arquivo) return;
  if (arquivo.size > 4 * 1024 * 1024) {
    $("#editar-erro").textContent = "A imagem precisa ter menos de 4 MB";
    return;
  }
  const fd = new FormData();
  fd.append("file", arquivo);
  try {
    const r = await api("/api/me/avatar", { method: "POST", body: fd });
    aplicarMeuPerfil(r.user);
    pintarAvatar($("#editar-avatar"), r.user);
    aviso("Foto atualizada!");
  } catch (e) {
    $("#editar-erro").textContent = e.message;
  }
}

async function removerAvatar() {
  try {
    const r = await api("/api/me", { method: "PATCH", body: { avatar_url: "" } });
    aplicarMeuPerfil(r.user);
    pintarAvatar($("#editar-avatar"), r.user);
  } catch (e) {
    $("#editar-erro").textContent = e.message;
  }
}

async function trocarSenha() {
  const atual = $("#ed-senha-atual").value;
  const nova = $("#ed-senha-nova").value;
  if (!atual || !nova) {
    $("#editar-erro").textContent = "Preencha a senha atual e a nova";
    return;
  }
  try {
    const r = await api("/api/me/senha", { method: "POST", body: { atual, nova } });
    // O servidor derruba as sessoes antigas por seguranca e devolve uma nova
    estado.token = r.token;
    localStorage.setItem("token", r.token);
    $("#ed-senha-atual").value = "";
    $("#ed-senha-nova").value = "";
    aviso("Senha trocada! Os outros aparelhos foram desconectados.");
  } catch (e) {
    $("#editar-erro").textContent = e.message;
  }
}

/** Atualiza meu perfil no estado e em tudo que aparece na tela. */
function aplicarMeuPerfil(user) {
  estado.eu = user;
  pintarAvatar($("#meu-avatar"), user);
  $("#meu-nome").textContent = user.display_name;
  $("#meu-status").textContent = user.status_texto || "online";
  desenharMembros();
}


/* ==========================================================================
   AMIGOS
   ========================================================================== */

async function recarregarAmigos() {
  try {
    estado.amigos = await api("/api/friends");
  } catch {
    estado.amigos = { amigos: [], recebidos: [], enviados: [] };
  }
  if (!estado.servidorAtual) abrirHome();
}

/** Desenha as secoes de amigos na barra lateral da tela inicial. */
function desenharAmigos(lista) {
  const a = estado.amigos || { amigos: [], recebidos: [], enviados: [] };

  if (a.recebidos.length) {
    const titulo = el("div", "grupo-titulo");
    titulo.appendChild(el("span", null, "Pedidos de amizade"));
    titulo.appendChild(el("span", "selo", String(a.recebidos.length)));
    lista.appendChild(titulo);

    a.recebidos.forEach((p) => {
      const linha = el("div", "pedido");
      linha.appendChild(avatarDe(p, 26));
      linha.appendChild(el("span", "nome-pedido", p.display_name));

      const sim = el("button", "mini-acao sim", "✓");
      sim.title = "Aceitar";
      sim.onclick = async (ev) => {
        ev.stopPropagation();
        await api(`/api/friends/${p.id}/aceitar`, { method: "POST" });
        aviso(`Voce e ${p.display_name} agora sao amigos!`);
        recarregarAmigos();
      };

      const nao = el("button", "mini-acao nao", "✕");
      nao.title = "Recusar";
      nao.onclick = async (ev) => {
        ev.stopPropagation();
        await api("/api/friends/" + p.id, { method: "DELETE" });
        recarregarAmigos();
      };

      linha.appendChild(sim);
      linha.appendChild(nao);
      lista.appendChild(linha);
    });
  }

  if (a.amigos.length) {
    lista.appendChild(el("div", "grupo-titulo", `Amigos - ${a.amigos.length}`));
    a.amigos.forEach((p) => {
      const linha = el("div", "canal");
      const wrap = el("div", "avatar-wrap");
      wrap.appendChild(avatarDe(p, 26));
      const ponto = el("div", "ponto-status");
      if (estado.online.has(p.id)) ponto.classList.add("on");
      wrap.appendChild(ponto);
      linha.appendChild(wrap);
      linha.appendChild(el("span", "nome", p.display_name));
      linha.onclick = () => verPerfil(p.id);
      lista.appendChild(linha);
    });
  }

  if (a.enviados.length) {
    lista.appendChild(el("div", "grupo-titulo", "Pedidos enviados"));
    a.enviados.forEach((p) => {
      const linha = el("div", "canal");
      linha.appendChild(avatarDe(p, 26));
      linha.appendChild(el("span", "nome", p.display_name));
      linha.onclick = () => verPerfil(p.id);
      lista.appendChild(linha);
    });
  }
}


/* ==========================================================================
   LIGANDO OS BOTOES
   ========================================================================== */

$("#btn-entrar").onclick = () => entrar(false);
$("#btn-criar").onclick  = () => entrar(true);
$("#in-pass").onkeydown  = (e) => { if (e.key === "Enter") entrar(false); };
$("#in-user").onkeydown  = (e) => { if (e.key === "Enter") $("#in-pass").focus(); };

$("#btn-voltar").onclick         = voltarParaLista;
$("#btn-membros").onclick        = () => $("#painel-membros").classList.toggle("aberto");
$("#btn-config").onclick          = abrirConfiguracoes;
$("#btn-instalar-login").onclick = instalarCodecom;
$("#btn-instalar-config").onclick = instalarCodecom;
$("#btn-home").onclick           = () => { voltarParaLista(); abrirHome(); };
$("#btn-novo-servidor").onclick  = novoServidor;
$("#btn-convite").onclick        = copiarConvite;
$("#btn-sair").onclick           = sairDaConta;
$("#btn-mudo").onclick           = alternarMudo;
$("#btn-mudo-call").onclick      = alternarMudo;
$("#btn-so-ouvir").onclick       = ouvirSemMicrofone;
$("#btn-sair-voz").onclick       = sairDaVoz;
$("#form-msg").onsubmit    = enviarMensagem;
$("#input-msg").oninput    = aoDigitar;
$("#mensagens").addEventListener("scroll", () => {
  if ($("#mensagens").scrollTop < 50) carregarMensagensAntigas();
}, { passive: true });
// Enter envia. Nao dependemos do "submit implicito" do form: em alguns
// navegadores/contextos ele nao dispara, e aqui o envio e o coracao do app.
$("#input-msg").onkeydown  = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarMensagem(e); }
};
$("#btn-anexo").onclick    = () => $("#input-arquivo").click();
$("#input-arquivo").onchange = (e) => escolherArquivo(e.target.files[0]);
$("#previa-cancelar").onclick = limparArquivo;
$("#resposta-cancelar").onclick = cancelarResposta;
$("#busca-mensagens").onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); buscarMensagens(false); }
  if (e.key === "Escape") { e.target.value = ""; buscarMensagens(false); }
};
$("#btn-fixadas").onclick = () => {
  if (estado.filtroMensagens?.fixadas) {
    estado.filtroMensagens = null;
    $("#btn-fixadas").classList.remove("ativo");
    recarregarCanalAtual();
  } else buscarMensagens(true);
};

// voz: tela e supressao de ruido
$("#btn-tela-janela").onclick = () => alternarTela("window");
$("#btn-tela-inteira").onclick = () => alternarTela("monitor");
$("#btn-parar-tela").onclick = pararDeCompartilhar;
restaurarQualidadeTela();
$("#qualidade-tela").onchange = mudarQualidadeTela;
$("#visor-recolher").onclick = alternarVisor;
$("#btn-ruido").onclick  = alternarRuido;
$("#btn-liberar-som").onclick = liberarSom;
$("#config-fechar").onclick = () => $("#dialog-config").close();
$("#tema-app").onchange = (e) => aplicarTema(e.target.value);
$("#dispositivo-microfone").onchange = (e) => trocarMicrofone(e.target.value);
$("#dispositivo-saida").onchange = (e) => trocarSaidaAudio(e.target.value);
$("#btn-testar-saida").onclick = testarSaidaAudio;
$("#atalho-ptt").onchange = atualizarPushToTalk;
$("#sons-call").onchange = (e) => {
  estado.sonsCall = e.target.checked;
  try { localStorage.setItem("codecom-sons", String(estado.sonsCall)); } catch {}
};
navigator.mediaDevices?.addEventListener?.("devicechange", atualizarDispositivosAudio);
$("#cancelar-edicao-mensagem").onclick = () => $("#dialog-editar-mensagem").close();
$("#salvar-edicao-mensagem").onclick = () => {
  const messageId = Number($("#dialog-editar-mensagem").dataset.messageId);
  const content = $("#texto-editar-mensagem").value.trim();
  if (!content) return aviso("A mensagem não pode ficar vazia", "#f0b232");
  mandarWS({ type: "edit", message_id: messageId, content });
  $("#dialog-editar-mensagem").close();
};
$("#fechar-foto").onclick = () => $("#visualizador-foto").close();
$("#visualizador-foto").onclick = (e) => { if (e.target.id === "visualizador-foto") $("#visualizador-foto").close(); };
$("#texto-editar-mensagem").onkeydown = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("#salvar-edicao-mensagem").click();
};
$("#volume-fechar").onclick = () => $("#modal-volume").close();
for (const tipo of ["voz", "tela"]) {
  $("#volume-" + tipo).oninput = (evento) => {
    const valor = salvarVolume(estado.volumeUsuario, tipo, evento.target.value);
    $("#volume-" + tipo + "-valor").textContent = valor + "%";
  };
}
$("#volume-restaurar").onclick = () => {
  for (const tipo of ["voz", "tela"]) {
    salvarVolume(estado.volumeUsuario, tipo, 100);
    $("#volume-" + tipo).value = 100;
    $("#volume-" + tipo + "-valor").textContent = "100%";
  }
};

// perfil
$("#btn-perfil").onclick      = abrirEditarPerfil;
$("#meu-bloco").onclick       = abrirEditarPerfil;
$("#perfil-fechar").onclick   = fecharPerfil;
$("#modal-perfil").onclick    = (e) => { if (e.target.id === "modal-perfil") fecharPerfil(); };
$("#editar-cancelar").onclick = () => $("#modal-editar").classList.add("escondido");
$("#editar-salvar").onclick   = salvarPerfil;
$("#btn-trocar-foto").onclick = () => $("#input-avatar").click();
$("#btn-tirar-foto").onclick  = removerAvatar;
$("#input-avatar").onchange   = (e) => enviarAvatar(e.target.files[0]);
$("#btn-trocar-senha").onclick = trocarSenha;

$("#modal-cancelar").onclick = () => $("#modal").classList.add("escondido");
$("#modal-input").onkeydown  = (e) => { if (e.key === "Enter") $("#modal-ok").click(); };
document.onkeydown = (e) => {
  if (e.key === "Escape") {
    ["#modal", "#modal-perfil", "#modal-editar"].forEach((id) => $(id).classList.add("escondido"));
  }
};

function campoEditavel(elemento) {
  return elemento?.matches?.("input, textarea, select, [contenteditable='true']");
}
document.addEventListener("keydown", (e) => {
  if (!estado.pushToTalk || !estado.vozCanal || campoEditavel(e.target) || e.code !== "KeyV" || e.repeat) return;
  e.preventDefault();
  estado.microfonePressionado = true;
  aplicarEstadoMicrofone();
});
document.addEventListener("keyup", (e) => {
  if (!estado.pushToTalk || e.code !== "KeyV" || !estado.microfonePressionado) return;
  estado.microfonePressionado = false;
  aplicarEstadoMicrofone();
});
window.addEventListener("blur", () => {
  if (estado.microfonePressionado) { estado.microfonePressionado = false; aplicarEstadoMicrofone(); }
});

// arrastar arquivo pra cima da janela
document.ondragover = (e) => e.preventDefault();
document.ondrop = (e) => { e.preventDefault(); escolherArquivo(e.dataTransfer.files[0]); };
window.addEventListener("resize", () => {
  if (estado.vozCanal && ehCelular()) mostrarChatNoCelular();
});

// colar imagem (Ctrl+V) direto no chat
document.onpaste = (e) => {
  if (campoEditavel(e.target)) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) escolherArquivo(item.getAsFile());
};

aplicarTema(estado.tema);
prepararInstalacao();

// desliga a chamada direito se fechar a aba
window.onbeforeunload = () => { if (estado.vozCanal) sairDaVoz(); };


/* ==========================================================================
   AUTO-LOGIN: se ja tem token salvo, entra direto
   ========================================================================== */
if (estado.token) {
  iniciarApp().catch(() => {
    localStorage.removeItem("token");
    estado.token = null;
  });
}

// Descobre se este servidor exige senha de convite pra criar conta
api("/api/config")
  .then((c) => { estado.precisaConvite = c.precisa_convite; })
  .catch(() => {});
