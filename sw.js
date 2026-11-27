const cacheName = 'turni-servizio-web-7';
const assets = ['./','./index.html','./style.css','./app.js?v=7','./sync.js?v=1','./manifest.webmanifest','./icona-192.png','./icona-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(assets))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(
  keys.filter(key=>key.startsWith('turni-servizio-web-')&&key!==cacheName).map(key=>caches.delete(key))
)).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request;
  if (request.method!=='GET'||new URL(request.url).origin!==location.origin) return;
  event.respondWith((async()=>{
    const cache=await caches.open(cacheName);
    if (request.mode==='navigate') {
      try { return await fetch(request); }
      catch { return await cache.match('./index.html')||Response.error(); }
    }
    return await cache.match(request)||fetch(request);
  })());
});
