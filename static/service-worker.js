const CACHE_ATUAL = "codecom-app-shell-v1";
const ARQUIVOS_DO_APP = [
  "/",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/codecom.svg",
  "/icons/codecom-192.png",
  "/icons/codecom-512.png",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(caches.open(CACHE_ATUAL).then((cache) => cache.addAll(ARQUIVOS_DO_APP)));
  self.skipWaiting();
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(caches.keys().then(async (chaves) => {
    await Promise.all(chaves.filter((chave) => chave.startsWith("codecom-app-shell-") && chave !== CACHE_ATUAL)
      .map((chave) => caches.delete(chave)));
    await self.clients.claim();
  }));
});

self.addEventListener("fetch", (evento) => {
  const pedido = evento.request;
  const url = new URL(pedido.url);
  if (pedido.method !== "GET" || url.origin !== self.location.origin) return;

  // Nunca guardamos API, mensagens, sessões, uploads ou sinalização da call.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname.startsWith("/uploads/")) return;

  if (pedido.mode === "navigate") {
    evento.respondWith(fetch(pedido).catch(async () =>
      (await caches.match("/offline.html")) || new Response("Code com está offline.", {
        status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
      })));
    return;
  }

  if (!ARQUIVOS_DO_APP.includes(url.pathname)) return;
  evento.respondWith(fetch(pedido).then(async (resposta) => {
    if (resposta.ok) {
      const cache = await caches.open(CACHE_ATUAL);
      await cache.put(pedido, resposta.clone());
    }
    return resposta;
  }).catch(async () => (await caches.match(pedido)) || Response.error()));
});
