import test from 'node:test';import assert from 'node:assert/strict';
import {vivoReview,xiaomiReview,xiaomiDownloads,unique,day} from './adapters/review-data.mjs';
import {collect as vivo} from './adapters/vivo.mjs';
const stamp=Date.parse('2026-10-29T16:05:00Z');
const review={packageName:'com.jryx.isho',commentId:46661030,score:5,commentOn:stamp,appVersion:'1.0.2',comment:'好用',userName:'private-user'};
test('vivo 评论校验包名、安全 ID、上海日期并丢弃用户名',()=>{const r=vivoReview(review);assert.equal(r.date,'2026-10-30');assert.equal(r.external_id,'46661030');assert.ok(!JSON.stringify(r).includes('private-user'));assert.throws(()=>vivoReview({...review,packageName:'other'}));assert.throws(()=>vivoReview({...review,commentId:9007199254740992}));assert.throws(()=>vivoReview({...review,score:6}));assert.throws(()=>unique([r,r]));});
test('小米评论只保留不可反推的去重指纹，评分和时间不得猜测',()=>{const v={userKeyV2:'private-fixture-user',updateTime:stamp,score:4,versionName:'1',content:'满意',isDeveloper:false};const a=xiaomiReview(v);assert.deepEqual(a,xiaomiReview(v));assert.ok(!JSON.stringify(a).includes(v.userKeyV2));assert.throws(()=>xiaomiReview({...v,score:0}));assert.throws(()=>xiaomiReview({...v,updateTime:null}));assert.throws(()=>day('not-date'));});
test('小米每日下载排除更新及累计，明确零保留，未提供字段不填零',()=>{const t=String(Date.parse('2026-10-29T00:00:00+08:00'));const row={startStamp:Number(t),firstCount:5202,totalCount:5216,updateCount:14,setFirstCount:true,setTotalCount:true,setUpdateCount:true};const parse=v=>xiaomiDownloads({dates:[t],values:{[t]:v}},'2026-10-01','2026-10-29');assert.equal(parse(row)[0].downloads,5202);assert.equal(parse({...row,firstCount:0,totalCount:14})[0].downloads,0);assert.deepEqual(parse({...row,setFirstCount:false}),[]);assert.throws(()=>parse({...row,totalCount:5202}));assert.throws(()=>parse({...row,startStamp:0}));assert.throws(()=>xiaomiDownloads({dates:[t,t],values:{[t]:row}},'2026-10-01','2026-10-29'));});
function pageFor(failSecond=false){return {url:()=> 'https://dev.vivo.com.cn/',goto:async()=>{},locator:()=>({filter:()=>({first:()=>({waitFor:async()=>{},innerText:async()=> '已发布'})})}),evaluate:async(fn,{path,params,body})=>{switch(path){case '/webapi/app/list-app':return [{id:1,packageName:review.packageName}];case '/webapi/app/detail':return {id:1,packageName:review.packageName,versionName:'1.0.2',versionCode:25229};case '/webapi/app/app-online-version':return {appStoreSale:1,versionName:'1.0.2'};case '/webapi/data-service/table/v2':return {indexList:[{indexField:'increase_download',indexName:'首次下载'}],pageData:{pageCount:1,data:[]}};case '/webapi/comment/info/app':return {id:1,packageName:review.packageName,starRating:4,socreCommentCount:3,commentCount:2};case '/webapi/comment/info/list':if(failSecond&&body.currentPageNum===2)throw Error('failed');return {currentPageNum:body.currentPageNum,recordCount:2,pageCount:2,data:[{...review,commentId:body.currentPageNum}]};default:throw Error('unexpected path');}}};}
test('vivo 三次评分与两条文字评论独立，完整分页后提交',async()=>{const v=await vivo({page:pageFor()});assert.equal(v.state,'ready');assert.equal(v.rows.channels[0].rating_count,3);assert.equal(v.rows.channels[0].rating,4);assert.equal(v.rows.reviews.length,2);});
test('分页中途失败丢弃该次评论分组，已读版本与下载仍可同步',async()=>{const v=await vivo({page:pageFor(true)});assert.equal(v.state,'partial');assert.deepEqual(v.rows.reviews,[]);assert.equal(v.parts.channels.state,'ok');assert.equal(v.parts.downloads.state,'ok');assert.equal(v.parts.reviews.state,'read_failed');});

