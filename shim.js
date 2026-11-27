/* Склад: отдельная версия. Даёт странице тот же window.claude.use(...), что и в Claude,
   но на своей базе Firebase (Firestore + вход через Google). Код страницы не меняется. */
(function(){
"use strict";
const cfg=window.SKLAD_FIREBASE_CONFIG;
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let resolveReady;const ready=new Promise(r=>resolveReady=r);
window.claude={use:async name=>{const api=await ready;return api?api[name]||null:null;}};

if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));

function gate(html){let g=$('auth-gate');if(!g){g=document.createElement('div');g.id='auth-gate';document.body.appendChild(g);}g.innerHTML='<div class="ag-card">'+html+'</div>';g.hidden=false;return g;}
function ungate(){const g=$('auth-gate');if(g)g.hidden=true;}

if(!cfg||!cfg.apiKey){document.addEventListener('DOMContentLoaded',()=>gate('<h2>Склад</h2><p>Программа ещё не подключена к базе. Нет файла настроек Firebase.</p>'));resolveReady(null);return;}

firebase.initializeApp(cfg);
const auth=firebase.auth();
const fs=firebase.firestore();
try{fs.settings({ignoreUndefinedProperties:true,merge:true});}catch(e){}
try{fs.enablePersistence({synchronizeTabs:true}).catch(()=>{});}catch(e){}

const lower=s=>String(s||'').trim().toLowerCase();
const ACC=fs.doc('access/main');
let me=null,role='none',access=null;

function roleOf(a,email){
  if(!a)return 'none';
  if(lower(a.owner)===email)return 'owner';
  if((a.editors||[]).map(lower).includes(email))return 'editor';
  if((a.viewers||[]).map(lower).includes(email))return 'viewer';
  if(Object.keys(a.perms||{}).map(lower).includes(email))return 'custom:'+JSON.stringify(a.perms[Object.keys(a.perms).find(k=>lower(k)===email)]);
  return 'none';
}
const ROLE_RU={owner:'владелец',editor:'может вносить',viewer:'только просмотр'};

function signIn(){
  const p=new firebase.auth.GoogleAuthProvider();p.setCustomParameters({prompt:'select_account'});
  return auth.signInWithPopup(p).catch(e=>{
    if(e&&(e.code==='auth/popup-blocked'||e.code==='auth/operation-not-supported-in-this-environment'))return auth.signInWithRedirect(p);
    if(e&&e.code!=='auth/popup-closed-by-user'&&e.code!=='auth/cancelled-popup-request')alert('Не удалось войти: '+(e.message||e.code));
  });
}
function showLogin(){
  const g=gate('<h2>Складской учёт</h2><p>Войдите через Google-аккаунт, которому владелец дал доступ.</p><button type="button" class="primary" id="ag-in">Войти через Google</button>');
  g.querySelector('#ag-in').onclick=signIn;
}
function showNoAccess(email){
  const g=gate('<h2>Нет доступа</h2><p>Вы вошли как <b>'+esc(email)+'</b>. Этому адресу доступ к складу не дан.</p><p>Попросите владельца добавить этот адрес в разделе «Доступ».</p><button type="button" class="ghost" id="ag-out">Войти другим аккаунтом</button>');
  g.querySelector('#ag-out').onclick=()=>auth.signOut();
}

let started=false;
auth.getRedirectResult().catch(()=>{});
const domReady=new Promise(r=>document.readyState==='loading'?document.addEventListener('DOMContentLoaded',r):r());
auth.onAuthStateChanged(async u=>{
  await domReady;
  if(!u){if(started){location.reload();return;}showLogin();return;}
  if(started&&me&&u.uid!==me.uid){location.reload();return;}
  me=u;const email=lower(u.email);
  gate('<h2>Складской учёт</h2><p>Загрузка…</p>');
  let snap;
  try{snap=await ACC.get();}catch(e){gate('<h2>Нет связи с базой</h2><p>Проверьте интернет и обновите страницу.</p>');return;}
  if(!snap.exists){
    /* первый вход: тот, кто открыл базу первым, становится владельцем */
    try{await ACC.set({owner:email,editors:[],viewers:[],at:new Date().toISOString()});snap=await ACC.get();}
    catch(e){showNoAccess(email);return;}
  }
  access=snap.data();role=roleOf(access,email);
  if(role==='none'){showNoAccess(email);return;}
  fs.doc('people/'+u.uid).set({name:u.displayName||email,email,at:new Date().toISOString()},{merge:true}).catch(()=>{});
  ACC.onSnapshot(s=>{if(!s.exists)return;const nr=roleOf(s.data(),email);access=s.data();if(nr!==role)location.reload();},()=>{});
  ungate();started=true;
  addBar();
  resolveReady(api());
});

