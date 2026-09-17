const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Executa as funcoes reais do cliente com os dispositivos e o DOM simulados.
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');

function setup() {
  let sequence = 0;
  class Track {
    constructor(kind) { this.kind = kind; this.id = `track-${++sequence}`; this.readyState = 'live'; this.enabled = true; }
    stop() { this.readyState = 'ended'; }
    end() { this.stop(); this.onended?.(); }
    getSettings() { return this.kind === 'video' ? (this.settings || { width: 1920, height: 1080 }) : { restrictOwnAudio: true }; }
    async applyConstraints(c) { this.settings = { width: c.width.ideal, height: c.height.ideal, frameRate: c.frameRate.ideal }; }
  }
  class Stream {
    constructor(tracks) { this.tracks = [...tracks]; this.id = `stream-${++sequence}`; this.listeners = []; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    addEventListener(type, fn) { if (type === 'removetrack') this.listeners.push(fn); }
    removeTrack(track) {
      this.tracks = this.tracks.filter(t => t !== track);
      this.listeners.forEach(fn => fn({ track }));
    }
  }
  const all = [];
  let blockPlayback = false;
  let restrictOwnAudioSupported = true;
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.dataset = {}; this.isConnected = false;
      const classes = new Set();
      this.classList = {
        add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle(c, value = !classes.has(c)) { value ? classes.add(c) : classes.delete(c); },
      };
      this.style = {};
      all.push(this);
    }
    appendChild(child) { child.parent = this; child.isConnected = true; this.children.push(child); }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
    querySelector(selector) { return this.children.find(c => selector.startsWith('.') ? c.className === selector.slice(1) : c.tag === selector); }
    querySelectorAll(selector) { return this.children.filter(c => c.tag === 'audio' && (!selector.includes('[data-bloqueado]') || c.dataset.bloqueado)); }
    async play() {
      this.playCalls = (this.playCalls || 0) + 1;
      if (blockPlayback) throw Object.assign(new Error('Blocked'), { name: 'NotAllowedError' });
      this.played = true;
    }
  }
  const roots = {};
  for (const id of ['audios', 'btn-liberar-som', 'btn-tela-janela', 'btn-tela-inteira', 'btn-parar-tela',
    'qualidade-tela', 'tela-som-status', 'area-telas', 'visor', 'visor-titulo', 'aviso']) {
    roots[id] = new Element('div'); roots[id].id = id; roots[id].isConnected = true;
  }
  const document = {
    createElement: tag => new Element(tag),
    getElementById: id => all.find(e => e.isConnected && e.id === id),
    querySelector: selector => roots[selector.slice(1)],
    querySelectorAll: selector => all.filter(e => e.isConnected && e.id?.startsWith(selector.match(/\[id\^="(.*)"\]/)[1])),
  };
  class Peer {
    constructor() { this.senders = []; }
    addTrack(track, stream) {
      const sender = { track, stream, params: { encodings: [{}] },
        getParameters() { return structuredClone(this.params); },
        async setParameters(params) { this.params = params; },
      };
      this.senders.push(sender); return sender;
    }
    getSenders() { return this.senders; }
    removeTrack(sender) { this.senders = this.senders.filter(s => s !== sender); }
    close() {}
  }
  const capture = new Stream([new Track('video'), new Track('audio')]);
  let options;
  const storage = new Map();
  const context = vm.createContext({
    document, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, console,
    URL,
    setTimeout: () => 1, clearTimeout() {}, MediaStream: Stream, RTCPeerConnection: Peer,
    navigator: { mediaDevices: {
      getSupportedConstraints: () => ({ restrictOwnAudio: restrictOwnAudioSupported }),
      getDisplayMedia: async opts => { options = opts; return capture; },
    } },
  });
  const cutoff = source.lastIndexOf('/* ==========================================================================', source.indexOf('   LIGANDO OS BOTOES'));
  vm.runInContext(source.slice(0, cutoff) + '\nglobalThis.state = estado;', context);
  context.state.eu = { id: 1, display_name: 'Eu' };
  context.state.vozCanal = 7;
  context.state.meuAudio = new Stream([new Track('audio')]);
  return { context, roots, capture, Track, Stream, storage, options: () => options,
    block: value => { blockPlayback = value; }, supportOwnAudioFilter: value => { restrictOwnAudioSupported = value; } };
}

