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
function claims(tok){try{const p=JSON.parse(new TextDecoder().decode(b64u.dec(tok.split('.')[1])));if(p.aud!==PROJECT||p.exp*1000<Date.now())return null;return p;}catch(e){return null;}}
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
      const k=Object.keys(acc.perms||{}).find(x=>lower(x)===e);if(!k)return false;const p=acc.perms[k]||{};return ['orders','porders','porders9'].some(s=>p[s]&&p[s]!=='none');};
    targets=(await listCol(tok,'push')).filter(d=>ok(d.email));
  }else return 0;
  let n=0;
  for(const t of targets){if(t.id===me.user_id)continue;for(const sub of t.subs||[]){try{const st=await sendPush(sub,{title,body,go,tag:q.kind==='msg'?'chat-'+q.chat:'order-'+(q.order||'')});if(st<300)n++;}catch(e){}}}
  return n;
}

export default {async fetch(req){
  const o=req.headers.get('Origin')||'';const allow=ORIGINS.includes(o)||/^http:\/\/localhost(:\d+)?$/.test(o)?o:ORIGINS[0];
  const cors={'Access-Control-Allow-Origin':allow,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'content-type, authorization','Vary':'Origin'};
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  const u=new URL(req.url);
  if(req.method==='GET')return new Response('Сервер уведомлений склада работает.',{headers:{...cors,'content-type':'text/plain; charset=utf-8'}});
  if(req.method!=='POST'||u.pathname!=='/notify')return new Response('not found',{status:404,headers:cors});
  const tok=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/,'');const me=claims(tok);
  if(!me)return new Response('no auth',{status:401,headers:cors});
  let q={};try{q=await req.json();}catch(e){}
  const n=await notify(tok,me,q);
  return new Response(JSON.stringify({sent:n}),{headers:{...cors,'content-type':'application/json'}});
}};