const names={};
function api(){
  const canWrite=role==='owner'||role==='editor';
  return {
    db:fs,
    user:{
      id:async()=>me.uid,
      isOwner:async()=>role==='owner',
      canEdit:async()=>canWrite,
      can:async n=>n==='data.write'?canWrite:false,
      sections:async()=>{const all=l=>({stock:l,orders:l,returns:l,plan:l,catalog:l});if(canWrite)return all('edit');if(role.startsWith('custom:'))return JSON.parse(role.slice(7));return all('view');},
      me:async()=>({id:me.uid,name:me.displayName||'',email:me.email,isOwner:role==='owner',canEdit:canWrite}),
      profiles:async ids=>{
        const out={};
        await Promise.all([...new Set(ids)].map(async id=>{
          if(!(id in names)){names[id]='';if(/^u_/.test(id))return;try{const s=await fs.doc('people/'+id).get();names[id]=s.exists?(s.data().name||''):'';}catch(e){}}
        }));
        for(const id of ids)out[id]={id,name:names[id]||''};
        return out;
      }
    },
    downloads:{save:async({filename,data})=>{
      const blob=data instanceof Blob?data:new Blob([data],{type:/\.csv$/i.test(filename)?'text/csv;charset=utf-8':/\.json$/i.test(filename)?'application/json':'text/html;charset=utf-8'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();
      setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},4000);
    }},
    desktop:null
  };
}

/* ---- панель в шапке: кто вошёл, Доступ (владелец), Выйти, Установить ---- */
let installEvt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvt=e;const b=$('sa-install');if(b)b.hidden=false;});
window.addEventListener('appinstalled',()=>{const b=$('sa-install');if(b)b.hidden=true;});
function addBar(){
  const brand=document.querySelector('.brand');if(!brand||$('sa-bar'))return;
  const bar=document.createElement('span');bar.id='sa-bar';
  bar.innerHTML='<button type="button" class="ghost sa-b" id="sa-install"'+(installEvt?'':' hidden')+'>Установить</button>'+
    (role==='owner'?'<button type="button" class="ghost sa-b" id="sa-acc">Доступ</button>':'')+
    '<button type="button" class="link sa-b" id="sa-out" title="'+esc(me.email)+'">Выйти</button>';
  brand.appendChild(bar);
  $('sa-out').onclick=()=>auth.signOut();
  $('sa-install').onclick=async()=>{if(!installEvt)return;installEvt.prompt();try{await installEvt.userChoice;}catch(e){}installEvt=null;$('sa-install').hidden=true;};
  const ab=$('sa-acc');if(ab)ab.onclick=openAccess;
}

