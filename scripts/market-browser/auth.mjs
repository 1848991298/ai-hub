// 会话资料仅本机 AES-GCM 加密保存；密钥由当前用户的 macOS 登录钥匙串保管。
// 凭据从不写入运营数据库、日志、HTTP 响应或源码导出。
import{spawnSync}from'node:child_process';import{randomBytes,createCipheriv,createDecipheriv}from'node:crypto';import{readFile,writeFile,rename,chmod}from'node:fs/promises';import{join}from'node:path';import{PORTALS}from'./portals.mjs';
const account='ai-hub-market',service=process.env.AI_HUB_MARKET_KEYCHAIN_SERVICE||'com.aihub.desktop.market.auth-state.v1';
function key(){
 if(process.platform!=='darwin')throw new Error('auth_key_unavailable');
 const find=()=>spawnSync('/usr/bin/security',['find-generic-password','-a',account,'-s',service,'-w'],{encoding:'utf8'});
 let r=find();if(r.status!==0){const secret=randomBytes(32).toString('hex');spawnSync('/usr/bin/security',['-i'],{input:`add-generic-password -a ${account} -s ${service} -w ${secret}\nquit\n`,encoding:'utf8'});r=find();}
 if(r.status!==0||!/^[a-f0-9]{64}$/.test(r.stdout.trim()))throw new Error('auth_key_unavailable');return Buffer.from(r.stdout.trim(),'hex');
}
function path(root,p){if(!PORTALS[p])throw new Error('unsupported provider');return join(root,'.local/market-browser',p,'auth-state.enc');}
export function encrypt(value,secret,provider){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(Buffer.from('ai-hub:'+provider));const payload=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),payload:payload.toString('base64')});}
export function decrypt(raw,secret,provider){const v=JSON.parse(raw);if(v.v!==1)throw new Error('auth_restore_failed');const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(v.iv,'base64'));decipher.setAAD(Buffer.from('ai-hub:'+provider));decipher.setAuthTag(Buffer.from(v.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(v.payload,'base64')),decipher.final()]).toString('utf8'));}
export async function restoreAuth(context,root,provider){let raw;try{raw=await readFile(path(root,provider),'utf8');}catch(e){if(e.code==='ENOENT')return false;throw new Error('auth_restore_failed');}let v;try{v=decrypt(raw,key(),provider);}catch{throw new Error('auth_restore_failed');}if(v.provider!==provider)throw new Error('auth_restore_failed');await context.setStorageState(v.storage);await context.addInitScript(({sessions})=>{const values=sessions[location.origin];if(values)for(const[k,v]of Object.entries(values))if(sessionStorage.getItem(k)===null)sessionStorage.setItem(k,v);},{sessions:v.sessions});return true;}
export async function captureSessions(context,origin){const sessions={};for(const p of context.pages())for(const f of p.frames()){try{if(new URL(f.url()).origin!==origin)continue;const v=await f.evaluate(()=>Object.fromEntries(Object.entries(sessionStorage)));if(Object.keys(v).length)sessions[origin]={...(sessions[origin]||{}),...v};}catch{}}return sessions;}
async function writeAuth(context,root,provider){const sessions=await captureSessions(context,new URL(PORTALS[provider].url).origin);
 const storage=await context.storageState({indexedDB:true});const raw=encrypt({provider,storage,sessions},key(),provider);const dest=path(root,provider),temp=dest+'.tmp';await writeFile(temp,raw,{mode:0o600});await chmod(temp,0o600);await rename(temp,dest);
}

const pendingSaves=new WeakMap();
export async function saveAuth(context,root,provider){
 const previous=pendingSaves.get(context)||Promise.resolve();
 const next=previous.catch(()=>{}).then(()=>writeAuth(context,root,provider));pendingSaves.set(context,next);
 try{return await next;}finally{if(pendingSaves.get(context)===next)pendingSaves.delete(context);}
}
export function confirmsAuthentication(provider,raw,value){
 let u;try{u=new URL(raw);}catch{return false;}
 if(!PORTALS[provider]||u.origin!==new URL(PORTALS[provider].url).origin||!value?.data)return false;
 if(Number(value.code)!==0&&value.code!=='BE000000')return false;
 const data=value.data;
 if(provider==='honor')return u.pathname==='/portal/card/userPermissions'&&typeof data==='object'&&Object.hasOwn(data,'permissions')&&Object.hasOwn(data,'cards');
 if(provider==='vivo')return u.pathname==='/webapi/app/list-app'&&Array.isArray(data)&&data.some(a=>a.packageName==='com.jryx.isho');
 if(provider==='xiaomi'){const rows=u.pathname==='/pltapi/uiue/myitems/myitemsV1'?data.appItemList:u.pathname==='/pltapi/uiue/myitems/listApp'?data:null;return Array.isArray(rows)&&rows.some(a=>a.packageName==='com.jryx.isho');}
 return false;
}
export function watchAuthentication(context,root,provider,persistState=saveAuth){
 let timer,confirmed=false,saved=false;
 const persist=async()=>{timer=undefined;try{await persistState(context,root,provider);saved=true;}catch{}};
 const observer=async response=>{try{
  const u=new URL(response.url());if(u.origin!==new URL(PORTALS[provider].url).origin||!['/portal/card/userPermissions','/webapi/app/list-app','/pltapi/uiue/myitems/myitemsV1','/pltapi/uiue/myitems/listApp'].includes(u.pathname))return;
  if(!confirmsAuthentication(provider,u.href,await response.json()))return;
  confirmed=true;if(timer)clearTimeout(timer);timer=setTimeout(persist,1000);
 }catch{}};
 context.on('response',observer);
 return {get saved(){return saved;},async finish(){context.off('response',observer);if(timer)clearTimeout(timer);if(confirmed&&!saved)await persist();}};
}
