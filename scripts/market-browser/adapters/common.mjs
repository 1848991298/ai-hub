export const PACKAGE='com.jryx.isho';
export const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
export function range(){const d=new Date(today()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-1);const to=d.toISOString().slice(0,10);d.setUTCDate(d.getUTCDate()-29);return {from:d.toISOString().slice(0,10),to};}
export async function read(page,path,params={},body){try{return await page.evaluate(async({path,params,body})=>{const res=await fetch(path+'?'+new URLSearchParams(params),{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(25000)});if(res.status===401||res.status===403)throw new Error('needs_login');if(!res.ok)throw new Error('read_failed');let v;try{v=await res.json();}catch{throw new Error('needs_login');}if(Number(v.code)!==0)throw new Error(/登录|登陆|认证|权限|login/i.test(v.msg||v.message||'')?'needs_login':'read_failed');return v.data;},{path,params,body});}catch(e){throw new Error(e.message.includes('needs_login')?'needs_login':'read_failed');}}
export function result(provider){return {provider,package:PACKAGE,state:'partial',rows:{channels:[],metrics:[],reviews:[]},parts:{}};}
export function finish(v){
 const parts=Object.values(v.parts), success=parts.some(p=>p.state==='ok');
 v.state=success?(parts.every(p=>p.state==='ok')?'ready':'partial'):['needs_login','app_not_found','access_denied','auth_restore_failed','auth_key_unavailable'].find(state=>parts.some(p=>p.state===state))||'read_failed';
 return v;
}
export function fail(e){return {state:e.message?.includes('needs_login')?'needs_login':'read_failed'};}
export function version(v){if(typeof v!=='string'||!v.trim()||v.length>100)throw new Error('version_schema');return v;}
export function count(v){if(!/^\d+$/.test(String(v)))throw new Error('count_schema');const n=Number(v);if(!Number.isSafeInteger(n))throw new Error('count_schema');return n;}
