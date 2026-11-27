/* Склад: офлайн-оболочка. Всегда сначала свежая версия из сети (мимо кэша браузера),
   без сети — сохранённая копия. Данные синхронизирует Firebase. */
const C='sklad-v3';
self.addEventListener('install',e=>{self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET')return;
  const same=u.origin===location.origin, sdk=u.hostname==='www.gstatic.com'||u.hostname==='fonts.googleapis.com'||u.hostname==='fonts.gstatic.com';
  if(!same&&!sdk)return;
  const req=same?new Request(e.request,{cache:'no-store'}):e.request;
  e.respondWith(fetch(req).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));}return r;}).catch(()=>caches.match(e.request,{ignoreSearch:true})));
});
