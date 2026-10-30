// Service worker: deja la página disponible sin conexión y la mantiene al día.
// - Archivos de la página (HTML, JS, CSS, textos): red primero (siempre la última versión si hay internet), copia guardada si no hay.
// - Lector de texto y de PDF (vendor/): copia guardada primero (son pesados y no cambian).
// No guarda ni envía nada que el usuario cargue: solo copia archivos del propio sitio.
const VERSION = '0.3.0';
const SHELL = `anon-shell-${VERSION}`;
const VENDOR = 'anon-vendor-v1';
const SHELL_FILES = ['./', 'index.html', 'manifest.webmanifest', 'version.json', 'css/app.css', 'js/app.js', 'js/i18n.js', 'js/rules.js', 'js/contexto-nombres.js', 'js/ocr.js', 'js/redact.js', 'js/pdfio.js', 'js/raf.js', 'js/version.js',
  'i18n/mac-en.json', 'i18n/mac-pt-BR.json', 'i18n/web-en.json', 'i18n/web-pt-BR.json', 'icons/icon-192.png', 'icons/icon-512.png'];
const VENDOR_FILES = ['vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js'];
const HEAVY_FILES = ['vendor/tesseract/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/tesseract-core-lstm.wasm.js', 'vendor/tessdata/spa.traineddata.gz', 'vendor/tessdata/eng.traineddata.gz', 'vendor/tessdata/por.traineddata.gz'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map((f) => shell.add(new Request(f, { cache: 'reload' })).catch(() => {})));
    const vendor = await caches.open(VENDOR);
    await Promise.all(VENDOR_FILES.map((f) => vendor.match(f).then((hit) => hit || vendor.add(f)).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('anon-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const isVendor = url.pathname.includes('/vendor/');
  e.respondWith((async () => {
    if (isVendor) {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(VENDOR)).put(req, res.clone());
      return res;
    }
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

// «Preparar para usar sin conexión»: guarda también el lector de texto y los idiomas (unos 10 MB, una sola vez).
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'prepare-offline') return;
  e.waitUntil((async () => {
    const vendor = await caches.open(VENDOR);
    let done = 0;
    for (const f of HEAVY_FILES) {
      try { if (!(await vendor.match(f))) await vendor.add(f); } catch (err) { /* se reintenta la próxima vez */ }
      done++;
      (await self.clients.matchAll()).forEach((c) => c.postMessage({ type: 'offline-progress', done, total: HEAVY_FILES.length }));
    }
  })());
});
