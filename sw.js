/* Склад: офлайн-оболочка. Сначала сеть, при отсутствии сети — сохранённая копия. Данные синхронизирует Firebase. */
const C='sklad-v1';
const SHELL=['./','index.html','shim.js','firebase-config.js','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET')return;
  const same=u.origin===location.origin, sdk=u.hostname==='www.gstatic.com'||u.hostname==='fonts.googleapis.com'||u.hostname==='fonts.gstatic.com';
  if(!same&&!sdk)return;
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));}return r;}).catch(()=>caches.match(e.request,{ignoreSearch:true})));
});