test('envia imagem e som a participantes atuais e a quem entra depois; parar preserva microfone', async () => {
  const app = setup();
  const first = app.context.criarLigacao(2);
  await app.context.alternarTela('window');
  const later = app.context.criarLigacao(3);
  for (const peer of [first, later]) {
    assert.equal(peer.getSenders().filter(s => s.track.kind === 'audio').length, 2);
    assert.equal(peer.getSenders().filter(s => s.track.kind === 'video').length, 1);
  }
  assert.equal(app.options().systemAudio, 'include');
  assert.equal(app.options().audio.suppressLocalAudioPlayback, false);
  assert.equal(app.options().audio.restrictOwnAudio, true);
  assert.equal(app.capture.getAudioTracks()[0].enabled, true);
  assert.equal(app.options().video.displaySurface, 'window');
  assert.equal(app.roots['btn-parar-tela'].classList.contains('escondido'), false);
  app.context.pararDeCompartilhar();
  for (const peer of [first, later]) {
    assert.equal(peer.getSenders().length, 1);
    assert.equal(peer.getSenders()[0].track, app.context.state.meuAudio.getAudioTracks()[0]);
  }
  assert.ok(app.capture.getTracks().every(t => t.readyState === 'ended'));
  assert.equal(app.roots['btn-tela-janela'].classList.contains('escondido'), false);
  assert.ok(app.roots['tela-som-status'].classList.contains('escondido'));
});

test('mantém o áudio da tela ativo quando o navegador não oferece filtro contra eco', async () => {
  const app = setup();
  app.supportOwnAudioFilter(false);
  app.capture.getAudioTracks()[0].getSettings = () => ({ restrictOwnAudio: false });
  const peer = app.context.criarLigacao(2);
  const mic = new app.Stream([new app.Track('audio')]);
  peer.ontrack({ track: mic.getAudioTracks()[0], streams: [mic] });
  await new Promise(setImmediate);
  const voz = app.roots.audios.children[0];
  assert.equal(voz.muted, false);

  await app.context.alternarTela('monitor');
  assert.equal(app.options().audio.restrictOwnAudio, undefined);
  assert.equal(app.context.state.audioTelaSemFiltroEco, true);
  assert.equal(app.capture.getAudioTracks()[0].enabled, true);
  const faixasDeAudioEnviadas = peer.getSenders().filter(sender => sender.track?.kind === 'audio');
  assert.equal(faixasDeAudioEnviadas.length, 2);
  assert.ok(faixasDeAudioEnviadas.some(sender => sender.track === app.context.state.meuAudio.getAudioTracks()[0]));
  assert.equal(app.context.state.meuAudio.getAudioTracks()[0].enabled, true);
  assert.equal(voz.muted, false);
  assert.match(app.roots['tela-som-status'].textContent, /com som.*não filtra o retorno do Codecom/);

  app.context.pararDeCompartilhar();
  assert.equal(app.context.state.audioTelaSemFiltroEco, false);
  assert.equal(voz.muted, false);
});

test('reproduz microfone e som da tela em players separados e libera autoplay bloqueado', async () => {
  const app = setup();
  const peer = app.context.criarLigacao(2);
  const mic = new app.Stream([new app.Track('audio')]);
  app.block(true);
  peer.ontrack({ track: mic.getAudioTracks()[0], streams: [mic] });
  peer.ontrack({ track: app.capture.getAudioTracks()[0], streams: [app.capture] });
  await new Promise(setImmediate);
  const players = app.roots.audios.children;
  assert.equal(players.length, 2);
  assert.ok(players.every(p => p.srcObject.getVideoTracks().length === 0));
  assert.equal(app.roots['btn-liberar-som'].classList.contains('escondido'), false);
  app.block(false);
  app.context.liberarSom();
  await new Promise(setImmediate);
  assert.ok(players.every(p => p.played && p.playCalls === 2));
  assert.ok(app.roots['btn-liberar-som'].classList.contains('escondido'));
});

test('remover somente audio remoto mantem o video; remover video limpa o visor', async () => {
  const app = setup();
  const peer = app.context.criarLigacao(2);
  peer.ontrack({ track: app.capture.getVideoTracks()[0], streams: [app.capture] });
  peer.ontrack({ track: app.capture.getAudioTracks()[0], streams: [app.capture] });
  await new Promise(setImmediate);
  app.capture.removeTrack(app.capture.getAudioTracks()[0]);
  assert.equal(app.roots.audios.children.length, 0);
  assert.equal(app.roots['area-telas'].children.length, 1);
  app.capture.removeTrack(app.capture.getVideoTracks()[0]);
  assert.equal(app.roots['area-telas'].children.length, 0);
});

