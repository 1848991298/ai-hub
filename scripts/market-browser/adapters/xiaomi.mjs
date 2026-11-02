import {xiaomiDownloads,xiaomiReview,unique,score} from './review-data.mjs';
import {PACKAGE,today,range,result,finish,fail,version,count} from './common.mjs';
export function channel(d,expectedId){
 if(d.packageName!==PACKAGE||String(d.appId)!==String(expectedId))throw new Error('app_mismatch');
 const online=d.onlineVersion?.appDetailsInfo,update=d.releaseNewVersion?.appDetailsInfo;
 const live=online?.summary==='已上架'&&d.onlineVersionSelling===true;
 const labels={'未发布':'not_submitted','审核中':'reviewing','审核未通过':'rejected','审核不通过':'rejected','待发布':'approved','已上架':'live','已下架':'offline'};
 const status=update?labels[update.summary]:live?'live':'offline';if(!status)throw new Error('unknown_status');
 return {channel:'xiaomi',live_version:live?version(online.versionName):'',live_code:live?count(online.versionCode):null,pending_version:update?version(update.versionName):'',pending_code:update?.versionCode?count(update.versionCode):null,status,as_of:today(),reason:''};
}
// 只复用已通过包名校验的官方控制台请求中的两项同源认证参数；不持久化或输出。
export async function query(page,auth,path,params={},report=false){
 return page.evaluate(async({auth,path,params,report})=>{
  const res=await fetch(path+'?'+new URLSearchParams({...auth,...params}),{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(25000)});
  if(res.status===401||res.status===403)throw Error('needs_login');if(!res.ok)throw Error('read_failed');
  if(!report){const v=await res.json();if(Number(v.code)!==0)throw Error(Number(v.code)===401||/登录|登陆|认证|权限|login/i.test(v.msg||v.message||'')?'needs_login':'read_failed');return v.data;}
  const text=await res.text();if(text.length>3*1024*1024)throw Error('report_schema');
  // 报表为服务端 JSON 字面量，仅解析业务对象，不执行页面脚本。
  const match=text.match(/\bdiaryDownload\s*=\s*([\s\S]*?);/);if(!match)throw Error('report_schema');
  const values=JSON.parse(match[1]);if(!values||Array.isArray(values)||typeof values!=='object')throw Error('report_schema');
  return {dates:Object.keys(values),values};
 },{auth,path,params,report});
}
export async function collect({page,context}){
 const out=result('xiaomi');let apps,detail,auth,login=false;
 const observer=async response=>{try{const u=new URL(response.url());if(u.origin!=='https://dev.mi.com')return;
  if(u.pathname==='/pltapi/uiue/myitems/myitemsV1'){
   const v=await response.json();if(v.code===401){login=true;return;}
   if(Number(v.code)===0&&Array.isArray(v.data?.appItemList)){
    apps=v.data.appItemList;const userId=u.searchParams.get('userId'),ph=u.searchParams.get('mideveloper_ph');
    if(/^\d+$/.test(userId||'')&&ph)auth={userId,mideveloper_ph:ph};
   }
  }else if(u.pathname==='/pltapi/uiue/app/detailsPage'){const v=await response.json();if(Number(v.code)===0&&v.data?.packageName===PACKAGE)detail=v.data;}
 }catch{}};
 context.on('response',observer);
 async function wait(test){const end=Date.now()+30000;while(!test()){if(login||/account\.xiaomi\.com|\/login/.test(page.url()))throw Error('needs_login');if(Date.now()>end)throw Error('read_failed');await page.waitForTimeout(150);}}
 try{
  await page.goto('https://dev.mi.com/xiaomihyperos/console/app-manage/mobile',{waitUntil:'domcontentloaded',timeout:30000});await wait(()=>apps);
  const matches=apps.filter(a=>a.packageName===PACKAGE);if(matches.length!==1)throw Error('app_not_found');const app=matches[0];if(typeof app.appId!=='string')throw Error('app_id_precision');
  const row=page.locator('tr').filter({hasText:PACKAGE}).first();await row.getByText(/^ISHO/).filter({visible:true}).first().click({timeout:15000});await wait(()=>detail);
  out.rows.channels=[channel(detail,app.appId)];out.parts.channels={state:'ok'};
  const namespace=String(app.namespaceValue);if(!/^\d+$/.test(namespace)||!/^\d+$/.test(app.appId))throw Error('app_schema');
  try{
   if(!auth)throw Error('needs_login');const {from,to}=range();
   const raw=await query(page,auth,`/datacenter/appview/${app.appId}/${namespace}`,{},true);
   out.rows.metrics=xiaomiDownloads(raw,from,to);out.parts.downloads={state:'ok',count:out.rows.metrics.length,from,to};
  }catch(e){out.rows.metrics=[];out.parts.downloads=fail(e);}
  try{
   if(!auth)throw Error('needs_login');const base='/uiueapi/comment/usercomment/';
   const summary=await query(page,auth,base+'scores',{packageName:PACKAGE});const rating=score(summary.score?.score),ratingCount=count(summary.score?.count);
   let rows=[],expected;
   for(let offset=0;offset<2000;offset+=8){
    const d=await query(page,auth,base+'commentlist',{packageName:PACKAGE,limit:'8',offset:String(offset),score:'',versionName:'',model:'',startTime:String(Date.parse('2000-01-01T00:00:00+08:00')),endTime:String(Date.parse(today()+'T23:59:59.999+08:00'))});
    if(!Array.isArray(d.commentInfoList)||count(d.offset)!==offset)throw Error('review_schema');const total=count(d.count);if(expected===undefined)expected=total;if(expected!==total)throw Error('changed_page');
    rows.push(...d.commentInfoList.map(v=>xiaomiReview(v.main)));unique(rows);if(rows.length===expected)break;if(!d.commentInfoList.length||rows.length>expected||offset===1992)throw Error('incomplete_page');
   }
   out.rows.reviews=rows;Object.assign(out.rows.channels[0],{rating,rating_count:ratingCount});out.parts.reviews={state:'ok',count:rows.length};
  }catch(e){out.rows.reviews=[];out.parts.reviews=fail(e);}
  return finish(out);
 }finally{context.off('response',observer);}
}
