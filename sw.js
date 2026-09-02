const CACHE_VERSION = 'nerf-arena-__BUILD_ID__';
const CORE_CACHE = `${CACHE_VERSION}-core`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/favicon.ico',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
  './src/audio.js',
  './src/bot-strategy.js',
  './src/bots.js',
  './src/combat.js',
  './src/dom.js',
  './src/engine.js',
  './src/hud.js',
  './src/jetpack.js',
  './src/main.js',
  './src/map-rules.js',
  './src/maps.js',
  './src/mobile-controls.js',
  './src/multiplayer.js',
  './src/network-sync.js',
  './src/pickups.js',
  './src/player.js',
  './src/pwa.js',
  './src/secret-maps.js',
  './src/water-movement.js',
  './src/weapons.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/RenderPass.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/OutputPass.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/environments/RoomEnvironment.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/Pass.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/ShaderPass.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/MaskPass.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/shaders/CopyShader.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/shaders/LuminosityHighPassShader.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await Promise.allSettled(CORE_ASSETS.map((asset) => cache.add(asset)));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('nerf-arena-') && ![CORE_CACHE, RUNTIME_CACHE].includes(key))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'NERF_ARENA_SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) ||
      (await caches.match(request, { ignoreSearch: true })) ||
      (await caches.match('./index.html'));
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const update = fetch(request).then(async (response) => {
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);
  return cached || (await update) || Response.error();
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && (url.pathname.startsWith('/api/') || url.pathname === '/ws')) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.origin === self.location.origin && (
    url.pathname.startsWith('/textures/') ||
    url.pathname.startsWith('/assets/sfx/') ||
    url.pathname.startsWith('/music/')
  )) {
    // These versioned runtime caches are immutable for the lifetime of this
    // service worker. Avoid redownloading and rewriting every large media file
    // during the first match of each browser session.
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.origin === self.location.origin && (url.pathname.endsWith('.js') || url.pathname.endsWith('.webmanifest'))) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
