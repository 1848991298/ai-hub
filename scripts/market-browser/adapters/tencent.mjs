import {redact} from '../portals.mjs';
import {PACKAGE,today,range,result,finish,fail,version,count} from './common.mjs';
// 应用宝软件总览的每日下载量。应用 ID 只用于定位，每次都用包名核对，不保存密钥。
const APP_ID='1112464281';
const INFO='/api/xy/runtime/env/prod/manage/datasource/collection/request/open/appdetail/app_info/request';
const DOWNLOADS='/api/xy/runtime/env/prod/manage/datasource/collection/request/open/data-overview-software-overview/data/custom_getSoftData';
function stamp(day,end){return String(Math.floor(new Date(`${day}T${end?'23:59:59':'00:00:00'}+08:00`).getTime()/1000));}
function released(seconds){const n=Number(seconds);if(!Number.isFinite(n)||n<1e9)return '';return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(n*1000));}
const failure=e=>({...fail(e),...(['needs_login','app_not_found','access_denied'].includes(e.message)?{state:e.message}:{}),...(Number.isSafeInteger(e.business_code)?{business_code:e.business_code}:{}),...(e.reason?{reason:e.reason}:{}),...(e.detail?{detail:e.detail}:{}),code: /^[a-z_]{1,40}$/.test(e.code||'') ? e.code : 'read_failed', ...(Number.isInteger(e.http_status)?{http_status:e.http_status}:{})});
const schema=value=>value&&typeof value==='object'?Object.keys(value).filter(key=>/^[a-z_][a-z0-9_]{0,40}$/i.test(key)).slice(0,20):[];
async function post(page,path,body){
 let response;
 try{response=await page.evaluate(async({path,body})=>{
  try{
   const res=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});
   if(!res.ok)return {error:res.status===401||res.status===403?'needs_login':'http_failed',http_status:res.status};
   try{return {value:await res.json(),http_status:res.status};}catch{return {error:'non_json',http_status:res.status};}
  }catch{return {error:'request_failed'};}
 },{path,body});}catch{response={error:'request_failed'};}
 if(response.error){const error=new Error(response.error==='needs_login'?'needs_login':'read_failed');error.code=response.error;error.http_status=response.http_status;throw error;}
 const value=response.value;
 if(!value||typeof value!=='object'){const error=new Error('read_failed');error.code='response_schema';throw error;}
 const businessCode=value.ret??value.code;
 if(businessCode!==undefined&&Number(businessCode)!==0){
  const message=String(value.msg||value.message||'');
  const state=/登录|登陆|未认证|login|logged.?in|session|auth.*fail|credential|token.*过期/i.test(message)?'needs_login':/权限|无权|permission|forbidden/i.test(message)?'access_denied':'read_failed';
  const error=new Error(state);error.detail=redact(message).replace(/https?:\/\/\S+/g,'[地址已隐藏]').replace(/[A-Za-z0-9_-]{24,}/g,'[标识已隐藏]').slice(0,120);error.code='business_rejected';error.business_code=Number(businessCode);error.http_status=response.http_status;
  error.reason=state==='needs_login'?'authentication_failed':state==='access_denied'?'permission_denied':/参数|parameter|argument|csrf/i.test(message)?'request_invalid':'service_error';
  throw error;
 }
 return value;
}
export async function collect({page}){
 if(new URL(page.url()).hostname!=='app.open.qq.com'||new URL(page.url()).pathname.startsWith('/p/login'))throw new Error('needs_login');
 const out=result('tencent');
 let info;
 try{
  info=await post(page,INFO,{app_id:APP_ID});
  if(info.package_name!==PACKAGE||String(info.app_id)!==APP_ID)throw Object.assign(new Error('app_not_found'),{code:'app_identity_mismatch'});
  const name=version(String(info.version_name||''));const code=count(info.version_code);
  out.rows.channels=[{channel:'tencent',live_version:name,live_code:code,pending_version:'',pending_code:null,status:'live',released_at:released(info.last_update_time),as_of:today(),reason:''}];
  out.parts.channels={state:'ok'};
 }catch(e){out.parts.channels={...failure(e),schema:schema(info)};}
 try{
  if(!info||info.package_name!==PACKAGE)throw Object.assign(new Error(out.parts.channels?.state||'read_failed'),{code:'blocked_by_app_info'});
  const {from,to}=range();
  const resp=await post(page,DOWNLOADS,{appId:APP_ID,start:stamp(from,false),stop:stamp(to,true)});
  if(!Array.isArray(resp.data))throw new Error('download_schema');
  const rows=resp.data.filter(row=>String(row.downloadCnt)!=='-1');
  if(new Set(rows.map(row=>row.date)).size!==rows.length)throw new Error('duplicate_date');
  out.rows.metrics=rows.map(row=>{
   if(!/^\d{8}$/.test(String(row.date)))throw new Error('date_schema');
   const date=`${row.date.slice(0,4)}-${row.date.slice(4,6)}-${row.date.slice(6,8)}`;
   if(date<from||date>to)throw new Error('date_range');
   return {channel:'tencent',date,downloads:count(row.downloadCnt),source:'应用宝开放平台 · 每日下载量'};
  });
  out.parts.downloads={state:'ok',count:rows.length,from,to};
 }catch(e){out.rows.metrics=[];out.parts.downloads=failure(e);}
 out.parts.audit={state:'unsupported'};
 out.parts.reviews={state:'unsupported'};
 return finish(out);
}
