import {vivoReview,unique,score} from './review-data.mjs';
import {PACKAGE,today,range,read,result,finish,fail,version,count} from './common.mjs';
export async function collect({page}){
 if(new URL(page.url()).hostname!=='dev.vivo.com.cn')throw new Error('needs_login');
 const apps=await read(page,'/webapi/app/list-app');if(!Array.isArray(apps))throw new Error('needs_login');const matches=apps.filter(a=>a.packageName===PACKAGE);if(matches.length!==1)throw new Error('app_not_found');const id=String(matches[0].id);if(!/^\d+$/.test(id))throw new Error('app_schema');
 const out=result('vivo');
 try{
  const info=await read(page,'/webapi/app/detail',{appId:id});const online=await read(page,'/webapi/app/app-online-version',{packageName:PACKAGE});if(info.packageName!==PACKAGE||String(info.id)!==id)throw new Error('app_mismatch');
  await page.goto('https://dev.vivo.com.cn/appLists',{waitUntil:'domcontentloaded'});
  const tr=page.locator('tr').filter({hasText:PACKAGE}).first();await tr.waitFor({state:'attached',timeout:18000});const text=await tr.innerText();
  const states={'已发布':'live','审核中':'reviewing','待发布':'approved','审核不通过':'rejected','未提交':'not_submitted','已下架':'offline','已撤回':'not_submitted'};
  const label=Object.keys(states).find(x=>text.includes(x));if(!label)throw new Error('unknown_state');const status=states[label];
  const current=version(info.versionName);const live=online.appStoreSale===1?version(online.versionName):'';
  out.rows.channels=[{channel:'vivo',status,live_version:live,live_code:live===current&&status==='live'?count(info.versionCode):null,pending_version:status==='live'?'':current,pending_code:status==='live'?null:count(info.versionCode),as_of:today(),reason:''}];out.parts.channels={state:'ok'};
 }catch(e){out.parts.channels=fail(e);}
 try{
  const {from,to}=range();let rows=[];
  for(let p=1;p<=100;p++){
   const d=await read(page,'/webapi/data-service/table/v2',{moduleId:'298',menuType:'1',type:'1',dataId:id,startDate:from,endDate:to,currentPageNum:String(p),numPerPage:'100',dataFormatType:'0',moduleCode:'',menuCode:'',tabCode:'business_install'});
   if(!Array.isArray(d.pageData?.data)||!d.indexList?.some(i=>i.indexField==='increase_download'&&i.indexName==='首次下载'))throw new Error('schema');rows.push(...d.pageData.data);if(p>=count(d.pageData.pageCount))break;if(p===100)throw new Error('pagination_limit');
  }
  if(new Set(rows.map(r=>r.effect_date)).size!==rows.length)throw new Error('duplicate_page');
  out.rows.metrics=rows.map(r=>{if(r.effect_date<from||r.effect_date>to)throw new Error('date_range');return {channel:'vivo',date:r.effect_date,downloads:count(r.increase_download),source:'vivo 开发者后台 · 每日首次下载（不含更新）'};});out.parts.downloads={state:'ok',count:rows.length,from,to};
 }catch(e){out.rows.metrics=[];out.parts.downloads=fail(e);}
 try{
  const summary=await read(page,'/webapi/comment/info/app',{packageName:PACKAGE});if(summary.packageName!==PACKAGE||String(summary.id)!==id)throw Error('app_mismatch');
  const expected=count(summary.commentCount),rating=score(summary.starRating),ratingCount=count(summary.socreCommentCount);let rows=[];
  for(let p=1;p<=200;p++){
   const d=await read(page,'/webapi/comment/info/list',{}, {model:'',starRating:'',appVersion:'',startDate:'2000-01-01 00:00:00',endDate:today()+' 23:59:59',currentPageNum:p,pageSize:10,packageName:PACKAGE,sort:2,replyStatus:''});
   if(!Array.isArray(d.data)||count(d.recordCount)!==expected||count(d.currentPageNum)!==p)throw Error('review_schema');rows.push(...d.data.map(vivoReview));unique(rows);if(p>=count(d.pageCount))break;if(p===200)throw Error('pagination_limit');
  }
  if(rows.length!==expected)throw Error('incomplete_page');out.rows.reviews=rows;if(out.rows.channels[0])Object.assign(out.rows.channels[0],{rating,rating_count:ratingCount});out.parts.reviews={state:'ok',count:rows.length};
 }catch(e){out.rows.reviews=[];out.parts.reviews=fail(e);}return finish(out);
}