import {collect as xiaomi,query as miQuery} from './adapters/xiaomi.mjs';
function miContext(broken=false,detailPatch={}){
 const listeners=new Set(),queries=[];const id='2882303761520556760';
 const response=async(path,data)=>{for(const f of listeners)await f({url:()=> 'https://dev.mi.com'+path,json:async()=>({code:0,data})});};
 const detail={appId:id,packageName:'com.jryx.isho',onlineVersionSelling:true,onlineVersion:{appDetailsInfo:{summary:'已上架',versionName:'1.0.2',versionCode:25229}},...detailPatch};
 const page={
  url:()=> 'https://dev.mi.com/xiaomihyperos/console/apps/app-detail',waitForTimeout:async()=>{},
  goto:async()=>response('/pltapi/uiue/myitems/myitemsV1?userId=123&mideveloper_ph=fixture-only-auth',{appItemList:[{appId:id,packageName:'com.jryx.isho',namespaceValue:0}]}),
  locator:()=>({filter:()=>({first:()=>({getByText:()=>({filter:()=>({first:()=>({click:async()=>response('/pltapi/uiue/app/detailsPage',detail)})})})})})}),
  evaluate:async(fn,{auth,path,params,report})=>{
   queries.push(path);assert.equal(auth.mideveloper_ph,'fixture-only-auth');
   if(report){assert.equal(path,`/datacenter/appview/${id}/0`);const t=String(Date.parse('2026-10-29T00:00:00+08:00'));return {dates:[t],values:{[t]:{startStamp:Number(t),setFirstCount:true,firstCount:5202}}};}
   assert.equal(params.packageName,'com.jryx.isho');if(path.endsWith('/scores'))return {score:{score:4.9,count:9}};
   const offset=Number(params.offset);return {count:9,offset,commentInfoList:Array.from({length:offset===0?8:1},(_,i)=>({main:{userKeyV2:'fixture-'+(broken?i:offset+i),updateTime:stamp,score:5,content:'好',versionName:'1.0.2',isDeveloper:false}}))};
  }
 };
 const context={on:(event,fn)=>listeners.add(fn),off:(event,fn)=>listeners.delete(fn)};return {page,context,listeners,queries};
}
test('小米复用已认证控制台请求，后台完整分页且不输出认证字段',async()=>{const args=miContext();const v=await xiaomi(args);assert.equal(v.state,'ready');assert.equal(v.rows.metrics[0].downloads,5202);assert.equal(v.rows.reviews.length,9);assert.equal(v.rows.channels[0].rating,4.9);assert.equal(args.listeners.size,0);assert.ok(!JSON.stringify(v).includes('fixture-only-auth'));assert.ok(!JSON.stringify(v).includes('mideveloper_ph'));});
test('小米重复分页不写入不完整评论，保留版本与下载结果',async()=>{const v=await xiaomi(miContext(true));assert.equal(v.state,'partial');assert.equal(v.parts.reviews.state,'read_failed');assert.deepEqual(v.rows.reviews,[]);assert.equal(v.rows.metrics[0].downloads,5202);});
test('小米报表只解析服务端 JSON，不执行脚本；日期使用真实业务对象键',async()=>{const original=globalThis.fetch;const t=String(Date.parse('2026-10-29T00:00:00+08:00'));try{globalThis.fetch=async url=>{assert.equal(new URL(url,'https://dev.mi.com').pathname,'/datacenter/appview/123/0');return {ok:true,status:200,text:async()=>`var diaryDownloadDate = []; var diaryDownload = ${JSON.stringify({[t]:{startStamp:Number(t),firstCount:5202,setFirstCount:true}})}; globalThis.fixtureExecuted=true;`};};const v=await miQuery({evaluate:(fn,arg)=>fn(arg)},{userId:'123',mideveloper_ph:'fixture'},'/datacenter/appview/123/0',{},true);assert.deepEqual(v.dates,[t]);assert.equal(v.values[t].firstCount,5202);assert.equal(globalThis.fixtureExecuted,undefined);globalThis.fetch=async()=>({ok:false,status:401});await assert.rejects(()=>miQuery({evaluate:(fn,arg)=>fn(arg)},{},'/fixed'),/needs_login/);}finally{globalThis.fetch=original;}});

test('小米出现未知审核状态时独立保留下载和完整评论，不误报登录失败',async()=>{
 const args=miContext(false,{releaseNewVersion:{appDetailsInfo:{summary:'fixture-new-status',versionName:'1.0.3',versionCode:25230}}});
 const v=await xiaomi(args);assert.equal(v.state,'partial');assert.deepEqual(v.parts.channels,{state:'read_failed',code:'unknown_status'});
 assert.deepEqual(v.rows.channels,[]);assert.equal(v.parts.downloads.state,'ok');assert.equal(v.rows.metrics[0].downloads,5202);
 assert.equal(v.parts.reviews.state,'ok');assert.equal(v.rows.reviews.length,9);assert.equal(args.listeners.size,0);
});
test('小米应用身份不匹配仍停止整批，不能继续查询下载或评论',async()=>{
 const args=miContext(false,{appId:'123'});await assert.rejects(()=>xiaomi(args),/app_mismatch/);assert.deepEqual(args.queries,[]);assert.equal(args.listeners.size,0);
});