test('captura sem audio mostra orientacao persistente', async () => {
  const app = setup();
  app.capture.removeTrack(app.capture.getAudioTracks()[0]);
  await app.context.alternarTela();
  assert.match(app.roots['tela-som-status'].textContent, /Tela sem som/);
  assert.ok(app.roots['tela-som-status'].classList.contains('sem-som'));
  assert.equal(app.roots['tela-som-status'].classList.contains('escondido'), false);
});

test('fim do audio local avisa sem encerrar imagem; fim do video encerra captura', async () => {
  const app = setup();
  await app.context.alternarTela();
  app.capture.getAudioTracks()[0].end();
  assert.equal(app.context.state.minhaTela, app.capture);
  assert.match(app.roots['tela-som-status'].textContent, /Tela sem som/);
  app.capture.getVideoTracks()[0].end();
  assert.equal(app.context.state.minhaTela, null);
});

test('sair durante o seletor encerra as faixas obtidas e libera o botao', async () => {
  const app = setup();
  const pending = app.context.alternarTela();
  app.context.state.vozCanal = null;
  await pending;
  assert.equal(app.context.state.minhaTela, null);
  assert.ok(app.capture.getTracks().every(t => t.readyState === 'ended'));
  assert.equal(app.roots['btn-tela-janela'].disabled, false);
  assert.equal(app.roots['btn-tela-inteira'].disabled, false);
});

test('cancelamento libera o botao para uma nova tentativa', async () => {
  const app = setup();
  app.context.navigator.mediaDevices.getDisplayMedia = async () => {
    throw Object.assign(new Error('Cancelado'), { name: 'NotAllowedError' });
  };
  await app.context.alternarTela();
  assert.equal(app.context.state.minhaTela, null);
  assert.equal(app.roots['btn-tela-janela'].disabled, false);
  assert.equal(app.roots['btn-tela-inteira'].disabled, false);
  assert.match(app.roots.aviso.textContent, /cancelado/);
});

test('preserva resolucao e bitrate escolhidos mesmo com varios espectadores', async () => {
  const app = setup();
  await app.context.alternarTela();
  for (const id of [2, 3, 4, 5, 6]) app.context.criarLigacao(id);
  await Promise.all(Object.values(app.context.state.peers).map(p => p.ajusteTela));
  const sender = app.context.state.peers[2].getSenders().find(s => s.track.kind === 'video');
  assert.equal(sender.params.encodings[0].maxBitrate, 8000000);
  assert.equal(sender.params.encodings[0].scaleResolutionDownBy, 1);
  assert.equal(sender.params.encodings[0].maxFramerate, 30);
  assert.equal(sender.params.degradationPreference, 'maintain-resolution');
  for (const id of [3, 4, 5, 6]) app.context.fecharLigacao(id);
  await app.context.state.peers[2].ajusteTela;
  assert.equal(sender.params.encodings[0].maxBitrate, 8000000);
  assert.equal(sender.params.encodings[0].scaleResolutionDownBy, 1);
  assert.equal(app.options().video.width.max, 1920);
  assert.equal(app.options().video.frameRate.ideal, 30);
});

test('adapta bitrate por espectador com rede ruim e recupera quando estabiliza', async () => {
  const app = setup();
  app.context.state.qualidadeTela = '1080-60';
  await app.context.alternarTela();
  const peer = app.context.criarLigacao(2);
  await peer.ajusteTela;
  const sender = peer.getSenders().find(s => s.track.kind === 'video');
  assert.equal(sender.params.encodings[0].maxBitrate, 12000000);
  assert.equal(sender.params.encodings[0].maxFramerate, 60);

  app.context.ajustarQualidadeAdaptativa(2, 0.7, 0.1);
  await peer.ajusteTela;
  assert.equal(sender.params.encodings[0].maxBitrate, 12000000, 'espera uma segunda medição antes de reduzir');
  app.context.ajustarQualidadeAdaptativa(2, 0.7, 0.1);
  await peer.ajusteTela;
  assert.equal(sender.params.encodings[0].maxBitrate, 9360000);
  assert.equal(sender.params.encodings[0].maxFramerate, 30);

  for (let i = 0; i < 5; i++) app.context.ajustarQualidadeAdaptativa(2, 0.08, 0);
  await peer.ajusteTela;
  assert.equal(sender.params.encodings[0].maxBitrate, 10483200);
  assert.equal(sender.params.encodings[0].maxFramerate, 36);
});

