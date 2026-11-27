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
function openAccess(){
  let d=$('sa-access');if(!d){d=document.createElement('div');d.id='sa-access';document.body.appendChild(d);}
  const a=access||{};
  const rows=[...(a.editors||[]).map(e=>[e,'editor']),...(a.viewers||[]).map(e=>[e,'viewer'])];
  d.innerHTML='<div class="ag-card" style="max-width:520px;text-align:left"><div class="panel-head" style="margin-bottom:8px"><h2>Доступ к складу</h2><button type="button" class="link" id="sa-x">Закрыть</button></div>'+
    '<p class="muted" style="margin:0 0 12px;font-size:13px">Владелец: <b>'+esc(a.owner)+'</b>. Человек входит своим Google-аккаунтом. «Может вносить» даёт право записывать и менять, «Только просмотр» даёт только смотреть. Проверку делает сама база.</p>'+
    (rows.length?'<div class="tbl-wrap" style="margin-bottom:12px"><table><tbody>'+rows.map(([e,r])=>'<tr><td>'+esc(e)+'</td><td><select data-sa-role="'+esc(e)+'"><option value="editor"'+(r==='editor'?' selected':'')+'>может вносить</option><option value="viewer"'+(r==='viewer'?' selected':'')+'>только просмотр</option></select></td><td class="act"><button type="button" class="ghost del" data-sa-rm="'+esc(e)+'">Убрать</button></td></tr>').join('')+'</tbody></table></div>':'<p class="muted">Пока доступ есть только у вас.</p>')+
    '<div class="filters" style="margin:0"><label class="fld wide"><span>Почта Google</span><input type="text" id="sa-email" inputmode="email" placeholder="name@gmail.com"></label>'+
    '<label class="fld"><span>Права</span><select id="sa-role"><option value="editor">может вносить</option><option value="viewer">только просмотр</option></select></label>'+
    '<label class="fld"><span>&nbsp;</span><button type="button" class="primary" id="sa-add" style="padding:8px 16px">Добавить</button></label></div><p class="err" id="sa-err" hidden></p>'+
    '<h3 style="margin:18px 0 6px">Перенос данных</h3><p class="muted" style="margin:0 0 8px;font-size:13px">Загрузите файл копии склада (.json): заказы, возвраты, журнал, справочники и план запишутся в эту базу. Записи с теми же номерами заменятся, остальное не трогается.</p>'+
    '<input type="file" id="sa-file" accept=".json,application/json"><p class="hint" id="sa-imp"></p></div>';
  d.hidden=false;
  const err=m=>{const e=$('sa-err');e.textContent=m||'';e.hidden=!m;};
  const save=async(editors,viewers)=>{try{await ACC.update({editors,viewers});access={...access,editors,viewers};openAccess();}catch(e){err('Не удалось сохранить: '+(e.code||e.message));}};
  const lists=()=>({ed:(access.editors||[]).map(lower),vw:(access.viewers||[]).map(lower)});
  $('sa-x').onclick=()=>{d.hidden=true;};
  $('sa-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;const h=$('sa-imp');
    try{const snap=JSON.parse(await f.text());h.textContent='Переносим…';const n=await importSnap(snap,k=>h.textContent='Переносим… записано '+k);h.textContent='Готово: перенесено '+n+' записей. Страница обновится.';setTimeout(()=>location.reload(),1500);}
    catch(x){h.textContent='Не получилось: '+(x.message||x.code||x);}};
  $('sa-add').onclick=()=>{const e=lower($('sa-email').value);if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)){err('Впишите почту полностью, например name@gmail.com');return;}
    if(e===lower(access.owner)){err('Это ваш адрес, у вас и так все права.');return;}
    let {ed,vw}=lists();ed=ed.filter(x=>x!==e);vw=vw.filter(x=>x!==e);($('sa-role').value==='editor'?ed:vw).push(e);save(ed,vw);};
  d.querySelectorAll('[data-sa-rm]').forEach(b=>b.onclick=()=>{if(!b.classList.contains('confirm')){b.classList.add('confirm');b.textContent='Точно?';return;}const e=b.dataset.saRm;const {ed,vw}=lists();save(ed.filter(x=>x!==e),vw.filter(x=>x!==e));});
  d.querySelectorAll('[data-sa-role]').forEach(s=>s.onchange=()=>{const e=s.dataset.saRole;let {ed,vw}=lists();ed=ed.filter(x=>x!==e);vw=vw.filter(x=>x!==e);(s.value==='editor'?ed:vw).push(e);save(ed,vw);});
}
})();
