// Retira el service worker de la primera versión de la herramienta (27 oct 2026), que vivía en la
// raíz de este sitio. Desde el 29 oct la raíz es la página de presentación (que NO usa service
// worker) y la herramienta está en /herramienta/ con el suyo. Los navegadores que ya tenían el viejo
// descargan este archivo (misma dirección) al revisar si hay una versión nueva, lo instalan y él
// se desinstala solo.
//
// Esta página no lo registra: solo existe para limpiar. Se puede borrar cuando haya pasado un tiempo.
// Solo toca lo de la herramienta (cachés «anon-…», que comparten origen con otras páginas del
// usuario) y deja lo que ya esté guardado de /herramienta/. Si cambia SITIO o BASE en src/config.ts,
// la ruta de abajo debe cambiar con ellos.
const HERRAMIENTA = "/anonimizador/herramienta/";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const nombre of await caches.keys()) {
        if (!nombre.startsWith("anon-")) continue;
        const cache = await caches.open(nombre);
        for (const peticion of await cache.keys()) {
          if (!new URL(peticion.url).pathname.startsWith(HERRAMIENTA)) await cache.delete(peticion);
        }
      }
      await self.registration.unregister();
    })(),
  );
});
