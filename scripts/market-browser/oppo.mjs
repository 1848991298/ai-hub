// 固定 ISHO / OPPO 只读采集器：复用隔离浏览器登录态，不读取或输出 Cookie。
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,chmod} from 'node:fs/promises';
import {APP_ID,channels,downloads,reviews} from './oppo-data.mjs';
const root=process.env.AI_HUB_ROOT||resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=createRequire(join(root,'.local/market-browser-runtime/package.json'))('playwright');
const profile=join(root,'.local/market-browser/oppo');await mkdir(profile,{recursive:true,mode:0o700});await chmod(profile,0o700);
const login=process.argv.includes('--login');let context;
const output={provider:'oppo',package:'com.jryx.isho',app_id:APP_ID,rows:{channels:[],metrics:[],reviews:[]},parts:{}};
const safeError=e=>/needs_login/.test(e.message)?'needs_login':/profile_busy/.test(e.message)?'profile_busy':'read_failed';
try{
 try{context=await chromium.launchPersistentContext(profile,{headless:!login,viewport:{width:1440,height:1000},acceptDownloads:false});}catch{throw new Error('profile_busy');}
 const page=context.pages()[0]||await context.newPage();
 await page.goto('https://open.oppomobile.com/new/mcom/app/detail?app_id='+APP_ID+'&pkg_symbol=0',{waitUntil:'domcontentloaded',timeout:45000});
 const paths={info:'/oresource/officialapi/v1/app/detail/app_basic_info',versions:'/oresource/officialapi/v1/app/version-list',downloads:'/resource/data/data-download-analysis-list',ratings:'/resource/comment/index.json',reviews:'/resource/comment/list.json'};
 async function read(name,data){
  const path=paths[name];if(!path)throw new Error('unapproved_read');
  const value=await page.evaluate(async({path,data})=>{
   if(location.origin!=='https://open.oppomobile.com')return {fail:'needs_login'};
   const form=path.startsWith('/resource/');
   const res=await fetch(path,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':form?'application/x-www-form-urlencoded':'application/json'},body:form?new URLSearchParams(data).toString():JSON.stringify(data),signal:AbortSignal.timeout(30000)});
   if(res.status===401||res.status===403)return {fail:'needs_login'};
   if(!res.ok)return {fail:'read_failed'};
   let v;try{v=await res.json();}catch{return {fail:'needs_login'};}
   if(Number(v.code??v.errno)!==0)return {fail:/登录|登陆|login|认证|权限/i.test(v.message||v.error||'')?'needs_login':'read_failed'};
   return {data:v.data};
  },{path,data});if(value.fail)throw new Error(value.fail);return value.data;
 }
 let info;
 const deadline=Date.now()+(login?15*60*1000:0);
 while(true){try{info=await read('info',{app_id:Number(APP_ID),relation_app_id:[null]});if(info.pkg_name!=='com.jryx.isho')throw new Error('needs_login');break;}catch(e){if(!login||Date.now()>deadline)throw e;await page.waitForTimeout(10000);}}
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
 try{
  let versions=[];for(let p=1;p<=20;p++){const v=await read('versions',{app_id:Number(APP_ID),page:p,size:20,pkg_name:'',type:null});if(!Array.isArray(v.list))throw new Error('schema');versions.push(...v.list);if(p>=Number(v.total_page))break;if(p===20)throw new Error('pagination_limit');}
  output.rows.channels=[channels(info,versions,today)];output.parts.channels={state:'ok'};
 }catch(e){output.parts.channels={state:safeError(e)};}
 try{
  const date=new Date(today+'T00:00:00Z');date.setUTCDate(date.getUTCDate()-1);const end=date.toISOString().slice(0,10);date.setUTCDate(date.getUTCDate()-29);const start=date.toISOString().slice(0,10);
  let all=[];let total=null;for(let p=1;p<=100;p++){const v=await read('downloads',{app_id:APP_ID,start_date:start,end_date:end,page:String(p),page_size:'100',export:'0',type:'2'});if(!Array.isArray(v.list?.rows)||!Number.isInteger(Number(v.list.total)))throw new Error('schema');total=Number(v.list.total);if(total>10000)throw new Error('pagination_limit');all.push(...v.list.rows);if(all.length>=total)break;if(!v.list.rows.length||p===100)throw new Error('pagination_incomplete');}
  output.rows.metrics=downloads(all);if(new Set(all.map(r=>r.dt)).size!==all.length||all.some(r=>r.dt<start||r.dt>end))throw new Error('range');output.parts.downloads={state:'ok',count:all.length,from:start,to:end};
 }catch(e){output.rows.metrics=[];output.parts.downloads={state:safeError(e)};}
 try{
  const rating=await read('ratings',{app_id:APP_ID});let all=[];let pages=0;
  for(let p=1;p<=200;p++){const v=await read('reviews',{page:String(p),app_id:APP_ID,level:'0',content:'',from_datetime:'',to_datetime:'',cp_order:'',cp_sort:'',replied:''});if(!Array.isArray(v.rows)||!Number.isInteger(Number(v.total_page)))throw new Error('schema');pages=Number(v.total_page);if(pages>200)throw new Error('pagination_limit');all.push(...v.rows);if(p>=pages)break;}
  const parsed=reviews(all);if(Number(rating.count)!==parsed.length)throw new Error('comment_count_changed');if(new Set(parsed.map(r=>r.external_id)).size!==parsed.length)throw new Error('duplicate_page');
  output.rows.reviews=parsed;if(output.rows.channels[0])Object.assign(output.rows.channels[0],{rating:rating.agv_score,rating_count:rating.count});
  output.parts.reviews={state:'ok',count:parsed.length,total:rating.count,pages};
 }catch(e){output.rows.reviews=[];output.parts.reviews={state:safeError(e)};}
 output.state=Object.values(output.parts).every(p=>p.state==='ok')?'ready':'partial';
}catch(e){output.state=safeError(e);}
finally{if(context)await context.close().catch(()=>{});}
console.log(JSON.stringify(output));
