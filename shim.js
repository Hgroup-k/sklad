/* Склад: отдельная версия. Даёт странице тот же window.claude.use(...), что и в Claude,
   но на своей базе Firebase (Firestore + вход через Google). Код страницы не меняется. */
(function(){
"use strict";
const cfg=window.SKLAD_FIREBASE_CONFIG;
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let resolveReady;const ready=new Promise(r=>resolveReady=r);
window.claude={use:async name=>{const api=await ready;return api?api[name]||null:null;}};

if('serviceWorker' in navigator){
  const hadCtl=!!navigator.serviceWorker.controller;let reloaded=false;
  /* новая версия программы подхватывается сама: страница один раз перезагружается */
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadCtl&&!reloaded){reloaded=true;location.reload();}});
  window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(r=>{setInterval(()=>r.update().catch(()=>{}),30*60*1000);}).catch(()=>{}));
}

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
/* ---- вход: имя пользователя + пароль (почта подставляется сама), первый вход = создание учётной записи ---- */
const UN=fs.collection('unames');
const unKey=n=>lower(n).replace(/\s+/g,' ');
const AERR={'auth/invalid-credential':'Неверное имя пользователя или пароль.','auth/wrong-password':'Неверный пароль.','auth/user-not-found':'Неверное имя пользователя или пароль.',
  'auth/too-many-requests':'Слишком много попыток. Подождите несколько минут.','auth/weak-password':'Пароль слишком короткий: нужно не меньше 6 знаков.',
  'auth/invalid-email':'Почта написана с ошибкой.','auth/network-request-failed':'Нет интернета.','auth/operation-not-allowed':'Вход по паролю ещё не включён в Firebase (владелец включает его один раз).'};
