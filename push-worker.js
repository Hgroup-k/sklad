/* Сервер уведомлений склада (Cloudflare Worker, бесплатно).
   Программа сообщает сюда «новое сообщение» или «заказ готов», а этот код рассылает push-уведомления
   на телефоны и компьютеры. Кому слать, он узнаёт из базы склада с правами того, кто отправил:
   чужие чаты он прочитать не может. Ключи VAPID вписываются ниже (их выдаёт Claude, в репозиторий их не кладём). */
const PROJECT='sklad-01';
const ORIGINS=['https://hgroup-k.github.io'];
const SUBJECT='https://hgroup-k.github.io/sklad/';
const VAPID_PUBLIC='__VAPID_PUBLIC__';
const VAPID_PRIVATE_JWK=__VAPID_PRIVATE_JWK__;

const FS='https://firestore.googleapis.com/v1/projects/'+PROJECT+'/databases/(default)/documents';
const enc=new TextEncoder();
const b64u={
  enc:b=>{let s='';const a=new Uint8Array(b);for(let i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');},
  dec:s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');s+='='.repeat((4-s.length%4)%4);const b=atob(s);return Uint8Array.from(b,c=>c.charCodeAt(0));}
};
const cat=(...a)=>{const n=a.reduce((x,y)=>x+y.length,0);const o=new Uint8Array(n);let i=0;for(const x of a){o.set(x,i);i+=x.length;}return o;};
async function hmac(key,data){const k=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',k,data));}

/* RFC 8291: шифрование содержимого push (aes128gcm) */
async function encryptPayload(sub,text){
  const uaPub=b64u.dec(sub.keys.p256dh),auth=b64u.dec(sub.keys.auth);
  const as=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const asPub=new Uint8Array(await crypto.subtle.exportKey('raw',as.publicKey));
  const uaKey=await crypto.subtle.importKey('raw',uaPub,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const ecdh=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:uaKey},as.privateKey,256));
  const prkKey=await hmac(auth,ecdh);
  const ikm=(await hmac(prkKey,cat(enc.encode('WebPush: info\0'),uaPub,asPub,new Uint8Array([1])))).slice(0,32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const prk=await hmac(salt,ikm);
  const cek=(await hmac(prk,cat(enc.encode('Content-Encoding: aes128gcm\0'),new Uint8Array([1])))).slice(0,16);
  const nonce=(await hmac(prk,cat(enc.encode('Content-Encoding: nonce\0'),new Uint8Array([1])))).slice(0,12);
  const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,cat(enc.encode(text),new Uint8Array([2]))));
  const rs=new Uint8Array([0,0,16,0]);
  return cat(salt,rs,new Uint8Array([asPub.length]),asPub,ct);
}
/* RFC 8292: подпись VAPID */
let vkey=null;
async function vapid(endpoint){
  if(!vkey)vkey=await crypto.subtle.importKey('jwk',VAPID_PRIVATE_JWK,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const aud=new URL(endpoint).origin;
  const h=b64u.enc(enc.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
  const p=b64u.enc(enc.encode(JSON.stringify({aud,exp:Math.floor(Date.now()/1000)+12*3600,sub:SUBJECT})));
  const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},vkey,enc.encode(h+'.'+p));
  return 'vapid t='+h+'.'+p+'.'+b64u.enc(sig)+', k='+VAPID_PUBLIC;
}
async function sendPush(sub,msg){
  const body=await encryptPayload(sub,JSON.stringify(msg));
  const r=await fetch(sub.endpoint,{method:'POST',headers:{'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:'86400',Urgency:'high',Authorization:await vapid(sub.endpoint)},body});
  return r.status;
}

/* чтение базы с правами отправителя */
function val(v){if(!v)return null;if('stringValue' in v)return v.stringValue;if('integerValue' in v)return Number(v.integerValue);if('doubleValue' in v)return v.doubleValue;if('booleanValue' in v)return v.booleanValue;
  if('nullValue' in v)return null;if('arrayValue' in v)return (v.arrayValue.values||[]).map(val);if('mapValue' in v)return obj(v.mapValue.fields||{});if('timestampValue' in v)return v.timestampValue;return null;}
function obj(f){const o={};for(const k in f)o[k]=val(f[k]);return o;}
async function getDoc(tok,path){const r=await fetch(FS+'/'+path,{headers:{Authorization:'Bearer '+tok}});if(!r.ok)return null;const j=await r.json();return obj(j.fields||{});}
async function listCol(tok,path){const out=[];let pt='';do{const r=await fetch(FS+'/'+path+'?pageSize=300'+(pt?'&pageToken='+pt:''),{headers:{Authorization:'Bearer '+tok}});if(!r.ok)break;const j=await r.json();for(const d of j.documents||[])out.push({id:d.name.split('/').pop(),...obj(d.fields||{})});pt=j.nextPageToken||'';}while(pt);return out;}
/* проверка входа: подпись токена Firebase ключами Google */
let JWKS=null,JWKS_AT=0;
async function claims(tok){
  try{const [h,p,sg]=tok.split('.');const H=JSON.parse(new TextDecoder().decode(b64u.dec(h)));const P=JSON.parse(new TextDecoder().decode(b64u.dec(p)));
    if(P.aud!==PROJECT||P.iss!=='https://securetoken.google.com/'+PROJECT||P.exp*1000<Date.now()||!P.sub)return null;
    if(!JWKS||Date.now()-JWKS_AT>3600e3){const r=await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');JWKS=(await r.json()).keys||[];JWKS_AT=Date.now();}
    const jwk=JWKS.find(k=>k.kid===H.kid);if(!jwk)return null;
    const key=await crypto.subtle.importKey('jwk',{kty:jwk.kty,n:jwk.n,e:jwk.e,alg:'RS256',ext:true},{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,b64u.dec(sg),enc.encode(h+'.'+p));return ok?{...P,user_id:P.user_id||P.sub}:null;}catch(e){return null;}}
/* 6-значный код на почту: без хранения, код = подпись (uid, почта, 10-минутное окно) */
async function codeFor(env,uid,email,win){const m=await hmac(enc.encode(env.CODE_SECRET),enc.encode(uid+'|'+lower(email)+'|'+win));const n=((m[0]<<24)|(m[1]<<16)|(m[2]<<8)|m[3])>>>0;return String(n%1000000).padStart(6,'0');}
async function sendCode(env,me){
  if(!env.BREVO_KEY||!env.SENDER_EMAIL||!env.CODE_SECRET)return {error:'not_configured'};
  const code=await codeFor(env,me.user_id,me.email,Math.floor(Date.now()/600000));
  const html='<div style="font-family:Arial,sans-serif;font-size:16px">Ваш код для программы «Склад»:<div style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:14px 0">'+code+'</div>Код действует 10 минут. Если вы не создавали аккаунт, просто удалите это письмо.</div>';
  const r=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':env.BREVO_KEY,'content-type':'application/json',accept:'application/json'},
    body:JSON.stringify({sender:{email:env.SENDER_EMAIL,name:'Склад'},to:[{email:me.email}],subject:'Код подтверждения: '+code,htmlContent:html})});
  return r.ok?{ok:true}:{error:'send_failed',detail:(await r.text()).slice(0,200)};
}
/* токен Google для служебного аккаунта Firebase (чтобы отметить почту подтверждённой) */
function pem2der(pem){return b64u.dec(pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,'').replace(/\+/g,'-').replace(/\//g,'_'));}
async function saToken(env){const sa=JSON.parse(env.SA_JSON);const now=Math.floor(Date.now()/1000);
  const h=b64u.enc(enc.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));const p=b64u.enc(enc.encode(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
  const key=await crypto.subtle.importKey('pkcs8',pem2der(sa.private_key),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sg=b64u.enc(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc.encode(h+'.'+p)));
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='+h+'.'+p+'.'+sg});
  const j=await r.json();if(!j.access_token)throw new Error('sa token');return j.access_token;}
async function verifyCode(env,me,code){
  if(!env.CODE_SECRET||!env.SA_JSON)return {error:'not_configured'};
  /* не больше 5 попыток за 10 минут на один аккаунт */
  try{const ck=new Request('https://limit.local/'+me.user_id+'/'+Math.floor(Date.now()/600000));const c=caches.default;const hit=await c.match(ck);const n=hit?Number(await hit.text())||0:0;
    if(n>=5)return {error:'too_many'};await c.put(ck,new Response(String(n+1),{headers:{'cache-control':'max-age=700'}}));}catch(e){}
  const w=Math.floor(Date.now()/600000);const ok=(await codeFor(env,me.user_id,me.email,w))===code||(await codeFor(env,me.user_id,me.email,w-1))===code;
  if(!ok)return {error:'bad_code'};
  const at=await saToken(env);
  const r=await fetch('https://identitytoolkit.googleapis.com/v1/projects/'+PROJECT+'/accounts:update',{method:'POST',headers:{authorization:'Bearer '+at,'content-type':'application/json'},body:JSON.stringify({localId:me.user_id,emailVerified:true})});
  return r.ok?{ok:true}:{error:'verify_failed',detail:(await r.text()).slice(0,200)};
}
const lower=s=>String(s||'').trim().toLowerCase();

async function notify(tok,me,q){
  let targets=[];let title=String(q.title||'Склад').slice(0,80),body=String(q.body||'').slice(0,200),go='';
  if(q.kind==='msg'){
    go='chat';
    const sender=await getDoc(tok,'people/'+me.user_id);const name=(sender&&sender.name)||'';
    if(q.chat==='all'){targets=await listCol(tok,'push');title='Общий чат';body=(name?name+': ':'')+body;}
    else{const c=await getDoc(tok,'chats/'+q.chat);if(!c||!(c.members||[]).includes(me.user_id))return 0;
      if(c.type==='dm'){title=name||'Сообщение';}else{title=c.name||'Группа';body=(name?name+': ':'')+body;}
      for(const u of c.members){const d=await getDoc(tok,'push/'+u);if(d)targets.push({id:u,...d});}}
  }else if(q.kind==='order'){
    go='orders';
    const acc=await getDoc(tok,'access/main');if(!acc)return 0;
    const ok=e=>{e=lower(e);if(lower(acc.owner)===e||(acc.editors||[]).map(lower).includes(e)||(acc.viewers||[]).map(lower).includes(e))return true;
      const k=Object.keys(acc.perms||{}).find(x=>lower(x)===e);if(!k)return false;const p=acc.perms[k]||{};return ['orders','porders','porders9','sorders'].some(s=>p[s]&&p[s]!=='none');};
    targets=(await listCol(tok,'push')).filter(d=>ok(d.email));
  }else if(q.kind==='buy'){
    go='buy';
    const acc=await getDoc(tok,'access/main');if(!acc)return 0;
    const ok=e=>{e=lower(e);if(lower(acc.owner)===e||(acc.editors||[]).map(lower).includes(e))return true;
      const k=Object.keys(acc.perms||{}).find(x=>lower(x)===e);if(!k)return false;const p=acc.perms[k]||{};return ['buy','mstock'].some(s=>p[s]&&p[s]!=='none');};
    targets=(await listCol(tok,'push')).filter(d=>ok(d.email));
  }else return 0;
  let n=0;
  for(const t of targets){if(t.id===me.user_id)continue;for(const sub of t.subs||[]){try{const st=await sendPush(sub,{title,body,go,tag:q.kind==='msg'?'chat-'+q.chat:q.kind==='buy'?'buy':'order-'+(q.order||'')});if(st<300)n++;}catch(e){}}}
  return n;
}

/* расшифровка голосовых: Workers AI (бесплатно до лимита в день), нужна привязка AI */
async function stt(env,q){
  if(!env.AI)return {error:'no_ai'};
  const m=/^data:([^;,]*)[^,]*,(.*)$/.exec(String(q.audio||''));if(!m)return {error:'bad_audio'};
  const b64=m[2];if(b64.length>14e6)return {error:'too_big'};
  let r,err='';
  try{r=await env.AI.run('@cf/openai/whisper-large-v3-turbo',{audio:b64,language:q.lang||undefined,vad_filter:true});}catch(e){err=String(e&&e.message||e);}
  if(!r||!r.text){try{const bin=atob(b64);const a=new Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);r=await env.AI.run('@cf/openai/whisper',{audio:a});}catch(e){err+=' | '+String(e&&e.message||e);}}
  if(!r||typeof r.text!=='string')return {error:'ai_failed',detail:err.slice(0,300)};
  return {ok:true,text:r.text.trim().slice(0,4000)};
}
/* описание видео по кадрам (картинка 2×2, кадры по порядку). Пробуем несколько бесплатных моделей Workers AI по очереди */
async function vis(env,q){
  if(!env.AI)return {error:'no_ai'};
  const dataUrl=String(q.image||'');const m=/^data:[^,]*,(.*)$/.exec(dataUrl);if(!m)return {error:'bad_image'};if(m[1].length>6e6)return {error:'too_big'};
  const bin=atob(m[1]);const img=new Array(bin.length);for(let i=0;i<bin.length;i++)img[i]=bin.charCodeAt(i);
  const ru=(q.lang||'ru')==='ru';
  const prompt='These are 4 frames from one video, in time order (left to right, top to bottom). Describe what is happening: people, actions, objects, place. 2-4 sentences.'+(ru?' Answer in Russian.':'');
  let err='';const pick=r=>String((r&&(r.response||r.description||r.text||(r.result&&r.result.response)))||'').trim();
  try{const r=await env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct',{messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:dataUrl}}]}],max_tokens:300});const t=pick(r);if(t)return {ok:true,text:t.slice(0,2000)};}catch(e){err+='llama4: '+String(e&&e.message||e)+' | ';}
  for(let k=0;k<2;k++){try{const r=await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct',{messages:[{role:'user',content:prompt}],image:img,max_tokens:300});const t=pick(r);if(t)return {ok:true,text:t.slice(0,2000)};break;}
    catch(e){const s=String(e&&e.message||e);err+='llama3.2: '+s+' | ';if(k===0&&/agree|licen|5016/i.test(s)){try{await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct',{prompt:'agree'});}catch(_){}continue;}break;}}
  for(const model of ['@cf/llava-hf/llava-1.5-7b-hf','@cf/unum/uform-gen2-qwen-500m']){
    try{const r=await env.AI.run(model,{image:img,prompt,max_tokens:250});const t=pick(r);if(t)return {ok:true,text:t.slice(0,2000)};}catch(e){err+=model+': '+String(e&&e.message||e)+' | ';}}
  return {error:'ai_failed',detail:err.slice(0,600)};
}
export default {async fetch(req,env){env=env||{};
  const o=req.headers.get('Origin')||'';const allow=ORIGINS.includes(o)||/^http:\/\/localhost(:\d+)?$/.test(o)?o:ORIGINS[0];
  const cors={'Access-Control-Allow-Origin':allow,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'content-type, authorization','Vary':'Origin'};
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  const u=new URL(req.url);
  if(req.method==='GET')return new Response('Сервер уведомлений склада работает.',{headers:{...cors,'content-type':'text/plain; charset=utf-8'}});
  if(req.method!=='POST'||!['/notify','/code','/verify','/stt','/vis'].includes(u.pathname))return new Response('not found',{status:404,headers:cors});
  const tok=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/,'');const me=await claims(tok);
  if(!me)return new Response(JSON.stringify({error:'no_auth'}),{status:401,headers:cors});
  let q={};try{q=await req.json();}catch(e){}
  if(u.pathname==='/code'||u.pathname==='/verify'){
    let res;try{res=u.pathname==='/code'?await sendCode(env,me):await verifyCode(env,me,String(q.code||''));}catch(e){res={error:'server',detail:String(e&&e.message||e)};}
    return new Response(JSON.stringify(res),{status:res.ok?200:400,headers:{...cors,'content-type':'application/json'}});
  }
  if(u.pathname==='/stt'||u.pathname==='/vis'){let res;try{res=u.pathname==='/stt'?await stt(env,q):await vis(env,q);}catch(e){res={error:'server',detail:String(e&&e.message||e)};}
    return new Response(JSON.stringify(res),{status:res.ok?200:400,headers:{...cors,'content-type':'application/json'}});}
  const n=await notify(tok,me,q);
  return new Response(JSON.stringify({sent:n}),{headers:{...cors,'content-type':'application/json'}});
}};
