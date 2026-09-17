// Integracao real de WebRTC/Web Audio em dois navegadores locais, com fontes sinteticas.
// Requer Playwright e Chrome; nao usa contas, microfone ou banco de dados reais.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const staticDir = path.resolve(__dirname, '../static');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/config') { res.setHeader('Content-Type', 'application/json'); res.end('{}'); return; }
    const file = {
      '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css',
      '/manifest.webmanifest': 'manifest.webmanifest', '/service-worker.js': 'service-worker.js',
      '/offline.html': 'offline.html', '/icons/codecom.svg': 'icons/codecom.svg',
      '/icons/codecom-192.png': 'icons/codecom-192.png', '/icons/codecom-512.png': 'icons/codecom-512.png',
    }[req.url];
    if (!file) { res.writeHead(404); res.end(); return; }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' :
      file.endsWith('.webmanifest') ? 'application/manifest+json' : file.endsWith('.png') ? 'image/png' :
      file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    res.setHeader('Content-Type', type);
    res.end(await fs.readFile(path.join(staticDir, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  let relayClosing = false;
  try {
    // A two-tab local test needs candidates the host resolver can reach;
    // production clients keep Chrome's normal mDNS privacy behavior.
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
      '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns',
    ] });
    const a = await browser.newPage();
    const b = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const failures = [];
    for (const [index, page] of [a, b].entries()) {
      page.on('pageerror', error => failures.push(error.message));
      page.on('console', msg => { if (msg.type() === 'warning') console.log('browser', index, msg.text()); });
    }
    const url = `http://127.0.0.1:${server.address().port}`;
    await Promise.all([a.goto(url), b.goto(url)]);
    // Sinalizacao serializada por destino como no websocket do app.
    let toA = Promise.resolve(), toB = Promise.resolve();
    await a.exposeFunction('signalToOther', msg => {
      if (msg.type === 'signal' && !relayClosing) toB = toB.then(() => b.evaluate(data => receberSinal(1, data), msg.data))
        .catch(error => { if (!relayClosing) failures.push(error.message); });
    });
    await b.exposeFunction('signalToOther', msg => {
      if (msg.type === 'signal' && !relayClosing) toA = toA.then(() => a.evaluate(data => receberSinal(2, data), msg.data))
        .catch(error => { if (!relayClosing) failures.push(error.message); });
    });
    for (const [page, id] of [[a, 1], [b, 2]]) {
      await page.evaluate(id => {
        estado.eu = { id, display_name: 'Teste ' + id };
        estado.usuarios = [{ id: 1, display_name: 'Pessoa transmitindo' }, { id: 2, display_name: 'Espectador' }];
        estado.vozCanal = 7;
        estado.vozPorCanal[7] = [1, 2];
        document.querySelector('#tela-login').classList.add('escondido');
        document.querySelector('#app').classList.remove('escondido');
        document.querySelector('#painel-voz').classList.remove('escondido');
        mandarWS = obj => window.signalToOther(JSON.parse(JSON.stringify(obj)));
        CONFIG_RTC.iceServers = [];
        ligarLayoutDaCall('Sala de teste');
        window.testAudio = new AudioContext();
        if (id === 1) {
          const mic = testAudio.createOscillator();
          mic.frequency.value = 330;
          const out = testAudio.createMediaStreamDestination();
          mic.connect(out); mic.start();
          estado.meuAudio = out.stream;
          const canvas = document.createElement('canvas');
          canvas.width = 1920; canvas.height = 1080;
          const ctx = canvas.getContext('2d');
          let x = 0;
          setInterval(() => {
            ctx.fillStyle = '#24283b'; ctx.fillRect(0, 0, 1920, 1080);
            ctx.fillStyle = '#7289da'; ctx.fillRect((x++ * 12) % 1100, 200, 180, 180);
            ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText('Code com • teste ao vivo', 70, 100);
          }, 8); // fonte pronta a cada ciclo; captureStream limita a 60 fps
          window.capture = canvas.captureStream(60);
          const tone = testAudio.createOscillator(); tone.frequency.value = 660;
          const screenAudio = testAudio.createMediaStreamDestination();
          tone.connect(screenAudio); tone.start(); capture.addTrack(screenAudio.stream.getAudioTracks()[0]);
          capture.getAudioTracks()[0].getSettings = () => ({ restrictOwnAudio: true });
          navigator.mediaDevices.getDisplayMedia = async () => capture;
        } else { estado.meuAudio = new MediaStream(); estado.soOuvir = true; estado.mutado = true; }
        atualizarModoOuvir();
      }, id);
    }
    await a.evaluate(async () => { criarLigacao(2); await alternarTela(); });
    try {
      await b.waitForFunction(() => estado.peers[1]?.connectionState === 'connected' &&
        document.querySelectorAll('#audios audio').length === 2 && document.querySelector('.tela-item video')?.videoWidth > 0,
        null, { timeout: 10000 });
    } catch (error) {
      for (const page of [a, b]) console.log(await page.evaluate(() => ({
        peers: Object.values(estado.peers).map(p => ({ state: p.connectionState, ice: p.iceConnectionState, gathering: p.iceGatheringState, signaling: p.signalingState,
          local: p.localDescription?.sdp.slice(0, 90), remote: p.remoteDescription?.sdp.slice(0, 90),
          senders: p.getSenders().map(s => s.track?.kind), receivers: p.getReceivers().map(r => r.track.kind) })),
        audios: document.querySelectorAll('#audios audio').length, videos: document.querySelectorAll('video').length,
      })));
      console.log({ failures });
      throw error;
    }
    assert.equal(await b.evaluate(() => estado.peers[1].getSenders().filter(sender => sender.track).length), 0,
      'quem entra apenas para assistir não deve enviar microfone');
    assert.equal(await b.locator('#call-stage').isVisible(), true);
    assert.equal(await b.locator('#btn-mudo-call').textContent(), '🔇');
    assert.equal(await b.locator('#visor').evaluate(node => node.parentElement.id), 'call-screens');
    await b.waitForFunction(() => document.querySelector('.call-person[data-voice-id="1"]')?.classList.contains('falando'));
    await b.screenshot({ path: path.join(os.tmpdir(), 'codecom-call-mobile.png') });
    await b.waitForFunction(() => document.querySelector('.tela-item video').getVideoPlaybackQuality().totalVideoFrames > 60);
    const stats = await b.evaluate(async () => {
      const stats = [...(await estado.peers[1].getStats()).values()];
      const video = stats.filter(s => s.type === 'inbound-rtp' && s.kind === 'video')
        .sort((a, b) => (b.lastPacketReceivedTimestamp || 0) - (a.lastPacketReceivedTimestamp || 0))[0];
      return { frames: video.framesDecoded, fps: video.framesPerSecond, width: video.frameWidth, height: video.frameHeight,
        jitterBufferMs: 1000 * video.jitterBufferDelay / video.jitterBufferEmittedCount,
        audioStreams: stats.filter(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.packetsReceived > 0).length };
    });
    assert.equal(stats.audioStreams, 2);
    assert.equal(stats.width, 1920);
    assert.equal(stats.height, 1080);
    const profiles = [];
    for (const [key, width, height, fps] of [['720-30', 1280, 720, 30], ['720-60', 1280, 720, 60],
      ['1080-60', 1920, 1080, 60], ['1080-30', 1920, 1080, 30]]) {
      await a.setViewportSize(width === 1280 ? { width: 390, height: 844 } : { width: 1366, height: 900 });
      await a.waitForFunction(() => !matchMedia('(max-width: 720px)').matches || document.querySelector('#app').classList.contains('ver-chat'));
      await a.locator('#qualidade-tela').selectOption(key);
      await a.waitForFunction(() => !document.querySelector('#qualidade-tela').disabled);
      await b.waitForFunction(({ width, height }) => {
        const video = document.querySelector('.tela-item video');
        return video.videoWidth === width && video.videoHeight === height;
      }, { width, height });
      const encoder = await a.evaluate(() => estado.peers[2].getSenders().find(s => s.track?.kind === 'video').getParameters());
      assert.equal(encoder.encodings[0].maxFramerate, fps);
      assert.equal(encoder.degradationPreference, 'maintain-resolution');
      await b.waitForTimeout(1000); // estabiliza a mudanca antes de medir FPS
      const received = await b.evaluate(async () => {
        const video = document.querySelector('.tela-item video');
        const start = performance.now(), frames = video.getVideoPlaybackQuality().totalVideoFrames;
        await new Promise(resolve => setTimeout(resolve, 2000));
        return { width: video.videoWidth, height: video.videoHeight,
          fps: Math.round(1000 * (video.getVideoPlaybackQuality().totalVideoFrames - frames) / (performance.now() - start)) };
      });
      assert.equal(received.width, width);
      assert.equal(received.height, height);
      assert.ok(received.fps >= fps * .75, 'Taxa recebida deve acompanhar o perfil');
      profiles.push({ key, received, maxBitrate: encoder.encodings[0].maxBitrate });
      console.log('Perfil verificado', key, received);
      if (key === '720-60') await a.screenshot({ path: path.join(os.tmpdir(), 'codecom-quality-mobile.png') });
    }
    await b.getByRole('button', { name: '🔊 Volume', exact: true }).tap();
    await b.locator('#volume-voz').fill('35');
    await b.locator('#volume-tela').fill('175');
    await b.waitForTimeout(150); // deixa a rampa suave do ganho terminar
    const volumes = await b.evaluate(() => [...document.querySelectorAll('#audios audio')].map(audio => ({
      tipo: audio.dataset.tipo, gain: audio.mixagem.ganho.gain.value, ctx: audio.mixagem.ctx.state, muted: audio.muted,
    })));
    assert.ok(Math.abs(volumes.find(v => v.tipo === 'voz').gain - .35) < .01);
    assert.ok(Math.abs(volumes.find(v => v.tipo === 'tela').gain - 1.75) < .01);
    assert.ok(volumes.every(v => v.ctx === 'running' && v.muted), 'o áudio deve sair apenas uma vez, pelo grafo Web Audio');
    const energy = await b.evaluate(async () => {
      const graph = document.querySelector('audio[data-tipo="voz"]').mixagem;
      const analyser = graph.analisador;
      await new Promise(resolve => setTimeout(resolve, 100));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
    });
    if (energy <= .001) console.log('diagnóstico de áudio', await b.evaluate(async () => {
      const audio = document.querySelector('audio[data-tipo="voz"]');
      const samples = new Float32Array(audio.mixagem.analisador.fftSize);
      audio.mixagem.analisador.getFloatTimeDomainData(samples);
      const stats = [...(await estado.peers[1].getStats()).values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'audio');
      return { currentTime: audio.currentTime, paused: audio.paused, muted: audio.muted, volume: audio.volume,
        playbackState: audio.readyState, ctx: audio.mixagem.ctx.state, gain: audio.mixagem.ganho.gain.value,
        compressor: audio.mixagem.limitador.reduction, track: audio.srcObject.getAudioTracks()[0]?.readyState,
        audioContext: testAudio.state, rms: Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length), stats };
    }));
    assert.ok(energy > .001, 'Web Audio deve entregar amostras audiveis');
    const box = await b.locator('#modal-volume').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844);
    await b.screenshot({ path: path.join(os.tmpdir(), 'codecom-volume-mobile.png') });
    await b.setViewportSize({ width: 1366, height: 900 });
    await b.screenshot({ path: path.join(os.tmpdir(), 'codecom-volume-desktop.png') });
    await b.locator('#volume-tela').fill('0');
    await b.waitForTimeout(150); // deixa a rampa suave do ganho zerar o som da tela
    assert.ok(await b.evaluate(() => document.querySelector('audio[data-tipo="tela"]').mixagem.ganho.gain.value) < .001,
      'o áudio da tela deve chegar ao silêncio após a rampa do controle');
    assert.ok(await b.evaluate(() => document.querySelector('audio[data-tipo="voz"]').mixagem.ganho.gain.value) > 0);
    await b.getByRole('button', { name: 'Pronto', exact: true }).click();
    await a.evaluate(() => pararDeCompartilhar());
    await b.waitForFunction(() => document.querySelectorAll('#audios audio').length === 1 && document.querySelectorAll('.tela-item').length === 0);
    assert.equal(await b.evaluate(() => document.querySelector('#audios audio').dataset.tipo), 'voz');
    await b.evaluate(async () => {
      const fonte = testAudio.createOscillator();
      const microfone = testAudio.createMediaStreamDestination();
      fonte.connect(microfone); fonte.start();
      navigator.mediaDevices.getUserMedia = async () => microfone.stream;
      await alternarMudo();
    });
    assert.equal(await b.evaluate(() => estado.soOuvir), false);
    assert.equal(await b.evaluate(() => estado.peers[1].getSenders().filter(sender => sender.track?.kind === 'audio').length), 1,
      'o botão de microfone da sala deve permitir falar depois de entrar só para ouvir');
    relayClosing = true;
    await Promise.all([toA, toB]);
    await b.reload();
    const persisted = await b.evaluate(() => {
      estado.eu = { id: 2 }; return lerVolume(1);
    });
    assert.deepEqual(persisted, { voz: 35, tela: 0 });
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ passed: true, stats, profiles, volumes, energy, screenshots: [path.join(os.tmpdir(), 'codecom-volume-mobile.png'), path.join(os.tmpdir(), 'codecom-volume-desktop.png')] }, null, 2));
  } finally {
    relayClosing = true;
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