const aerr=e=>AERR[e&&e.code]||('Не получилось: '+((e&&(e.message||e.code))||e));
function fld2(id,label,type,ph){return '<label class="fld" style="text-align:left"><span>'+label+'</span><input id="'+id+'" type="'+(type||'text')+'" autocomplete="'+(type==='password'?'current-password':'username')+'"'+(ph?' placeholder="'+ph+'"':'')+'></label>';}
function showLogin(msg){
  const g=gate('<h2>Складской учёт</h2><form id="ag-f" style="display:grid;gap:10px;margin:10px 0">'+fld2('ag-u','Имя пользователя')+fld2('ag-p','Пароль','password')+
    '<p class="err" id="ag-err"'+(msg?'':' hidden')+'>'+esc(msg||'')+'</p><button type="submit" class="primary">Войти</button></form>'+
    '<p style="margin:8px 0"><button type="button" class="link" id="ag-reg">Первый вход: создать учётную запись</button></p>'+
    '<p style="margin:8px 0"><button type="button" class="link" id="ag-forgot">Забыли пароль?</button></p>'+
    '<p style="margin:14px 0 0"><button type="button" class="ghost" id="ag-in">Войти через Google</button></p>');
  const err=m=>{const e=g.querySelector('#ag-err');e.textContent=m||'';e.hidden=!m;};
  g.querySelector('#ag-in').onclick=signIn;
  g.querySelector('#ag-reg').onclick=()=>showRegister();
  g.querySelector('#ag-forgot').onclick=async()=>{const u=unKey(g.querySelector('#ag-u').value);if(!u){err('Впишите имя пользователя, и нажмите «Забыли пароль?» ещё раз.');return;}
    try{const s=await UN.doc(u).get();if(!s.exists){err('Такого имени пользователя нет.');return;}await auth.sendPasswordResetEmail(s.data().email);err('Письмо для смены пароля отправлено на почту '+maskMail(s.data().email)+'.');}catch(e){err(aerr(e));}};
  g.querySelector('#ag-f').onsubmit=async e=>{e.preventDefault();const u=unKey(g.querySelector('#ag-u').value),pw=g.querySelector('#ag-p').value;
    if(!u||!pw){err('Впишите имя пользователя и пароль.');return;}
    try{const s=await UN.doc(u).get();if(!s.exists){err('Неверное имя пользователя или пароль.');return;}await auth.signInWithEmailAndPassword(s.data().email,pw);}
    catch(x){err(aerr(x));}};
}
function maskMail(m){const [a,b]=String(m).split('@');return (a||'').slice(0,2)+'***@'+(b||'');}
function showRegister(){
  const g=gate('<h2>Создать учётную запись</h2><p class="muted" style="font-size:13px">Впишите почту, на которую владелец дал доступ, придумайте имя пользователя и пароль. Потом входить нужно будет только по имени и паролю.</p>'+
    '<form id="ag-f" style="display:grid;gap:10px;margin:10px 0">'+fld2('ag-e','Почта, на которую дали доступ','email','name@gmail.com')+fld2('ag-u','Имя пользователя (его будут видеть все)','text','например Миша')+
    fld2('ag-p','Пароль (не меньше 6 знаков)','password')+fld2('ag-p2','Пароль ещё раз','password')+'<p class="err" id="ag-err" hidden></p><button type="submit" class="primary">Создать</button></form>'+
    '<p><button type="button" class="link" id="ag-back">Назад ко входу</button></p>');
  const err=m=>{const e=g.querySelector('#ag-err');e.textContent=m||'';e.hidden=!m;};
  g.querySelector('#ag-back').onclick=()=>showLogin();
  g.querySelector('#ag-f').onsubmit=async e=>{e.preventDefault();
    const em=lower(g.querySelector('#ag-e').value),name=g.querySelector('#ag-u').value.trim().replace(/\s+/g,' '),pw=g.querySelector('#ag-p').value,pw2=g.querySelector('#ag-p2').value;
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em))return err('Впишите почту полностью.');
    if(name.length<2||name.length>30)return err('Имя пользователя: от 2 до 30 знаков.');
    if(pw.length<6)return err('Пароль: не меньше 6 знаков.');if(pw!==pw2)return err('Пароли не совпадают.');
    try{const s=await UN.doc(unKey(name)).get();if(s.exists&&lower(s.data().email)!==em)return err('Такое имя пользователя уже занято, придумайте другое.');}catch(x){return err(aerr(x));}
    pendingName={name,email:em};
    try{const c=await auth.createUserWithEmailAndPassword(em,pw);try{await claimName(c.user,name);}catch(x){}try{await c.user.sendEmailVerification();}catch(x){}}
    catch(x){pendingName=null;if(x.code==='auth/email-already-in-use')return err('С этой почтой уже входили. Если раньше входили через Google, нажмите «Назад ко входу» → «Войти через Google», и там программа попросит придумать имя и пароль. Если забыли пароль, нажмите «Забыли пароль?».');return err(aerr(x));}
  };
}
let pendingName=null;
async function claimName(u,name){
  const k=unKey(name);const ref=UN.doc(k);
  await fs.runTransaction(async t=>{const s=await t.get(ref);if(s.exists&&s.data().uid!==u.uid)throw {code:'taken'};t.set(ref,{uid:u.uid,email:lower(u.email),name});});
  await fs.doc('people/'+u.uid).set({name,uname:k,email:lower(u.email),at:new Date().toISOString()},{merge:true});
}
function showVerify(u){
  const g=gate('<h2>Подтвердите почту</h2><p>Мы отправили письмо на <b>'+esc(u.email)+'</b>. Откройте его и нажмите ссылку в письме (если письма нет, проверьте папку «Спам»). Потом вернитесь сюда и нажмите «Я подтвердил».</p>'+
    '<p class="err" id="ag-err" hidden></p><div style="display:grid;gap:8px"><button type="button" class="primary" id="ag-ok">Я подтвердил</button><button type="button" class="ghost" id="ag-again">Отправить письмо ещё раз</button><button type="button" class="link" id="ag-out">Выйти</button></div>');
  const err=m=>{const e=g.querySelector('#ag-err');e.textContent=m||'';e.hidden=!m;};
  g.querySelector('#ag-ok').onclick=async()=>{try{await u.reload();if(auth.currentUser.emailVerified){await auth.currentUser.getIdToken(true);location.reload();}else err('Почта ещё не подтверждена. Нажмите ссылку в письме.');}catch(x){err(aerr(x));}};
  g.querySelector('#ag-again').onclick=async()=>{try{await u.sendEmailVerification();err('Письмо отправлено ещё раз.');}catch(x){err(aerr(x));}};
  g.querySelector('#ag-out').onclick=()=>auth.signOut();
}
function askName(u,isGoogle){
  return new Promise(res=>{
    const g=gate('<h2>Придумайте имя пользователя</h2><p class="muted" style="font-size:13px">Это имя будут видеть все вместо вашей почты.'+(isGoogle?' Если задать пароль, потом можно входить просто по имени и паролю.':'')+'</p>'+
      '<form id="ag-f" style="display:grid;gap:10px;margin:10px 0">'+fld2('ag-u','Имя пользователя','text','например Миша')+(isGoogle?fld2('ag-p','Пароль для входа по имени (не меньше 6 знаков)','password'):'')+
      '<p class="err" id="ag-err" hidden></p><button type="submit" class="primary">Сохранить</button></form>');
    const err=m=>{const e=g.querySelector('#ag-err');e.textContent=m||'';e.hidden=!m;};
    g.querySelector('#ag-f').onsubmit=async e=>{e.preventDefault();const name=g.querySelector('#ag-u').value.trim().replace(/\s+/g,' ');const pe=g.querySelector('#ag-p');const pw=pe?pe.value:'';
      if(name.length<2||name.length>30)return err('Имя пользователя: от 2 до 30 знаков.');
      if(isGoogle&&pw&&pw.length<6)return err('Пароль: не меньше 6 знаков (или оставьте пустым).');
      try{await claimName(u,name);}catch(x){if(x&&x.code==='taken')return err('Такое имя уже занято, придумайте другое.');if(x&&/permission/.test(x.code||'')){res(name);return;}return err(aerr(x));}
      if(isGoogle&&pw){try{await u.linkWithCredential(firebase.auth.EmailAuthProvider.credential(u.email,pw));}catch(x){if(x.code!=='auth/provider-already-linked')alert('Имя сохранено, но пароль не задан: '+aerr(x));}}
      res(name);};
  });
}
let started=false;
auth.getRedirectResult().catch(()=>{});
const domReady=new Promise(r=>document.readyState==='loading'?document.addEventListener('DOMContentLoaded',r):r());
auth.onAuthStateChanged(async u=>{
  await domReady;
  if(!u){if(started){location.reload();return;}showLogin();return;}
  if(started&&me&&u.uid!==me.uid){location.reload();return;}
  me=u;const email=lower(u.email);
  const isGoogle=(u.providerData||[]).some(p=>p.providerId==='google.com');
  if(!u.emailVerified&&!isGoogle){showVerify(u);return;}
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
  let prof=null;try{const ps=await fs.doc('people/'+u.uid).get();prof=ps.exists?ps.data():null;}catch(e){}
  if(!prof||!prof.uname){
    let done=false;if(pendingName&&lower(pendingName.email)===email){try{await claimName(u,pendingName.name);done=true;}catch(e){}}
    if(!done)await askName(u,isGoogle);
    gate('<h2>Складской учёт</h2><p>Загрузка…</p>');
  }else fs.doc('people/'+u.uid).set({email,at:new Date().toISOString()},{merge:true}).catch(()=>{});
  ACC.onSnapshot(s=>{if(!s.exists)return;const nr=roleOf(s.data(),email);access=s.data();if(nr!==role)location.reload();},()=>{});
  window.SKLAD_ME_EMAIL=email;
  window.SKLAD_ID_TOKEN=()=>auth.currentUser?auth.currentUser.getIdToken():Promise.resolve('');
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
      sections:async()=>{const all=l=>Object.fromEntries(SEC().map(([k])=>[k,l]));if(canWrite)return all('edit');if(role.startsWith('custom:'))return JSON.parse(role.slice(7));return all('view');},
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
  fs.doc('people/'+me.uid).get().then(s=>{const n=s.exists&&s.data().name;const b=$('sa-out');if(n&&b)b.title=n;window.SKLAD_ME_NAME=n||'';}).catch(()=>{});
  brand.appendChild(bar);
  $('sa-out').onclick=()=>{if(confirm('Выйти из программы?'))auth.signOut();};
  $('sa-install').onclick=async()=>{if(!installEvt)return;installEvt.prompt();try{await installEvt.userChoice;}catch(e){}installEvt=null;$('sa-install').hidden=true;};
  const ab=$('sa-acc');if(ab)ab.onclick=openAccessFresh;
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
const HINT={chatall:'автоматически состоит в общем чате',chatord:'вопросы по заказам',input:'приход, отгрузка, переучёт, перемещения',orders:'заказы и выдача со склада',returns:'возвраты и приёмка',journal:'все записи, правка и удаление',porders:'взять в работу, отметить готов',catalog:'товары, размеры, оформители'};
function SEC(){return (window.SKLAD_TABS||[]).map(t=>[t.k,t.l,HINT[t.k]||'',t.ed?1:0,t.g]);}
const LV=[['edit','Редактирует'],['view','Просмотр'],['none','Нет доступа']];
const OLD={input:'stock',journal:'stock',stock:'stock',period:'stock',sizes:'stock',months:'stock'};
const norm=(v,canEdit)=>v===true||v==='edit'?(canEdit?'edit':'view'):v==='view'?'view':'none';
const isChat=k=>k==='chatall'||k==='chatord';
function people(a){
  const out=new Map();const all=l=>{const p={};SEC().forEach(([k,,,e])=>p[k]=l==='edit'&&!e?'view':l);return p;};
  for(const e of a.viewers||[])out.set(lower(e),all('view'));
  for(const [e,p] of Object.entries(a.perms||{})){const q={};SEC().forEach(([k,,,ed])=>q[k]=norm(k in p?p[k]:isChat(k)?'edit':p[OLD[k]],ed));out.set(lower(e),q);}
  for(const e of a.editors||[])out.set(lower(e),all('edit'));
  return out;
}
const grpOf=k=>(SEC().find(t=>t[0]===k)||[])[4]||'';
const PRESET={view:k=>'view',edit:k=>'edit',orders:k=>k==='orders'?'edit':'view',ordersOnly:k=>k==='orders'?'edit':'none',
  office:k=>grpOf(k)==='Офис'?'edit':'none',p11:k=>grpOf(k)==='Производство 11'?'edit':'none',p9:k=>grpOf(k)==='Производство 9'?'edit':'none'};
function summary(p){const v=SEC().map(([k])=>p[k]);if(SEC().every(([k,,,e])=>p[k]===(e?'edit':'view')))return 'всё редактирует';if(v.every(x=>x==='view'))return 'всё только смотрит';return 'по разделам';}
const OPEN=new Set();let PEOPLE={};
async function loadPeople(){try{const q=await fs.collection('people').get();PEOPLE={};q.forEach(d=>{const x=d.data();if(x.email)PEOPLE[lower(x.email)]=x.name||'';});}catch(e){}}
async function openAccessFresh(){await loadPeople();openAccess();}
function openAccess(){
  let d=$('sa-access');if(!d){d=document.createElement('div');d.id='sa-access';document.body.appendChild(d);}
  const a=access||{};const P=people(a);
  const rows=[...P.entries()];
  d.innerHTML='<div class="ag-card" style="max-width:560px;text-align:left"><div class="panel-head" style="margin-bottom:8px"><h2>Доступ к складу</h2><button type="button" class="link" id="sa-x">Закрыть</button></div>'+
    '<p class="muted" style="margin:0 0 12px;font-size:13px">Версия программы: '+esc(window.SKLAD_VERSION||'')+'. Владелец: <b>'+esc(PEOPLE[lower(a.owner)]||a.owner)+'</b>. Добавьте почту человека. При первом входе он сам создаст имя пользователя и пароль. Нажмите на человека, чтобы открыть его права. Для каждой вкладки: <b>Редактирует</b>, <b>Просмотр</b> или <b>Нет доступа</b> (вкладки не видно совсем). Изменения сохраняются сразу.</p>'+
    (rows.length?rows.map(([e,p])=>'<details class="sa-person" data-sa-d="'+esc(e)+'"'+(OPEN.has(e)?' open':'')+'><summary class="sa-ph"><span style="min-width:0"><b>'+esc(PEOPLE[e]||'ещё не входил')+'</b> <span class="muted" style="font-size:12px;word-break:break-all">'+esc(e)+' · '+summary(p)+'</span></span><button type="button" class="ghost del sa-b" data-sa-rm="'+esc(e)+'" style="margin-left:auto">Убрать</button></summary>'+
      SEC().map(([k,l,t,ed,g],i,A)=>(i===0||A[i-1][4]!==g?'<div class="sa-grp">'+esc(g)+'</div>':'')+'<label class="sa-row"><span>'+esc(l)+(t?'<br><small class="muted">'+esc(t)+'</small>':'')+'</span><select data-sa-p="'+esc(e)+'" data-k="'+k+'">'+LV.filter(([v])=>ed||v!=='edit').map(([v,n])=>'<option value="'+v+'"'+(p[k]===v?' selected':'')+'>'+n+'</option>').join('')+'</select></label>').join('')+'</details>').join('')
      :'<p class="muted">Пока доступ есть только у вас.</p>')+
    '<h3 style="margin:16px 0 6px">Добавить человека</h3><div class="filters" style="margin:0"><label class="fld wide"><span>Почта</span><input type="text" id="sa-email" inputmode="email" placeholder="name@gmail.com"></label>'+
    '<label class="fld"><span>Начать с</span><select id="sa-role"><option value="view">всё только смотрит</option><option value="edit">всё редактирует</option><option value="orders">заказы редактирует, остальное смотрит</option><option value="ordersOnly">только заказы, остального не видит</option><option value="office">только Офис (заказы и возвраты)</option><option value="p11">только Производство 11</option><option value="p9">только Производство 9</option></select></label>'+
    '<label class="fld"><span>&nbsp;</span><button type="button" class="primary" id="sa-add" style="padding:8px 16px">Добавить</button></label></div><p class="muted" style="font-size:12px;margin:6px 0 0">После добавления права по каждому разделу можно поменять выше.</p><p class="err" id="sa-err" hidden></p>'+
    '<h3 style="margin:18px 0 6px">Перенос данных</h3><p class="muted" style="margin:0 0 8px;font-size:13px">Загрузите файл копии склада (.json): заказы, возвраты, журнал, справочники и план запишутся в эту базу. Записи с теми же номерами заменятся, остальное не трогается.</p>'+
    '<input type="file" id="sa-file" accept=".json,application/json"><p class="hint" id="sa-imp"></p></div>';
  d.hidden=false;
  const err=m=>{const e=$('sa-err');e.textContent=m||'';e.hidden=!m;};
  const save=async P2=>{
    const editors=[],viewers=[],perms={};
    for(const [e,p] of P2){const v=SEC().map(([k])=>p[k]);
      if(SEC().every(([k,,,ed])=>p[k]===(ed?'edit':'view')))editors.push(e);else if(v.every(x=>x==='view'))viewers.push(e);else{perms[e]={};SEC().forEach(([k])=>perms[e][k]=p[k]);}}
    try{await ACC.update({editors,viewers,perms});access={...access,editors,viewers,perms};openAccess();}catch(x){err('Не удалось сохранить: '+(x.code||x.message));}
  };
  $('sa-x').onclick=()=>{d.hidden=true;};
  $('sa-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;const h=$('sa-imp');
    try{const snap=JSON.parse(await f.text());h.textContent='Переносим…';const n=await importSnap(snap,k=>h.textContent='Переносим… записано '+k);h.textContent='Готово: перенесено '+n+' записей. Страница обновится.';setTimeout(()=>location.reload(),1500);}
    catch(x){h.textContent='Не получилось: '+(x.message||x.code||x);}};
  $('sa-add').onclick=()=>{const e=lower($('sa-email').value);if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)){err('Впишите почту полностью, например name@gmail.com');return;}
    if(e===lower(a.owner)){err('Это ваш адрес, у вас и так все права.');return;}
    const pr=PRESET[$('sa-role').value];const p={};SEC().forEach(([k,,,ed])=>{const l=isChat(k)&&$('sa-role').value!=='view'?'edit':pr(k);p[k]=l==='edit'&&!ed?'view':l;});
    const P2=people(access);P2.set(e,p);save(P2);};
  d.querySelectorAll('[data-sa-d]').forEach(x=>x.addEventListener('toggle',()=>{if(x.open)OPEN.add(x.dataset.saD);else OPEN.delete(x.dataset.saD);}));
  d.querySelectorAll('[data-sa-rm]').forEach(b=>b.onclick=ev=>{ev.preventDefault();ev.stopPropagation();if(!b.classList.contains('confirm')){b.classList.add('confirm');b.textContent='Точно?';return;}const P2=people(access);P2.delete(b.dataset.saRm);save(P2);});
  d.querySelectorAll('[data-sa-p]').forEach(c=>c.onchange=()=>{const P2=people(access);const p={...(P2.get(c.dataset.saP)||{})};p[c.dataset.k]=c.value;P2.set(c.dataset.saP,p);save(P2);});
}
})();
