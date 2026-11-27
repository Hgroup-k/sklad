/* Склад: офлайн-оболочка. Всегда сначала свежая версия из сети (мимо кэша браузера),
   без сети — сохранённая копия. Данные синхронизирует Firebase. */
const C='sklad-v6';
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
/* уведомления (push): приходят даже когда программа закрыта */
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{};}catch(x){d={title:'Общий учёт',body:e.data?e.data.text():''};}
  e.waitUntil(self.registration.showNotification(d.title||'Общий учёт',{body:d.body||'',icon:'icons/icon-192.png',badge:'icons/icon-192.png',tag:d.tag||undefined,data:{go:d.go||'',tag:d.tag||''}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();let go=(e.notification.data&&e.notification.data.go)||'';const tag=e.notification.tag||(e.notification.data&&e.notification.data.tag)||'';
  /* открыть именно тот чат, откуда пришло сообщение */
  if(tag.indexOf('chat-')===0)go='chat:'+tag.slice(5);else if(tag==='order-'||go==='orders'&&tag.indexOf('order-')===0&&tag.length<=6)go='chat:orders';
  const url=self.registration.scope+(go?'#'+go:'');
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{for(const w of ws){if('focus' in w){try{w.postMessage({open:go});}catch(x){}return w.focus();}}return self.clients.openWindow(url);}));
});