/* ---- перенос копии (формат резервной копии склада) ---- */
async function importSnap(snap,progress){
  if(!snap||!snap.catalog||!snap.ops)throw new Error('это не файл копии склада');
  const W=[];const clean=o=>{const c={...o};delete c.id;delete c.m;return c;};
  W.push(['config/catalog',snap.catalog]);
  if(snap.plan)W.push(['config/plan',snap.plan]);
  if(snap.lists)W.push(['config/lists',snap.lists]);
  for(const o of snap.orders||[])W.push(['orders/'+o.id,clean(o)]);
  for(const r of snap.returns||[])W.push(['returns/'+r.id,clean(r)]);
  for(const m in snap.ops)for(const o of snap.ops[m])W.push(['months/'+m+'/ops/'+o.id,clean(o)]);
  let k=0;
  for(let i=0;i<W.length;i+=400){const b=fs.batch();for(const [p,d] of W.slice(i,i+400))b.set(fs.doc(p),d);await b.commit();k+=Math.min(400,W.length-i);progress(k);}
  return k;
}
/* ---- раздел «Доступ» (только владелец) ---- */
const SEC=[['stock','Склад','ввод, журнал, остатки и отчёты'],['orders','Заказы','заказы и выдача со склада'],['returns','Возвраты','возвраты и приёмка'],['plan','План','план производства'],['catalog','Справочники','товары, размеры, оформители']];
const LV=[['edit','Редактирует'],['view','Просмотр'],['none','Нет доступа']];
const norm=v=>v===true||v==='edit'?'edit':v==='view'?'view':'none';
function people(a){
  const out=new Map();const all=l=>{const p={};SEC.forEach(([k])=>p[k]=l);return p;};
  for(const e of a.viewers||[])out.set(lower(e),all('view'));
  for(const [e,p] of Object.entries(a.perms||{})){const q={};SEC.forEach(([k])=>q[k]=norm(p[k]));out.set(lower(e),q);}
  for(const e of a.editors||[])out.set(lower(e),all('edit'));
  return out;
}
const PRESET={view:['view','view','view','view','view'],edit:['edit','edit','edit','edit','edit'],orders:['view','edit','view','view','view'],ordersOnly:['none','edit','none','none','none']};
function summary(p){const v=SEC.map(([k])=>p[k]);if(v.every(x=>x==='edit'))return 'всё редактирует';if(v.every(x=>x==='view'))return 'всё только смотрит';return 'по разделам';}
function openAccess(){
  let d=$('sa-access');if(!d){d=document.createElement('div');d.id='sa-access';document.body.appendChild(d);}
  const a=access||{};const P=people(a);
  const rows=[...P.entries()];
  d.innerHTML='<div class="ag-card" style="max-width:560px;text-align:left"><div class="panel-head" style="margin-bottom:8px"><h2>Доступ к складу</h2><button type="button" class="link" id="sa-x">Закрыть</button></div>'+
    '<p class="muted" style="margin:0 0 12px;font-size:13px">Владелец: <b>'+esc(a.owner)+'</b>. Человек входит своим Google-аккаунтом. Для каждого раздела выберите: <b>Редактирует</b>, <b>Просмотр</b> (только смотрит) или <b>Нет доступа</b> (раздела не видно совсем). Изменения сохраняются сразу, проверку делает сама база.</p>'+
    (rows.length?rows.map(([e,p])=>'<div class="sa-person"><div class="sa-ph"><b style="word-break:break-all">'+esc(e)+'</b> <span class="muted" style="font-size:12px">'+summary(p)+'</span><button type="button" class="ghost del sa-b" data-sa-rm="'+esc(e)+'" style="margin-left:auto">Убрать</button></div>'+
      SEC.map(([k,l,t])=>'<label class="sa-row"><span>'+esc(l)+'<br><small class="muted">'+esc(t)+'</small></span><select data-sa-p="'+esc(e)+'" data-k="'+k+'">'+LV.map(([v,n])=>'<option value="'+v+'"'+(p[k]===v?' selected':'')+'>'+n+'</option>').join('')+'</select></label>').join('')+'</div>').join('')
      :'<p class="muted">Пока доступ есть только у вас.</p>')+
    '<h3 style="margin:16px 0 6px">Добавить человека</h3><div class="filters" style="margin:0"><label class="fld wide"><span>Почта Google</span><input type="text" id="sa-email" inputmode="email" placeholder="name@gmail.com"></label>'+
    '<label class="fld"><span>Начать с</span><select id="sa-role"><option value="view">всё только смотрит</option><option value="edit">всё редактирует</option><option value="orders">заказы редактирует, остальное смотрит</option><option value="ordersOnly">только заказы, остального не видит</option></select></label>'+
    '<label class="fld"><span>&nbsp;</span><button type="button" class="primary" id="sa-add" style="padding:8px 16px">Добавить</button></label></div><p class="muted" style="font-size:12px;margin:6px 0 0">После добавления права по каждому разделу можно поменять выше.</p><p class="err" id="sa-err" hidden></p>'+
    '<h3 style="margin:18px 0 6px">Перенос данных</h3><p class="muted" style="margin:0 0 8px;font-size:13px">Загрузите файл копии склада (.json): заказы, возвраты, журнал, справочники и план запишутся в эту базу. Записи с теми же номерами заменятся, остальное не трогается.</p>'+
    '<input type="file" id="sa-file" accept=".json,application/json"><p class="hint" id="sa-imp"></p></div>';
  d.hidden=false;
  const err=m=>{const e=$('sa-err');e.textContent=m||'';e.hidden=!m;};
  const save=async P2=>{
    const editors=[],viewers=[],perms={};
    for(const [e,p] of P2){const v=SEC.map(([k])=>p[k]);
      if(v.every(x=>x==='edit'))editors.push(e);else if(v.every(x=>x==='view'))viewers.push(e);else{perms[e]={};SEC.forEach(([k])=>perms[e][k]=p[k]);}}
    try{await ACC.update({editors,viewers,perms});access={...access,editors,viewers,perms};openAccess();}catch(x){err('Не удалось сохранить: '+(x.code||x.message));}
  };
  $('sa-x').onclick=()=>{d.hidden=true;};
  $('sa-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;const h=$('sa-imp');
    try{const snap=JSON.parse(await f.text());h.textContent='Переносим…';const n=await importSnap(snap,k=>h.textContent='Переносим… записано '+k);h.textContent='Готово: перенесено '+n+' записей. Страница обновится.';setTimeout(()=>location.reload(),1500);}
    catch(x){h.textContent='Не получилось: '+(x.message||x.code||x);}};
  $('sa-add').onclick=()=>{const e=lower($('sa-email').value);if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)){err('Впишите почту полностью, например name@gmail.com');return;}
    if(e===lower(a.owner)){err('Это ваш адрес, у вас и так все права.');return;}
    const pr=PRESET[$('sa-role').value];const p={};SEC.forEach(([k],i)=>p[k]=pr[i]);
    const P2=people(access);P2.set(e,p);save(P2);};
  d.querySelectorAll('[data-sa-rm]').forEach(b=>b.onclick=()=>{if(!b.classList.contains('confirm')){b.classList.add('confirm');b.textContent='Точно?';return;}const P2=people(access);P2.delete(b.dataset.saRm);save(P2);});
  d.querySelectorAll('[data-sa-p]').forEach(c=>c.onchange=()=>{const P2=people(access);const p={...(P2.get(c.dataset.saP)||{})};p[c.dataset.k]=c.value;P2.set(c.dataset.saP,p);save(P2);});
}
})();
