// Regressao de fotos e rolagem, sem usar contas ou mensagens reais.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/config') { res.setHeader('Content-Type', 'application/json'); res.end('{}'); return; }
    if (req.url.startsWith('/photo')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><rect width="4000" height="3000" fill="#5865f2"/></svg>');
      return;
    }
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
    res.end(await fs.readFile(path.join(__dirname, '../static', file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const viewport of [{ width: 1366, height: 768 }, { width: 800, height: 600 },
      { width: 390, height: 844 }, { width: 320, height: 480 }]) {
      const page = await browser.newPage({ viewport, isMobile: viewport.width < 720, hasTouch: viewport.width < 720 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const devtools = await page.context().newCDPSession(page);
      const manifestCheck = await devtools.send('Page.getAppManifest');
      await devtools.detach();
      assert.deepEqual(manifestCheck.errors, [], 'manifest deve ser reconhecido sem erros pelo Chrome');
      const pwa = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        const manifest = await fetch('/manifest.webmanifest').then(response => response.json());
        return {
          scope: registration.scope,
          active: registration.active?.state,
          cachedShell: Boolean(await caches.match('/app.js')),
          name: manifest.name,
          display: manifest.display,
          icons: manifest.icons.map(icon => icon.sizes),
        };
      });
      assert.match(pwa.scope, /127\.0\.0\.1/);
      assert.equal(pwa.active, 'activated');
      assert.equal(pwa.cachedShell, true);
      assert.equal(pwa.name, 'Code com');
      assert.equal(pwa.display, 'standalone');
      assert.ok(pwa.icons.includes('192x192') && pwa.icons.includes('512x512'));
      assert.equal(await page.locator('#btn-instalar-login').isVisible(), true);
      if (viewport.width === 1366) {
        await page.evaluate(() => {
          window.installPromptForTest = 0;
          const prompt = new Event('beforeinstallprompt', { cancelable: true });
          prompt.prompt = async () => { window.installPromptForTest++; };
          prompt.userChoice = Promise.resolve({ outcome: 'accepted' });
          window.dispatchEvent(prompt);
          window.installPromptPrevented = prompt.defaultPrevented;
        });
        await page.locator('#btn-instalar-login').click();
        await page.waitForFunction(() => window.installPromptForTest === 1);
        assert.equal(await page.evaluate(() => window.installPromptPrevented), true);
      }
      await page.evaluate(() => {
        estado.eu = { id: 1, display_name: 'Eu' }; estado.canalAtual = 7;
        $('#tela-login').classList.add('escondido'); $('#app').classList.remove('escondido');
        mostrarChatNoCelular();
        window.addTestMessage = (id, photo = false) => tratarEvento({ type: 'message', message: {
          id, user_id: 1, channel_id: 7, display_name: 'Teste', avatar_color: '#5865f2',
          created_at: '2026-09-16T12:00:00Z', content: 'Mensagem ' + id,
          ...(photo ? { file_url: '/photo.svg?id=' + id, file_name: 'foto.svg', file_type: 'image/svg+xml' } : {}),
        } });
        for (let i = 1; i <= 30; i++) addTestMessage(i, i % 3 === 0);
      });
      const ultimaFoto = page.locator('[data-msg="30"] .anexo-img');
      await ultimaFoto.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('[data-msg="30"] .anexo-img')?.complete);
      const metrics = await page.evaluate(() => ({
        viewport: innerHeight, chatBottom: $('.chat').getBoundingClientRect().bottom,
        clientHeight: $('#mensagens').clientHeight, scrollHeight: $('#mensagens').scrollHeight,
        composerBottom: $('#form-msg').getBoundingClientRect().bottom,
        pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      }));
      console.log({ viewport, metrics });
      assert.ok(metrics.chatBottom <= metrics.viewport + 1, 'Chat precisa caber na tela apos carregar fotos');
      assert.ok(metrics.composerBottom <= metrics.viewport, 'Campo de mensagem precisa continuar visivel');
      assert.ok(metrics.scrollHeight > metrics.clientHeight + 100, 'Historico precisa ter rolagem propria');
      assert.ok(metrics.pageWidth <= metrics.viewportWidth, 'Foto nao deve alargar a pagina');
      const scroll = await page.evaluate(() => {
        const box = $('#mensagens'); box.scrollTop = box.scrollHeight;
        const bottom = box.scrollTop; box.scrollTop = 100;
        return { bottom, top: box.scrollTop };
      });
      assert.ok(scroll.bottom > 100 && scroll.top === 100, 'Rolagem precisa funcionar nos dois sentidos');
      let uploads = 0;
      await page.route('**/api/upload', async route => {
        uploads++;
        assert.match(route.request().headers()['content-type'], /multipart\/form-data/);
        assert.ok(route.request().postDataBuffer().includes(Buffer.from('image/png')));
        await route.fulfill({ json: { ok: true } });
        await page.evaluate(() => addTestMessage(31, true));
      });
      const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=', 'base64');
      await page.locator('#input-arquivo').setInputFiles({ name: 'foto-'.repeat(30) + '.png', mimeType: 'image/png', buffer: photo });
      await page.locator('#input-msg').fill('Foto de teste');
      await page.locator('.btn-enviar').click();
      const fotoNova = page.locator('[data-msg="31"] .anexo-img');
      await fotoNova.waitFor();
      assert.equal(uploads, 1);
      await page.locator('#previa-arquivo').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => $('#mensagens').scrollTop), 100, 'Foto recebida nao deve tirar o leitor do historico');
      assert.equal(await fotoNova.getAttribute('loading'), 'lazy', 'Fotos fora da tela devem carregar sob demanda');
      await fotoNova.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('[data-msg="31"] .anexo-img')?.complete);
      await page.evaluate(() => { $('#mensagens').scrollTop = 100; });
      // Confere rolagem por gesto, alem de ajustar scrollTop diretamente.
      await page.locator('#mensagens').hover();
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(() => document.querySelector('#mensagens').scrollTop > 100);
      await page.mouse.wheel(0, -400);
      await page.waitForFunction(() => document.querySelector('#mensagens').scrollTop <= 100);
      await page.locator('#input-msg').fill('Chat continua funcionando');
      await page.locator('#input-msg').press('Enter');
      assert.equal(await page.locator('#input-msg').inputValue(), '');
      if (viewport.width === 1366) {
        const url = `http://127.0.0.1:${server.address().port}`;
        await page.reload();
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        await page.context().setOffline(true);
        try {
          await page.goto(url);
          assert.match(await page.locator('h1').textContent(), /sem conexão/i);
        } finally {
          await page.context().setOffline(false);
        }
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