test('alterna os quatro perfis ao vivo, aplica a novos espectadores e salva a escolha', async () => {
  const app = setup();
  const peer = app.context.criarLigacao(2);
  await app.context.alternarTela();
  const mic = peer.getSenders().find(s => s.track.kind === 'audio');
  for (const [key, width, height, fps, bitrate] of [
    ['720-30', 1280, 720, 30, 4000000], ['720-60', 1280, 720, 60, 6000000],
    ['1080-30', 1920, 1080, 30, 8000000], ['1080-60', 1920, 1080, 60, 12000000],
  ]) {
    app.roots['qualidade-tela'].value = key;
    await app.context.mudarQualidadeTela();
    const later = app.context.criarLigacao(3);
    await later.ajusteTela;
    for (const p of [peer, later]) {
      const sender = p.getSenders().find(s => s.track.kind === 'video');
      assert.equal(sender.params.encodings[0].maxBitrate, bitrate);
      assert.equal(sender.params.encodings[0].maxFramerate, fps);
      assert.equal(sender.params.encodings[0].scaleResolutionDownBy, 1);
    }
    assert.deepEqual(app.capture.getVideoTracks()[0].getSettings(), { width, height, frameRate: fps });
    assert.equal(app.storage.get('codecom-qualidade-tela'), key);
    assert.equal(peer.getSenders().find(s => s.track.kind === 'audio'), mic);
    app.context.fecharLigacao(3);
  }
  app.context.restaurarQualidadeTela();
  assert.equal(app.roots['qualidade-tela'].value, '1080-60');
});

test('falha ao mudar captura preserva perfil anterior e libera seletor', async () => {
  const app = setup();
  await app.context.alternarTela();
  app.capture.getVideoTracks()[0].applyConstraints = async () => { throw new Error('Sem suporte'); };
  app.roots['qualidade-tela'].value = '720-60';
  await app.context.mudarQualidadeTela();
  assert.equal(app.context.state.qualidadeTela, '1080-30');
  assert.equal(app.roots['qualidade-tela'].value, '1080-30');
  assert.equal(app.roots['qualidade-tela'].disabled, false);
  assert.equal(app.context.state.minhaTela, app.capture);
});

test('volume individual preserva outras pessoas e reconhece audio que chega antes do video', async () => {
  const app = setup();
  app.context.salvarVolume(2, 'voz', 25);
  app.context.salvarVolume(2, 'tela', 0);
  const peer = app.context.criarLigacao(2);
  const mic = new app.Stream([new app.Track('audio')]);
  peer.ontrack({ track: mic.getAudioTracks()[0], streams: [mic] });
  const video = app.capture.getVideoTracks()[0];
  app.capture.removeTrack(video);
  peer.ontrack({ track: app.capture.getAudioTracks()[0], streams: [app.capture] });
  app.capture.tracks.push(video);
  peer.ontrack({ track: video, streams: [app.capture] });
  const other = app.context.criarLigacao(3);
  const otherMic = new app.Stream([new app.Track('audio')]);
  other.ontrack({ track: otherMic.getAudioTracks()[0], streams: [otherMic] });
  await new Promise(setImmediate);
  const [voice, screen, otherVoice] = app.roots.audios.children;
  assert.equal(voice.volume, .25);
  assert.equal(screen.muted, true);
  assert.equal(screen.dataset.tipo, 'tela');
  assert.equal(otherVoice.volume, 1);
  app.context.salvarVolume(2, 'voz', 75);
  assert.equal(voice.volume, .75);
  assert.equal(screen.muted, true);
  assert.equal(otherVoice.volume, 1);
  assert.equal(JSON.parse(app.storage.get('codecom-volume:1:2')).voz, 75);
  app.context.state.eu.id = 9;
  assert.equal(app.context.lerVolume(2).voz, 100);
});

test('volume tolera dados invalidos no armazenamento', () => {
  const app = setup();
  app.storage.set('codecom-volume:1:2', 'invalido');
  assert.equal(app.context.lerVolume(2).voz, 100);
  app.storage.set('codecom-volume:1:2', JSON.stringify({ voz: -3, tela: 999 }));
  assert.equal(app.context.lerVolume(2).voz, 0);
  assert.equal(app.context.lerVolume(2).tela, 200);
});
